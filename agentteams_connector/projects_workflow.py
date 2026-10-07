# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.9：projects-workflow 取数聚合器。

背景：前端装载/每 30s 对全部项目逐个打
GET /api/v1/projects/{id}/workflow?includeTasks=true（实测 36 路并发，
尾延迟 6-9s，多窗口各打一份）。改为连接器侧后台单点聚合（缓存 + 后台
刷 + 闸门），前端 1 请求取 {projects, workflows} 原始件，装配（
mapProjectWorkflow 等）仍在前端（零移植漂移）。

设计（完全照 worker_status（T9）的任务生命周期/快照/单飞模式）：

- tick 30s；sweep: GET /api/v1/projects（信封/裸数组兼容 + 按 project_id
 去重，与前端 fetchProjectSummaries 逐行对齐）→ 逐项目
 /workflow?includeTasks=true（teamQ 规则与前端真源一致）→ 快照。
- 名单/枚举失败：projects_status 记录（供前端横幅分类）、projects 保旧、
 scan_at 照常推进（避免 ensure_fresh 每次都重打）；workflows 保旧。
- 单项目失败：该 pid 保旧值（无旧值则不落 → 前端 mapProjectWorkflow
 跳过）。
- 取数复用 worker_status._ctl_get（本模块唯一取数注入点，测试 monkeypatch
 它；ordered failover + GatedAsyncClient 全局闸门与 T9 一致行为）。
- 扫描并发 4（Semaphore）；单飞：扫描中不重入；ensure_fresh
 fire-and-forget（端点路径零等待）；stop 优雅退出。
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional
from urllib.parse import quote as _quote

from . import config as config_mod
from . import router as router_mod
from . import worker_status
# v0.5.0-beta.14.19：tick 生命周期骨架抽 bg_aggregator.BgTicker
# （与 worker_status 去克隆）。本模块保留数据态 _snap 与扫描体
# _do_sweep；取数注入点仍复用 worker_status._ctl_get（测试 monkeypatch 面不变）。
from .bg_aggregator import BgTicker

logger = logging.getLogger(
    "qwenpaw.plugins.agentteams_qwenpaw_workbench.projects_workflow"
)

_TICK = 30.0  # 后台 tick 周期（秒）
_TTL = 30.0  # 快照新鲜度阈值（ensure_fresh 判据）
_CONCURRENCY = 4  # 扫描并发（与旧前端扇出同档）
_STARTUP_DELAY = 6.0  # 启动让行（比 worker_status 稍后，避开启动风暴）
_MAX_PROJECTS = 100  # 逐项目扇出安全上限（与旧前端 slice(0, 100) 一致）

_snap: Dict[str, Any] = {
    "projects": [],  # 去重后项目摘要列表（与前端 fetchProjectSummaries 语义一致）
    "workflows": {},  # {pid: wf raw json}
    "projects_status": 0,  # 最近一次 /projects 的 HTTP 状态（0=未跑）
    "projects_error": "",  # 失败 detail（供前端横幅分类）
    "scan_at": 0.0,
    "scanning": False,
}


def snapshot() -> Dict[str, Any]:
    """当前聚合快照（端点直读；不触发扫描）。"""
    return {
        "ok": True,
        "projects": _snap["projects"],
        "workflows": _snap["workflows"],
        "projectsStatus": _snap["projects_status"],
        "projectsError": _snap["projects_error"],
        "scanAt": int(_snap["scan_at"]),
        "scanning": bool(_snap["scanning"]),
    }


# 骨架实例在 _do_sweep 定义后构造（模块尾 _ticker = BgTicker(...)）；
# 模块级薄委托保持测试/前端既有注入点与断言面（pw._snap 状态容器、
# pw._sweep 直跑、snapshot 形状）。
_ticker: Optional[BgTicker] = None


def _ticker_ref() -> BgTicker:
    assert _ticker is not None, "projects_workflow ticker 未初始化（模块加载顺序）"
    return _ticker


def ensure_fresh(force: bool = False) -> None:
    """过期（或 force=True 无视 TTL）且未扫描中 → 起后台扫描
 （fire-and-forget；端点路径零等待）。实现见 BgTicker.ensure_fresh。"""
    _ticker_ref().ensure_fresh(force)


async def _sweep() -> None:
    """单飞门 + 后台共用通道（让权/90s 超时放弃本轮）。
 实现见 BgTicker._sweep；扫描体=_do_sweep（本模块）。"""
    await _ticker_ref()._sweep()


async def _do_sweep() -> None:
    """一轮：/projects（去重）→ 逐项目 /workflow?includeTasks=true → 快照。

 - 名单/枚举失败：projects_status 记录、projects 保旧、scan_at 照常
 推进（避免 ensure_fresh 每次都重打）；workflows 保旧。
 - 单项目失败：该 pid 保旧值（无旧值则不落 → 前端 mapProjectWorkflow
 跳过）。
 - teamQ 规则与前端真源一致：proj.team_id 非空 → "&team=<urlencode>"。
 """
    cfg = config_mod.load_config()
    try:
        token, _src = router_mod._resolve_controller_token(cfg)
    except Exception:  # noqa: BLE001 - token 内容非法 → 本轮不拨
        logger.info(
            "projects_workflow sweep: controller token 解析失败，跳过本轮"
        )
        return
    if not token:
        return  # 无 token → 不拨号（保旧表）

    base_urls = router_mod._ordered_addresses(cfg, "controller")
    if not base_urls:
        return  # 未配置 controller → 保旧表
    base = base_urls[0].rstrip("/")

    # 1) 项目名单（信封 {projects:[...], total} 兼容裸数组；失败记
    # 状态 + 保旧 + scan_at 照常推进）。
    st, data, text = await worker_status._ctl_get(
        f"{base}/api/v1/projects", token
    )
    if st != 200:
        logger.info(
            "projects_workflow sweep: 项目名单获取失败（%s），保留旧值", st
        )
        _snap["projects_status"] = int(st)
        _snap["projects_error"] = str(text or "")
        _snap["scan_at"] = time.time()
        return

    raw_list = (
        data
        if isinstance(data, list)
        else (data.get("projects", []) if isinstance(data, dict) else [])
    )
    # 去重与前端 fetchProjectSummaries 逐行对齐：同一 project_id
    # 留一条，优先带 team_id 的记录（它是 ?team= 寻址的有效键）。
    by_id: Dict[str, Any] = {}
    for p in raw_list:
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
    if not projects:
        # 空名单不轻信（端点异常可能返回空 → 会清掉全部工作流）；
        # 保旧表，scan_at 照常推进（T9 空名单同款语义）。
        logger.info("projects_workflow sweep: 项目名单为空，保留旧值")
        _snap["projects_status"] = 200
        _snap["projects_error"] = ""
        _snap["scan_at"] = time.time()
        return

    # 2) 逐项目 /workflow（并发 4）。
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def _one(proj: Dict[str, Any]) -> tuple:
        pid = str(proj.get("project_id") or "")
        team = proj.get("team_id")
        # teamQ 规则与前端真源一致：仅非空字符串 team_id 带 &team=
        # （独立项目 team_id 为空 → 不带参数）。
        team_q = (
            f"&team={_quote(team, safe='')}"
            if isinstance(team, str) and team
            else ""
        )
        url = (
            f"{base}/api/v1/projects/{_quote(pid, safe='')}/workflow"
            f"?includeTasks=true{team_q}"
        )
        async with sem:
            try:
                return await worker_status._ctl_get(url, token)
            except Exception:  # noqa: BLE001 - 单项目失败不影响同轮其他
                return (0, {}, "")

    results = await asyncio.gather(*[_one(p) for p in projects])

    # 3) 组装新表：成功覆盖、失败保旧、消失项目随新名单清。
    new_workflows: Dict[str, Any] = {}
    for proj, res in zip(projects, results):
        pid = str(proj.get("project_id") or "")
        wst, wdata, _wtext = res
        if wst == 200 and isinstance(wdata, dict):
            new_workflows[pid] = wdata
        else:
            old = _snap["workflows"].get(pid)
            if old is not None:
                new_workflows[pid] = old
            # 无旧值 → 不落（前端 mapProjectWorkflow 跳过该 pid）
    _snap["projects"] = projects
    _snap["workflows"] = new_workflows
    _snap["projects_status"] = 200
    _snap["projects_error"] = ""
    _snap["scan_at"] = time.time()


def start() -> None:
    """启动 tick 循环（幂等，进程内单实例）。由 plugin.register_startup_hook 调用。"""
    _ticker_ref().start()


async def stop() -> None:
    """停止 tick 循环。由 plugin.register_shutdown_hook 调用。"""
    await _ticker_ref().stop()


# 扫描体（_do_sweep）定义完成 → 骨架实例就位（启动让行 6s，晚于
# worker_status 3s，避开启动风暴）。
_ticker = BgTicker(
    "projects_workflow",
    _snap,
    _do_sweep,
    tick=_TICK,
    ttl=_TTL,
    startup_delay=_STARTUP_DELAY,
)
logger.info(
    "projects workflow aggregator configured (tick=%.0fs, ttl=%.0fs)",
    _TICK,
    _TTL,
)
