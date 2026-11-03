# -*- coding: utf-8 -*-
"""条件请求缓存层（ETag / Last-Modified → 304，弱网减带宽）。

位置：build_router() 装配完成后对每个 GET 路由的 ASGI app 统一包装
（apply_to_router）——业务 handler 签名零改动，catch-all 代理与全部
固定路由共用此层。

语义（与前端 requestCache 条件再验证配对）：
- 只缓存 GET 200 且 body ≤ 1MB（流式 / SSE / 大文件直通不缓存）；
  非 200（含上游 5xx/超时等失败态）一律不缓存——「失败态返回上次
  成功值 + stale 标记」由前端 requestCache 的 SWR 既有语义承担；
- 只存元数据（etag / last_modified / expiry），不存 body——304 响应
  不带 body，前端保留旧值（不覆盖本地缓存）并延长条目 TTL
  （再验证新鲜语义）；
- ETag 取上游透传值优先（approval_api._passthrough_headers 已把
  上游 ETag 带上 X-Upstream-ETag 标记），否则按 body 合成
  ``W/"<sha256>"``；
- TTL 分级（按请求路径子串，见 tier_ttl）：messages 5s /
  events|signals 10s / models|config 120s / 默认 60s（CRD 档）；
- 直通（不缓存不 304）：非 GET；SSE（/events 精确）/ /docker-logs /
  /wechat-qr（长轮询）/ /media（流式媒体）路由（按模板静态判）；
  ?force=true / ?refresh=1 / ?consistency=strong 查询（按请求动态判
  ——强一致读 #1407 不得被缓存满足）。

并发与容量：模块级元数据表 _conditional_cache（conftest 逐测清空，
命名遵循 *_cache 惯例）；MAX_ENTRIES 超容先清过期、再逐 expiry 最早。
"""
from __future__ import annotations

import hashlib
import time
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, List, Optional

MAX_BODY = 1 * 1024 * 1024  # 仅缓存 body ≤1MB 的 200 响应
MAX_ENTRIES = 256  # 元数据表容量上限

# 静态直通路由（按注册模板判）：SSE / 长轮询 / 流式媒体。
_SSE_EXACT = {"/events"}
_STREAM_PREFIXES = ("/docker-logs", "/wechat-qr", "/media")

# 元数据表：key=path[?query] → {expiry(monotonic), etag, last_modified}
_conditional_cache: Dict[str, Dict[str, Any]] = {}


def tier_ttl(path: str) -> float:
    """TTL 分级（按路径子串，大小写不敏感）。

    messages → 5s（消息面，变化最快）；
    events|signals → 10s（工作流事件 / 信号面）；
    models|config → 120s（模型 / 配置面，低频变化）；
    默认 → 60s（CRD 档，含 catch-all 代理的 controller 列表端点）。
    """
    p = path.lower()
    if "messages" in p:
        return 5.0
    if "events" in p or "signals" in p:
        return 10.0
    if "models" in p or "config" in p:
        return 120.0
    return 60.0


def _bypass_template(template: str) -> bool:
    """静态直通判定（路由模板）：SSE / 长轮询 / 流式媒体路由不缓存。"""
    if template in _SSE_EXACT:
        return True
    return template.startswith(_STREAM_PREFIXES)


def _query_bypass(query: bytes) -> bool:
    """动态直通判定（请求查询串）：强一致读 / 显式刷新标记不进缓存。"""
    if not query:
        return False
    q = query.decode("latin-1", "replace").lower()
    return (
        "force=true" in q
        or "refresh=1" in q
        or "consistency=strong" in q
    )


def _normalize_etag(value: str) -> str:
    v = value.strip()
    if v.startswith("W/"):
        v = v[2:]
    return v


def etag_matches(if_none_match: str, etag: str) -> bool:
    """RFC 7232 If-None-Match 匹配：``*`` / 逗号列表 / 剥离 W/ 弱标记归一。"""
    inm = if_none_match.strip()
    if inm == "*":
        return True
    target = _normalize_etag(etag)
    for cand in inm.split(","):
        if _normalize_etag(cand) == target:
            return True
    return False


def ims_satisfied(if_modified_since: str, last_modified: Optional[str]) -> bool:
    """RFC 7232 If-Modified-Since：Last-Modified ≤ If-Modified-Since → 满足。

    无 Last-Modified 或日期不可解析 → 不满足（诚实回源）。
    """
    if not last_modified:
        return False
    try:
        ims = parsedate_to_datetime(if_modified_since)
        lm = parsedate_to_datetime(last_modified)
    except (TypeError, ValueError):
        return False
    return lm <= ims


def _headers_map(headers: List) -> Dict[str, str]:
    """scope 头（[(bytes, bytes)]）→ 小写键首值 dict（latin-1 解码）。"""
    out: Dict[str, str] = {}
    for k, v in headers or []:
        key = k.decode("latin-1", "replace").lower()
        if key not in out:
            out[key] = v.decode("latin-1", "replace")
    return out


def _store(key: str, path: str, etag: str, last_modified: Optional[str]) -> None:
    """写入元数据（不存 body）；超容先清过期、再逐 expiry 最早。"""
    now = time.monotonic()
    if len(_conditional_cache) >= MAX_ENTRIES:
        for k in [k for k, e in _conditional_cache.items() if e["expiry"] <= now]:
            del _conditional_cache[k]
        while len(_conditional_cache) >= MAX_ENTRIES:
            oldest = min(
                _conditional_cache, key=lambda k: _conditional_cache[k]["expiry"]
            )
            del _conditional_cache[oldest]
    _conditional_cache[key] = {
        "expiry": time.monotonic() + tier_ttl(path),
        "etag": etag,
        "last_modified": last_modified,
    }


def clear() -> None:
    """清空元数据表（测试 / 调试用；conftest 亦按 *_cache 惯例自动清）。"""
    _conditional_cache.clear()


async def _send_304(send: Callable, etag: str) -> None:
    """304 Not Modified：空 body + ETag 头（RFC 7232：304 不带实体体）。"""
    await send(
        {
            "type": "http.response.start",
            "status": 304,
            "headers": [(b"etag", etag.encode("latin-1"))],
        }
    )
    await send({"type": "http.response.body", "body": b"", "more_body": False})


def make_conditional_app(original: Callable) -> Callable:
    """把单条路由的 ASGI app 包一层条件请求缓存。

    original = 路由现有 app（FastAPI 依赖注入后的 handler app）；
    返回同签名 (scope, receive, send) 的新 app。包装器对请求体零感知
    （GET 无体），receive 原样透传。
    """

    async def conditional_app(scope, receive, send):
        # 非 GET 直通（HEAD/OPTIONS/写方法不缓存）。
        if scope.get("method") != "GET":
            return await original(scope, receive, send)
        path = scope.get("path") or ""
        query = scope.get("query_string") or b""
        if _query_bypass(query):
            return await original(scope, receive, send)

        headers = _headers_map(scope.get("headers") or [])
        inm = headers.get("if-none-match")
        ims = headers.get("if-modified-since")
        key = path + (f"?{query.decode('latin-1', 'replace')}" if query else "")
        now = time.monotonic()
        entry = _conditional_cache.get(key)
        if entry is not None and entry["expiry"] > now:
            # If-None-Match 优先；无 INM 时再看 If-Modified-Since
            # （RFC 7232：两条件同时出现时 INM 命中即 304，IMS 被忽略）。
            if inm is not None and etag_matches(inm, entry["etag"]):
                await _send_304(send, entry["etag"])
                return
            if (
                inm is None
                and ims is not None
                and ims_satisfied(ims, entry.get("last_modified"))
            ):
                await _send_304(send, entry["etag"])
                return

        # 拨号 original 并缓冲响应：body 完成且可缓存 → 存元数据 +
        # 补 ETag 头后重放；流式 / 超大 → 立即切直通；非 200 → 原样
        # 重放、不缓存（失败态不缓存）。
        state: Dict[str, Any] = {
            "body": b"",
            "status": None,
            "etag": None,
            "lm": None,
            "stream": False,
            "done": False,
            "start": None,
        }
        pending: List[Dict[str, Any]] = []

        async def orig_send(msg: Dict[str, Any]) -> None:
            if state["done"] or state["stream"]:
                await send(msg)
                return
            mtype = msg.get("type")
            if mtype == "http.response.start":
                state["status"] = msg.get("status")
                state["start"] = msg
                for k, v in msg.get("headers") or []:
                    lk = k.decode("latin-1", "replace").lower()
                    if lk == "etag":
                        state["etag"] = v.decode("latin-1", "replace")
                    elif lk == "last-modified":
                        state["lm"] = v.decode("latin-1", "replace")
                    elif (
                        lk == "content-type"
                        and "text/event-stream" in v.decode("latin-1", "replace")
                    ):
                        state["stream"] = True
                if state["stream"]:
                    await send(msg)
                else:
                    pending.append(msg)
            elif mtype == "http.response.body":
                chunk = msg.get("body") or b""
                state["body"] += chunk
                pending.append(msg)
                more = msg.get("more_body")
                if more or len(state["body"]) > MAX_BODY:
                    # 流式 / 超 1MB → 直通：先放已缓冲的，后续消息接力。
                    state["stream"] = True
                    for m in pending:
                        await send(m)
                    pending.clear()
                elif state["status"] == 200:
                    # 完整 200 且 ≤1MB：定 ETag（上游透传优先，否则
                    # 合成弱 ETag）、存元数据（不存 body）、补 ETag 头重放。
                    etag = (
                        state["etag"]
                        or 'W/"%s"' % hashlib.sha256(state["body"]).hexdigest()
                    )
                    _store(key, path, etag, state["lm"])
                    out_headers = list(state["start"].get("headers") or [])
                    if state["etag"] is None:
                        out_headers.append(
                            (b"etag", etag.encode("latin-1"))
                        )
                    state["done"] = True
                    await send(
                        {
                            "type": "http.response.start",
                            "status": state["status"],
                            "headers": out_headers,
                        }
                    )
                    await send(
                        {
                            "type": "http.response.body",
                            "body": state["body"],
                            "more_body": False,
                        }
                    )

        try:
            await original(scope, receive, orig_send)
        finally:
            # 非 200 完整响应（未走 200 缓存分支）→ 原样重放、不缓存。
            if not state["done"] and not state["stream"] and pending:
                for m in pending:
                    await send(m)
                pending.clear()

    return conditional_app


def apply_to_router(router) -> None:
    """build_router() 装配后调用：对每个含 GET 的路由包装条件请求层。

    include_router 已把子路由的 Route 对象扁平进 router.routes，遍历
    即覆盖全部域。route.app 为普通属性（Starlette 1.9 实证可赋值）；
    每次 build_router() 新建 Route 实例，不会重复包装。SSE / 长轮询 /
    流式媒体路由按模板直通（_bypass_template）。
    """
    for route in getattr(router, "routes", []):
        methods = getattr(route, "methods", None)
        if not methods or "GET" not in methods:
            continue
        template = getattr(route, "path", "") or ""
        if _bypass_template(template):
            continue
        route.app = make_conditional_app(route.app)
