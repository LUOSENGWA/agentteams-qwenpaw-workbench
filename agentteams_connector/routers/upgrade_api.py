# -*- coding: utf-8 -*-
"""运行时升级域：/upgrade/{check,run,status}（per-worker，15.25 重接）。

10/17 实锤根因（用户反馈「运行时在线升级没接好，还要提示 QwenPaw only」）：
旧版=薄代理 127.0.0.1 回环宿主 ``/api/upgrade/*``（同宿主 agentteams-
upgrade 插件端点）——但 **worker 容器运行时并未加载该插件**（v1.2.5
``worker.py _prepare_default_plugins()`` 只 prepare matrix-channel/
teamharness/workerflow 三件，upgrade 漏接线——镜像里
``/opt/agentteams/plugins/agentteams-upgrade`` 存在但不注册，上游打包
缺口）。宿主回环 404 恒成立（本机 ``/api/upgrade/check`` 实测 404）。

重接方案（不依赖插件装载，直用镜像内置 CLI——正源同上游插件消费路径）：
- **check**：``docker exec`` worker 容器跑
  ``/opt/agentteams/scripts/check_qwenpaw_upgrade.py --target V --json``
  （无 version = 轻探：当前版本 + 脚本可用性）。
- **run**：``docker exec``（**detached**）跑
  ``/opt/agentteams/scripts/upgrade_qwenpaw_runtime.sh --target V
  --phase pre-restart --job-id J --state-file … --venv /opt/venv/qwenpaw
  --restart-mode kill``。两阶段链：pre-restart 装新版后 kill app 进程
  → 容器退出 → docker restart policy 拉起 → entrypoint 自动 boot-check/
  post-start（健康门 + 失败自动回滚）。state-file = on-disk 真相源。
- **status**：docker exec 读 state-file + pending.json。

QwenPaw only（用户点名提示）：worker CRD ``runtime != qwenpaw`` →
400「仅支持 qwenpaw 运行时」（升级脚本/venv/回滚链只对 QwenPaw 形态
成立；openclaw 原生等运行时拒绝并明确告知）。

安全（同 node-version/approval 域口径）：
- **L1 only**（docker exec 需 Controller admin 鉴权）——无 token 403。
- 命令=固定常量；worker 名/版本/job_id 正则白名单后才进 shell 串
  （零注入面）；version 形态 ``^[0-9][0-9A-Za-z.+-]{0,63}$``（拒绝
  空格/引号/$/分号）。
- run=破坏性（重启目标容器、中断在跑任务、失败自动回滚）——前端必须
  二次确认；本层保持 202 语义 + job 追踪。
"""
from __future__ import annotations

import asyncio
import re
import time
import uuid
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request

from .. import config as config_mod
from ..dial_gate import GatedAsyncClient
from ..router import (
    _headers_for,
    _ordered_addresses,
    _token_or_none,
    logger,
)

# worker 名（CRD 名域，同 node-version）。
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,62}$")
# 版本形态（PEP440 常规：数字开头，拒绝 shell 元字符）。
_VERSION_RE = re.compile(r"^[0-9][0-9A-Za-z.+\-]{0,63}$")
# job id（本层生成/回显：upg-<ts>-<rand6>）。
_JOB_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{3,63}$")

# working_dir 运行时自取（/proc/1/environ → QWENPAW_WORKING_DIR，
# 回退发行默认 /app/working）。docker exec 的进程环境≠app 进程环境
# （daemon 空环境）——upgrader sh 的 pending.json 默认路径依赖
# QWENPAW_WORKING_DIR，不显式传 --pending-file/--state-file 会落
# /upgrade/（entrypoint boot-check 读 /app/working/upgrade/ → 失联、
# 失败无自动回滚）。
_WRESOLVE = (
    "W=$(tr '\\0' '\\n' < /proc/1/environ | "
    "sed -n 's/^QWENPAW_WORKING_DIR=//p'); "
    '[ -n "$W" ] || W=/app/working; '
)

# checker 必须用 venv python（10/17 真机实锤：系统 python3 无
# qwenpaw_worker 模块 → ModuleNotFoundError；app 本体就跑在该 venv）。
_CHECK_PY = "/opt/venv/qwenpaw/bin/python3"

# 当前版本探测（qwenpaw venv 优先，copaw 回退）。
# 15.27 廉价化：主路径读 dist-info METADATA（不起 Python venv，真机实测
# 0.84s vs venv-python 2.37s——「检查更新」批量探 29 worker 冷启动
# 41s→~3s 的关键）。glob 必须在双引号外（"$d"/lib/python3*/…，引号内
# 不展开 glob）。dist-info 缺失（dev 安装）时回退 venv-python importlib。
_CURRENT_CMD = (
    'v=""; '
    'for d in /opt/venv/qwenpaw /opt/venv/copaw; do '
    '  v=$(cat "$d"/lib/python3*/site-packages/qwenpaw-*.dist-info/'
    'METADATA 2>/dev/null | grep -m1 "^Version:" | sed "s/^Version: *//"); '
    '  [ -n "$v" ] && break; '
    "done; "
    'if [ -z "$v" ]; then '
    '  for p in /opt/venv/qwenpaw/bin/python3 /opt/venv/copaw/bin/python3; do '
    '    [ -x "$p" ] || continue; '
    '    v=$("$p" -c \'import importlib.metadata as m;'
    'print(m.version("qwenpaw"))\' 2>/dev/null) && break; '
    "  done; "
    'fi; '
    'printf "%s" "$v"'
)

_CHECKER = "/opt/agentteams/scripts/check_qwenpaw_upgrade.py"
_UPGRADER = "/opt/agentteams/scripts/upgrade_qwenpaw_runtime.sh"
_VENV = "/opt/venv/qwenpaw"

# ── PyPI 元数据（latest + release 列表共用一次抓取，15.27 扩展）─────
# 「检查更新」= 当前(容器内 qwenpaw 运行时版) vs 最新稳定版 逐 worker 匹配。
# 注意 image tag（如 v1.2.5）是 AgentTeams 镜像版，≠qwenpaw 运行时版
# （如 2.2.1），不能拿它比 PyPI qwenpaw latest（恒误判可升级）。
# 服务端拉取（浏览器内网常连不上外网 registry），10min 缓存 + 断网回退
# 旧缓存（stale）。缓存体 = {version: 最新稳定版, releases: {v: {
# upload_time, size, yanked}}, fetched_at}（PyPI /pypi/qwenpaw/json 的
# info.version + releases 字典）——版本表格（/upgrade/versions）与
# latest（/upgrade/latest）同源，一次网络往返两用。
_PYPY_LATEST_URL = "https://pypi.org/pypi/qwenpaw/json"
_LATEST_TTL = 600.0  # 10 分钟
_latest_cache: Dict[str, Any] = {
    "version": None, "releases": None, "fetched_at": 0.0}

# 预发布判定：任一版本段形如 [数字]*{a|alpha|b|beta|c|rc|dev|pre|preview}[数字]*
# （覆盖 2.3.0rc1 / 1.2.5b2 / rc1 / preview 等；post-release 不算预发布）。
_PRE_TAG_RE = re.compile(
    r"^\d*(?:a|alpha|b|beta|c|rc|dev|pre|preview)\d*$", re.IGNORECASE)


def _is_prerelease(version: str) -> bool:
    for seg in re.split(r"[.\-+]", version):
        if _PRE_TAG_RE.match(seg):
            return True
    return False


# 逐 worker 轻探结果缓存（10min TTL；upgrade run 启动后逐 worker 失效）。
# 「检查更新」二次点击=命中缓存零 exec（服务端本地匹配，毫秒级）。
_probe_cache: Dict[str, Dict[str, Any]] = {}
_PROBE_TTL = 600.0

# worker 列表短缓存（60s TTL）：check-all 每次点击都拉 /api/v1/workers，
# 而该端点在 29-worker 集群上实测 2–2.9s（controller 侧查询开销）——缓存
# 后重复点击=worker 列表+探测+PyPI 三重全命中=纯本地匹配（毫秒级）。
# 60s 内 worker 增删对「检查更新」视图可忽略（前端另有实时 worker 列表）。
_worker_list_cache: Dict[str, Any] = {"items": None, "at": 0.0}
_WORKER_LIST_TTL = 60.0


async def _fetch_worker_list(token: str) -> list:
    """worker 列表（60s TTL 缓存；失败不缓存、抛 502）。"""
    now = time.time()
    if _worker_list_cache.get("items") is not None and \
            (now - float(_worker_list_cache.get("at") or 0.0)) < _WORKER_LIST_TTL:
        return _worker_list_cache["items"]
    st, r, err = await _ctl_call(token, "GET", "/api/v1/workers?limit=40")
    if st != 200 or r is None:
        raise HTTPException(
            status_code=502, detail=f"worker 列表查询失败：{err}")
    body = r.json() if hasattr(r, "json") else {}
    items = body.get("workers") if isinstance(body, dict) else body
    if not isinstance(items, list):
        items = []
    _worker_list_cache["items"] = items
    _worker_list_cache["at"] = now
    return items


async def _fetch_pypi() -> Dict[str, Any]:
    """PyPI qwenpaw 元数据（TTL 缓存；断网回退旧缓存）。

    返回 {data, from_cache, stale, error}：
    data={version, releases}|None；stale=True=断网回退旧缓存。
    """
    now = time.time()
    cached_version = _latest_cache.get("version")
    if cached_version and (
            now - float(_latest_cache.get("fetched_at") or 0.0)) < _LATEST_TTL:
        return {"data": {"version": cached_version,
                         "releases": _latest_cache.get("releases") or {}},
                "from_cache": True, "stale": False, "error": ""}
    data: Optional[Dict[str, Any]] = None
    err = ""
    try:
        async with GatedAsyncClient(timeout=20.0) as client:
            r = await client.get(_PYPY_LATEST_URL)
        if r.status_code != 200:
            err = f"PyPI {r.status_code}"
        else:
            body = r.json() or {}
            info = body.get("info") or {}
            version = str(info.get("version") or "").strip() or None
            releases_raw = body.get("releases") or {}
            releases: Dict[str, Dict[str, Any]] = {}
            for v, files in releases_raw.items():
                files = list(files or [])
                if not files:
                    continue
                f0 = files[0] or {}
                releases[str(v)] = {
                    "upload_time": str(
                        f0.get("upload_time_iso_8601")
                        or f0.get("upload_time") or "")[:10],
                    "size": int(f0.get("size") or 0),
                    "yanked": bool(f0.get("yanked")),
                }
            if version:
                data = {"version": version, "releases": releases}
            else:
                err = "PyPI 响应无 version"
    except Exception as exc:  # noqa: BLE001 - 断网/DNS/超时
        err = f"请求失败：{exc}"
    if data:
        _latest_cache["version"] = data["version"]
        _latest_cache["releases"] = data["releases"]
        _latest_cache["fetched_at"] = now
        return {"data": data, "from_cache": False, "stale": False,
                "error": ""}
    # PyPI 失败（非 200 / 无 version / 断网）→ 有旧缓存则回退 stale。
    if cached_version:
        logger.warning("pypi 元数据不可达(%s)，回退缓存", err)
        return {"data": {"version": cached_version,
                         "releases": _latest_cache.get("releases") or {}},
                "from_cache": True, "stale": True,
                "error": f"PyPI 不可达（{err}），回退缓存"}
    return {"data": None, "from_cache": False, "stale": False,
            "error": err or "PyPI 不可达"}


def _check_cmd(version: str, verify: bool) -> str:
    extra = " --download" if verify else ""
    return (
        f"[ -f {_CHECKER} ] || {{ printf 'CHECKER_MISSING'; exit 3; }}; "
        f"{_CHECK_PY} {_CHECKER} --target {version} --json{extra}"
    )


def _run_cmd(version: str, job_id: str) -> str:
    # state/pending 显式绝对路径（$W 由本 sh -c 层展开；子 sh 的
    # QWENPAW_WORKING_DIR 为空，默认路径会错——见 _WRESOLVE 注释）。
    state = f"$W/upgrade/upgrade-{job_id}.json"
    pending = "$W/upgrade/pending.json"
    log = f"$W/upgrade/upgrade-{job_id}.log"
    return (
        f"[ -f {_UPGRADER} ] || {{ printf 'UPGRADER_MISSING'; exit 3; }}; "
        + _WRESOLVE
        + f'mkdir -p "$W/upgrade" && '
        f"nohup sh {_UPGRADER} --target {version} --phase pre-restart "
        f"--job-id {job_id} --state-file {state} --pending-file {pending} "
        f"--venv {_VENV} --restart-mode kill "
        f'>> "{log}" 2>&1 & printf OK'
    )


def _status_cmd(job_id: Optional[str]) -> str:
    if job_id:
        head = (
            f'if [ -f "$W/upgrade/upgrade-{job_id}.json" ]; then '
            f'cat "$W/upgrade/upgrade-{job_id}.json"; '
            "else printf MISSING; fi"
        )
    else:
        head = (
            "f=$(ls -t \"$W\"/upgrade/upgrade-*.json 2>/dev/null | head -1); "
            '[ -n "$f" ] && cat "$f" || printf MISSING'
        )
    return _WRESOLVE + head + '; printf "\\n---PENDING---\\n"; ' \
        '[ -f "$W/upgrade/pending.json" ] && cat "$W/upgrade/pending.json"; true'


def _parse_exec_stream(raw: bytes) -> str:
    """docker exec 非 TTY 流：8 字节帧头+载荷；<8 字节=裸文本。"""
    if len(raw) < 8:
        return raw.decode("utf-8", "replace")
    out: list[bytes] = []
    i = 0
    while i + 8 <= len(raw):
        ln = int.from_bytes(raw[i + 4:i + 8], "big")
        i += 8
        if ln == 0:
            continue
        out.append(raw[i:i + ln])
        i += ln
    if i < len(raw):
        out.append(raw[i:])
    return b"".join(out).decode("utf-8", "replace")


def _new_job_id() -> str:
    return f"upg-{int(time.time())}-{uuid.uuid4().hex[:6]}"


async def _ctl_call(token: str, method: str, path: str,
                    json_body: Optional[dict] = None,
                    timeout: float = 25.0):
    """controller 地址 failover → (status, response|None, err)。

    模块级（15.27 提级）：runtime_env_api 等只读域同通道复用。
    """
    urls = [u.rstrip("/") for u in _ordered_addresses(
        config_mod.load_config(), "controller")]
    if not urls:
        return 0, None, "未配置 Controller 地址"
    last_err = ""
    for b in urls:
        try:
            headers = _headers_for(
                config_mod.load_config(), "controller", b,
                {"Authorization": f"Bearer {token}"})
            async with GatedAsyncClient(timeout=timeout,
                                        verify=False) as client:
                if method == "POST":
                    r = await client.post(
                        f"{b}{path}", json=json_body, headers=headers)
                else:
                    r = await client.get(f"{b}{path}", headers=headers)
        except Exception as exc:  # noqa: BLE001 - try next address
            last_err = f"请求失败：{exc}"
            continue
        if r.status_code < 500:
            return r.status_code, r, ""
        last_err = f"Controller {r.status_code}"
    return 0, None, last_err or "请求失败"


async def _exec(token: str, container: str, cmd: str,
                detach: bool = False,
                timeout: float = 60.0) -> Tuple[int, str]:
    """docker exec（attach 读 stdout / detached 后台存活）→ (status, text)。

    模块级（15.27 提级）：runtime_env_api 等只读域同通道复用。
    """
    st1, r1, err = await _ctl_call(
        token, "POST",
        f"/docker/v1.41/containers/{container}/exec",
        json_body={"Cmd": ["sh", "-c", cmd],
                   "AttachStdout": True, "AttachStderr": True,
                   "Detach": detach},
        timeout=timeout)
    if st1 in (403, 404):
        raise HTTPException(
            status_code=502,
            detail=f"容器 {container} Docker API {st1}"
                   "（容器不存在或 L1 鉴权失败）")
    if st1 != 200 and st1 != 201:
        raise HTTPException(status_code=502, detail=err or f"Docker {st1}")
    eid = ((r1.json() or {}).get("Id")) if r1 is not None else None
    if not eid:
        raise HTTPException(status_code=502, detail="exec 创建无 Id")
    st2, r2, err2 = await _ctl_call(
        token, "POST", f"/docker/v1.41/exec/{eid}/start",
        json_body={"Detach": detach, "Tty": False}, timeout=timeout)
    if st2 != 200:
        raise HTTPException(status_code=502, detail=err2 or f"exec {st2}")
    if detach:
        return st2, ""
    raw = r2.content if r2 is not None else b""
    return st2, _parse_exec_stream(raw)


async def _light_probe(token: str, worker: str,
                       semaphore: Optional[asyncio.Semaphore] = None
                       ) -> Dict[str, Any]:
    """轻探：当前 qwenpaw 运行时版 + checker/upgrader 脚本可用性。

    命中未过期缓存 → 零 exec 直接返回（cached=True）；否则 exec 一次并
    缓存 10min。check-all 批量并发走 semaphore；单 worker 轻探直接调。
    失败（exec/容器错误）抛 HTTPException，不缓存。
    """
    now = time.time()
    hit = _probe_cache.get(worker)
    if hit and (now - float(hit.get("at") or 0.0)) < _PROBE_TTL:
        return {**hit, "cached": True}

    async def _do() -> Dict[str, Any]:
        container = f"agentteams-worker-{worker}"
        st, text = await _exec(
            token, container,
            _CURRENT_CMD + "; printf '\\n'; "
            f'[ -f {_CHECKER} ] && printf "HAS\\n" || printf "NONE\\n"; '
            f'[ -f {_UPGRADER} ] && printf "HAS\\n" || printf "NONE\\n"',
            timeout=60.0)
        parts = [p.strip() for p in text.strip().splitlines()]
        return {
            "current": parts[0] if len(parts) > 0 and parts[0] else None,
            "checker": parts[1] if len(parts) > 1 else None,
            "upgrader": parts[2] if len(parts) > 2 else None,
            "supported": bool(parts) and bool(parts[0])
            and len(parts) > 2 and parts[1] == "HAS" and parts[2] == "HAS",
            "at": time.time(),
        }

    if semaphore is not None:
        async with semaphore:
            result = await _do()
    else:
        result = await _do()
    _probe_cache[worker] = result
    return {**result, "cached": False}


def build_upgrade_router() -> APIRouter:
    router = APIRouter()

    async def _worker_runtime(token: str, worker: str) -> str:
        """worker CRD runtime（qwenpaw only 门控正源）。"""
        st, r, err = await _ctl_call(
            token, "GET", f"/api/v1/workers/{worker}")
        if st != 200 or r is None:
            raise HTTPException(
                status_code=404, detail=f"worker 不存在或查询失败：{err}")
        data = r.json() if hasattr(r, "json") else {}
        runtime = str((data or {}).get("runtime") or "")
        return runtime

    async def _guard_qwenpaw(token: str, worker: str) -> None:
        """QwenPaw only 门控（用户点名：非 qwenpaw 明确拒绝并提示）。"""
        runtime = await _worker_runtime(token, worker)
        if runtime and runtime != "qwenpaw":
            raise HTTPException(
                status_code=400,
                detail=f"仅支持 qwenpaw 运行时升级（当前 runtime={runtime}）")

    @router.get("/upgrade/latest")
    async def upgrade_latest(request: Request) -> Dict[str, Any]:
        """最新稳定 qwenpaw 版本（PyPI info.version，10min 缓存）。

        L1 only（与 check/run/status 同域门控：运行时升级面板是 L1 面）。
        当前版本不走此端点——check/check-all 轻探经容器 exec 读 qwenpaw
        运行时版（image tag ≠ qwenpaw 运行时版，不能拿 tag 匹配）。
        断网时回退旧缓存（stale 标记）。
        """
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能执行升级操作")
        meta = await _fetch_pypi()
        data = meta["data"]
        if not data:
            raise HTTPException(
                status_code=502,
                detail=f"无法查询最新版本：{meta['error']}")
        out: Dict[str, Any] = {
            "latest": data["version"], "source": "pypi",
            "cached": meta["from_cache"],
            "fetched_at": _latest_cache.get("fetched_at"),
        }
        if meta["stale"]:
            out["stale"] = True
            out["error"] = meta["error"]
        return out

    @router.get("/upgrade/versions")
    async def upgrade_versions(request: Request) -> Dict[str, Any]:
        """qwenpaw release 列表（版本表格数据源）。

        L1 only。PyPI releases 字典按上传时间倒序取前 30 条；每项
        {version, upload_time, size, prerelease, yanked, is_latest}——
        前端 antd.Table 点选目标版本（默认锚定 latest），替代自由文本
        输入（自定义 tag 走前端高级兜底输入）。与 /upgrade/latest 同一
        PyPI 缓存（零额外网络往返）。
        """
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能执行升级操作")
        meta = await _fetch_pypi()
        data = meta["data"]
        if not data:
            raise HTTPException(
                status_code=502,
                detail=f"无法查询版本列表：{meta['error']}")
        latest = data["version"]
        rows = []
        for v, info in (data.get("releases") or {}).items():
            rows.append({
                "version": v,
                "upload_time": info.get("upload_time") or "",
                "size": int(info.get("size") or 0),
                "prerelease": _is_prerelease(v),
                "yanked": bool(info.get("yanked")),
                "is_latest": v == latest,
            })
        rows.sort(key=lambda r: (r["upload_time"], r["version"]),
                  reverse=True)
        out: Dict[str, Any] = {
            "versions": rows[:30],
            "latest": latest,
            "source": "pypi",
            "cached": meta["from_cache"],
            "fetched_at": _latest_cache.get("fetched_at"),
        }
        if meta["stale"]:
            out["stale"] = True
            out["error"] = meta["error"]
        return out

    @router.get("/upgrade/check-all")
    async def upgrade_check_all(request: Request) -> Dict[str, Any]:
        """批量检查更新：一次调用=全部 worker 当前版+latest 本地匹配。

        设计（15.27 定案「读到现在版本→本机匹配」）：
        - 当前版本：服务端批量轻探（并发 10，逐 worker 失败不阻塞整体）
          + 10min 服务端缓存——二次「检查更新」= 零 exec 毫秒级；
        - latest：PyPI 10min 缓存（断网 stale 回退；latest 缺失时
          worker 侧仍返回，匹配列前端降级）；
        - 匹配在服务端响应组装+前端展示完成，浏览器零轮询。
        L1 only。
        """
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能执行升级操作")
        items = await _fetch_worker_list(token)
        meta = await _fetch_pypi()
        sem = asyncio.Semaphore(10)
        # 先按 items 顺序建全部 row（输出序不变）；非 qwenpaw 行标 skipped，
        # qwenpaw（含 runtime 缺省）行待探。
        rows: list[Dict[str, Any]] = []
        probe_idx: list[int] = []
        for w in items:
            w = w or {}
            name = str(w.get("name") or "")
            if not _NAME_RE.match(name):
                continue
            runtime = str(w.get("runtime") or "")
            row: Dict[str, Any] = {
                "name": name,
                "image": w.get("image") or "",
                "runtime": runtime,
            }
            rows.append(row)
            if runtime and runtime != "qwenpaw":
                row["skipped"] = True
            else:
                probe_idx.append(len(rows) - 1)
        # 关键（15.27 修「检查更新慢」真根）：gather 并行探测（sem 限并发
        # 10），而非 for 循环逐个 await（=串行，29 worker 冷探 41s）。
        # 并行后冷探 ≈ ceil(29/10)×0.8s ≈ 3s；暖态命中缓存=0 exec 毫秒级。
        if probe_idx:
            async def _probe_one(idx: int) -> None:
                row = rows[idx]
                try:
                    row.update(await _light_probe(token, row["name"], sem))
                except HTTPException as exc:
                    row["error"] = str(exc.detail or exc)
            await asyncio.gather(*[_probe_one(i) for i in probe_idx])
        out: Dict[str, Any] = {
            "workers": rows,
            "latest": meta["data"]["version"] if meta["data"] else None,
            "source": "pypi",
            "cached": meta["from_cache"],
            "fetched_at": _latest_cache.get("fetched_at"),
        }
        if meta["stale"]:
            out["stale"] = True
        if not out["latest"]:
            out["error"] = meta["error"] or "PyPI 不可达（无缓存）"
        elif meta["stale"]:
            out["error"] = meta["error"]
        return out

    @router.get("/upgrade/check")
    async def upgrade_check(request: Request) -> Dict[str, Any]:
        """预检。worker 必填；version 缺省=轻探（当前版本+脚本可用性），
        带 version=完整 gate 检查（checker --json）；verify=1 附加
        --download wheel 可达性（慢，客户端超时放宽）。"""
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能执行升级操作")
        worker = request.query_params.get("worker", "").strip()
        if not worker or not _NAME_RE.match(worker):
            raise HTTPException(status_code=400, detail="worker 名称非法")
        container = f"agentteams-worker-{worker}"
        await _guard_qwenpaw(token, worker)
        raw_version = request.query_params.get("version")
        verify = request.query_params.get("verify") == "1"
        if raw_version is not None:
            # 显式传空 = 非法输入（400）；未传 = 轻探（当前版本+脚本可用性）。
            if not _VERSION_RE.match(raw_version.strip()):
                raise HTTPException(status_code=400, detail="版本号非法")
        version = (raw_version or "").strip()
        if version:
            timeout = 300.0 if verify else 120.0
            st, text = await _exec(
                token, container, _check_cmd(version, verify),
                timeout=timeout)
            if "CHECKER_MISSING" in text:
                raise HTTPException(
                    status_code=404,
                    detail="worker 镜像缺少升级检查脚本（<1.2.5 镜像）")
            try:
                # checker 可能先吐一行 note（stderr 并入）——取首个 JSON 对象。
                start = text.find("{")
                data = __import__("json").loads(text[start:]) if start >= 0 \
                    else None
            except Exception:  # noqa: BLE001
                data = None
            payload: Dict[str, Any] = {
                "worker": worker,
                "container": container,
                "version": version,
                "check": data,
                "raw": None if data else text[:2000],
            }
            return payload
        # 轻探：当前版本 + 脚本存在性（共享 check-all 缓存：命中=零 exec）。
        probe = await _light_probe(token, worker)
        return {
            "worker": worker,
            "container": container,
            "current": probe.get("current"),
            "checker": probe.get("checker"),
            "upgrader": probe.get("upgrader"),
            "supported": probe.get("supported", False),
            "cached": probe.get("cached", False),
        }

    @router.post("/upgrade/run", status_code=202)
    async def upgrade_run(request: Request) -> Dict[str, Any]:
        """触发两阶段升级（detached）。破坏性：目标容器会重启、在跑任务
        中断、失败自动回滚——UI 须二次确认。"""
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能执行升级操作")
        try:
            raw = await request.json()
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400,
                                detail="body must be a JSON object")
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400,
                                detail="body must be a JSON object")
        worker = str(raw.get("worker") or "").strip()
        version = str(raw.get("version") or "").strip()
        if not worker or not _NAME_RE.match(worker):
            raise HTTPException(status_code=400, detail="worker 名称非法")
        if not version or not _VERSION_RE.match(version):
            raise HTTPException(status_code=400, detail="版本号非法")
        container = f"agentteams-worker-{worker}"
        await _guard_qwenpaw(token, worker)
        job_id = _new_job_id()
        st, text = await _exec(
            token, container, _run_cmd(version, job_id),
            detach=True, timeout=30.0)
        # 升级启动=当前版即将变化：逐 worker 失效轻探缓存（防 10min 内
        # 「检查更新」回显升级前的旧版本）。
        _probe_cache.pop(worker, None)
        logger.info("upgrade run: worker=%s version=%s job=%s",
                    worker, version, job_id)
        return {
            "job_id": job_id,
            "worker": worker,
            "container": container,
            "version": version,
            "state": "running",
            "detail": "已启动后台升级；容器将在安装完成后重启（两阶段链）",
        }

    @router.get("/upgrade/status")
    async def upgrade_status(request: Request) -> Dict[str, Any]:
        """job 状态（state-file on-disk 真相源，跨容器重启可读）。
        job_id 缺省=最近一个 job；无 job → 404 job_not_found。"""
        token = _token_or_none(config_mod.load_config())
        if not token:
            raise HTTPException(
                status_code=403,
                detail="需要 Controller 管理员 token（L1）才能执行升级操作")
        worker = request.query_params.get("worker", "").strip()
        if not worker or not _NAME_RE.match(worker):
            raise HTTPException(status_code=400, detail="worker 名称非法")
        job_id = request.query_params.get("job_id", "").strip()
        if job_id and not _JOB_RE.match(job_id):
            raise HTTPException(status_code=400, detail="job_id 非法")
        container = f"agentteams-worker-{worker}"
        st, text = await _exec(
            token, container, _status_cmd(job_id or None), timeout=30.0)
        if "MISSING" in text.split("---PENDING---")[0]:
            raise HTTPException(
                status_code=404, detail="job_not_found")
        import json as _json

        head, _, tail = text.partition("---PENDING---")
        state = None
        try:
            state = _json.loads(head.strip())
        except Exception:  # noqa: BLE001
            state = {"raw": head.strip()[:2000]}
        pending = None
        ptail = tail.strip()
        if ptail:
            try:
                pending = _json.loads(ptail)
            except Exception:  # noqa: BLE001
                pending = {"raw": ptail[:1000]}
        return {
            "worker": worker,
            "container": container,
            "job_id": job_id or (state.get("job_id") if isinstance(
                state, dict) else None),
            "state": state,
            "pending": pending,
        }

    return router
