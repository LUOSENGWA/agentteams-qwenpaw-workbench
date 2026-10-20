# -*- coding: utf-8 -*-
"""KB 域数据通道纯 helper（无 per-build 状态）。

自 routers/kb_api.py build_kb_router 原体搬移：常量 + tar/find/profile
解析 + Docker archive/exec 通道 + 批量读通道。GatedAsyncClient 经
router_mod 模块对象调用时属性读（重绑定可见）；kb_api.py 保留装配壳。
"""
from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from .. import config as config_mod
from .. import router as router_mod
from ..router import (
    _headers_for,
    _kb_batch_decode,
    _ordered_addresses,
    _pick_address,
)


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

 ：单地址直拨改 ordered 地址
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
        # 该地址覆盖凭据（无则原生 Bearer）。
        headers = _headers_for(
            cfg, "controller", b, {"Authorization": f"Bearer {token}"}
        )
        try:
            async with router_mod.GatedAsyncClient(timeout=timeout, verify=False) as client:
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
    # 该地址覆盖凭据（无则原生 Bearer）。
    _cfg = config_mod.load_config()
    headers = _headers_for(
        _cfg, "controller", base, {"Authorization": f"Bearer {token}"}
    )
    try:
        async with router_mod.GatedAsyncClient(timeout=timeout, verify=False) as client:
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


def _kb_parse_find_lines(out: str) -> List[Dict[str, Any]]:
    """find -printf '%y %s %T@ %P' 行解析（_kb_find_list 主通道与
 KBBATCH-K2 合并探测共用——同一解析=同一语义：
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
 -H 跟随**命令行参数**层的符号链接（worker
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


# ── ：tree 合并探测 ─────────────────
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


# ── ：批量读（单次 exec 分帧）────────
# graph 冷取 = N 次逐文件 kb_file 往返（N=md 数，数十~上百）。批量读
# 把 N 次往返收进**单次** exec：容器内 python3 逐文件读，输出确定性
# 分帧 `===FRAME:<size>:<path>` + **恰好 size 字节**内容（帧边界由
# size 决定，内容含 ===FRAME: 字样也不串帧），总内容 ≤1.8MB（2MB
# 传输上限内留帧头余量），超限 `===TRUNC`。通道挂（None）→ 调用方
# 区分并回退旧逐文件路径。
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
