# -*- coding: utf-8 -*-
"""团队共享文件列取/单文件读取（#87 聊天引用工作区文件 · 数据面）。

数据通道与 KB 域同源（零新端点、零新凭据、零服务器侧改动）：
Controller Docker API 反向代理（GET/HEAD 恒放行；POST exec allowlist）
× Controller 管理员 token（L1）。

- team→容器：GET /api/v1/workers（team 字段，TTL 缓存）→ 取团队任一
  worker（shared 对全团队成员是同一 MinIO 路径，任一成员容器都是合法
  exec/archive 目标）。A0 探针实锤（2026-11，见 state/qc-task-163）：
  全部 worker 存在 $HOME/.qwenpaw/workspaces/default/shared，
  find -H -maxdepth 1 可列，archive?path=<abs> 可读。
- 列取：复用 _kb_find_list（find -H <shared>/<prefix> -maxdepth 1，
  零下载）——与 KB tree/ls 主通道同一语义。
- 单文件：复用 _kb_docker archive?path=<shared>/<key>（tar 单条目
  读，_kb_tar_entries 解析）——与 KB 文件直读同通道。
- 敏感过滤复用 _kb_is_sensitive（credentials/ 与 credentials.yaml、
  .lock 等 dashboard SENSITIVE_PATTERNS 对齐清单）+ 隐藏项不入列
 （KB 惯例）；敏感直读返 404（不泄露存在性，W8 反探测同款）。
- 作用域与审批/技能矩阵同款 scoped 语义：L1（admin token）任意
  team 可达；L2（非 admin token）Docker 网关 403 → 诚实 403 透传
 （Controller 无 team-scoped 共享文件 API，L2 无数据通道——不做
 假兜底）。
- team 名 / 路径段校验与 dashboard isValidNameSegment 同款
 （段=字母数字开头 + [A-Za-z0-9._-]*，禁点段/斜杠）→ 路径穿越
 结构上不可达。
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..router import _ctl_json

# 路径段校验（dashboard isValidNameSegment 同款：非空、非点段、
# 无斜杠、字母数字开头、余部 [A-Za-z0-9._-]*）。
_TF_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _tf_valid_segment(seg: str) -> bool:
    if not seg or seg in (".", ".."):
        return False
    if "/" in seg or "\\" in seg:
        return False
    return bool(_TF_SEGMENT_RE.match(seg))


def _tf_valid_relpath(p: str) -> bool:
    """相对路径（shared 根内）逐段校验；空串=根，合法。"""
    if not p:
        return True
    return all(_tf_valid_segment(s) for s in p.split("/"))


_TF_WORKERS_TTL = 60.0     # team→workers 正缓存
_TF_WORKERS_NEG_TTL = 10.0  # 负缓存（Controller 抖动不阻塞 60s）
_TF_PROBE_TTL = 30.0       # 容器 Docker 通道三态缓存
_TF_SHARED_TTL = 1800.0    # 容器内 shared 根探测缓存（与 _kb_ws_cache 同 TTL）


def build_team_files_router(
        kb_shared: Dict[str, Any], state: Dict[str, Any]) -> APIRouter:
    """team-files/team-file 域子路由。

    kb_shared=KB builder 导出的共享 helper（装配方传入，跨域不重复
    定义）；state=可变状态（probe/shared/workers 缓存），由装配方
    build_router 创建显式传入（build_router 每建一次全新——测试
    隔离随之成立）。"""
    router = APIRouter()

    _kb_require_token = kb_shared["require_token"]
    _kb_docker = kb_shared["docker"]
    _kb_exec_full = kb_shared["exec_full"]
    _kb_find_list = kb_shared["find_list"]
    _kb_is_sensitive = kb_shared["is_sensitive"]
    _kb_tar_entries = kb_shared["tar_entries"]
    _TF_MAX_FILE = kb_shared["max_file"]

    # ── team→workers（GET /api/v1/workers 的 team 字段分组）──────
    async def _tf_team_workers(token: str) -> tuple:
        """→ (team→[worker 名], 取数是否成功)。

 失败（无地址/全败）→ ({}, False)：调用方须区分「team 不存在」
 （取数成功但无该 team → 404）与「取数失败」（→ 502 诚实提示）。
 短 TTL 负缓存——Controller 抖动窗口内不逐请求重拨。"""
        now = time.time()
        ent = state["workers"]
        if ent["data"] is not None and now - ent["ts"] < _TF_WORKERS_TTL:
            return ent["data"], True
        if ent["data"] is None and now - ent["ts"] < _TF_WORKERS_NEG_TTL:
            return {}, False
        st, data, _text = await _ctl_json("GET", "/api/v1/workers", token)
        team_workers: Dict[str, List[str]] = {}
        ok = st == 200
        if ok:
            ws = data if isinstance(data, list) else (
                (data or {}).get("workers") or (data or {}).get("items") or []
            )
            for w in ws:
                if not isinstance(w, dict):
                    continue
                name = str(w.get("name") or "")
                team = str(w.get("team") or "")
                if name and team:
                    team_workers.setdefault(team, []).append(name)
        state["workers"] = {"data": team_workers if ok else None, "ts": now}
        return (team_workers if ok else {}), ok

    # ── 容器 Docker 通道三态探针（ok/forbidden/missing/down）────
    async def _tf_probe(token: str, base: str, container: str) -> str:
        """GET /containers/{c}/json → ok | forbidden(L2 403/401)
 | missing(404) | down(其余/超时)。30s 缓存——L2 恒 403、
 Docker 挂恒 502 的通道不逐请求重探（与 _kb_docker_available
 同 TTL 语义，本端点需区分 403 与 502 故不直接复用其布尔）。"""
        now = time.time()
        cached = state["probe"].get(container)
        if cached and now - cached[1] < _TF_PROBE_TTL:
            return cached[0]
        try:
            st, _ = await _kb_docker(
                token, base, f"/containers/{container}/json", timeout=15.0)
        except HTTPException:
            st = 502
        if st in (401, 403):
            res = "forbidden"
        elif st == 404:
            res = "missing"
        elif st == 200:
            res = "ok"
        else:
            res = "down"
        state["probe"][container] = (res, now)
        return res

    _L2_403_DETAIL = (
        "团队共享文件需要 Controller 管理员 token（L1）；"
        "当前 token 无 Docker 网关权限（L2 无共享文件读取通道）"
    )

    # ── team→可用容器（逐 worker 探，首个 ok 者）────────────────
    async def _tf_pick_container(token: str, base: str, team: str) -> str:
        team_workers, ok = await _tf_team_workers(token)
        if not ok:
            raise HTTPException(
                status_code=502, detail="团队结构取数失败（Controller API 不可用）")
        cands = team_workers.get(team) or []
        if not cands:
            raise HTTPException(
                status_code=404, detail=f"Team「{team}」不存在或无 worker 容器")
        last: str = "down"
        for w in cands:
            c = f"agentteams-worker-{w}"
            res = await _tf_probe(token, base, c)
            if res == "ok":
                return c
            last = res
        if last == "forbidden":
            raise HTTPException(status_code=403, detail=_L2_403_DETAIL)
        if last == "missing":
            raise HTTPException(
                status_code=502, detail="该团队 worker 容器均不存在（未部署或已回收）")
        raise HTTPException(
            status_code=502,
            detail="容器 API 响应超时——Docker daemon 对该容器无响应")

    # ── 容器内 shared 根探测（$HOME 三候选，首个存在者）──────────
    _TF_SHARED_CANDIDATES = (
        "$HOME/.qwenpaw/workspaces/default/shared",
        "$HOME/.copaw/workspaces/default/shared",
        "$HOME/shared",
    )

    async def _tf_shared_of(token: str, base: str, container: str) -> Optional[str]:
        now = time.time()
        cached = state["shared"].get(container)
        if cached and now - cached[1] < _TF_SHARED_TTL:
            return cached[0]
        script = (
            "for c in " + " ".join(_TF_SHARED_CANDIDATES)
            + '; do [ -e "$c" ] && echo "$c" && break; done'
        )
        out = await _kb_exec_full(
            token, base, container, ["sh", "-c", script], timeout=60.0)
        if out is None:
            return None
        for line in out.splitlines():
            ln = line.strip()
            # 只认真路径（$ 开头=未展开的 shell 变量行，跳过）。
            if ln and not ln.startswith("$") and ln.startswith("/"):
                state["shared"][container] = (ln, now)
                return ln
        return None

    # ── GET /team-files?team=<name>&prefix=<p> ─────────────────
    # 列取 teams/{team}/shared/<p> 一层（非递归）→
    # [{name, key, isPrefix, size}]（key 相对 shared 根）。
    @router.get("/team-files")
    async def team_files_list(team: str = "", prefix: str = "") -> List[Dict[str, Any]]:
        token, base = _kb_require_token()
        if not _tf_valid_segment(team):
            raise HTTPException(status_code=400, detail="非法 team 名")
        norm_prefix = (prefix or "").strip("/")
        if not _tf_valid_relpath(norm_prefix):
            raise HTTPException(status_code=400, detail="非法路径")
        container = await _tf_pick_container(token, base, team)
        shared = await _tf_shared_of(token, base, container)
        if shared is None:
            raise HTTPException(
                status_code=502, detail="worker 容器内团队共享目录不可达")
        target = shared if not norm_prefix else f"{shared}/{norm_prefix}"
        entries = await _kb_find_list(token, base, container, target, maxdepth=1)
        if entries is None:
            # find 通道失败：容器 404 已被前置探针挡下，此处=
            # Docker 执行通道异常（exec 403/502 或超时）。
            if await _tf_probe(token, base, container) == "forbidden":
                raise HTTPException(status_code=403, detail=_L2_403_DETAIL)
            raise HTTPException(
                status_code=502, detail="团队文件列取失败（Docker 通道不可用）")
        out: List[Dict[str, Any]] = []
        seen: set = set()
        for e in entries:
            rel = e["rel"]
            if not rel or rel.startswith("."):
                continue  # 目标目录自身行 + 隐藏项（KB 惯例）
            key = f"{norm_prefix}/{rel}" if norm_prefix else rel
            name = rel.rsplit("/", 1)[-1]
            if key in seen or _kb_is_sensitive(name, key):
                continue
            seen.add(key)
            out.append({
                "name": name,
                "key": key,
                "isPrefix": e["type"] in ("d", "l"),
                "size": e["size"] if e["type"] == "f" else 0,
            })
        out.sort(key=lambda x: (0 if x["isPrefix"] else 1, x["name"].lower()))
        return out

    # ── GET /team-file?team=<name>&key=<k> ──────────────────────
    # 单文件文本预览；敏感 404（反探测）/ 不存在 404 / 二进制 415 /
    # 超 512KB 413（_KB_MAX_FILE 同源上限）。
    @router.get("/team-file")
    async def team_file_read(team: str = "", key: str = "") -> Response:
        token, base = _kb_require_token()
        if not _tf_valid_segment(team):
            raise HTTPException(status_code=400, detail="非法 team 名")
        norm_key = (key or "").strip("/")
        if not norm_key or not _tf_valid_relpath(norm_key):
            raise HTTPException(status_code=400, detail="非法文件路径")
        name = norm_key.rsplit("/", 1)[-1]
        if _kb_is_sensitive(name, norm_key):
            # 敏感直读 404（不泄露存在性，KB W8 同款）。
            raise HTTPException(status_code=404, detail="文件不存在")
        container = await _tf_pick_container(token, base, team)
        if await _tf_probe(token, base, container) == "forbidden":
            raise HTTPException(status_code=403, detail=_L2_403_DETAIL)
        shared = await _tf_shared_of(token, base, container)
        if shared is None:
            raise HTTPException(
                status_code=502, detail="worker 容器内团队共享目录不可达")
        target = f"{shared}/{norm_key}"
        st, data = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={quote(target)}",
            timeout=60.0,
        )
        if st in (400, 404):
            raise HTTPException(status_code=404, detail="文件不存在或已删除")
        if st in (401, 403):
            raise HTTPException(status_code=403, detail=_L2_403_DETAIL)
        if st not in (200, 304):
            raise HTTPException(
                status_code=502, detail=f"文件读取失败（Docker API {st}）")
        entries = await asyncio.to_thread(_kb_tar_entries, data)
        file_entry = next(
            (e for e in entries if not e.get("isdir")), None)
        if file_entry is None or file_entry.get("size", 0) > _TF_MAX_FILE:
            if file_entry is not None:
                raise HTTPException(
                    status_code=413,
                    detail=f"文件超过 {_TF_MAX_FILE // 1024}KB，无法预览")
            raise HTTPException(status_code=404, detail="文件不存在或已删除")
        # tar 解析只给 size——实际字节从 tar 取（单条目）。
        payload = _tf_tar_member_bytes(data, name)
        if payload is None:
            raise HTTPException(status_code=404, detail="文件不存在或已删除")
        if len(payload) > _TF_MAX_FILE:
            raise HTTPException(
                status_code=413,
                detail=f"文件超过 {_TF_MAX_FILE // 1024}KB，无法预览")
        # 二进制判定：头部 8KB 含 NUL 或 UTF-8 解码失败 → 415。
        if b"\x00" in payload[:8192]:
            raise HTTPException(status_code=415, detail="二进制文件不支持文本预览")
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status_code=415, detail="二进制文件不支持文本预览")
        return Response(content=text, media_type="text/plain; charset=utf-8")

    def _tf_tar_member_bytes(data: bytes, top_name: str) -> Optional[bytes]:
        """单条目 archive tar → 成员字节（同步，调用方 to_thread 包裹；
 此处调用点在 to_thread 解析之后的轻量路径——tar 已 ≤512KB+头部，
 直接同步解一次可接受）。"""
        import io as _io
        import tarfile as _tf
        try:
            with _tf.open(fileobj=_io.BytesIO(data), mode="r:*") as tf:
                for m in tf.getmembers():
                    if m.name.replace("\\", "/").rsplit("/", 1)[-1] == top_name \
                            and m.isfile():
                        f = tf.extractfile(m)
                        return f.read() if f else None
        except Exception:  # noqa: BLE001 - tar 损坏按不存在处理
            return None
        return None

    return router
