# -*- coding: utf-8 -*-
"""KB 域路由注册 + SWR 计算体/探针/共享装配（工厂）。

下方嵌套 helper 原为 routers/kb_api.py build_kb_router 体内的嵌套闭包，
逐字搬入 build_kb_routes 工厂函数（函数体未改）。纯数据通道 helper 在
kb_core.py，WSF 兜底通道在 kb_workspace.py，SWR 刷新/存储入口在
kb_refresh.py；3 个 per-build 可变状态经 ctx 参数传入（装配方
build_router 创建）。
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from .. import config as config_mod
from .. import kb_cache
from .. import router as router_mod
from ..router import (
    _ctl_json,
    _headers_for,
    _kb_agents_cache,
    _kb_apply_runtime_fields,
    _kb_file_cache,
    _kb_graph_cache,
    _kb_merged_cache,
    _kb_tree_cache,
)
from .kb_core import (
    _KB_AGENT_RE,
    _KB_BATCH_MAX_PATHS,
    _KB_GRAPH_FILE_CAP,
    _KB_MAX_FILE,
    _KB_MAX_GRAPH_FILES,
    _KB_MAX_TAR,
    _KB_PROFILE_FILES,
    _kb_docker,
    _kb_exec_full,
    _kb_find_list,
    _kb_files_batch_read,
    _kb_is_sensitive,
    _kb_parse_find_lines,
    _kb_parse_profile_lines,
    _kb_require_token,
    _kb_tar_entries,
    _kb_tar_list,
    _kb_tree_merged_probe,
)
from .kb_refresh import (
    _kb_prewarm_last,
    _kb_probe_signature,
    _kb_swr_ttl_now,
    _spawn_kb_refresh,
    _store_kb,
)
from .kb_workspace import (
    _kb_docker_available,
    _kb_ls_wsf_fallback,
    _kb_tree_wsf_fallback,
    _kb_workspace,
    _wsf_in_allowlist,
    _wsf_read_file,
)


def build_kb_routes(router: APIRouter, ctx: Dict[str, Any]) -> tuple:
    """在给定 router 上注册 KB 域 8 条路由。

    返回 (prewarm_hooks, probe_hooks, _kb_shared)：SWR 计算体/刷新入口/
    轻探针交装配方注册入 router 模块级表（调用时解析）；_kb_shared
    交 approval 域。
    """
    async def _kb_agents_ctl_fallback(token: str, base: str) -> Dict[str, Any]:
        """KB 形状兜底（Docker 通道不可用）：agent 清单=Controller workers API。

 ：/kb/agents 的 Docker 降级路径此前误调
 _approval_list_wsf(token, base, agent)——agent 在 kb_agents 作用域
 不存在 → NameError → 500（Docker 通道 401/403/502 即触发：切外网后
 WAN 链路 401 首现）。形状必须 KB {agents, count}（旧调用即便不
 NameError 也返回 approval 形状，前端解析全废）。
 """
        st, data, _ = await _ctl_json("GET", f"{base}/api/v1/workers", token)
        if st != 200:
            raise HTTPException(
                status_code=502, detail=f"Worker 列表获取失败（Controller {st}）"
            )
        workers = (data.get("workers") or []) if isinstance(data, dict) else []
        found: Dict[str, Dict[str, Any]] = {}
        for w in workers:
            if not isinstance(w, dict):
                continue
            wn = str(w.get("name") or "")
            if not wn:
                continue
            role_raw = str(w.get("role") or "worker")
            found[wn] = {
                "name": wn,
                "container": f"agentteams-worker-{wn}",
                "state": str(w.get("state") or w.get("phase") or ""),
                "kind": "worker",
                "team": str(w.get("team") or ""),
                "role": (
                    "leader" if role_raw == "team_leader"
                    else "critic" if "critic" in wn.lower()
                    else "worker"
                ),
            }
        # runtime 判定字段与主（Docker）
        # 路径同批透传——共用 _kb_apply_runtime_fields 单一实现（E2E
        # 实锤：本部署 Docker 通道不可用 → 全量走本兜底路径）。
        _kb_apply_runtime_fields(found, workers)
        found["manager"] = {
            "name": "manager",
            "container": "agentteams-manager",
            "state": "",
            "kind": "manager",
            "team": "",
            "role": "leader",
        }
        agents = sorted(
            found.values(),
            key=lambda a: (
                0 if a.get("role") == "leader" else 1,
                str(a.get("team") or ""),
                a["name"],
            ),
        )
        return {"agents": agents, "count": len(agents)}


    @router.get("/kb/agents")
    async def kb_agents() -> Dict[str, Any]:
        """远端 Agent 清单：Docker 容器列表（agentteams-worker-* +
 agentteams-manager）+ Controller workers API 补 role/team。"""
        # SWR——60s 内存门 + 磁盘门（旧值
        # 秒回、cached/age 提示），冷取 = 原全量清单（抽为 _kb_agents_compute）。
        _c = _kb_agents_cache.get("agents")
        if _c and _c[0] > time.monotonic():
            _kb_prewarm_last(_c[1])
            return _c[1]
        _disk = kb_cache.load("agents")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh(ctx, "agents", "")
            _resp = {**_payload, "cached": True, "age": int(_age)}
            _kb_prewarm_last(_resp)
            return _resp
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (router_mod._KB_PREWARM_HOOKS.get("agents")
                          or _kb_agents_compute)()
        _store_kb("", _payload, "agents")
        _kb_prewarm_last(_payload)
        return _payload

    async def _kb_agents_compute() -> Dict[str, Any]:
        # kb_agents 冷取计算体——原端点体逐字搬移
        # （原体无缓存写，抽取零 diff；缓存写收口在调用点 _store_kb）。
        token, base = _kb_require_token()
        # L2（403）/ Docker 挂（502）→ KB 形状兜底（worker 走 Controller；
        # manager L1-only 占位）。：旧代码误调
        # _approval_list_wsf(token, base, agent)——本函数无 agent 变量 →
        # NameError → 500（仅 Docker 通道降级 401/403/502 时暴露，切外网后
        # WAN 链路 401 首现），且 approval 列表形状 ≠ KB {agents,count}。
        try:
            st, data = await _kb_docker(token, base, "/containers/json")
        except HTTPException:
            return await _kb_agents_ctl_fallback(token, base)
        if st in (401, 403, 502):
            return await _kb_agents_ctl_fallback(token, base)
        if st != 200:
            raise HTTPException(
                status_code=502, detail=f"容器列表获取失败（Docker API {st}）"
            )
        import json as _json
        try:
            containers = _json.loads(data or b"[]")
        except Exception:  # noqa: BLE001
            containers = []
        found: Dict[str, Dict[str, Any]] = {}
        for c in containers:
            name = (c.get("Names") or [""])[0].lstrip("/")
            if name == "agentteams-manager":
                found["manager"] = {
                    "name": "manager", "container": name,
                    "state": c.get("State") or "", "kind": "manager",
                }
            elif name.startswith("agentteams-worker-"):
                wn = name[len("agentteams-worker-"):]
                if wn:
                    found[wn] = {
                        "name": wn, "container": name,
                        "state": c.get("State") or "", "kind": "worker",
                    }
        # Controller workers API 补 role/team（失败降级=只有 name）。
        try:
            import httpx as _h
            async with router_mod.GatedAsyncClient(timeout=8.0, verify=False) as client:
                resp = await client.get(
                    f"{base}/api/v1/workers",
                    headers=_headers_for(config_mod.load_config(), "controller", base,
                                {"Authorization": f"Bearer {token}"}),
                )
            if resp.status_code == 200:
                payload = resp.json()
                workers = payload if isinstance(payload, list) else payload.get("workers", [])
                for w in workers:
                    wn = str(w.get("name") or "")
                    if wn in found:
                        found[wn]["team"] = str(w.get("team") or "")
                        role_raw = str(w.get("role") or "worker")
                        found[wn]["role"] = (
                            "leader" if role_raw == "team_leader"
                            else "critic" if "critic" in wn.lower()
                            else "worker"
                        )
                # runtime 判定字段同批
                # 透传（KB 面按 runtime 降级空态 + legacy 角标）——与
                # ctl 兜底路径共用 _kb_apply_runtime_fields 单一实现。
                _kb_apply_runtime_fields(found, workers)
        except Exception:  # noqa: BLE001 — role/team 补全失败不致命
            pass
        agents = sorted(
            found.values(),
            key=lambda a: (0 if a.get("role") == "leader" else 1,
                           str(a.get("team") or ""), a["name"]),
        )
        return {"agents": agents, "count": len(agents)}

    @router.get("/kb/{agent}/tree")
    async def kb_tree(agent: str) -> Dict[str, Any]:
        """知识库文件清单：工作区顶层知识文件 + memory/ 全子树（文本过滤）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        # tree 结果短 TTL 命中（重复访问零容器读）。
        _c = _kb_tree_cache.get(agent)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        # SWR 磁盘缓存——有旧数据先秒回
        # （cached/age 提示），超 TTL 触发后台单飞刷新；无则同步冷取。
        _disk = kb_cache.load(f"tree-{agent}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh(ctx, "tree", agent)
            kb_cache.save("last-agent", {"agent": agent})
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (router_mod._KB_PREWARM_HOOKS.get("tree")
                          or _kb_tree_compute)(agent)
        _store_kb(agent, _payload, "tree")
        return _payload

    async def _kb_tree_compute(agent: str) -> Dict[str, Any]:
        # tree 冷取计算体——原端点「缓存门之后」
        # 逐字搬移（原尾内存缓存写移至调用点 _store_kb，14.7「WSF 兜底早退
        # 不缓存」语义在 _store_kb 入口单点保留）。
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 预探（worker only）：Docker 通道可用性。L2 token → 403（ActionGateway）/
        # Docker 挂 → 502 → 切 #1208 兜底（三分类，本团队 scope）；Manager 无
        # #1208 端点 → 走原错误路径（L1 only）。
        if agent != "manager":
            if not await _kb_docker_available(ctx, token, base, container):
                return await _kb_tree_wsf_fallback(token, base, agent)
        ws = await _kb_workspace(ctx, token, base, agent)
        import urllib.parse as _up
        # （用户要求对齐 QwenPaw 最新版文件管理）：四分类——
        # 档案 = 6 个默认 workspace markdown（QwenPaw console
        # defaultWorkspaceMarkdown 同款清单，_KB_PROFILE_FILES——
        # K2 合并探测 stat 段共用）；日记 = memory/**
        # （daily section）；知识库 = digest/**（digest section）；
        # 文件 = 其余顶层文件 + 顶层目录（只列不展开，文本可点开）。
        files: List[Dict[str, Any]] = []
        dirs: List[Dict[str, Any]] = []
        seen: set = set()

        async def _add_entries(
            data: bytes, prefix: str, category: str,
        ) -> None:
            # 路径修：tar 目录请求返回相对路径（memory/ 下文件=
            # "2026-08-29.md"），而 /kb/{a}/file 按 {ws}/{path} 直读——
            # 早期版本起 tree 返回相对路径导致日记/digest 文件点开必 404
            # （此前被「容器不存在」404 掩盖，用户未走到点开那步）。
            # 此处统一拼回工作区相对全路径。
            for e in await asyncio.to_thread(_kb_tar_entries, data):
                rel = e["path"]
                p = f"{prefix}/{rel}" if rel else prefix
                if _kb_is_sensitive(e["name"] or p.rsplit("/", 1)[-1], p):
                    continue  # 敏感文件过滤（dashboard SENSITIVE_PATTERNS 对齐）
                if p in seen:
                    continue
                seen.add(p)
                files.append(
                    {"path": p, "name": e["name"] or p.rsplit("/", 1)[-1],
                     "size": e["size"], "mtime": e["mtime"],
                     "category": category, "openable": True}
                )

        # ① 顶层：档案（6 默认 md）+ 文件（其余文件 + 目录条目）。
        # 双通道：exec find 主（零下载，manager/worker 统一）
        # + tar 兜底（小工作区精确解析）。旧 worker 支整树 tar 在大工作区
        # （实测 180MB）必 413；旧 manager 支 exec-only 无兜底——同批处理。
        # 先试合并探测（1 exec = 顶层 +
        # memory + digest 三个 find + 六档案 stat 段）；通道挂（None）/
        # 无收尾标记 → 下方原双通道逻辑整段照跑（原代码保留为 fallback
        # 路径，输出逐字段一致——共用同一下方构建代码与 _kb_parse_find_lines）。
        _mem_entries = _dig_entries = None
        _profile_entries: Optional[List[Dict[str, Any]]] = None
        entries: Optional[List[Dict[str, Any]]] = None
        _merged = await _kb_tree_merged_probe(token, base, container, ws)
        if _merged is not None:
            entries = _kb_parse_find_lines(_merged.get("top", ""))
            _mem_entries = _kb_parse_find_lines(_merged.get("memory", ""))
            _dig_entries = _kb_parse_find_lines(_merged.get("digest", ""))
            _profile_entries = _kb_parse_profile_lines(
                _merged.get("profile", ""))
        if entries is None:
            entries = await _kb_find_list(token, base, container, ws,
                                          maxdepth=1)
            if entries is None:
                entries = await _kb_tar_list(
                    token, base, container, ws,
                    maxdepth=1, include_dirs=True,
                )
            _mem_entries = await _kb_find_list(
                token, base, container, f"{ws}/memory")
            if _mem_entries is None:
                _mem_entries = await _kb_tar_list(
                    token, base, container, f"{ws}/memory")
            _dig_entries = await _kb_find_list(
                token, base, container, f"{ws}/digest")
            if _dig_entries is None:
                _dig_entries = await _kb_tar_list(
                    token, base, container, f"{ws}/digest")
        _text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
        _symlink_names: List[str] = []
        for e in (entries or []):
            name = e["rel"]
            if name.startswith(".") or name in (
                "memory", "digest",
            ) or _kb_is_sensitive(name, name):
                continue  # 隐藏项 + ②③ 专属分类 + 敏感文件
            if name in seen:
                continue
            seen.add(name)
            et = e["type"]
            if et == "d":
                dirs.append(
                    {"path": name, "name": name, "isdir": True,
                     "category": "file"}
                )
            elif et == "l":
                # # 符号链接此前被整条跳过（worker 工作区 shared →
                # teams/{team}/shared 团队共享目录不可见）。批量解析目标
                # 类型（python3 argv 传路径，不经过 shell 解析——manager
                # 工作区存在含空格/逗号/引号的目录名，shell 拼串必碎）。
                # 目标=目录 → 目录条目（kb_ls -H 可展开）；目标=文件/
                # 断链 → 非文本文件条目（列出不可点开）。
                _symlink_names.append(name)
                files.append(
                    {"path": name, "name": name,
                     "size": e["size"], "mtime": e["mtime"],
                     "category": "file", "openable": False,
                     "symlink": True, "_pending_resolve": True}
                )
            else:
                # 根因②：非文本文件（.jsonl/.py/.bak/.db 等）此前被
                # 文本过滤器整条吞掉 → 列表与实盘目录对不上（「不全」
                # 感观）。改为全量列出 + openable 标记（前端不可点开）。
                files.append(
                    {"path": name, "name": name,
                     "size": e["size"], "mtime": e["mtime"],
                     "category": "profile" if name in _KB_PROFILE_FILES
                    else "file",
                    "openable": name.lower().endswith(_text_ok)}
                )
        if _symlink_names:
            try:
                _targets = [f"{ws}/{n}" for n in _symlink_names]
                _out = await _kb_exec_full(
                    token, base, container,
                    ["python3", "-c",
                     "import os,sys;print('\\n'.join("
                     "'D' if os.path.isdir(p) else 'F' "
                     "for p in sys.argv[1:]))",
                     *_targets],
                    timeout=30.0,
                )
                _resolved = (
                    dict(zip(_symlink_names, _out.splitlines()))
                    if _out else {}
                )
                for _f in files:
                    if _f.pop("_pending_resolve", False):
                        _t = _resolved.get(_f["name"], "")
                        if _t == "D":
                            dirs.append(
                                {"path": _f["path"], "name": _f["name"],
                                 "isdir": True, "category": "file",
                                 "symlink": True}
                            )
                            files.remove(_f)
            except Exception:  # noqa: BLE001 — 解析失败保持文件条目
                for _f in files:
                    _f.pop("_pending_resolve", None)

        # ②③ 日记（memory/**）+ 知识库（digest/**）：构建体与 ① 共用——
        # 条目源 = K2 合并探测段（_mem_entries/_dig_entries）或 fallback
        # 分支上方的原双通道取数（根因修保留）。
        for _sub, _cat, _src in (
            ("memory", "daily", _mem_entries),
            ("digest", "digest", _dig_entries),
        ):
            for e in (_src or []):
                if e["type"] not in ("f", "l"):
                    continue  # ②③ 子树只列文件（目录不单独成条目）
                rel = f"{_sub}/{e['rel']}"
                nm = e["rel"].rsplit("/", 1)[-1]
                if (
                    _kb_is_sensitive(nm, rel)
                    or any(q.startswith(".") for q in e["rel"].split("/"))
                ):
                    continue  # 敏感文件 + 隐藏项（dashboard 对齐）
                if rel in seen:
                    continue
                seen.add(rel)
                # 非文本文件同样列出（openable=False）——
                # 与 ① 顶层同口径，列表=实盘目录的诚实镜像。
                files.append(
                    {"path": rel, "name": nm, "size": e["size"],
                     "mtime": e["mtime"], "category": _cat,
                     "openable": e["type"] == "f"
                     and nm.lower().endswith(_text_ok)}
                )

        # ④ 兼容旧逻辑：单独抓 6 档案文件中未随顶层 tar 出现者（布局差异兜底）。
        # K2 合并探测路径：stat 段已提供 存在+size/mtime（与 ④ tar 语义等价，
        # 任务书 §二 K2）→ 直接落 stat 条目，免 6 次逐文件 archive。
        if _profile_entries is None:
            for sub in ("MEMORY.md", "SOUL.md", "AGENTS.md", "PROFILE.md",
                        "HEARTBEAT.md", "BOOTSTRAP.md"):
                if sub in seen:
                    continue
                st, data = await _kb_docker(
                    token, base,
                    f"/containers/{container}/archive?path={_up.quote(ws + '/' + sub)}",
                    timeout=60.0,
                )
                if st not in (200, 304) or not data:
                    continue
                await _add_entries(data, sub, "profile")
        else:
            for e in _profile_entries:
                if e["path"] in seen:
                    continue
                seen.add(e["path"])
                files.append(
                    {"path": e["path"], "name": e["name"], "size": e["size"],
                     "mtime": e["mtime"], "category": "profile",
                     "openable": True}
                )

        # 不再按文本扩展名整体过滤——每条自带 openable
        # 标记（前端据此决定可否点开），列表=实盘目录诚实镜像（非文本
        # 灰显不可点）。排序：分类优先 → 可打开优先 → 路径。
        cat_order = {"profile": 0, "daily": 1, "digest": 2, "file": 3}
        files.sort(
            key=lambda f: (
                cat_order.get(f.get("category", "file"), 3),
                0 if f.get("openable", False) else 1,
                f["path"],
            )
        )
        keep = files[:300]
        keep_dirs = dirs[:60]
        _payload: Dict[str, Any] = {
            "agent": agent, "workspace": ws,
            "files": keep, "dirs": keep_dirs, "count": len(keep),
        }
        return _payload

    def _kb_file_first_member(data: bytes) -> tuple:
        """tar → 首个普通文件的 (content, size)。同步，调用方 to_thread
        包裹（不挂事件循环）；tar 损坏 → 502（与旧内联版语义一致）。"""
        import io as _io
        import tarfile as _tf
        content = b""
        size = 0
        try:
            with _tf.open(fileobj=_io.BytesIO(data), mode="r:*") as tf:
                for m in tf.getmembers():
                    if m.isfile():
                        fobj = tf.extractfile(m)
                        if fobj:
                            content = fobj.read()
                            size = m.size
                        break
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"tar 解包失败：{exc}")
        return content, size

    async def _kb_file_compute(agent: str, path: str) -> Dict[str, Any]:
        # kb_file 冷取计算体——原端点体
        # （校验之后）逐字搬移；缓存写收口在调用点 _store_kb。只缓存
        # 文本类返回（{"path","size","content"}）；415 二进制 / 413 超限
        # 均以 HTTPException 终止、不达 _store_kb，天然不缓存。
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 兜底（worker only）：Docker 不可用（L2 403 / 挂 502）且 path 在 #1208
        # allowlist（MEMORY.md|memory/**|digest/**）→ #1208 file-content 分块读。
        if agent != "manager" and _wsf_in_allowlist(path):
            if not await _kb_docker_available(ctx, token, base, container):
                res = await _wsf_read_file(token, base, agent, path)
                if res is None:
                    raise HTTPException(
                        status_code=404, detail=f"文件不存在：{path}")
                size, text = res
                return {"path": path, "size": size, "content": text,
                        "source": "controller"}
        ws = await _kb_workspace(ctx, token, base, agent)
        import urllib.parse as _up
        st, data = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(ws + '/' + path)}",
            timeout=60.0,
        )
        if st not in (200, 304) or not data:
            raise HTTPException(status_code=404, detail=f"文件不存在：{path}")
        if len(data) > _KB_MAX_TAR:
            raise HTTPException(status_code=413, detail="文件 tar 超过 20MB")
        content, size = await asyncio.to_thread(
            _kb_file_first_member, data
        )
        if size > _KB_MAX_FILE:
            raise HTTPException(
                status_code=413, detail="文件超过 512KB，暂不支持在线预览"
            )
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status_code=415, detail="二进制文件，无法在线预览")
        return {"path": path, "size": size, "content": text}

    async def _kb_file_compute_wrapped(key: str) -> Dict[str, Any]:
        # K5 单飞注册表统一签名（key="agent/path"，_spawn_kb_refresh 单飞
        # 槽位同名）。
        a, _, p = key.partition("/")
        return await _kb_file_compute(a, p)

    @router.get("/kb/{agent}/file")
    async def kb_file(agent: str, path: str = "") -> Dict[str, Any]:
        """读单个知识库文件（tar 解包 → UTF-8 文本；二进制/超限拒）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        if not path or path.startswith("/") or ".." in path.split("/"):
            raise HTTPException(status_code=400, detail="非法文件路径")
        if _kb_is_sensitive(path.rsplit("/", 1)[-1], path):
            # 404 而非 403：不泄露敏感文件存在性（dashboard 同款过滤）
            raise HTTPException(status_code=404, detail=f"文件不存在：{path}")
        # SWR 30s 内存+磁盘门（与
        # tree/graph 同款），键 file-<agent>-<path>。只缓存文本类返回
        # （{"path","size","content"} 形态）；415 二进制/413 超限以
        # HTTPException 终止不达 _store_kb；WSF 兜底（source:"controller"）
        # 在 _store_kb 单点收口不缓存（14.7 不变式）。
        _fkey = f"file-{agent}-{path}"
        _c = _kb_file_cache.get(_fkey)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        _disk = kb_cache.load(_fkey)
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh(ctx, "file", f"{agent}/{path}")
            return {**_payload, "cached": True, "age": int(_age)}
        _payload = await (router_mod._KB_PREWARM_HOOKS.get("file")
                          or _kb_file_compute_wrapped)(f"{agent}/{path}")
        _store_kb(f"{agent}/{path}", _payload, "file")
        return _payload

    @router.get("/kb/{agent}/files-batch")
    async def kb_files_batch(agent: str, paths: str = "") -> Dict[str, Any]:
        """批量读（K1）：paths=逗号分隔相对路径（≤200），单次 exec
 分帧批读。返回 {agent, files, missing, truncated, cached:false}。
 敏感路径 → missing（不读不报错，与 tree 过滤口径一致）；非法
 路径（绝对/.. /控制字符）静默跳过；通道挂 → 502（调用方 graph
 compute 区分并回退逐文件）。本端点结果不缓存（K1 定位=冷时
 graph compute 的内部批读通道，前端不直调）。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        input_missing: List[str] = []
        want: List[str] = []
        seen_p: set = set()
        for seg in paths.split(","):
            p = seg.strip()
            if not p:
                continue
            # 绝对路径 / .. / 控制字符（含 \n \r \t \x00——行协议安全）
            # → 静默跳过（不入 files 也不入 missing）
            if (p.startswith("/") or ".." in p.split("/")
                    or any(c in p for c in ("\n", "\r", "\t", "\x00"))):
                continue
            while p.startswith("./"):
                p = p[2:]
            if not p or p in seen_p:
                continue
            seen_p.add(p)
            if _kb_is_sensitive(p.rsplit("/", 1)[-1], p):
                input_missing.append(p)  # 敏感 → missing（不读）
                continue
            want.append(p)
        want = want[:_KB_BATCH_MAX_PATHS]
        if not want:
            # 空请求 / 全部敏感或非法 → 直接返回（不发 exec）
            return {"agent": agent, "files": {},
                    "missing": input_missing,
                    "truncated": False, "cached": False}
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        if not await _kb_docker_available(ctx, token, base, container):
            raise HTTPException(status_code=409, detail="Docker 通道不可用")
        ws = await _kb_workspace(ctx, token, base, agent)
        result = await _kb_files_batch_read(token, base, container, ws, want)
        if result is None:
            raise HTTPException(
                status_code=502, detail="批量读通道失败，请重试")
        return {
            "agent": agent,
            "files": result["files"],
            "missing": input_missing + result["missing"],
            "truncated": result["truncated"],
            "cached": False,
        }

    @router.get("/kb/{agent}/ls")
    async def kb_ls(agent: str, dir: str = "") -> Dict[str, Any]:
        """ （用户真机：知识库「只能看见工作区目录，不能点开看；
 子目录文件也看不见」）：一级目录懒加载——前端目录树展开时按层
 取内容。dir 空=工作区顶层；协议文档目录=该目录一级内容。
 返回 files（文本可点开，路径=工作区相对全路径，直接喂 /file）+
 dirs（可继续展开）。列取走双通道（exec find 主/tar 兜底，
 ），只返回一级子条目，深层跳过。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        if dir:
            segs = [p for p in dir.split("/") if p and p != "."]
            if not segs or any(
                p in (".", "..") or p.startswith(".") for p in segs
            ):
                raise HTTPException(status_code=400, detail="非法目录路径")
            dir = "/".join(segs)
        token, base = _kb_require_token()
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 兜底（worker only）：Docker 不可用 → #1208 懒加载（memory/**|digest/**|MEMORY.md）。
        if agent != "manager":
            if not await _kb_docker_available(ctx, token, base, container):
                return await _kb_ls_wsf_fallback(token, base, agent, dir)
        ws = await _kb_workspace(ctx, token, base, agent)
        target = f"{ws}/{dir}" if dir else ws
        # 双通道（旧版 exec-only：通道挂时把传输失败误报
        # 「目录不存在」404）：exec find 主 + tar 兜底；「通道正常但输出空」
        # 以 HEAD 探针（零下载）区分空目录（200/304）与不存在（404）。
        entries = await _kb_find_list(token, base, container, target, maxdepth=1)
        if entries is None:
            entries = await _kb_tar_list(
                token, base, container, target,
                maxdepth=1, include_dirs=True,
            )
            if entries is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"目录不存在：{dir or '（工作区顶层）'}",
                )
        elif not entries:
            import urllib.parse as _up
            st_head, _ = await _kb_docker(
                token, base,
                f"/containers/{container}/archive?path={_up.quote(target)}",
                head=True, timeout=20.0,
            )
            if st_head not in (200, 304):
                raise HTTPException(
                    status_code=404,
                    detail=f"目录不存在：{dir or '（工作区顶层）'}",
                )

        own = target.rstrip("/").rsplit("/", 1)[-1]
        files: List[Dict[str, Any]] = []
        dirs: Dict[str, Dict[str, Any]] = {}
        text_ok = (".md", ".txt", ".yaml", ".yml", ".json")
        symlink_names: List[str] = []
        for e in entries:
            name = e["rel"]
            if not name or name.startswith(".") \
                    or _kb_is_sensitive(name, f"{dir}/{name}" if dir else name):
                continue
            if e["type"] == "d" and name == own:
                continue  # 所请求目录自身（防御：exec 通道 %P 首行为空已滤）
            rel = f"{dir}/{name}" if dir else name
            if e["type"] == "d":
                dirs.setdefault(name, {
                    "path": rel, "name": name, "isdir": True,
                })
            elif e["type"] == "l":
                # 符号链接列全（目标=目录→可展开，
                # find -H 展开已支持；目标=文件/断链→非文本条目）。
                symlink_names.append(name)
                files.append({
                    "path": rel, "name": name,
                    "size": e["size"], "mtime": e["mtime"],
                    "category": "file", "openable": False,
                    "symlink": True, "_pending_resolve": True,
                })
            elif e["type"] == "f":
                # 非文本文件列出 + openable 标记（13.9「不全」根因②，
                # 与 kb_tree 同口径）。
                files.append({
                    "path": rel, "name": name,
                    "size": e["size"], "mtime": e["mtime"],
                    "category": "file",
                    "openable": name.lower().endswith(text_ok),
                })
        if symlink_names:
            try:
                _targets = [f"{target.rstrip('/')}/{n}" for n in symlink_names]
                _out = await _kb_exec_full(
                    token, base, container,
                    ["python3", "-c",
                     "import os,sys;print('\\n'.join("
                     "'D' if os.path.isdir(p) else 'F' "
                     "for p in sys.argv[1:]))",
                     *_targets],
                    timeout=30.0,
                )
                _resolved = (
                    dict(zip(symlink_names, _out.splitlines()))
                    if _out else {}
                )
                for _f in files:
                    if _f.pop("_pending_resolve", False):
                        if _resolved.get(_f["name"]) == "D":
                            dirs.setdefault(_f["name"], {
                                "path": _f["path"], "name": _f["name"],
                                "isdir": True, "symlink": True,
                            })
                            files.remove(_f)
            except Exception:  # noqa: BLE001 — 解析失败保持文件条目
                for _f in files:
                    _f.pop("_pending_resolve", None)
        files.sort(
            key=lambda f: (0 if f.get("openable", False) else 1, f["path"])
        )
        dir_list = sorted(dirs.values(), key=lambda d: d["path"])
        return {
            "agent": agent, "dir": dir,
            "files": files[:300], "dirs": dir_list[:120],
        }

    @router.get("/kb/{agent}/graph")
    async def kb_graph(agent: str) -> Dict[str, Any]:
        """知识图谱（对齐 QwenPaw 最新版 ReMe 图谱模型）：
 digest 三虚拟分类根 + digest/** + memory/** + 顶层 md 全量节点；
 边 = 分类根→分桶文件（结构边）+ [[wikilink]]/inlinks-outlinks
 路径块（语义边）；无 digest 分桶的旧布局由 MEMORY.md 挂 depth-1
 memory 文件兜底。"""
        if not _KB_AGENT_RE.match(agent):
            raise HTTPException(status_code=400, detail="非法 agent 名")
        # graph 结果短 TTL 命中（内部 kb_tree 亦命中树缓存）。
        _c = _kb_graph_cache.get(agent)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        # SWR 磁盘缓存（与 tree 同款门；
        # key=graph-{agent}）。
        _disk = kb_cache.load(f"graph-{agent}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh(ctx, "graph", agent)
            kb_cache.save("last-agent", {"agent": agent})
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (router_mod._KB_PREWARM_HOOKS.get("graph")
                          or _kb_graph_compute)(agent)
        _store_kb(agent, _payload, "graph")
        return _payload

    async def _kb_graph_compute(agent: str) -> Dict[str, Any]:
        # graph 冷取计算体——原端点「缓存门之后」
        # 逐字搬移（原尾内存缓存写移至调用点 _store_kb；内部 kb_tree 调用
        # 走 tree 端点 = 先命中树缓存/SWR 门）。
        tree = await kb_tree(agent)
        # （对齐 QwenPaw 最新版图谱模型，ReMe
        # graph_snapshot_step 同款结构）：节点 = digest 三虚拟分类根
        # （wiki/personal/procedure）+ digest/** 全量 md + memory/**
        # 全量 md + 顶层 md（档案）。旧版只取 memory/** + 3 个顶层文件、
        # 漏掉 digest/ → 用户真机「图谱只有几个点」（实测：
        # 某 daily Worker digest=6 文件全落选；manager 落错工作区=0 节点）。
        md_files = [
            f["path"] for f in tree["files"]
            if f["path"].lower().endswith(".md")
            and (
                f["path"].startswith("memory/")
                or f["path"].startswith("digest/")
                or "/" not in f["path"]
            )
        ][: _KB_MAX_GRAPH_FILES]

        def _cat(p: str) -> str:
            if p.startswith("digest/wiki/"):
                return "digest/wiki"
            if p.startswith("digest/personal/"):
                return "digest/personal"
            if p.startswith("digest/procedure/"):
                return "digest/procedure"
            if p.startswith("digest/"):
                return "digest/other"
            if p.startswith("memory/"):
                return "memory"
            if p in ("MEMORY.md", "SOUL.md", "AGENTS.md", "TEAMS.md",
                     "PROFILE.md", "HEARTBEAT.md", "BOOTSTRAP.md"):
                return "profile"
            return "other"

        existing = {p: _cat(p) for p in md_files}
        # 归一：target（可能缺 .md / 带 .md / 带 query）→ 现有文件路径。
        norm_map: Dict[str, str] = {}
        for p in existing:
            norm_map[p] = p
            if p.lower().endswith(".md"):
                norm_map[p[:-3]] = p
            tail = p.rsplit("/", 1)[-1]
            norm_map.setdefault(tail, p)
            if tail.lower().endswith(".md"):
                norm_map.setdefault(tail[:-3], p)

        nodes: Dict[str, Dict[str, Any]] = {}
        for p, c in existing.items():
            nodes[p] = {"id": p, "name": p.rsplit("/", 1)[-1],
                        "category": c, "virtual": False, "resolved": True,
                        "path": p}
        edges: List[Dict[str, str]] = []
        seen_edges: set = set()

        def _add_edge(s: str, t: str, anchor: str = "") -> None:
            key = (s, t, anchor)
            if key in seen_edges:
                return
            seen_edges.add(key)
            e: Dict[str, str] = {"source": s, "target": t}
            if anchor:
                e["target_anchor"] = anchor
            edges.append(e)

        # 虚拟分类根（ReMe graph_snapshot_step 同款：
        # virtual:{bucket} → digest/{bucket}/ 文件结构边），非空才生成——
        # 避免空根节点污染前端。无 digest 分桶（旧布局 worker）时
        # MEMORY.md 当 hub 挂 depth-1 memory 文件，保证图不空。
        _buckets = ("wiki", "personal", "procedure")
        for b in _buckets:
            if any(p.startswith(f"digest/{b}/") for p in existing):
                nodes[f"virtual:{b}"] = {
                    "id": f"virtual:{b}", "name": b,
                    "category": f"digest/{b}", "virtual": True,
                }
        for p in existing:
            if p.startswith("digest/") and p.count("/") >= 2:
                first = p.split("/", 2)[1]
                if first in _buckets:
                    _add_edge(f"virtual:{first}", p)
        has_digest_bucket = any(
            p.startswith(f"digest/{b}/")
            for b in _buckets for p in existing
        )
        if not has_digest_bucket and "MEMORY.md" in existing:
            for p in existing:
                if p.startswith("memory/") and p.count("/") == 1:
                    _add_edge("MEMORY.md", p)
        # N 个 md 冷拉——先试 K1
        # 批量读（N 次往返 → 单次 exec 分帧读；仅 docker 正常 tree 可用，
        # WSF 兜底 tree 无真实工作区路径）；通道挂（None）/ 截断 / 任何
        # 异常 → 下方旧并发 8 逐文件路径（原代码逐字保留为 fallback）。
        # 截断也回退：1.8MB 预算盖不住总量时部分内容会降级图谱
        # （漏边/漏摘要），不完整宁慢勿错（与现行为逐字段一致）。
        fetched: Optional[List[str]] = None
        if md_files and tree.get("source") != "controller":
            try:
                _btok, _bbase = _kb_require_token()
                _bcontainer = (
                    "agentteams-manager" if agent == "manager"
                    else f"agentteams-worker-{agent}"
                )
                _bws = str(tree.get("workspace") or "")
                if _bws and _bws != "(controller #1208)":
                    _batch = await _kb_files_batch_read(
                        _btok, _bbase, _bcontainer, _bws, md_files)
                    if _batch is not None and not _batch["truncated"]:
                        _bf = _batch["files"]
                        fetched = [_bf.get(p, "") for p in md_files]
            except Exception:  # noqa: BLE001 - 批量失败一律回退逐文件
                fetched = None
        if fetched is None:
            # 并发 8 拉文件（150 文件串行 ~7s → 并发 ~1s）。
            sem = asyncio.Semaphore(8)

            async def _fetch_text(p: str) -> str:
                async with sem:
                    try:
                        fdata = await kb_file(agent, p)
                    except Exception:  # noqa: BLE001
                        return ""
                    return fdata["content"]

            fetched = await asyncio.gather(*(_fetch_text(p) for p in md_files))
        for p, text in zip(md_files, fetched):
            if not text:
                continue
            if len(text) > _KB_GRAPH_FILE_CAP:
                text = text[:_KB_GRAPH_FILE_CAP]
            # 节点 description（首个非标题/标记行 = 文件
            # 摘要，≤120 字；供详情面板展示）。
            for line in text.splitlines():
                s0 = line.strip()
                if (
                    not s0
                    or s0.startswith(("#", "---", "```", "<", "!", "|"))
                ):
                    continue
                nodes[p]["description"] = s0[:120]
                break
            # [[wiki#anchor]] 锚点捕获（移植 QwenPaw
            # MemoryGraphView 详情面板出链/入链展示，开源见
            # THIRD-PARTY-NOTICES）。
            targets: list = []
            for m in re.finditer(
                r"\[\[([^\]|#\n]+?)(?:#([^\]|]+?))?\]", text
            ):
                targets.append(
                    (m.group(1).strip(), (m.group(2) or "").strip())
                )
            for m in re.finditer(
                r"^[ \t]*(?:→|←)\s+(\S+?)(?:[ \t]+name=|[ \t]*$)", text, re.M
            ):
                targets.append((m.group(1).strip(), ""))
            for t, anc in targets:
                t = t.strip().strip("`'\"")
                if not t or t.startswith(("http", "/")):
                    continue
                target = norm_map.get(t) or norm_map.get(t.rstrip("/") or "")
                if not target:
                    tmd = t + ".md" if not t.endswith(".md") else t
                    target = norm_map.get(tmd)
                if target == p:
                    continue
                if target:
                    node_id = target
                else:
                    node_id = t
                    if node_id not in nodes:
                        # 未解析引用≠虚拟根（前端按 virtual:*
                        # 前缀识别根）——普通灰点、不可点开（文件不存在）。
                        nodes[node_id] = {
                            "id": node_id,
                            "name": node_id.rsplit("/", 1)[-1],
                            "category": "other",
                            "virtual": False,
                            "resolved": False,
                        }
                _add_edge(p, node_id, anc)
        _payload: Dict[str, Any] = {
            "agent": agent,
            "nodes": list(nodes.values()),
            "edges": edges,
            "file_count": len(md_files),
        }
        return _payload

    # ── 团队知识库深化（跨 Worker 搜索 + 聚合图谱）──────────

    async def _kb_all_agents(token: str, base: str) -> List[str]:
        """全部 Agent 名（worker 容器 + manager），供搜索/聚合默认范围。"""
        st, data = await _kb_docker(token, base, "/containers/json")
        if st != 200:
            raise HTTPException(status_code=502, detail="Docker API 不可达")
        import json as _json
        names: List[str] = []
        for c in (_json.loads(data) or []):
            nm = ((c.get("Names") or [""])[0] or "").lstrip("/")
            if nm == "agentteams-manager":
                names.append("manager")
            elif nm.startswith("agentteams-worker-"):
                names.append(nm[len("agentteams-worker-"):])
        return names

    @router.get("/kb/search")
    async def kb_search(q: str = "", agents: str = "") -> Dict[str, Any]:
        """团队知识全量搜索（跨 Worker）——扫各 Agent 的
 MEMORY.md + memory/**/*.md，返回命中行+上下文。
 agents=逗号分隔（缺省=全部，上限 12）；每 Agent ≤60 个 md 文件、
 单文件 ≤100KB；结果上限 100 条（150 熔断）。"""
        query = (q or "").strip()
        if not query:
            raise HTTPException(status_code=400, detail="缺少搜索词 q")
        token, base = _kb_require_token()
        if agents.strip():
            agent_list = [
                a.strip() for a in agents.split(",") if a.strip()
            ][:12]
            agent_list = [a for a in agent_list if _KB_AGENT_RE.match(a)]
        else:
            agent_list = (await _kb_all_agents(token, base))[:12]
        if not agent_list:
            return {"query": query, "matches": [], "count": 0,
                    "agents": []}
        ql = query.lower()
        matches: List[Dict[str, Any]] = []
        done_agents: List[str] = []
        sem = asyncio.Semaphore(6)

        async def search_agent(a: str) -> None:
            async with sem:
                try:
                    tree = await kb_tree(a)
                except HTTPException:
                    return
                done_agents.append(a)
                md = [
                    f["path"] for f in tree["files"]
                    if f["path"].lower().endswith(".md") and f["size"] <= 100 * 1024
                ][:60]
                inner = asyncio.Semaphore(4)

                async def _one(pth: str) -> None:
                    if len(matches) > 150:
                        return  # 熔断
                    async with inner:
                        try:
                            fdata = await kb_file(a, pth)
                        except HTTPException:
                            return
                        lines = fdata["content"].splitlines()
                        for i, ln in enumerate(lines):
                            if ql in ln.lower():
                                matches.append(
                                    {
                                        "agent": a,
                                        "path": pth,
                                        "line": i + 1,
                                        "snippet": ln.strip()[:200],
                                    }
                                )
                                if len(matches) > 150:
                                    return

                await asyncio.gather(*(_one(pth) for pth in md))

        await asyncio.gather(*(search_agent(a) for a in agent_list))
        matches.sort(key=lambda m: (m["agent"], m["path"], m["line"]))
        return {
            "query": query,
            "matches": matches[:100],
            "count": len(matches),
            "agents": sorted(done_agents),
        }

    async def kb_graph_merged_compute(agent_list: List[str]) -> Dict[str, Any]:
        # kb_graph_merged 冷取计算体——
        # 原端点体（agent 解析之后）逐字搬移；供单飞刷新复用
        # （_spawn_kb_refresh "merged"）。逐 agent 走 kb_graph 端点（自带
        # 其 tree/graph 缓存门）→ 合并本身不重复付单 agent 冷取成本。
        sem = asyncio.Semaphore(4)

        async def one(a: str) -> Optional[Dict[str, Any]]:
            async with sem:
                try:
                    return await kb_graph(a)
                except HTTPException:
                    return None

        graphs = await asyncio.gather(*(one(a) for a in agent_list))
        nodes: List[Dict[str, Any]] = []
        edges: List[Dict[str, str]] = []
        ok_agents: List[str] = []
        for g in graphs:
            if not g:
                continue
            a = str(g.get("agent") or "")
            ok_agents.append(a)
            for n in g.get("nodes") or []:
                nid = str(n.get("id") or "")
                nodes.append(
                    {
                        **n,
                        "id": f"{a}::{nid}",
                        "agent": a,
                        "name": n.get("name") or nid.rsplit("/", 1)[-1],
                    }
                )
            for e in g.get("edges") or []:
                edges.append(
                    {
                        "source": f"{a}::{e.get('source')}",
                        "target": f"{a}::{e.get('target')}",
                    }
                )
        return {
            "nodes": nodes[:400],
            "edges": edges[:800],
            "agents": ok_agents,
        }

    async def _kb_merged_compute_wrapped(csv: str) -> Dict[str, Any]:
        # K3 单飞注册表统一签名（key = sorted(agents) 逗号连 csv，
        # _spawn_kb_refresh 单飞槽位同名）。
        return await kb_graph_merged_compute(
            [a for a in csv.split(",") if a])

    @router.get("/kb/graph/merged")
    async def kb_graph_merged(agents: str = "") -> Dict[str, Any]:
        """团队聚合图谱——多 Agent 图谱合并（节点 id=
 agent::path，前端按 agent 着色；边保留在原 Agent 内）。
 agents=逗号分隔（缺省=全部，上限 8）；节点 400 / 边 800 上限。
 ：SWR 30s 内存+磁盘门（与
 tree/graph 同款），键 merged-<sorted(agents) 逗号连>；冷算 = 多
 Agent 图谱合并（抽 kb_graph_merged_compute，供单飞复用）。"""
        token, base = _kb_require_token()
        if agents.strip():
            agent_list = [
                a.strip() for a in agents.split(",") if a.strip()
            ][:8]
            agent_list = [a for a in agent_list if _KB_AGENT_RE.match(a)]
        else:
            agent_list = (await _kb_all_agents(token, base))[:8]
        if not agent_list:
            return {"nodes": [], "edges": [], "agents": []}
        csv = ",".join(sorted(agent_list))
        # SWR 门（与 tree/graph 同款）。
        _c = _kb_merged_cache.get(csv)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        _disk = kb_cache.load(f"merged-{csv}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh(ctx, "merged", csv)
            return {**_payload, "cached": True, "age": int(_age)}
        _payload = await (router_mod._KB_PREWARM_HOOKS.get("merged")
                          or _kb_merged_compute_wrapped)(csv)
        _store_kb(csv, _payload, "merged")
        return _payload


    # SWR 计算体 + 刷新入口注册入模块级表（端点
    # 调用时解析 / 单测假注入 / 启动预热 _kb_prewarm_agent 均读本表）。
    # 触状态入口绑 ctx 闭包（调用契约不变：agents 零参 /
    # tree、graph 单参 agent / merged、file 单参 key / refresh 双参）。
    prewarm_hooks = {
        "refresh": lambda kind, agent: _spawn_kb_refresh(ctx, kind, agent),
        "tree": _kb_tree_compute,
        "graph": _kb_graph_compute,
        "agents": _kb_agents_compute,
        # merged/file 冷取计算体注册
        # （单飞刷新与端点冷取同一注入点；签名=key 字符串）。
        "merged": _kb_merged_compute_wrapped,
        "file": _kb_file_compute_wrapped,
    }
    # 轻探针注册（SWR 刷新门变更检测用）。
    probe_hooks = {
        "probe": lambda agent: _kb_probe_signature(ctx, agent)
    }

    async def _docker_available_bounded(token: str, base: str,
                                        container: str) -> bool:
        """approval 域共享入口（3 参签名不变，ctx 内部绑定）。"""
        return await _kb_docker_available(ctx, token, base, container)

    # 与 approval 域共享：交装配方转传。
    _kb_shared = {
        "agent_re": _KB_AGENT_RE,
        "require_token": _kb_require_token,
        "docker": _kb_docker,
        "docker_available": _docker_available_bounded,
        # #87 团队共享文件域（team_files_api）复用面：
        "exec_full": _kb_exec_full,
        "find_list": _kb_find_list,
        "is_sensitive": _kb_is_sensitive,
        "tar_entries": _kb_tar_entries,
        "max_file": _KB_MAX_FILE,
    }
    return prewarm_hooks, probe_hooks, _kb_shared
