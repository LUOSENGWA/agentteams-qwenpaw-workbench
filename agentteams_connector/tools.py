"""v0.4.98: agent 工具实现——补 plugin.json 声明的 ``agentteams_qwenpaw_workbench_status``。

此前 manifest 声明了该工具但无注册代码（屎山审计发现的 manifest/实现漂移，
本轮补齐实现而非删声明）。工具复用 teams/sync 的同一数据链
（matrix_client.sync + direct_rooms + _parse_sync_rooms），不新增请求面。
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict


def _team_lines(parsed: Dict[str, Any], limit: int = 8) -> str:
    """worker_tree → 紧凑的每团队行。"""
    tree = parsed.get("worker_tree") or {}
    teams = tree.get("teams") or []
    if not teams:
        return "（worker 树为空——Controller 未接入时为房间聚合）"
    lines = []
    for t in teams[:limit]:
        tname = t.get("team_name") or "?"
        workers = t.get("workers") or []
        names = [w.get("worker_name") or "?" for w in workers][:6]
        more = len(workers) - len(names)
        lines.append(f"- {tname}: {len(workers)} Worker（{', '.join(names)}{'…' if more > 0 else ''}）")
    if len(teams) > limit:
        lines.append(f"…另有 {len(teams) - limit} 个团队")
    return "\n".join(lines) if lines else "（无团队）"


async def agentteams_qwenpaw_workbench_status(scope: str = "overview") -> str:
    """查询当前登录用户的 AgentTeams 团队状态（零 LLM 部署下为人工/agent 通用查询口）。

    数据 = Matrix /sync 会话快照（与工作台「团队管理」同源，60s 缓存之外的直连查询）。

    Args:
        scope: ``"overview"``（默认，团队/房间/Worker 摘要）| ``"rooms"``
            （全部房间含未读与最后消息）| ``"teams"``（Worker 树明细）。

    Returns:
        纯文本摘要（供 agent 直接引用；失败时返回带原因的错误文本）。
    """
    from agentteams_connector import config as config_mod
    from agentteams_connector import matrix_client, router as router_mod

    cfg = config_mod.load_config()
    matrix_cfg = cfg.get("matrix") or {}
    token = (matrix_cfg.get("access_token") or "").strip()
    user_id = (matrix_cfg.get("user_id") or "").strip()
    if not token or not user_id:
        return "工作台未登录：请先在插件配置页登录 Matrix 账号，再重试。"
    homeservers = cfg.get("matrix_homeservers") or []
    if not homeservers:
        return "未配置 Matrix 地址（插件配置页 matrix_homeservers 为空）。"
    homeserver = homeservers[0]

    try:
        # timeout_ms=0 立即返回快照（同 router /teams/sync 调用方式；
        # 注意 sync() 第三位置参是 since(str)，不能传 0）。
        sync_resp = await asyncio.to_thread(
            matrix_client.sync,
            homeserver,
            token,
            timeout_ms=0,
            sync_filter=router_mod._SYNC_FILTER,
        )
        dm_peers = await asyncio.to_thread(
            matrix_client.direct_rooms, homeserver, token, user_id
        )
        parsed = router_mod._parse_sync_rooms(sync_resp, user_id, dm_peers)
    except Exception as exc:  # noqa: BLE001 —— 工具返回文本而非 HTTP
        return f"查询失败：{type(exc).__name__}: {exc}"

    rooms = parsed.get("rooms") or []
    dms = [r for r in rooms if (r.get("member_count") or 0) <= 2]
    team_rooms = [r for r in rooms if r not in dms]
    unread_rooms = [r for r in rooms if r.get("unread")]
    tree = parsed.get("worker_tree") or {}
    n_teams = len(tree.get("teams") or [])
    n_workers = sum(len(t.get("workers") or []) for t in (tree.get("teams") or []))

    out = [
        f"AgentTeams 工作台状态（{user_id}）",
        f"房间 {len(rooms)}（团队房间 {len(team_rooms)} / DM {len(dms)}）；"
        f"Worker 树 {n_teams} 团队 / {n_workers} Worker",
    ]
    if scope == "rooms":
        for r in sorted(rooms, key=lambda x: -(x.get("unread") or 0))[:20]:
            mark = f"[未读{r['unread']}]" if r.get("unread") else ""
            last = (r.get("last_body") or "")[:40].replace("\n", " ")
            out.append(f"- {r.get('name') or r.get('room_id')} {mark} {last}")
    elif scope == "teams":
        out.append(_team_lines(parsed))
    else:  # overview
        out.append(_team_lines(parsed))
        if unread_rooms:
            top = unread_rooms[:3]
            out.append(
                "未读："
                + "、".join(
                    f"{r.get('name') or r.get('room_id')}({r.get('unread')})"
                    for r in top
                )
                + (f" 等{len(unread_rooms)}个" if len(unread_rooms) > 3 else "")
            )
        else:
            out.append("无未读")
    return "\n".join(out)
