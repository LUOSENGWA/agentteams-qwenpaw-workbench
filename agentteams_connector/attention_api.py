# -*- coding: utf-8 -*-
"""attention 决策面（读聚合 + 人类身份答回）。

背景：AgentTeams 生产已有 attention 模型（request_attention #1206/#1229）——
worker 卡住时往任务房间发 ``ATTENTION_<KIND>: <task-id> - <question>`` 并
@ leader + 人类。本模块把工作台升级为**结构化决策弹窗**的数据面：

- ``GET /attention``：读侧。复用现有 controller 代理取项目列表，逐项目拉
  ``GET /api/v1/projects/{id}/attention?include_resolved=0&limit=200``
  合并；过滤 resolved；按 ``requested_at`` 倒序；30s 进程内缓存
  （``refresh=1`` 绕过）。**controller 404 = 端点未部署（旧版本）→ 返回
  ``{"deployed": false, "items": []}``**（HTTP 200，UI 诚实降级：不显示
  badge，不报错）；逐项目失败不致命（记 ``errors`` 数组，其余照常返回）。
- ``POST /attention/answer``：答侧。以**人类身份**（Matrix 登录 token）把
  决策发回任务房间——复用现有 matrix 代理发送路径（``matrix_client.
  send_message``），不写任务 meta、不改 worker。消息固定格式：
  ``DECISION: <task_id> → <answer>`` +（basis 存在时换行 ``basis: ...``）。
  校验：有 options 时 answer 必须是该请求 option id 之一；无 options 时
  自由文本 ≤500。本地持久化 ``<state>/attention-answered.json``（key =
  ``task_id:kind:attempt``）用于去重（重复回答 → 409）与 UI 状态；
  room 缺失 / 发送失败 → 502。

NMH §8 对齐（只体现在字段/文案，不新增协议）：选项=options、推荐=
suggested（仅提示，绝不自动选中/提交）、期限=expires_at、依据=basis
（写入答案消息）、兜底=模式切换类选项 human-only（不做自动执行）。

挂接：``router.build_router()`` 在 catch-all（approval_api）之前 include
本域 router（``/attention*`` 固定路径必须排在 ``/{target}/{path:path}`` 前）。
本模块**不做模块级 router 导入**（函数内惰性导入，同 ctl_client 模式）——
router.py 在模块尾部 import 本模块，模块级互导会成环。
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import quote as _quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# 30s 进程内聚合缓存（GET /attention 的重复轮询不再打 controller）。
_CACHE_TTL = 30.0
# 模块级缓存——名字以 ``_cache`` 结尾（tests/conftest 的
# ``_clear_module_caches`` 按此约定统一清，防跨测试泄漏）。
_attention_cache: Dict[str, Any] = {}
# answered 文件读写锁（进程内；单进程插件）。
_LOCK = threading.Lock()

_ANSWERED_FILENAME = "attention-answered.json"
_MAX_ANSWER_LEN = 500  # 无 options 时自由文本上限（契约）
_MAX_PROJECTS = 100  # 项目数上限（与 projects_workflow 一致，防失控）
_CONCURRENCY = 4  # 逐项目并发（与 projects_workflow 一致）


# ── 本地 answered 持久化（去重 + UI 状态） ──────────────────────────


def _answered_path():
    from . import config as config_mod  # 惰性（conftest 重定向 _CONFIG_DIR）

    return config_mod._CONFIG_DIR / _ANSWERED_FILENAME


def _load_answered() -> Dict[str, Any]:
    p = _answered_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_answered(entries: Dict[str, Any]) -> None:
    p = _answered_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(
        json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    tmp.replace(p)


def _answer_key(task_id: Any, kind: Any, attempt: Any) -> str:
    """去重键 = ``task_id:kind:attempt``（同一请求的重复回答被 409 挡下）。"""
    return f"{task_id or ''}:{kind or 'other'}:{attempt if attempt is not None else 1}"


def _attempt_eq(a: Any, b: Any) -> bool:
    try:
        return int(a) == int(b)
    except (TypeError, ValueError):
        return str(a or "") == str(b or "")


def _requested_ts(v: Any) -> float:
    """requested_at → epoch（排序用；解析失败 → 0 = 排最后，不伪造）。"""
    s = str(v or "").strip()
    if not s:
        return 0.0
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return 0.0


# ── 读侧：聚合 ─────────────────────────────────────────────────────


async def _fetch_all(include_resolved: bool) -> Dict[str, Any]:
    """项目列表 → 逐项目 attention 合并（无缓存层，调用方自管）。

 返回 ``{"deployed": bool, "items": [...], "errors": [...]}``：
 - controller 404（项目列表或任一 attention URL）= 端点未部署（旧版本）
   → ``deployed=False, items=[]``（诚实降级信号）；
 - 项目列表/聚合不可用（无 token、无地址、5xx）→ 抛 502；
 - 逐项目失败（5xx/异常）→ 记 ``errors``，其余照常（不致命）。
 """
    from . import config as config_mod
    from . import router as router_mod
    from . import worker_status

    cfg = config_mod.load_config()
    try:
        token, _src = router_mod._resolve_controller_token(cfg)
    except Exception:
        token = ""
    if not token:
        raise HTTPException(
            status_code=502, detail="未配置 Controller token，无法拉取 attention"
        )
    base_urls = router_mod._ordered_addresses(cfg, "controller")
    if not base_urls:
        raise HTTPException(status_code=502, detail="未配置 Controller 地址")
    base = base_urls[0].rstrip("/")

    st, data, _text = await worker_status._ctl_get(f"{base}/api/v1/projects", token)
    if st == 404:
        return {"deployed": False, "items": [], "errors": []}
    if st != 200:
        raise HTTPException(
            status_code=502, detail=f"拉取项目列表失败（Controller {st}）"
        )
    raw_list = (
        data
        if isinstance(data, list)
        else (data.get("projects", []) if isinstance(data, dict) else [])
    )
    # 项目去重（同前端 fetchProjectSummaries 约定：按 project_id，优先带 team_id 者）。
    by_id: Dict[str, Any] = {}
    for p in raw_list if isinstance(raw_list, list) else []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("project_id") or "")
        if not pid:
            continue
        cur = by_id.get(pid)
        if cur is None:
            by_id[pid] = p
        elif not str(cur.get("team_id") or "") and str(p.get("team_id") or ""):
            by_id[pid] = p
    projects = list(by_id.values())[:_MAX_PROJECTS]

    errors: List[str] = []
    items: List[Dict[str, Any]] = []
    not_deployed = False
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(proj: Dict[str, Any]) -> None:
        nonlocal not_deployed
        pid = str(proj.get("project_id") or "")
        team = proj.get("team_id")
        team_q = (
            f"&team={_quote(team, safe='')}"
            if isinstance(team, str) and team
            else ""
        )
        inc = 1 if include_resolved else 0
        url = (
            f"{base}/api/v1/projects/{_quote(pid, safe='')}"
            f"/attention?include_resolved={inc}&limit=200{team_q}"
        )
        async with sem:
            try:
                st2, data2, _t2 = await worker_status._ctl_get(url, token)
            except Exception as exc:
                errors.append(f"{pid}: {str(exc)[:120]}")
                return
        if st2 == 404:
            # 旧 controller（端点未部署）——整体诚实降级（404 不会触发
            # ctl_client 地址级 failover：确定性 4xx 立即返回）。
            not_deployed = True
            return
        if st2 != 200:
            errors.append(f"{pid}: Controller {st2}")
            return
        payload = data2 if isinstance(data2, dict) else {}
        for it in payload.get("items") or []:
            if not isinstance(it, dict):
                continue
            if not include_resolved and it.get("resolved"):
                continue
            it2 = dict(it)
            it2.setdefault("project_id", str(payload.get("project_id") or pid))
            items.append(it2)

    if projects:
        await asyncio.gather(*(_one(p) for p in projects))

    if not_deployed:
        return {"deployed": False, "items": [], "errors": errors}

    # requested_at 倒序（解析失败的排最后，不伪造）。
    items.sort(key=lambda it: _requested_ts(it.get("requested_at")), reverse=True)
    return {"deployed": True, "items": items, "errors": errors}


def _with_answered(result: Dict[str, Any]) -> Dict[str, Any]:
    """聚合结果 + 本地 answered 状态（UI 去重标记 + 历史段）。

 每项补 ``answered_locally``；顶层补 ``count`` / ``cached`` / ``errors`` /
 ``answered_history``（本地已答记录，answered_at 倒序）。
 """
    answered = _load_answered()
    out_items = []
    for it in result.get("items", []):
        key = _answer_key(it.get("task_id"), it.get("kind"), it.get("attempt"))
        out_items.append({**it, "answered_locally": bool(answered.get(key))})
    history = [
        rec
        for rec in sorted(
            answered.values(),
            key=lambda r: str((r or {}).get("answered_at") or ""),
            reverse=True,
        )
        if isinstance(rec, dict)
    ]
    return {
        "deployed": bool(result.get("deployed", True)),
        "items": out_items,
        "count": len(out_items),
        "errors": list(result.get("errors", [])),
        "cached": bool(result.get("cached", False)),
        "answered_history": history,
    }


async def _find_item(task_id: str, kind: str, attempt: Any) -> Optional[Dict[str, Any]]:
    """定位被回答的原请求（options 校验用）：先查 30s 聚合缓存（未答项
 都在里面），未命中则绕过缓存现扫一次（回答是低频人工动作，成本可接受）。
 找不到 → None（按无 options 处理：自由文本 ≤500）。"""
    hit = _attention_cache.get("0")
    if hit and hit[0] > time.monotonic():
        for it in hit[1].get("items", []):
            if (
                str(it.get("task_id") or "") == task_id
                and str(it.get("kind") or "other") == str(kind or "other")
                and _attempt_eq(it.get("attempt"), attempt)
            ):
                return it
    try:
        result = await _fetch_all(False)
    except HTTPException:
        return None
    for it in result.get("items", []):
        if (
            str(it.get("task_id") or "") == task_id
            and str(it.get("kind") or "other") == str(kind or "other")
            and _attempt_eq(it.get("attempt"), attempt)
        ):
            return it
    return None


# ── 端点 ───────────────────────────────────────────────────────────


class AttentionAnswerRequest(BaseModel):
    """人类身份答回请求（字段 = NMH §8 对齐的答案面）。"""

    room_id: str = ""  # 任务房间（! 开头）；缺失 → 502（定位不到房间）
    task_id: str = ""
    kind: str = "other"
    attempt: int = 1
    answer: str = ""  # 有 options = option id 之一；无 = 自由文本 ≤500
    text: Optional[str] = None  # 可选补充（答案消息的第二行）
    basis: Optional[str] = None  # 可选依据（写入答案消息 ``basis: ...`` 行）


def build_attention_router() -> APIRouter:
    """attention 决策域 router（挂在 /agentteams-proxy 前缀下）。

 固定路径（/attention、/attention/answer）——必须注册在 catch-all
 （approval_api，``/{target}/{path:path}``）之前，否则会被吞。
 """
    router = APIRouter(tags=["attention"])

    @router.get("/attention")
    async def attention_list(include_resolved: int = 0, refresh: int = 0) -> Dict[str, Any]:
        """聚合未答（默认）/全部 attention 项：30s 进程内缓存，refresh=1 绕过。

 controller 404（端点未部署）→ HTTP 200 + ``{"deployed": false, "items": []}``
 （UI 诚实降级：不显示 badge，不报错）；controller 不可用（无 token/
 5xx）→ 502（前端保留旧值/隐藏入口）。
 """
        inc = 1 if int(include_resolved) == 1 else 0
        key = str(inc)
        if not int(refresh):
            hit = _attention_cache.get(key)
            if hit and hit[0] > time.monotonic():
                result = dict(hit[1])
                result["cached"] = True
                return _with_answered(result)
        result = await _fetch_all(inc == 1)
        result["cached"] = False
        _attention_cache[key] = (time.monotonic() + _CACHE_TTL, result)
        return _with_answered(result)

    @router.post("/attention/answer")
    async def attention_answer(req: AttentionAnswerRequest) -> Dict[str, Any]:
        """以人类身份把决策发回任务房间（Matrix 消息，DECISION 行格式）。

 校验链：task_id/answer 必填 → 400；room 缺失 → 502；本地已答（key 命中）
 → 409；有 options 时 answer 必须是 option id 之一 → 否则 400；无 options
 时自由文本 ≤500 → 否则 400；Matrix 发送失败 → 502。成功：写本地记录
 （key=task_id:kind:attempt）+ 返回 event_id。
 """
        from . import config as config_mod
        from . import matrix_client
        from . import router as router_mod

        task_id = (req.task_id or "").strip()
        answer = (req.answer or "").strip()
        if not task_id:
            raise HTTPException(status_code=400, detail="task_id 必填")
        if not answer:
            raise HTTPException(status_code=400, detail="answer 必填")

        room_id = (req.room_id or "").strip()
        if not room_id:
            raise HTTPException(
                status_code=502, detail="未定位到任务房间（room_id 缺失），无法发送回答"
            )

        key = _answer_key(task_id, req.kind, req.attempt)
        with _LOCK:
            if key in _load_answered():
                raise HTTPException(
                    status_code=409, detail="该决策已回答（本地去重拦截）"
                )

        # answer 校验：有 options → option id 之一；无 → 自由文本 ≤500。
        item = await _find_item(task_id, req.kind, req.attempt)
        options = (item or {}).get("options") or []
        option_ids = [
            str(o.get("id") or "")
            for o in options
            if isinstance(o, dict) and o.get("id")
        ]
        if option_ids:
            if answer not in option_ids:
                raise HTTPException(
                    status_code=400,
                    detail=f"answer 必须是该请求的选项之一：{', '.join(option_ids)}",
                )
        elif len(answer) > _MAX_ANSWER_LEN:
            raise HTTPException(
                status_code=400,
                detail=f"自由文本回答不得超过 {_MAX_ANSWER_LEN} 字符",
            )

        # 人类身份发送（Matrix 登录 token = 当前登录人类账号本身）。
        cfg = config_mod.load_config()
        matrix_cfg = cfg.get("matrix") or {}
        token = (matrix_cfg.get("access_token") or "").strip()
        if not token:
            raise HTTPException(
                status_code=401, detail="未登录 Matrix，无法以人类身份回答"
            )
        homeserver = router_mod._pick_address(cfg, "matrix")
        if not homeserver:
            raise HTTPException(status_code=502, detail="未配置 Matrix 地址")

        lines = [f"DECISION: {task_id} → {answer}"]
        text_supplement = (req.text or "").strip()
        if text_supplement:
            lines.append(text_supplement)
        basis = (req.basis or "").strip()
        if basis:
            lines.append(f"basis: {basis}")
        body = "\n".join(lines)

        try:
            result = await asyncio.to_thread(
                matrix_client.send_message, homeserver, token, room_id, body
            )
        except matrix_client.MatrixError as exc:
            raise HTTPException(status_code=502, detail=f"发送回答失败：{exc}") from exc
        except Exception as exc:  # noqa: BLE001 — 网络/超时族 → 502 + 归因
            from . import selfcheck

            raise HTTPException(
                status_code=502,
                detail=f"发送回答失败：{selfcheck._classify_error(exc)}"
                f"{router_mod._pinned_note(cfg)}",
            ) from exc

        answered_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        record = {
            "key": key,
            "task_id": task_id,
            "kind": req.kind,
            "attempt": req.attempt,
            "answer": answer,
            "basis": basis or None,
            "room_id": room_id,
            "answered_at": answered_at,
            "event_id": str((result or {}).get("event_id") or ""),
        }
        with _LOCK:
            entries = _load_answered()
            if key in entries:
                raise HTTPException(
                    status_code=409, detail="该决策已回答（本地去重拦截）"
                )
            entries[key] = record
            _save_answered(entries)
        return {
            "ok": True,
            "key": key,
            "room_id": room_id,
            "event_id": record["event_id"],
            "answered_at": answered_at,
        }

    return router
