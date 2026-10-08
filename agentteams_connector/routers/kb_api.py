from __future__ import annotations

import asyncio
import os
import re
import time

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException

from .. import config as config_mod, kb_cache
from ..dial_gate import GatedAsyncClient, bg_slot
from ..router import (
    _KB_AGENTS_TTL_SECONDS,
    _KB_FILE_TTL_SECONDS,
    _KB_GRAPH_TTL_SECONDS,
    _KB_MERGED_TTL_SECONDS,
    _KB_PREWARM_HOOKS,
    _KB_PROBE_HOOKS,
    _KB_TREE_TTL_SECONDS,
    _ctl_json,
    _headers_for,
    _kb_agents_cache,
    _kb_apply_runtime_fields,
    _kb_batch_decode,
    _kb_file_cache,
    _kb_graph_cache,
    _kb_merged_cache,
    _kb_prewarm_agent,
    _kb_tree_cache,
    _ordered_addresses,
    _pick_address,
    kb_swr_ttl_for,
    logger,
)


def build_kb_router(
        _kb_ws_cache: Dict[str, Dict[str, Any]],
        _kb_docker_ok_cache: Dict[str, tuple],
        _kb_inflight: Dict[str, Any],
    ) -> tuple:
    """KB 域子路由（build_router 原段逐字搬移，任务 190）。

    三个可变状态（_kb_ws_cache/_kb_docker_ok_cache/_kb_inflight）由装配方
    build_router 创建并显式传入；返回 (router, _kb_shared)，_kb_shared 携带
    与 approval 域共享的四个 helper。"""
    router = APIRouter()
    # ── 远端团队知识库（用户定位：知识库=自己团队的
    # Leader/Worker 知识库，不是宿主本地）────────────────────────────
    # 数据通道：Controller Docker API 反向代理（docker/v1.41/...，
    # 上游 internal/proxy/proxy.go——GET/HEAD 只读恒放行）→
    # GET /containers/{name}/archive?path=...（tar）读 Worker 容器内文件。
    # 零服务器侧改动、零新端点、零新凭据（复用 Controller admin token，L1）。
    # 容器名/布局（AgentTeams 源码实锤）：agentteams-worker-{name} /
    # agentteams-manager；qwenpaw-worker-entrypoint.sh L19-59：
    # HOME==/root/agentteams-fs/agents/<name>（==MinIO 镜像根）,
    # QWENPAW_WORKING_DIR=$HOME/.qwenpaw,
    # AGENT_WORKSPACE=$HOME/.qwenpaw/workspaces/default（MEMORY.md+memory/
    # +SOUL.md 所在）；copaw 旧布局 memory/ 在 HOME 顶层。

    _KB_AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
    _KB_MAX_TAR = 20 * 1024 * 1024  # 单次 archive 拉取上限 20MB
    _KB_MAX_FILE = 512 * 1024  # 单文件返回上限 512KB

    # 敏感文件过滤（对齐 dashboard FilesBrowserPanel SENSITIVE_PATTERNS：
    # ChatRoom 文件面板同款清单）。dashboard 过滤的是 MinIO 全量 key；插件
    # KB 走容器 archive/exec，隐藏文件（.ssh/ .hermes/）各列取点已 skip，
    # 此处补齐 dashboard 清单中非隐藏部分 + 兜底。
    # 直读 /file 命中时返 404（不泄露存在性，W8 反探测同款）。
    def _kb_is_sensitive(name: str, rel: str) -> bool:
        if rel == "credentials" or rel.startswith("credentials/"):
            return True
        # B1（维护者 1.2.4 联调验收报告，dashboard 侧同修）：
        # credentials.yaml 独立凭证文件（不在 credentials/ 目录下）
        # 原先漏护——KB 视图与文件视图统一补规则。
        if name.lower().endswith("credentials.yaml") or \
                name.lower().endswith("credentials.yml"):
            return True
        if rel == "openclaw.json" or rel == ".hermes/config.yaml":
            return True
        if name.lower().endswith(".lock"):
            return True
        return False
    _KB_MAX_GRAPH_FILES = 150  # 图谱解析文件数上限
    _KB_GRAPH_FILE_CAP = 200 * 1024  # 图谱单文件 200KB

    def _kb_require_token() -> tuple:
        cfg = config_mod.load_config()
        token = (cfg.get("controller_token") or "").strip()
        if not token:
            raise HTTPException(
                status_code=401,
                detail="远端团队知识库需要 Controller 管理员 token（配置页填写后刷新）",
            )
        base = _pick_address(cfg, "controller")
        if not base:
            raise HTTPException(status_code=502, detail="未配置 Controller 地址")
        return token, base.rstrip("/")

    async def _kb_docker(
        token: str, base: str, path: str, head: bool = False,
        timeout: float = 40.0,
    ) -> tuple:
        """Controller Docker API（GET/HEAD 恒放行）。返回 (status, bytes)。

 v0.5.0-beta.14.2（外网 401 根因③）：单地址直拨改 ordered 地址
 failover——旧版只拨 _pick_address 单地址：切网窗口 working cache 未
 换 / 401 地址居首时全族端点（KB/审批/日志）恒 401 或卡满 40s 超时。
 200 即止；4xx/5xx/传输错 → 下一地址；全败 → 返回最后一个
 (status, bytes)（调用方按 st 走 fallback）；全超时 → 原 502 detail
 （Docker daemon 挂诊断，实测：manager 容器 running 但 API 全超时）。
 """
        import httpx as _h
        cfg = config_mod.load_config()
        urls = [u.rstrip("/") for u in _ordered_addresses(cfg, "controller")]
        if not urls:
            urls = [base.rstrip("/")]
        last: Optional[tuple] = None
        all_timeout = True
        for b in urls:
            url = f"{b}/docker/v1.41{path}"
            # v0.5.0-beta.14.3: 该地址覆盖凭据（无则原生 Bearer）。
            headers = _headers_for(
                cfg, "controller", b, {"Authorization": f"Bearer {token}"}
            )
            try:
                async with GatedAsyncClient(timeout=timeout, verify=False) as client:
                    if head:
                        resp = await client.head(url, headers=headers)
                    else:
                        resp = await client.get(url, headers=headers)
                if resp.status_code == 200:
                    if head:
                        return 200, b""
                    return 200, resp.content
                last = (resp.status_code, resp.content if not head else b"")
                all_timeout = False
            except _h.TimeoutException:
                last = (502, b"timeout")
                # all_timeout 保持 True（除非后面有非超时的失败/成功）
            except Exception:  # noqa: BLE001 - try the next address
                last = (502, b"error")
                all_timeout = False
        if all_timeout and last is not None:
            # 实测：服务器 Docker daemon 对个别容器（agentteams-manager，
            # 状态 running 但 inspect/archive 全超时）会挂——容器活着 ≠ API 可用。
            # 明确报错而非裸 500，指向服务器侧处置。
            raise HTTPException(
                status_code=502,
                detail=(
                    "容器 API 响应超时——服务器 Docker daemon 对该容器无响应"
                    "（容器可能 running 但内部挂起）。"
                    "处置：需管理员在服务器执行 docker restart <容器名>"
                ),
            )
        if last is None:
            return 502, b""
        return last

    async def _kb_exec_full(
        token: str, base: str, container: str, cmd: List[str],
        timeout: float = 40.0,
    ) -> Optional[str]:
        """ Controller 代理 docker exec（只读 find/ls 用途）。
 manager live 大工作区超 20MB tar 上限时的轻量列取。
 实测：POST /exec → 201，POST /exec/{id}/start → 多路复用帧
 （8 字节头：stream+3×0+4B big-endian len + payload）。
 输出上限 2MB（find -maxdepth 1 行式清单足够）。
 传输失败（超时/非 200/缺 Id）→ None——调用方需区分「通道挂」
 与「命令成功但输出为空」（后者含 find 目标不存在：find 报错走
 stderr、stdout 为空，exec 仍 200）。"""
        import httpx as _h
        # v0.5.0-beta.14.3: 该地址覆盖凭据（无则原生 Bearer）。
        _cfg = config_mod.load_config()
        headers = _headers_for(
            _cfg, "controller", base, {"Authorization": f"Bearer {token}"}
        )
        try:
            async with GatedAsyncClient(timeout=timeout, verify=False) as client:
                r1 = await client.post(
                    f"{base}/docker/v1.41/containers/{container}/exec",
                    json={
                        "AttachStdout": True,
                        "AttachStderr": True,
                        "Cmd": cmd,
                    },
                    headers=headers,
                )
                if r1.status_code not in (200, 201):
                    return None
                eid = (r1.json() or {}).get("Id", "")
                if not eid:
                    return None
                r2 = await client.post(
                    f"{base}/docker/v1.41/exec/{eid}/start",
                    json={"Detach": False, "Tty": False},
                    headers=headers,
                )
        except _h.TimeoutException:
            return None
        if r2.status_code != 200:
            return None
        raw = r2.content
        out: List[str] = []
        i = 0
        while i + 8 <= len(raw) and sum(len(x) for x in out) < 2 * 1024 * 1024:
            stream = raw[i]
            ln = int.from_bytes(raw[i + 4:i + 8], "big")
            i += 8
            if i + ln > len(raw):
                break
            if stream == 1:
                out.append(raw[i:i + ln].decode("utf-8", "replace"))
            i += ln
        return "".join(out)

    def _kb_tar_entries(data: bytes) -> List[Dict[str, Any]]:
        """Docker archive tar → 相对条目列表。目录请求时顶层条目名=
 所请求目录/文件自身，剥离后得相对路径。同步函数——调用方必须
  asyncio.to_thread 包裹（tar 解析挂事件循环会卡全部并发请求）。"""
        if len(data) > _KB_MAX_TAR:
            raise HTTPException(
                status_code=413,
                detail="目录过大（tar 超过 20MB），无法列取",
            )
        import io as _io
        import tarfile as _tf
        raw: List[Dict[str, Any]] = []
        try:
            with _tf.open(fileobj=_io.BytesIO(data), mode="r:*") as tf:
                for m in tf.getmembers():
                    nm = m.name.replace("\\", "/")
                    parts = [p for p in nm.split("/") if p and p != "."]
                    if not parts:
                        continue
                    raw.append(
                        {
                            "top": parts[0],
                            "rel": "/".join(parts[1:]),
                            "size": m.size,
                            "mtime": m.mtime,
                            "isdir": m.isdir(),
                        }
                    )
        except Exception:  # noqa: BLE001 — tar 损坏按空处理
            return []
        if not raw:
            return []
        # 顶层段一致 = 目录请求（顶层=所请求目录自身，剥前缀）；
        # 不一致 = 条目已归一（如 ./ 前缀被 tarfile 剥掉）→ 按相对处理。
        tops = {e["top"] for e in raw}
        uniform = len(tops) == 1
        top = raw[0]["top"]
        out = []
        for e in raw:
            if uniform:
                if e["top"] != top:
                    continue
            if not e["rel"]:
                if e["isdir"]:
                    continue  # 顶层目录条目自身——跳过
                if uniform:
                    # 单文件请求（tar 仅一条目=文件自身）。
                    out.append(
                        {"path": "", "name": top, "size": e["size"],
                         "mtime": e["mtime"], "isdir": False}
                    )
                else:
                    # 非统一前缀：单段条目=顶层文件。
                    out.append(
                        {"path": e["top"], "name": e["top"], "size": e["size"],
                         "mtime": e["mtime"], "isdir": False}
                    )
            elif not e["isdir"]:
                if uniform:
                    rel = e["rel"]
                else:
                    # 非统一前缀：完整路径 = top[/rel]。
                    rel = e["top"] if not e["rel"] else f"{e['top']}/{e['rel']}"
                out.append(
                    {"path": rel, "name": rel.rsplit("/", 1)[-1],
                     "size": e["size"], "mtime": e["mtime"], "isdir": False}
                )
        return out

    # ── KB 目录列取双通道（v0.5.0-beta.13.9 根因修）────────────────
 # 真机反馈：worker 工作区总体积 >20MB（实测 180MB）→ 旧版
    # kb_tree 顶层（worker 支）/ memory / digest 子树全走「先整目录递归
    # tar 下载完、下载完才查大小」→ 413「工作区顶层超过 20MB，无法列取」
    # （manager 顶层早前已单独切 exec find，worker 支漏改=同类没扫全）。
    # 根因 = 列取路径不再依赖整树下载：
    # 主通道 _kb_find_list —— exec find（零下载，manager live 大工作区
    # 生产已验证的链路；实测 125 条目 ~100ms）；
    # 兜底 _kb_tar_list —— Docker archive tar（小工作区保留旧精确解析
    # + 413 守卫，仅主通道失败时可达）。
    # 失败语义：find 返 None=传输失败（切 tar）；tar 返 None=路径不存在
    # （404）；tar 超限→413（仅兜底路径可触达）。

    def _kb_parse_find_lines(out: str) -> List[Dict[str, Any]]:
        """find -printf '%y %s %T@ %P' 行解析（_kb_find_list 主通道与
 v0.5.0-beta.14.17 KBBATCH-K2 合并探测共用——同一解析=同一语义：
 rel 空/绝对路径行跳过，size/mtime 解析失败归 0）。"""
        entries: List[Dict[str, Any]] = []
        for ln in out.splitlines():
            parts = ln.split(" ", 3)
            if len(parts) != 4:
                continue
            typ, size_s, mtime_s, rel = parts
            rel = rel.replace("\\", "/")
            if not rel or rel.startswith("/"):
                continue
            try:
                size = int(float(size_s))
            except ValueError:
                size = 0
            try:
                mtime = int(float(mtime_s))
            except ValueError:
                mtime = 0
            entries.append({"type": typ, "size": size,
                            "mtime": mtime, "rel": rel})
        return entries

    async def _kb_find_list(
        token: str, base: str, container: str, target: str,
        maxdepth: Optional[int] = None,
    ) -> Optional[List[Dict[str, Any]]]:
        """主通道：exec find 列目录（零下载）。
 返回 [{type,size,mtime,rel}]（rel 相对 target，顶层条目=裸名）；
 通道失败 → None（调用方切 tar 兜底）；目标不存在/空目录 → 空列表
 （find 报错走 stderr、stdout 空——调用方必要时以 HEAD 探针区分
 空目录与不存在）。
 v0.5.0-beta.13.10：-H 跟随**命令行参数**层的符号链接（worker
 工作区 shared → teams/.../shared 团队目录符号链接——kb_ls 展开
 符号链接目录需要；条目内深层符号链接仍不跟随，防环）。"""
        cmd = ["find", "-H", target]
        if maxdepth is not None:
            cmd += ["-maxdepth", str(maxdepth)]
        cmd += ["-printf", "%y %s %T@ %P\n"]
        out = await _kb_exec_full(token, base, container, cmd, timeout=90.0)
        if out is None:
            return None
        return _kb_parse_find_lines(out)

    def _kb_parse_tar_list(
        data: bytes,
        maxdepth: Optional[int],
        include_dirs: bool,
    ) -> List[Dict[str, Any]]:
        """tar 解析 → 条目列表（同步，调用方 to_thread 包裹）。
 语义与旧 _kb_tar_list 内联解析逐字一致：超 _KB_MAX_TAR → 413；
 tar 损坏 → 502；顶层统一判定（单顶层=剥前缀）。"""
        import io as _io
        import tarfile as _tf
        if len(data) > _KB_MAX_TAR:
            raise HTTPException(
                status_code=413,
                detail="目录过大（tar 超过 20MB），无法列取")
        try:
            tf = _tf.open(fileobj=_io.BytesIO(data), mode="r:*")
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=502, detail="tar 解析失败")
        members = []
        with tf:
            for m in tf.getmembers():
                nm = m.name.replace("\\", "/")
                parts = [q for q in nm.split("/") if q and q != "."]
                if parts:
                    members.append((m, parts))
        if not members:
            return []
        # 统一顶层=所请求目录自身（剥前缀）；不一致=条目已归一（按相对）。
        tops = {p[0] for _, p in members}
        strip = len(tops) == 1
        entries: List[Dict[str, Any]] = []
        for m, parts in members:
            rel_parts = parts[1:] if strip else parts
            if not rel_parts:
                continue  # 所请求目录自身
            depth = len(rel_parts)
            if maxdepth is not None and depth > maxdepth:
                continue
            if m.isdir():
                if not include_dirs:
                    continue
                entries.append({"type": "d", "size": 0,
                                "mtime": int(m.mtime),
                                "rel": "/".join(rel_parts)})
            elif m.isfile():
                entries.append({"type": "f", "size": m.size,
                                "mtime": int(m.mtime),
                                "rel": "/".join(rel_parts)})
        return entries

    async def _kb_tar_list(
        token: str, base: str, container: str, target: str,
        maxdepth: Optional[int] = None,
        include_dirs: bool = False,
    ) -> Optional[List[Dict[str, Any]]]:
        """兜底通道：Docker archive tar 列目录（递归 tar，只解析到指定层）。
 返回 [{type,size,mtime,rel}]；路径不存在 → None；tar 超
 _KB_MAX_TAR → 413；其余非 200/304 → 502。
 maxdepth=1 + include_dirs=True → 一级文件+目录（tree 顶层/kb_ls）；
 maxdepth=None → 全层文件（tree memory/digest 子树，旧
 _kb_tar_entries 语义）。tar 解析在 to_thread（不挂事件循环）。"""
        import urllib.parse as _up
        st, data = await _kb_docker(
            token, base,
            f"/containers/{container}/archive?path={_up.quote(target)}",
            timeout=60.0,
        )
        if st in (400, 404):
            return None
        if st not in (200, 304):
            raise HTTPException(
                status_code=502, detail=f"目录列取失败（Docker API {st}）")
        if not data:
            return []
        return await asyncio.to_thread(
            _kb_parse_tar_list, data, maxdepth, include_dirs
        )

    # ── v0.5.0-beta.14.17（KBBATCH-K2）：tree 合并探测 ─────────────────
    # 冷时 tree = ws 探测 + 可用性探测 + 顶层 find + memory find + digest
    # find + 六档案逐个 archive 兜底（4-10 次 HTTP 往返）。合并探测把
    # 三个 find 与六档案 stat 收进**一次** exec（sh -c 分段脚本，
    # ###SECTION: 标记切分——find -printf 行首恒为 f/d/l 等单字符，
    # # 开头行不可能来自 find 输出，切分确定性安全）。成功判据=输出含
    # 收尾标记 ###SECTION:end（sh 缺失→exec 非 200→None；find 缺失/
    # 中途挂→无 end 标记→按失败处理）；失败（None/无 end）→ 调用方走
    # 原双通道逻辑整段（回退语义保留，见 _kb_tree_compute）。
    _KB_PROFILE_FILES = (
        "MEMORY.md", "SOUL.md", "AGENTS.md", "PROFILE.md",
        "HEARTBEAT.md", "BOOTSTRAP.md",
    )
    _KB_TREE_MERGED_SCRIPT = (
        "echo '###SECTION:top';"
        "find -H {ws} -maxdepth 1 -printf '%y %s %T@ %P\\n' 2>/dev/null;"
        "echo '###SECTION:memory';"
        "find -H {ws}/memory -printf '%y %s %T@ %P\\n' 2>/dev/null;"
        "echo '###SECTION:digest';"
        "find -H {ws}/digest -printf '%y %s %T@ %P\\n' 2>/dev/null;"
        "echo '###SECTION:profile';"
        "for f in MEMORY.md SOUL.md AGENTS.md PROFILE.md HEARTBEAT.md"
        " BOOTSTRAP.md; do"
        " [ -e {ws}/$f ] && stat -c '%n %s %Y' {ws}/$f;"
        "done 2>/dev/null;"
        "echo '###SECTION:end'"
    )

    def _kb_split_sections(out: str) -> Dict[str, str]:
        """###SECTION:<name> 标记切分 → {name: 段内容(\\n 连行)}。
 标记行本身不入段；未知标记（未来扩展）同样收集。"""
        sections: Dict[str, str] = {}
        cur: Optional[str] = None
        for ln in out.splitlines():
            if ln.startswith("###SECTION:"):
                cur = ln[len("###SECTION:"):].strip()
                sections.setdefault(cur, "")
                continue
            if cur is None:
                continue
            sections[cur] = f"{sections[cur]}\n{ln}" if sections[cur] else ln
        return sections

    def _kb_parse_profile_lines(out: str) -> List[Dict[str, Any]]:
        """六档案 stat 段行解析：`<完整路径> <size> <mtime>`（stat -c
 '%n %s %Y'；%n=固定六文件名、无空格，rsplit 安全）。返回
 [{path(裸名),name,size,mtime}]——与旧 ④ archive 兜底的
 _add_entries 输出字段一致（category/openable 由调用点补齐）。"""
        entries: List[Dict[str, Any]] = []
        for ln in out.splitlines():
            parts = ln.rsplit(" ", 2)
            if len(parts) != 3:
                continue
            full, size_s, mtime_s = parts
            name = full.rsplit("/", 1)[-1]
            if name not in _KB_PROFILE_FILES:
                continue
            try:
                size = int(float(size_s))
            except ValueError:
                size = 0
            try:
                mtime = int(float(mtime_s))
            except ValueError:
                mtime = 0
            entries.append({"path": name, "name": name,
                            "size": size, "mtime": mtime})
        return entries

    async def _kb_tree_merged_probe(
        token: str, base: str, container: str, ws: str,
    ) -> Optional[Dict[str, str]]:
        """K2 合并探测（1 exec）：成功 → {top,memory,digest,profile}
 四段原文；通道挂（None）/ 无收尾标记（脚本中途挂）→ None
 （调用方走原双通道 fallback 整段）。timeout=90 与原 find 主通道
 一致（三段 find 串行最坏 ≤3×90 的旧上界，合并后单窗口）。"""
        script = _KB_TREE_MERGED_SCRIPT.format(ws=ws)
        out = await _kb_exec_full(
            token, base, container, ["sh", "-c", script], timeout=90.0,
        )
        if out is None or "###SECTION:end" not in out:
            return None
        return _kb_split_sections(out)

    # ── v0.5.0-beta.14.17（KBBATCH-K1）：批量读（单次 exec 分帧）────────
    # graph 冷取 = N 次逐文件 kb_file 往返（N=md 数，数十~上百）。批量读
    # 把 N 次往返收进**单次** exec：容器内 python3 逐文件读，输出确定性
    # 分帧 `===FRAME:<size>:<path>` + **恰好 size 字节**内容（帧边界由
    # size 决定，内容含 ===FRAME: 字样也不串帧），总内容 ≤1.8MB（2MB
    # 传输上限内留帧头余量），超限 `===TRUNC`。通道挂（None）→ 调用方
    # 区分并回退旧逐文件路径。
    #
    # 声明偏离（任务书 §二 K1 字面为 sh -c stat+cat 两段）：传输层
    # _kb_exec_full 以 utf-8/replace 解码帧——二进制帧直穿会因多字节
    # 截断/替换符使 size 与实际字节失配、必然串帧。改为容器内
    # decode(errors="ignore") 保证有效 UTF-8、size=重编码后字节长度，
    # 帧边界字节精确（语义等价 stat+cat，仍单次 exec）。
    _KB_BATCH_BUDGET = 1887436  # 1.8MB 内容预算（2MB 传输上限内）
    _KB_BATCH_MAX_PATHS = 200
    _KB_BATCH_READ_SCRIPT = r'''import os, sys
import gzip, base64
ws = sys.argv[1]
paths = sys.argv[2:]
budget = 1887436
out = []
for p in paths:
 if not p or "\n" in p or "\r" in p:
 continue
 full = os.path.normpath(os.path.join(ws, p))
 if full == ws or not full.startswith(ws + os.sep):
 out.append("===MISSING:" + p)
 continue
 try:
 st = os.stat(full)
 except OSError:
 out.append("===MISSING:" + p)
 continue
 if st.st_size > budget:
 out.append("===TRUNC")
 break
 budget -= st.st_size
 try:
 with open(full, "rb") as f:
 data = f.read()
 except OSError:
 out.append("===MISSING:" + p)
 continue
 text = data.decode("utf-8", "ignore")
 enc = text.encode("utf-8")
 if enc:
 out.append("===FRAME:%d:%s" % (len(enc), p))
 out.append(text)
 else:
 out.append("===FRAME:0:" + p)
out.append("===END")
payload = ("\n".join(out) + "\n").encode("utf-8")
blob = base64.b64encode(gzip.compress(payload, 9)).decode("ascii")
sys.stdout.buffer.write(b"===GZB1===\n" + blob.encode("ascii")
                        + b"\n===END\n")
'''

    def _kb_take_bytes(s: str, pos: int, nbytes: int):
        """从 s[pos:] 恰好消费 nbytes 字节（UTF-8 宽度感知：per-char
 <0x80→1 / <0x800→2 / <0x110000→3 / 其余→4），返回 (消费串,
 新 pos)。内容恒为有效 UTF-8（容器内 decode ignore）→ 恰在字符
 边界停。"""
        chars: List[str] = []
        i = pos
        n = len(s)
        used = 0
        while i < n and used < nbytes:
            cp = ord(s[i])
            if cp < 0x80:
                w = 1
            elif cp < 0x800:
                w = 2
            elif cp < 0x110000:
                w = 3
            else:
                w = 4
            chars.append(s[i])
            used += w
            i += 1
        return "".join(chars), i

    _kb_batch_marker_re = re.compile(
        r"\n(?====FRAME:|===MISSING:|===TRUNC|===END)"
    )

    def _kb_parse_batch(text: Optional[str]) -> Optional[Dict[str, Any]]:
        """批量读分帧输出 → {files, missing, truncated}；text=None
 （通道挂）→ None（调用方区分并回退）。帧边界由 size 决定
 （恰好消费 size 字节）→ 内容内嵌 ===FRAME: 不当帧头（不串帧）；
 异常失步 → 正则重同步到下一标记行。"""
        if text is None:
            return None
        files: Dict[str, str] = {}
        missing: List[str] = []
        truncated = False
        i = 0
        n = len(text)
        while i < n:
            line_end = text.find("\n", i)
            if line_end == -1:
                line_end = n
            line = text[i:line_end]
            i = line_end + 1
            if line.startswith("===FRAME:"):
                rest = line[len("===FRAME:"):]
                m = rest.find(":")
                if m == -1:
                    continue
                try:
                    size = int(rest[:m])
                except ValueError:
                    continue
                pth = rest[m + 1:]
                if size == 0:
                    files.setdefault(pth, "")
                    continue
                taken, i = _kb_take_bytes(text, i, size)
                files[pth] = taken
                if i < n and text[i] == "\n":
                    i += 1
                else:
                    # 失步（正常不可达）：重同步到下一标记行
                    mm = _kb_batch_marker_re.search(text, i)
                    if mm is None:
                        break
                    i = mm.start() + 1
            elif line.startswith("===MISSING:"):
                missing.append(line[len("===MISSING:"):])
            elif line == "===TRUNC":
                truncated = True
                break
            elif line == "===END":
                break
        return {"files": files, "missing": missing,
                "truncated": truncated}

    async def _kb_files_batch_read(
        token: str, base: str, container: str, ws: str,
        paths: List[str],
    ) -> Optional[Dict[str, Any]]:
        """单次 exec 批量读（K1）。paths 已校验（相对路径、非敏感、
 ≤200）。通道挂 → None（调用方区分并回退旧逐文件路径）。"""
        paths = paths[:_KB_BATCH_MAX_PATHS]
        if not paths:
            return {"files": {}, "missing": [], "truncated": False}
        out = await _kb_exec_full(
            token, base, container,
            ["python3", "-c", _KB_BATCH_READ_SCRIPT, ws, *paths],
            timeout=60.0,
        )
        if out is None:
            return None
        text = _kb_batch_decode(out)
        if text is None:
            return None  # 信封损坏=通道挂（调用方回退逐文件路径）
        return _kb_parse_batch(text)

    async def _kb_workspace(token: str, base: str, agent: str) -> str:
        """探测 Agent 工作区路径（5min 缓存）。无则 404。"""
        now = time.time()
        hit = _kb_ws_cache.get(agent)
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
        # v0.5.0-beta.12 修：Controller Docker 代理不转 HEAD /containers/{name}/json
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
                _kb_ws_cache[agent] = {"ws": cand, "ts": now}
                return cand
        _kb_ws_cache.pop(agent, None)
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
        async with GatedAsyncClient(timeout=30.0, verify=False) as client:
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

    async def _kb_docker_available(token: str, base: str, container: str) -> bool:
        import time as _time
        now = _time.time()
        cached = _kb_docker_ok_cache.get(container)
        if cached and (now - cached[1]) < _KB_DOCKER_OK_TTL:
            return cached[0]
        try:
            st, _ = await _kb_docker(
                token, base, f"/containers/{container}/json", timeout=15.0,
            )
            ok = st not in (401, 403)
        except HTTPException:
            ok = False
        _kb_docker_ok_cache[container] = (ok, now)
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

    async def _kb_agents_ctl_fallback(token: str, base: str) -> Dict[str, Any]:
        """KB 形状兜底（Docker 通道不可用）：agent 清单=Controller workers API。

 v0.5.0-beta.14.2（-KB-500）：/kb/agents 的 Docker 降级路径此前误调
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
        # v0.5.0-beta.14.22（D4 #5/#8）：runtime 判定字段与主（Docker）
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

    # ── v0.5.0-beta.14.10：SWR 刷新/存储助手（tree/graph/agents 共用）──
    # 单飞：同 key 刷新任务在飞不重复起；刷新失败保旧值（磁盘缓存不覆写）。
    # _kb_swr_ttl_now() = 磁盘 stale 阈值（超过 → 触发后台刷新；未超旧值
    # 也先回，SWR 语义；v0.5.0-beta.14.22 起随 address_mode 自适应
    # wan=180s / 其余 60s）；内存缓存 TTL 以现有常量为准对齐（tree 30s /
    # graph 60s / agents 60s）。

    def _kb_swr_ttl_now() -> float:
        """v0.5.0-beta.14.22：SWR TTL 随生效网路自适应（见
 kb_swr_ttl_for）。配置读取走 load_config 读缓存（零磁盘）；异常回退
 内网值（TTL 不是安全边界，降级无害）。"""
        try:
            return kb_swr_ttl_for(
                config_mod.load_config().get("address_mode") or "auto")
        except Exception:  # noqa: BLE001
            return 60.0

    # ── v0.5.0-beta.14.11：轻探针（变更检测——变才刷）──────────
    # 刷新门前先跑轻探针：只列条目元数据（name/mtime/size，绝不读文件
    # 内容）。签名一致 → 只重置 60s 时钟（零深扫）；不一致/失败 → 深扫
    # （安全）。目录集 = tree 同款数据源（ws 顶层 + memory/ + digest/）。
    # 列取复用 tree 计算体同款双通道（find 主=零下载 + tar 兜底，参考其
    # 状态码/降级处理）——纯 archive 在大工作区（实测 180MB）必 413，
    # 探针将恒 None、优化失效，故以 tree 实际通道为准。
    async def _kb_probe_signature(agent: str) -> Optional[str]:
        """v0.5.0-beta.14.11：KB 轻探针——只列工作区顶层 +
 memory/ + digest/ 的条目元数据（name/mtime/size），不读文件内容。
 签名=排序后的 sha1；任何失败 → None（调用方退回深扫，安全）。
 复用 tree 计算体里同款 archive 列目录通道（参考其状态码/降级处理）。
 """
        if not _KB_AGENT_RE.match(agent):
            return None  # 与端点同款正则（agents 刷新 agent="" → 无探针）
        try:
            token, base = _kb_require_token()
        except HTTPException:
            return None
        container = (
            "agentteams-manager" if agent == "manager"
            else f"agentteams-worker-{agent}"
        )
        # 预探可用性沿用 _kb_docker_available（与 tree 同款）；失败 → None。
        if not await _kb_docker_available(token, base, container):
            return None
        try:
            ws = await _kb_workspace(token, base, agent)
        except HTTPException:
            return None
        parts: List[str] = []
        for sub in ("ws", "memory", "digest"):
            target = ws if sub == "ws" else f"{ws}/{sub}"
            maxdepth = 1 if sub == "ws" else None
            entries = None
            try:
                entries = await _kb_find_list(
                    token, base, container, target, maxdepth=maxdepth)
                if entries is None:  # find 通道挂 → tar 兜底（tree 同款）
                    entries = await _kb_tar_list(
                        token, base, container, target,
                        maxdepth=maxdepth, include_dirs=True)
            except Exception:  # noqa: BLE001 - 通道异常（413/502/连接错）
                # 一律按探针失败处理（退回深扫，安全）。
                entries = None
            if entries is None:
                if sub == "digest":
                    entries = []  # digest 缺失不报错（tree 同款 continue）
                else:
                    return None  # ws 顶层 / memory 不可用 → 深扫（安全）
            for e in entries:
                parts.append(
                    f"{sub}/{e['rel']}|{e['type']}|{e['size']}|{e['mtime']}"
                )
        import hashlib as _hashlib
        return _hashlib.sha1(
            "\n".join(sorted(parts)).encode("utf-8")
        ).hexdigest()

    def _store_kb(agent: str, payload: Dict[str, Any], kind: str,
                  probe: Optional[str] = None) -> None:
        """SWR 内存+磁盘同点写（端点冷取与后台刷新共用）。

 v0.5.0-beta.14.7 语义保留：#1208 WSF 兜底 payload（标记
 source:"controller"，见 _kb_tree_wsf_fallback）不写任何缓存——
 单点收口在此，后台刷新同样不会用降级值污染磁盘缓存。

 v0.5.0-beta.14.11：probe = 本次深扫时的轻探针签名；
 非 None 时一并落盘（下轮刷新门「变才刷」的比对基准）。端点冷取
 路径不跑探针（传 None）→ 不记，由下轮后台刷新的深扫补记。
 """
        if kind == "tree" and payload.get("source") == "controller":
            return
        # v0.5.0-beta.14.17（KBBATCH-K5）：file 的 WSF 兜底 payload 同样
        # 不缓存（14.7 不变式扩展到 file 支）。
        if kind == "file" and payload.get("source") == "controller":
            return
        if kind == "tree":
            _kb_tree_cache[agent] = (
                time.monotonic() + _KB_TREE_TTL_SECONDS, payload
            )
            kb_cache.save(f"tree-{agent}", payload)
        elif kind == "graph":
            _kb_graph_cache[agent] = (
                time.monotonic() + _KB_GRAPH_TTL_SECONDS, payload
            )
            kb_cache.save(f"graph-{agent}", payload)
        elif kind == "merged":  # v0.5.0-beta.14.17（KBBATCH-K3）：键=csv
            _kb_merged_cache[agent] = (
                time.monotonic() + _KB_MERGED_TTL_SECONDS, payload
            )
            kb_cache.save(f"merged-{agent}", payload)
            return  # 不记 last-agent / 探针（csv 非 agent 名）
        elif kind == "file":  # v0.5.0-beta.14.17（KBBATCH-K5）：键=agent/path
            _a, _, _p = agent.partition("/")
            _kb_file_cache[f"file-{_a}-{_p}"] = (
                time.monotonic() + _KB_FILE_TTL_SECONDS, payload
            )
            kb_cache.save(f"file-{_a}-{_p}", payload)
            return  # 不记 last-agent / 探针
        else:  # agents：agent 无关单键，不记 last-agent（仅 tree/graph
            # 访问计「上次访问」）
            _kb_agents_cache["agents"] = (
                time.monotonic() + _KB_AGENTS_TTL_SECONDS, payload
            )
            kb_cache.save("agents", payload)
            return
        kb_cache.save("last-agent", {"agent": agent})
        # v0.5.0-beta.14.11：记本次深扫的轻探针签名（端点
        # 冷取不跑探针 → probe=None 不记，下轮后台刷新补记）。agents 支
        # 已早退且 agent="" 探针恒 None → 天然不记。
        if probe is not None:
            kb_cache.save_probe(f"{kind}-{agent}", probe)

    def _spawn_kb_refresh(kind: str, agent: str) -> None:
        """SWR 后台单飞刷新（fire-and-forget；调用路径零等待）。

 计算体调用时从模块级注册表 _KB_PREWARM_HOOKS 解析（单测可换假
 计算体；T9 _ctl_get 同款唯一注入点）。
 """
        key = f"{kind}-{agent}" if agent else kind
        t = _kb_inflight.get(key)
        if t is not None and not t.done():
            return
        compute = _KB_PREWARM_HOOKS.get(kind)
        if compute is None:
            return  # 注册表未填（build_router 未完成）→ 跳过
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - 防御（T9 教训：无循环
            # 时先查循环再建协程，避免悬挂 coroutine 警告）
            logger.debug("kb %s refresh: no running event loop, skip", kind)
            return

        async def _run() -> None:
            try:
                # v0.5.0-beta.14.12：后台共用通道——执行期
                # 持锁（与两路 sweep 共享，同一时刻至多一路后台扫描）；
                # 前台忙让权/等锁超时 → 本轮放弃（单飞槽位由 finally
                # 释放，下轮重试）。
                async with bg_slot() as _bg:
                    if not _bg:
                        return
                    # v0.5.0-beta.14.11：变才刷——轻探针与上次
                    # 签名一致 → 只重置 60s 时钟，零深扫；不一致/探针失败 →
                    # 深扫（安全）。探针经注册表调用时解析（单测假注入）。
                    probe_fn = _KB_PROBE_HOOKS.get("probe") or _kb_probe_signature
                    probe = await probe_fn(agent)
                    if probe is not None and kb_cache.load_probe(key) == probe:
                        kb_cache.touch(key)
                        return
                    # agents 计算体无参（单键 agent 无关）；tree/graph 带 agent。
                    payload = (
                        await compute() if kind == "agents" else await compute(agent)
                    )
                    _store_kb(agent, payload, kind, probe=probe)
            except Exception as exc:  # noqa: BLE001 - 后台刷新失败保旧
                logger.debug("kb %s refresh failed for %s: %s", kind, agent, exc)
            finally:
                _kb_inflight.pop(key, None)
        _kb_inflight[key] = loop.create_task(_run())

    def _kb_prewarm_last(payload: Optional[Dict[str, Any]]) -> None:
        """v0.5.0-beta.14.23：/kb/agents 响应后后台预热 last-agent 的
 tree+graph——外网「打开知识库」时缓存大概率已暖（首屏 graph 冷读
 3–5s 的 WAN 往返）。last-agent 缺失/非 dict/空名/不在本次清单
 （防预热已删除的 agent）→ 静默跳过；单飞由 _spawn_kb_refresh 的
 _kb_inflight 保证（重复 /kb/agents 请求在飞即跳过）；异常全吞
 （预热失败不得影响主响应）。"""
        try:
            hit = kb_cache.load("last-agent")
            if hit is None:
                return
            meta = hit[1]
            agent = meta.get("agent") if isinstance(meta, dict) else None
            if not isinstance(agent, str) or not agent:
                return
            names = {
                str(a.get("name") or "")
                for a in ((payload or {}).get("agents") or [])
                if isinstance(a, dict)
            }
            if agent not in names:
                return
            asyncio.create_task(_kb_prewarm_agent(agent))
        except Exception as exc:  # noqa: BLE001
            logger.debug("kb last-agent prewarm skipped: %s", exc)

    @router.get("/kb/agents")
    async def kb_agents() -> Dict[str, Any]:
        """远端 Agent 清单：Docker 容器列表（agentteams-worker-* +
 agentteams-manager）+ Controller workers API 补 role/team。"""
        # v0.5.0-beta.14.10：SWR——60s 内存门 + 磁盘门（旧值
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
                _spawn_kb_refresh("agents", "")
            _resp = {**_payload, "cached": True, "age": int(_age)}
            _kb_prewarm_last(_resp)
            return _resp
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (_KB_PREWARM_HOOKS.get("agents")
                          or _kb_agents_compute)()
        _store_kb("", _payload, "agents")
        _kb_prewarm_last(_payload)
        return _payload

    async def _kb_agents_compute() -> Dict[str, Any]:
        # v0.5.0-beta.14.10：kb_agents 冷取计算体——原端点体逐字搬移
        # （原体无缓存写，抽取零 diff；缓存写收口在调用点 _store_kb）。
        token, base = _kb_require_token()
        # L2（403）/ Docker 挂（502）→ KB 形状兜底（worker 走 Controller；
        # manager L1-only 占位）。v0.5.0-beta.14.2（-KB-500）：旧代码误调
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
            async with GatedAsyncClient(timeout=8.0, verify=False) as client:
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
                # v0.5.0-beta.14.22（D4 #5/#8）：runtime 判定字段同批
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
        # v0.5.0-beta.14.7：tree 结果短 TTL 命中（重复访问零容器读）。
        _c = _kb_tree_cache.get(agent)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        # v0.5.0-beta.14.10：SWR 磁盘缓存——有旧数据先秒回
        # （cached/age 提示），超 TTL 触发后台单飞刷新；无则同步冷取。
        _disk = kb_cache.load(f"tree-{agent}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh("tree", agent)
            kb_cache.save("last-agent", {"agent": agent})
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (_KB_PREWARM_HOOKS.get("tree")
                          or _kb_tree_compute)(agent)
        _store_kb(agent, _payload, "tree")
        return _payload

    async def _kb_tree_compute(agent: str) -> Dict[str, Any]:
        # v0.5.0-beta.14.10：tree 冷取计算体——原端点「缓存门之后」
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
            if not await _kb_docker_available(token, base, container):
                return await _kb_tree_wsf_fallback(token, base, agent)
        ws = await _kb_workspace(token, base, agent)
        import urllib.parse as _up
        # （用户要求对齐 QwenPaw 最新版文件管理）：四分类——
        # 档案 = 6 个默认 workspace markdown（QwenPaw console
        # defaultWorkspaceMarkdown 同款清单，_KB_PROFILE_FILES——
        # v0.5.0-beta.14.17 K2 合并探测 stat 段共用）；日记 = memory/**
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
        # v0.5.0-beta.13.9 双通道：exec find 主（零下载，manager/worker 统一）
        # + tar 兜底（小工作区精确解析）。旧 worker 支整树 tar 在大工作区
        # （实测 180MB）必 413；旧 manager 支 exec-only 无兜底——同批处理。
        # v0.5.0-beta.14.17（KBBATCH-K2）：先试合并探测（1 exec = 顶层 +
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
                # v0.5.0-beta.13.10（13.9 知识库目录不全根因①）：
                # 符号链接此前被整条跳过（worker 工作区 shared →
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
        # 分支上方的原双通道取数（v0.5.0-beta.13.9 根因修保留）。
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
                # v0.5.0-beta.13.10：非文本文件同样列出（openable=False）——
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

        # v0.5.0-beta.13.10：不再按文本扩展名整体过滤——每条自带 openable
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
        # v0.5.0-beta.14.17（KBBATCH-K5）：kb_file 冷取计算体——原端点体
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
            if not await _kb_docker_available(token, base, container):
                res = await _wsf_read_file(token, base, agent, path)
                if res is None:
                    raise HTTPException(
                        status_code=404, detail=f"文件不存在：{path}")
                size, text = res
                return {"path": path, "size": size, "content": text,
                        "source": "controller"}
        ws = await _kb_workspace(token, base, agent)
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
        # v0.5.0-beta.14.17（KBBATCH-K5）：SWR 30s 内存+磁盘门（与
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
                _spawn_kb_refresh("file", f"{agent}/{path}")
            return {**_payload, "cached": True, "age": int(_age)}
        _payload = await (_KB_PREWARM_HOOKS.get("file")
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
        if not await _kb_docker_available(token, base, container):
            raise HTTPException(status_code=409, detail="Docker 通道不可用")
        ws = await _kb_workspace(token, base, agent)
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
 v0.5.0-beta.13.9），只返回一级子条目，深层跳过。"""
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
            if not await _kb_docker_available(token, base, container):
                return await _kb_ls_wsf_fallback(token, base, agent, dir)
        ws = await _kb_workspace(token, base, agent)
        target = f"{ws}/{dir}" if dir else ws
        # v0.5.0-beta.13.9 双通道（旧版 exec-only：通道挂时把传输失败误报
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
                # v0.5.0-beta.13.10：符号链接列全（目标=目录→可展开，
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
        # v0.5.0-beta.14.7：graph 结果短 TTL 命中（内部 kb_tree 亦命中树缓存）。
        _c = _kb_graph_cache.get(agent)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        # v0.5.0-beta.14.10：SWR 磁盘缓存（与 tree 同款门；
        # key=graph-{agent}）。
        _disk = kb_cache.load(f"graph-{agent}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh("graph", agent)
            kb_cache.save("last-agent", {"agent": agent})
            return {**_payload, "cached": True, "age": int(_age)}
        # 冷取经注册表取计算体（生产 = 本闭包；测试可假注入，与预热/
        # 刷新同一注入点）。
        _payload = await (_KB_PREWARM_HOOKS.get("graph")
                          or _kb_graph_compute)(agent)
        _store_kb(agent, _payload, "graph")
        return _payload

    async def _kb_graph_compute(agent: str) -> Dict[str, Any]:
        # v0.5.0-beta.14.10：graph 冷取计算体——原端点「缓存门之后」
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
        # v0.5.0-beta.14.17（KBBATCH-K1 接线）：N 个 md 冷拉——先试 K1
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
            # v0.5.0-beta.12：节点 description（首个非标题/标记行 = 文件
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
            # v0.5.0-beta.12：[[wiki#anchor]] 锚点捕获（移植 QwenPaw
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

    # ── v0.5.0-beta.12 ：团队知识库深化（跨 Worker 搜索 + 聚合图谱）──────────

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
        """v0.5.0-beta.12 ：团队知识全量搜索（跨 Worker）——扫各 Agent 的
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
        # v0.5.0-beta.14.17（KBBATCH-K3）：kb_graph_merged 冷取计算体——
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
        """v0.5.0-beta.12 ：团队聚合图谱——多 Agent 图谱合并（节点 id=
 agent::path，前端按 agent 着色；边保留在原 Agent 内）。
 agents=逗号分隔（缺省=全部，上限 8）；节点 400 / 边 800 上限。
 v0.5.0-beta.14.17（KBBATCH-K3）：SWR 30s 内存+磁盘门（与
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
        # v0.5.0-beta.14.17（KBBATCH-K3）：SWR 门（与 tree/graph 同款）。
        _c = _kb_merged_cache.get(csv)
        if _c and _c[0] > time.monotonic():
            return _c[1]
        _disk = kb_cache.load(f"merged-{csv}")
        if _disk is not None:
            _ts, _payload = _disk
            _age = time.time() - _ts
            if _age > _kb_swr_ttl_now():
                _spawn_kb_refresh("merged", csv)
            return {**_payload, "cached": True, "age": int(_age)}
        _payload = await (_KB_PREWARM_HOOKS.get("merged")
                          or _kb_merged_compute_wrapped)(csv)
        _store_kb(csv, _payload, "merged")
        return _payload

    # v0.5.0-beta.14.10：SWR 计算体 + 刷新入口注册入模块级表（端点
    # 调用时解析 / 单测假注入 / 启动预热 _kb_prewarm_agent 均读本表）。
    _KB_PREWARM_HOOKS.update({
        "refresh": _spawn_kb_refresh,
        "tree": _kb_tree_compute,
        "graph": _kb_graph_compute,
        "agents": _kb_agents_compute,
        # v0.5.0-beta.14.17（KBBATCH-K3/K5）：merged/file 冷取计算体注册
        # （单飞刷新与端点冷取同一注入点；签名=key 字符串）。
        "merged": _kb_merged_compute_wrapped,
        "file": _kb_file_compute_wrapped,
    })
    # v0.5.0-beta.14.11：轻探针注册（SWR 刷新门变更检测用）。
    _KB_PROBE_HOOKS.update({"probe": _kb_probe_signature})

    # 与 approval 域共享（任务 190）：交装配方转传。
    _kb_shared = {
        "agent_re": _KB_AGENT_RE,
        "require_token": _kb_require_token,
        "docker": _kb_docker,
        "docker_available": _kb_docker_available,
    }
    return router, _kb_shared
