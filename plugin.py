# -*- coding: utf-8 -*-
"""AgentTeams QwenPaw Workbench backend plugin entry point.

Registered capabilities (v0.5.0-beta.12):

- ``register_http_router`` → ``/agentteams-proxy/*`` (config/login/连通性/
 selfcheck L0-L4/Matrix 代理/Controller 透传/workflow-events/teams-sync/
 房间 SSE/DM/上传/通知/sglang-loads)
- ``register_slash_command("selfcheck")`` → run L0-L2 from the chat input
- ``register_tool("agentteams_qwenpaw_workbench_status")`` → agent 工具：查询当前
 登录用户的团队/房间/Worker 树状态（overview|rooms|teams；默认关闭）

The frontend entry (``dist/index.js``) renders the workbench page at
``/apps/agentteams-qwenpaw-workbench``.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

from qwenpaw.plugins.api import PluginApi

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")

_PLUGIN_DIR = Path(os.path.dirname(os.path.abspath(__file__)))


def _ensure_importable() -> None:
    """Expose the bundled ``agentteams_connector`` package on ``sys.path``."""
    plugin_dir = str(_PLUGIN_DIR)
    if plugin_dir not in sys.path:
        sys.path.insert(0, plugin_dir)


async def _selfcheck_handler(ctx: Any, args: Any) -> Any:
    """Slash command handler: /selfcheck [l0|l1|l2|all]."""
    from agentteams_connector import config as config_mod
    from agentteams_connector import selfcheck

    level = (args or "").strip().lower() or "all"
    cfg = config_mod.load_config()
    if level == "l0":
        result = selfcheck.run_l0()
    elif level == "l1":
        result = selfcheck.run_l1(cfg)
    elif level == "l2":
        result = selfcheck.run_l2(cfg)
    else:
        result = selfcheck.run_all(cfg)

    lines = ["AgentTeams 自检结果："]
    if "levels" in result:
        for lv in result["levels"]:
            lines.append(f"  {lv['level']}: {'✅' if lv['ok'] else '❌'}")
            for check in lv["checks"]:
                mark = "✅" if check["ok"] else "❌"
                detail = check.get("detail", "")
                hint = check.get("hint")
                line = f"    {mark} {check['name']}"
                if detail:
                    line += f" — {detail}"
                if hint:
                    line += f"（{hint}）"
                lines.append(line)
    else:
        for check in result["checks"]:
            mark = "✅" if check["ok"] else "❌"
            lines.append(f"  {mark} {check['name']} — {check.get('detail', '')}")

    # Slash command handler contract（QwenPaw 2.1 源码：runtime/slash_command_registry.py
    # CommandHandler = (HookContext, str) -> Awaitable[Msg | None]，Msg = agentscope.message
    # pydantic 模型，content 必须是 list[Block]）——宿主 builtin_commands.py 同款写法。
    from agentscope.message import Msg, TextBlock

    return Msg(
        name="assistant",
        role="assistant",
        content=[TextBlock(type="text", text="\n".join(lines))],
    )


class AgentTeamsWorkbenchPlugin:
    """Registers the proxy router and the /selfcheck slash command."""

    def register(self, api: PluginApi) -> None:
        _ensure_importable()

        from agentteams_connector import __version__
        from agentteams_connector.router import build_router
        from agentteams_connector import sync_watcher

        api.register_http_router(
            build_router(),
            prefix="/agentteams-proxy",
            tags=["agentteams-qwenpaw-workbench"],
        )

        # v0.5.0-beta.12: agent 工具——补齐 plugin.json 声明（此前声明无实现=漂移）。
        # 默认关闭（enabled=False，用户在 agent 工具面板显式启用）；
        # 零 LLM 部署下无调用者，纯通用性能力（有 LLM 的宿主可让 agent 查团队状态）。
        from agentteams_connector import tools

        api.register_tool(
            tool_name="agentteams_qwenpaw_workbench_status",
            tool_func=tools.agentteams_qwenpaw_workbench_status,
            description=(
                "Query AgentTeams team status (rooms/members/worker tree) "
                "for the current logged-in user. scope: overview|rooms|teams."
            ),
            icon="🏢",
            enabled=False,
            tool_type="network",
        )

        # IM 式事件触发（30s 轮询太笨）：后台 /sync 长轮询
        # 循环，@提到我 → 写宿主收件箱 + SSE 推前端（events）。
        api.register_startup_hook(
            "agentteams-sync-watcher",
            lambda: sync_watcher.start(),
            priority=200,
        )
        api.register_shutdown_hook(
            "agentteams-sync-watcher",
            lambda: sync_watcher.stop(),
        )

        # v0.5.0-beta.12 宿主收件箱审批桥——Worker 工具审批请求
        # → 宿主收件箱（导航抖动+红点+审批条目+一键批准/拒绝）。
        # 特性探测降级：宿主无 create_pending_summary（<2.1）→ 整桥静默
        # 禁用，插件内审批卡不受影响。
        from agentteams_connector import host_bridge

        host_bridge.init()

        # v0.5.0-beta.12: 后台地址自动重排（外/内网切换自动识别，用户需求）：
        # 每 120s 并行探测全部配置地址测延迟，最快可达者生效（防抖滞回）。
        from agentteams_connector import address_probe

        api.register_startup_hook(
            "agentteams-address-probe",
            lambda: address_probe.start(),
            priority=210,
        )
        api.register_shutdown_hook(
            "agentteams-address-probe",
            lambda: address_probe.stop(),
        )

        # v0.5.0-beta.14.9：Worker 状态聚合扫描（前端状态灯的
        # 扇出收敛——连接器侧单点扫描 + /workers-status 单端点）。
        from agentteams_connector import worker_status

        api.register_startup_hook(
            "agentteams-worker-status",
            lambda: worker_status.start(),
            priority=220,
        )
        api.register_shutdown_hook(
            "agentteams-worker-status",
            lambda: worker_status.stop(),
        )

        # v0.5.0-beta.14.9：项目+工作流取数聚合扫描（工作流
        # 列表逐项目 36 路 /workflow 扇出收敛——连接器侧单点扫描 +
        # /projects-workflow 单端点）。
        from agentteams_connector import projects_workflow

        api.register_startup_hook(
            "agentteams-projects-workflow",
            lambda: projects_workflow.start(),
            priority=230,
        )
        api.register_shutdown_hook(
            "agentteams-projects-workflow",
            lambda: projects_workflow.stop(),
        )

        # v0.5.0-beta.14.10：KB 预热——上次访问的 agent 后台
        # 静默补 tree+graph（重启后首开知识库同样秒开）。fire-and-forget、
        # 预热失败无碍；不依赖 HTTP 自呼（直调 router 模块 _kb_prewarm_agent
        # → 注册表计算体，见 router.py _KB_PREWARM_HOOKS）。
        from agentteams_connector import kb_cache

        async def _kb_prewarm() -> None:
            import asyncio as _aio

            try:
                last = await _aio.to_thread(kb_cache.load, "last-agent")
                agent = str(((last or (0, {}))[1] or {}).get("agent") or "")
                if not agent:
                    return
                from agentteams_connector.router import _kb_prewarm_agent

                await _kb_prewarm_agent(agent)
            except Exception:  # noqa: BLE001 - 预热失败无碍
                pass

        def _kb_prewarm_hook() -> None:
            # 先查运行循环再建协程（T9 冒烟教训：无循环时裸 create_task
            # 留下未 await 的悬挂 coroutine 警告）。
            import asyncio as _aio

            try:
                _loop = _aio.get_running_loop()
            except RuntimeError:
                logger.debug("kb prewarm: no running event loop, skip")
                return
            _loop.create_task(_kb_prewarm())

        api.register_startup_hook(
            "agentteams-kb-prewarm",
            _kb_prewarm_hook,
            priority=240,
        )

        api.register_slash_command(
            "selfcheck",
            _selfcheck_handler,
            category="agentteams",
            help_text="运行 AgentTeams 连接自检（l0/l1/l2/all）",
        )

        logger.info(
            "AgentTeams QwenPaw Workbench backend registered "
            "(proxy + /selfcheck + sync watcher), version %s",
            __version__,
        )


plugin = AgentTeamsWorkbenchPlugin()
