# -*- coding: utf-8 -*-
"""KB 域 WSF 兜底通道 + 工作区解析（ctx 携带 per-build 状态 dict）。

自 routers/kb_api.py build_kb_router 原体搬移；_kb_workspace 与
_kb_docker_available 携带 per-build 状态（ws_cache/docker_ok_cache，
装配方 build_router 创建后经 ctx 传入），GatedAsyncClient 经 router_mod
调用时属性读（重绑定可见）。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from .. import config as config_mod
from .. import router as router_mod
from ..router import _headers_for
from .kb_core import _kb_docker, _kb_is_sensitive


async def _kb_workspace(ctx: Dict[str, Any], token: str, base: str, agent: str) -> str:
    """探测 Agent 工作区路径（5min 缓存）。无则 404。"""
    now = time.time()
    hit = ctx["ws_cache"].get(agent)
    # TTL 5min→30min。工作区路径由容器挂载决定、实际不变；
    # 5min 一到期就重付「inspect + 3×HEAD 探测 + archive」4 次串行 Docker
    # API 往返（经 Controller 代理）， 图谱「点好多次才打开」的
    # 后端侧贡献项之一。
    if hit and now - hit["ts"] < 1800:
        return hit["ws"]
    container = (
        "agentteams-manager" if agent == "manager"
        else f"agentteams-worker-{agent}"
    )
    # 修：Controller Docker 代理不转 HEAD /containers/{name}/json
    # （实测 HEAD=404 / GET=200 / HEAD archive=200）——改用 GET
    # 探存在性，候选路径探测仍走 HEAD archive（可用）。
    st, _ = await _kb_docker(
        token, base, f"/containers/{container}/json", head=False
    )
    if st == 404:
        raise HTTPException(status_code=404, detail=f"容器 {container} 不存在")
    home = f"/root/agentteams-fs/agents/{agent}"
    candidates = (
        f"{home}/.qwenpaw/workspaces/default",  # qwenpaw runtime
        f"{home}/.copaw/workspaces/default",  # copaw runtime
        home,  # copaw openclaw（memory/ 在顶层）
    )
    # （用户真机：子目录文件看不见 + 图谱节点缺失）：manager
    # 是特例——live 工作区在 /root/manager-workspace（HOME 挂载），而
    # MinIO 镜像目录只有 agent.json stub（最小）。实测：
    # stub=最小 tar（仅 agent.json）；live=完整工作区（记忆/摘要/协议文档等子目录）。
    # manager 优先探
    # live，探不到再回退 MinIO 候选。
    if agent == "manager":
        candidates = (
            "/root/manager-workspace/.qwenpaw/workspaces/default",
        ) + candidates
    import urllib.parse as _up
    # 候选路径探测并行（原串行——4 个候选最坏 4×40s 超时；
    # 并行后最坏 1×40s）。结果按候选优先级取第一个命中。
    import asyncio as _aio
    async def _probe(cand: str) -> int:
        st, _ = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(cand)}",
            head=True,
        )
        return st
    results = await _aio.gather(
        *[_probe(c) for c in candidates], return_exceptions=True
    )
    for cand, st in zip(candidates, results):
        if isinstance(st, int) and st in (200, 304):
            ctx["ws_cache"][agent] = {"ws": cand, "ts": now}
            return cand
    ctx["ws_cache"].pop(agent, None)
    raise HTTPException(
        status_code=404, detail="未找到工作区目录（容器可能仍在启动中）"
    )


# ── #1208 workspace-files 兜底数据面（L2 team-scoped / Docker 不可用）──
# 上游 #1208：GET /api/v1/workers/{name}/workspace-files/{sub}，
# sub∈{tree,file-metadata,file-content,file-download}，allowlist=
# MEMORY.md+memory/+digest/（controller 固定 root=workspace）。仅 Worker
# （无 manager 端点）。L2 可读本团队 Worker；跨团队→404（W8）；旧
# Controller（未合 #1208）→404（路由未注册）。tree limit≤500/默认 200；
# file-content limit≤1MB/默认 256KB；path≤4 段。
_KB_WSF_MAX_DEPTH = 2  # memory/ 或 digest/ 下最多再下探 2 层（path≤4 段）
_KB_WSF_MAX_FILES = 300  # 单分类文件数上限（防大工作区拖死）
_KB_WSF_MAX_READ = 512 * 1024  # 单文件返回上限（与 Docker 通道 _KB_MAX_FILE 一致）


async def _wsf_get(token: str, base: str, agent: str, sub: str,
                   params: Optional[Dict[str, str]]) -> tuple:
    """GET /api/v1/workers/{agent}/workspace-files/{sub}?params。
 返回 (status_code, 解析后 JSON dict|bytes)。"""
    import httpx as _h
    import urllib.parse as _up
    url = (
        f"{base}/api/v1/workers/{agent}"
        f"/workspace-files/{sub}"
    )
    if params:
        url += "?" + _up.urlencode(params)
    async with router_mod.GatedAsyncClient(timeout=30.0, verify=False) as client:
        r = await client.get(url, headers=_headers_for(config_mod.load_config(),
                                "controller", base, {"Authorization": f"Bearer {token}"}))
    try:
        return r.status_code, r.json()
    except Exception:  # noqa: BLE001
        return r.status_code, r.content


def _wsf_mtime(iso: Optional[str]) -> int:
    """ISO modified_at → epoch 秒（解析失败→0，与 Docker 通道 mtime 同量级）。"""
    import datetime as _dt
    if not iso:
        return 0
    try:
        return int(_dt.datetime.fromisoformat(
            iso.replace("Z", "+00:00")).timestamp())
    except Exception:  # noqa: BLE001
        return 0


async def _wsf_tree_files(token: str, base: str, agent: str,
                          root_dir: str) -> List[Dict[str, Any]]:
    """#1208 tree：递归列 root_dir（memory/digest）下文件，带界。
 返回 [{path(工作区相对),name,size,mtime}]。path 形如 memory/2026-08-29.md。"""
    out: List[Dict[str, Any]] = []

    async def _walk(dir_path: str, depth: int) -> None:
        if depth > _KB_WSF_MAX_DEPTH or len(out) >= _KB_WSF_MAX_FILES:
            return
        cursor: Optional[str] = None
        while True:
            params: Dict[str, str] = {"path": dir_path, "limit": "200"}
            if cursor:
                params["cursor"] = cursor
            st, data = await _wsf_get(token, base, agent, "tree", params)
            if st != 200 or not isinstance(data, dict):
                return
            for e in (data.get("entries") or []):
                if len(out) >= _KB_WSF_MAX_FILES:
                    return
                kind = e.get("kind")
                p = str(e.get("path") or "")
                name = str(e.get("name") or (p.rsplit("/", 1)[-1] if p else ""))
                if not p or _kb_is_sensitive(name, p):
                    continue
                if kind == "directory":
                    if depth < _KB_WSF_MAX_DEPTH:
                        await _walk(p, depth + 1)
                else:
                    out.append({
                        "path": p, "name": name,
                        "size": int(e.get("size") or 0),
                        "mtime": _wsf_mtime(e.get("modified_at")),
                    })
            if data.get("has_more") and data.get("next_cursor"):
                cursor = str(data["next_cursor"])
            else:
                break

    await _walk(root_dir, 1)
    return out


async def _wsf_read_file(token: str, base: str, agent: str,
                         path: str) -> Optional[tuple]:
    """#1208 file-content：分块读到 eof（≤_KB_WSF_MAX_READ）。
 成功→(size, text)；不存在/非文本/超限→None。"""
    offset = 0
    chunks: List[str] = []
    total = 0
    while total < _KB_WSF_MAX_READ:
        st, data = await _wsf_get(token, base, agent, "file-content", {
            "path": path, "offset": str(offset), "limit": "262144",
        })
        if st != 200 or not isinstance(data, dict):
            return None
        chunk = data.get("content") or ""
        chunks.append(chunk)
        total += len(chunk)
        if data.get("eof"):
            break
        offset = int(data.get("next_offset") or offset)
    text = "".join(chunks)
    return (total, text)


async def _kb_tree_wsf_fallback(token: str, base: str, agent: str) -> Dict[str, Any]:
    """#1208 兜底树（L2 / Docker 不可用，worker only）：三分类=
 memory/**（日记）+ digest/**（知识库）+ MEMORY.md（档案）。
 非 MEMORY.md 的档案文件 + 文件分类不在 #1208 allowlist → 不渲染
 （L1-only 数据，前端按 dirs=[] 优雅降级）。"""
    files: List[Dict[str, Any]] = []
    for e in await _wsf_tree_files(token, base, agent, "memory"):
        files.append({**e, "category": "daily"})
    for e in await _wsf_tree_files(token, base, agent, "digest"):
        files.append({**e, "category": "digest"})
    st, meta = await _wsf_get(token, base, agent, "file-metadata",
                              {"path": "MEMORY.md"})
    if st == 200 and isinstance(meta, dict):
        files.append({
            "path": "MEMORY.md", "name": "MEMORY.md",
            "size": int(meta.get("size") or 0),
            "mtime": _wsf_mtime(meta.get("modified_at")),
            "category": "profile",
        })
    keep = [
        f for f in files
        if f["path"].lower().endswith(
            (".md", ".txt", ".yaml", ".yml", ".json"))
    ][:300]
    cat_order = {"profile": 0, "daily": 1, "digest": 2, "file": 3}
    keep.sort(key=lambda f: (cat_order.get(f.get("category", "file"), 3),
                             f["path"]))
    return {
        "agent": agent,
        "workspace": "(controller #1208)",
        "source": "controller",
        "files": keep, "dirs": [], "count": len(keep),
    }


_KB_DOCKER_OK_TTL = 30.0

async def _kb_docker_available(ctx: Dict[str, Any], token: str, base: str, container: str) -> bool:
    import time as _time
    now = _time.time()
    cached = ctx["docker_ok_cache"].get(container)
    if cached and (now - cached[1]) < _KB_DOCKER_OK_TTL:
        return cached[0]
    try:
        st, _ = await _kb_docker(
            token, base, f"/containers/{container}/json", timeout=15.0,
        )
        ok = st not in (401, 403)
    except HTTPException:
        ok = False
    ctx["docker_ok_cache"][container] = (ok, now)
    return ok


def _wsf_in_allowlist(path: str) -> bool:
    """#1208 allowlist：MEMORY.md 单文件 + memory/** + digest/**。"""
    if path == "MEMORY.md":
        return True
    return path.startswith("memory/") or path.startswith("digest/")

async def _kb_ls_wsf_fallback(token: str, base: str, agent: str,
                              dir: str) -> Dict[str, Any]:
    """#1208 兜底懒加载（L2/docker 不可用，worker only）。
 dir=""→顶层（memory/ + digest/ + MEMORY.md）；dir 在 memory/**|digest/**
 内→该层 tree；其它目录（协议文档等）→404（不在 #1208 allowlist）。"""
    text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
    if dir == "":
        dirs_out: List[Dict[str, Any]] = []
        files_out: List[Dict[str, Any]] = []
        for root in ("memory", "digest"):
            st, data = await _wsf_get(
                token, base, agent, "tree", {"path": root, "limit": "1"})
            if st == 200 and isinstance(data, dict):
                dirs_out.append(
                    {"path": root, "name": root, "isdir": True})
        st, meta = await _wsf_get(
            token, base, agent, "file-metadata", {"path": "MEMORY.md"})
        if st == 200 and isinstance(meta, dict):
            files_out.append({
                "path": "MEMORY.md", "name": "MEMORY.md",
                "size": int(meta.get("size") or 0),
                "mtime": _wsf_mtime(meta.get("modified_at")),
                "category": "profile",
            })
        return {"agent": agent, "dir": dir,
                "files": files_out, "dirs": dirs_out}
    if not (dir == "memory" or dir == "digest"
            or dir.startswith("memory/") or dir.startswith("digest/")):
        raise HTTPException(status_code=404, detail=f"目录不存在：{dir}")
    if len(dir.split("/")) > 3:
        raise HTTPException(status_code=404, detail=f"目录不存在：{dir}")
    st, data = await _wsf_get(
        token, base, agent, "tree", {"path": dir, "limit": "200"})
    if st != 200 or not isinstance(data, dict):
        raise HTTPException(status_code=404, detail=f"目录不存在：{dir}")
    files_out = []
    dirs_out = []
    for e in (data.get("entries") or []):
        name = str(e.get("name") or "")
        p = str(e.get("path") or "")
        if not p or _kb_is_sensitive(name, p):
            continue
        if e.get("kind") == "directory":
            dirs_out.append({"path": p, "name": name, "isdir": True})
        elif name.lower().endswith(text_ok):
            files_out.append({
                "path": p, "name": name,
                "size": int(e.get("size") or 0),
                "mtime": _wsf_mtime(e.get("modified_at")),
                "category": "file",
            })
    files_out.sort(key=lambda f: f["path"])
    dirs_out.sort(key=lambda d: d["path"])
    return {"agent": agent, "dir": dir,
            "files": files_out[:300], "dirs": dirs_out[:120]}
