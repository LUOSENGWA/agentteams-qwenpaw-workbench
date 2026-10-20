# -*- coding: utf-8 -*-
"""自检域层级执行层：L0-L4 + run_all。

自 selfcheck.py 逐字搬移（模块级函数，无缩进变化）。探针函数/错误
分类在 selfcheck_probes.py；重绑定目标名（四大探针/_mark_working/
GatedAsyncClient）经 selfcheck 模块对象调用时属性读（单测 monkeypatch
目标是 selfcheck 模块属性）；router 状态读点保留既有函数内局部
import router_mod 限定。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

import httpx

from . import config as config_mod
from . import matrix_client
from . import selfcheck as selfcheck_mod
from .dial_gate import sync_dial_slot
from .selfcheck_probes import _classify_error

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")


def run_l0() -> Dict[str, Any]:
    """Local environment: backend alive + QwenPaw version."""
    try:
        from importlib.metadata import version as _dist_version

        qwenpaw_version = _dist_version("qwenpaw")
    except Exception as exc:  # noqa: BLE001
        qwenpaw_version = f"unknown ({exc!r})"
    # 版本门禁放宽到 2.1/2.2（plugin.json min 2.1.0 max 2.2.0）——
    # 此前写死 2.1 前缀，宿主跑 2.2.x 时 L0 误报红。
    ver_ok = qwenpaw_version.startswith(("2.1", "2.2"))
    return {
        "level": "L0",
        "ok": True,
        "checks": [
            {
                "name": "插件后端已加载",
                "ok": True,
                "detail": "selfcheck 端点可访问即证明后端存活",
            },
            {
                "name": "QwenPaw 版本",
                "ok": ver_ok,
                "detail": qwenpaw_version,
                "hint": None
                if ver_ok
                else "需要 QwenPaw 2.1.x/2.2.x（plugin.json qwenpaw_version 约束）",
            },
        ],
    }


async def run_l1(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Connectivity: probe every configured address, report the effective one."""
    checks: List[Dict[str, Any]] = []
    all_ok = True

    homeservers = [
        config_mod.address_url(u)
        for u in (cfg.get("matrix_homeservers") or [])
        if config_mod.address_url(u)
    ]
    _hs_auths = {
        u: config_mod.auth_for_url(cfg.get("matrix_homeservers"), u)
        for u in homeservers
    }
    if not homeservers:
        checks.append(
            {
                "name": "Matrix 地址",
                "ok": False,
                "detail": "未配置",
                "hint": "在配置页填写 Matrix 地址（内网/外网至少一个）",
            }
        )
        all_ok = False
    else:
        effective: Optional[str] = None
        for i, hs in enumerate(homeservers):
            result = await selfcheck_mod._probe_matrix(hs, 6.0, _hs_auths.get(hs))
            if result["ok"] and effective is None:
                effective = hs
                selfcheck_mod._mark_working("matrix", hs)
            checks.append(
                {
                    "name": f"Matrix 地址 {i + 1}（{hs}）",
                    "ok": result["ok"],
                    "detail": result["detail"]
                    + (" ← 当前生效" if result["ok"] and effective == hs else ""),
                    "hint": None
                    if result["ok"]
                    else "该路径不可达——会自动切换到下一个地址",
                }
            )
        if effective is None:
            all_ok = False

    controller_urls = [
        config_mod.address_url(u)
        for u in (cfg.get("controller_urls") or [])
        if config_mod.address_url(u)
    ]
    _cu_auths = {
        u: config_mod.auth_for_url(cfg.get("controller_urls"), u)
        for u in controller_urls
    }
    if not controller_urls:
        checks.append(
            {
                "name": "Controller",
                "ok": True,
                "detail": "未配置（可选——全量团队视图才需要）",
            }
        )
    else:
        token = (cfg.get("controller_token") or "").strip()
        effective: Optional[str] = None
        for i, cu in enumerate(controller_urls):
            # 该地址覆盖凭据（WAN 门）。
            result = await selfcheck_mod._probe_controller(cu, token, 6.0, _cu_auths.get(cu))
            if result["ok"] and effective is None:
                effective = cu
                selfcheck_mod._mark_working("controller", cu)
            checks.append(
                {
                    "name": f"Controller 地址 {i + 1}（{cu}）",
                    "ok": result["ok"],
                    "detail": result["detail"]
                    + (" ← 当前生效" if result["ok"] and effective == cu else ""),
                    "hint": None
                    if result["ok"]
                    else "该路径不可达——会自动切换到下一个地址",
                }
            )
        if effective is None:
            all_ok = False

    return {"level": "L1", "ok": all_ok, "checks": checks}


def run_l2(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Auth/API: Matrix whoami + joined_rooms (+ optional Controller projects)."""
    matrix_cfg = cfg.get("matrix") or {}
    token = (matrix_cfg.get("access_token") or "").strip()
    user_id = (matrix_cfg.get("user_id") or "").strip()

    # Use the cached working homeserver (post-L1), else the first configured.
    from . import router as router_mod

    with router_mod._cache_lock:
        cached = router_mod._working_cache.get("matrix")
    homeservers = [
        config_mod.address_url(u)
        for u in (cfg.get("matrix_homeservers") or [])
        if config_mod.address_url(u)
    ]
    homeserver = cached if cached in homeservers else (homeservers[0] if homeservers else "")

    checks: List[Dict[str, Any]] = []
    all_ok = True

    if not homeserver:
        return {
            "level": "L2",
            "ok": False,
            "checks": [
                {
                    "name": "Matrix 认证",
                    "ok": False,
                    "detail": "未配置地址",
                    "hint": "先完成配置页 Matrix 地址 + 登录",
                }
            ],
        }

    if not token:
        return {
            "level": "L2",
            "ok": False,
            "checks": [
                {
                    "name": "Matrix 登录",
                    "ok": False,
                    "detail": "尚未登录",
                    "hint": "在配置页填写账号密码并点击登录",
                }
            ],
        }

    try:
        who = matrix_client.whoami(homeserver, token)
        ok = bool(who.get("user_id"))
        all_ok = all_ok and ok
        checks.append(
            {
                "name": "Matrix whoami",
                "ok": ok,
                "detail": who.get("user_id", "无"),
                "hint": None if ok else "access_token 失效，重新登录",
            }
        )
        if ok and user_id and who.get("user_id") != user_id:
            checks.append(
                {
                    "name": "MXID 一致性",
                    "ok": False,
                    "detail": f"配置 {user_id} ≠ 实际 {who.get('user_id')}",
                    "hint": "重新登录以刷新配置",
                }
            )
            all_ok = False
    except Exception as exc:  # noqa: BLE001
        all_ok = False
        checks.append(
            {
                "name": "Matrix whoami",
                "ok": False,
                "detail": _classify_error(exc),
                "hint": "token 失效或地址不可达",
            }
        )

    try:
        rooms = matrix_client.joined_rooms(homeserver, token)
        joined = rooms.get("joined_rooms", [])
        checks.append(
            {
                "name": "joined_rooms",
                "ok": True,
                "detail": f"已加入 {len(joined)} 个房间",
            }
        )
    except Exception as exc:  # noqa: BLE001
        all_ok = False
        checks.append(
            {
                "name": "joined_rooms",
                "ok": False,
                "detail": _classify_error(exc),
                "hint": "token 失效或地址不可达",
            }
        )

    controller_urls = [
        config_mod.address_url(u)
        for u in (cfg.get("controller_urls") or [])
        if config_mod.address_url(u)
    ]
    if controller_urls:
        with router_mod._cache_lock:
            cached_ctl = router_mod._working_cache.get("controller")
        controller_url = (
            cached_ctl if cached_ctl in controller_urls else controller_urls[0]
        )
        # 该地址覆盖凭据（WAN 门）。
        _ctl2_auth = config_mod.auth_for_url(
            cfg.get("controller_urls"), controller_url
        )
        # ── 14.34：先探 L1 管理员 token 路径，L2 的 401 分支才能判「预期态」──
        # L2 Matrix token 路径按上游设计只接受 level-2/3 Human，level-1 管理员
        # 账号恒 401。L1 正源可用时，L2 的 401 是结构性预期状态（与 Basic
        # 账密无关）——此前 L1 在 L2 之后探测、无法判定，L2 行红 ❌「HTTP 401」
        # 被用户误读成「密码错」反复重填（14.34 反馈：显示「已保存」但 401
        # 逼重填，而 controller 又能连上）。现在 L1 探测先跑，L2 分支用 l1_ok
        # 判预期态，该行显 ⚠️ 预期而非 ❌ 失败。
        ctl_token = (cfg.get("controller_token") or "").strip()
        l1_ok: bool | None = None
        l1_checks: list[Dict[str, Any]] = []
        if ctl_token:
            # 500 + mc/minio 特征 = Controller 侧 MinIO 客户端故障（mc 别名未
            # 注册），不是权限问题——此前被前端「Controller 不可用」通用横幅
            # 掩盖，用户无从下手（历史真机缺陷根因）。
            try:
                with sync_dial_slot(), httpx.Client(timeout=15.0, verify=False) as client:
                    resp2 = client.get(
                        f"{controller_url.rstrip('/')}/api/v1/projects",
                        headers=config_mod.headers_with_auth(
                            _ctl2_auth, {"Authorization": f"Bearer {ctl_token}"}
                        ),
                    )
                body2 = (resp2.text or "")[:300]
                if resp2.status_code == 200:
                    l1_ok = True
                    l1_checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": True,
                            "detail": "admin token 正源可用",
                        }
                    )
                elif resp2.status_code == 500 and (
                    "mc " in body2 or "minio" in body2.lower()
                ):
                    l1_checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": False,
                            "detail": f"HTTP 500: {body2[:200]}",
                            "hint": "Controller 的 MinIO 客户端（mc 别名）异常——在 Controller 宿主机执行: docker exec agentteams-controller sh -c 'mc alias set agentteams $AGENTTEAMS_FS_ENDPOINT $AGENTTEAMS_MINIO_USER $AGENTTEAMS_MINIO_PASSWORD && mc ls agentteams/ | head -5'",
                        }
                    )
                elif resp2.status_code in (401, 403):
                    l1_checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": False,
                            "detail": f"HTTP {resp2.status_code}",
                            "hint": "controller_token 已失效——在 Controller 宿主机重新读取 /var/run/agentteams/cli-token 填入配置页",
                        }
                    )
                else:
                    l1_checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": False,
                            "detail": f"HTTP {resp2.status_code}: {body2[:200]}",
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                l1_checks.append(
                    {
                        "name": "Controller projects (L1 正源)",
                        "ok": False,
                        "detail": _classify_error(exc),
                        "hint": "检查 Controller 地址",
                    }
                )

        # L2 Controller access: try Matrix-token auth (W-PR-1 composite
        # authenticator). 404 = endpoint/PR not deployed yet (distinguish
        # from 403 = permission denied).
        try:
            headers = {"Authorization": f"Bearer {token}"}
            headers = config_mod.headers_with_auth(_ctl2_auth, headers)
            with sync_dial_slot(), httpx.Client(timeout=10.0, verify=False) as client:
                resp = client.get(
                    f"{controller_url.rstrip('/')}/api/v1/projects", headers=headers
                )
            if resp.status_code == 200:
                checks.append(
                    {
                        "name": "Controller projects (L2)",
                        "ok": True,
                        "detail": "Matrix token 可通过 Controller 认证",
                    }
                )
            elif resp.status_code == 404:
                checks.append(
                    {
                        "name": "Controller projects (L2)",
                        "ok": True,
                        "detail": "404——接口未部署，AgentTeams 升级后自动生效",
                    }
                )
            elif resp.status_code == 401 and l1_ok:
                # 预期态：L1 正源已可用 → L2 的 401 是上游权限设计使然
                # （level-1 管理员走 Matrix token 恒 401），不是故障。
                # 该行显 ⚠️ 而非 ❌，detail 点明「与 Basic 账密无关」——
                # 此前用户把这条 401 读成密码错，反复重填保存（14.34）。
                checks.append(
                    {
                        "name": "Controller projects (L2)",
                        "ok": True,
                        "warn": True,
                        "detail": "HTTP 401（预期态——本账号为 level-1 管理员，L1 管理员 token 正源已可用，功能不受影响）",
                        "hint": "此行为 Controller Matrix token 路径的结构性 401（上游只放行 level-2/3 只读），与外网/内网 Basic 账密无关，无需重新填写密码。若需 L2 只读视图，请让部署管理员把该 Human 改为 level 2。",
                    }
                )
            else:
                all_ok = False
                checks.append(
                    {
                        "name": "Controller projects (L2)",
                        "ok": False,
                        "detail": f"HTTP {resp.status_code}",
                        "hint": "403=账号无团队权限（联系管理员）；401=Controller Matrix token 路径仅接受 Human CR permissionLevel=2 账号（level-1 管理员账号需填 Controller 管理员 token，或把该 Human 改为 level 2）",
                    }
                )
        except Exception as exc:  # noqa: BLE001
            all_ok = False
            checks.append(
                {
                    "name": "Controller projects (L2)",
                    "ok": False,
                    "detail": _classify_error(exc),
                    "hint": "检查 Controller 地址",
                }
            )

        # L1 检查结果（已在 L2 之前探测，供 L2 401 预期态判定）；
        # 显示顺序不变（L1 行仍在 L2 行后）。
        if l1_checks:
            checks.extend(l1_checks)
            all_ok = all_ok and all(c["ok"] for c in l1_checks)

    return {"level": "L2", "ok": all_ok, "checks": checks}


async def _run_l3_l4(cfg: Dict[str, Any], include_artifact: bool) -> Dict[str, Any]:
    """L3 room permission/message round-trip; L4 = L3 + artifact check.

 One ping burst across all joined rooms, then a single long-poll /sync
 (with the pre-ping ``since``) collects replies for every room in one
 wait window — no per-room serial waiting.
 """
    matrix_cfg = cfg.get("matrix") or {}
    token = (matrix_cfg.get("access_token") or "").strip()
    user_id = (matrix_cfg.get("user_id") or "").strip()

    from . import router as router_mod

    with router_mod._cache_lock:
        cached = router_mod._working_cache.get("matrix")
    homeservers = [
        config_mod.address_url(u)
        for u in (cfg.get("matrix_homeservers") or [])
        if config_mod.address_url(u)
    ]
    homeserver = cached if cached in homeservers else (homeservers[0] if homeservers else "")

    if not homeserver or not token:
        return {
            "level": "L3" if not include_artifact else "L4",
            "ok": False,
            "rooms": [],
            "checks": [
                {
                    "name": "前置条件",
                    "ok": False,
                    "detail": "未配置地址或未登录",
                    "hint": "先完成配置页地址 + Matrix 登录（L2 通过后再跑）",
                }
            ],
        }

    # 1. Snapshot rooms + baseline sync token.
    try:
        # 同步 matrix_client 调用全部 to_thread 化——L3/L4
        # 的 45s 长轮询若不包线程会冻结宿主整个 app。
        rooms = (
            await asyncio.to_thread(matrix_client.joined_rooms, homeserver, token)
        ).get("joined_rooms", [])
        baseline = await asyncio.to_thread(
            matrix_client.sync, homeserver, token, timeout_ms=0
        )
        since = baseline.get("next_batch", "")
    except Exception as exc:  # noqa: BLE001
        return {
            "level": "L3" if not include_artifact else "L4",
            "ok": False,
            "rooms": [],
            "checks": [
                {
                    "name": "前置检查",
                    "ok": False,
                    "detail": _classify_error(exc),
                    "hint": "地址不可达或 token 失效",
                }
            ],
        }

    # 2. Ping every room (best-effort, collect per-room status).
    room_status: Dict[str, Dict[str, Any]] = {}
    for room_id in rooms:
        entry: Dict[str, Any] = {
            "room_id": room_id,
            "members": None,
            "ping_ok": False,
            "reply": {"ok": False, "detail": ""},
            "artifact": None,
        }
        try:
            members = await asyncio.to_thread(
                matrix_client.joined_members, homeserver, token, room_id
            )
            entry["members"] = len(members.get("joined", {}))
        except Exception as exc:  # noqa: BLE001
            entry["members_error"] = _classify_error(exc)
        try:
            sent = await asyncio.to_thread(
                matrix_client.send_message,
                homeserver,
                token,
                room_id,
                "[selfcheck] ping — AgentTeams QwenPaw Workbench 自检",
            )
            entry["ping_ok"] = True
            entry["ping_event_id"] = sent.get("event_id")
        except Exception as exc:  # noqa: BLE001
            entry["ping_error"] = _classify_error(exc)
        room_status[room_id] = entry

    # 3. One long-poll sync: collect replies in all rooms.
    wait_ms = 45000
    try:
        # 45s 长轮询同步调用 to_thread 化（否则冻结整个 app）。
        sync_resp = await asyncio.to_thread(
            matrix_client.sync, homeserver, token,
            since=since, timeout_ms=wait_ms,
        )
        join_events = sync_resp.get("rooms", {}).get("join", {})
        for room_id, entry in room_status.items():
            timeline = (join_events.get(room_id) or {}).get("timeline") or {}
            events = timeline.get("events") or []
            replies = [
                ev
                for ev in events
                if ev.get("type") == "m.room.message"
                and ev.get("sender") != user_id
            ]
            if replies:
                last = replies[-1]
                entry["reply"] = {
                    "ok": True,
                    "sender": last.get("sender"),
                    "body": str((last.get("content") or {}).get("body", ""))[:80],
                }
            else:
                entry["reply"] = {
                    "ok": False,
                    "detail": "无回复（allowlist 静默拦截？或 Agent 未响应）",
                }
    except Exception as exc:  # noqa: BLE001
        for entry in room_status.values():
            entry["reply"] = {"ok": False, "detail": _classify_error(exc)}

    # 4. L4 extra: artifact presence check (per-room latest m.file).
    if include_artifact:
        for room_id, entry in room_status.items():
            try:
                import httpx as _httpx

                async with selfcheck_mod.GatedAsyncClient(timeout=15.0, verify=False) as client:
                    resp = await client.get(
                        f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{room_id}/messages",
                        headers={"Authorization": f"Bearer {token}"},
                        params={"dir": "b", "limit": 50},
                    )
                if resp.status_code == 200:
                    events = resp.json().get("chunk", [])
                    files = [
                        ev
                        for ev in events
                        if ev.get("type") == "m.room.message"
                        and str((ev.get("content") or {}).get("msgtype", ""))
                        .startswith("m.")
                        and (ev.get("content") or {}).get("url")
                    ]
                    entry["artifact"] = {
                        "ok": len(files) > 0,
                        "detail": (
                            f"最近 50 条中有 {len(files)} 条产物消息"
                            if files
                            else "最近 50 条无产物消息"
                        ),
                    }
                else:
                    entry["artifact"] = {
                        "ok": False,
                        "detail": f"messages API HTTP {resp.status_code}",
                    }
            except Exception as exc:  # noqa: BLE001
                entry["artifact"] = {"ok": False, "detail": _classify_error(exc)}

    rooms_out = [
        room_status[rid]
        for rid in rooms
        if rid in room_status
    ]
    overall_ok = all(r["ping_ok"] and r["reply"]["ok"] for r in rooms_out)
    logger.info(
        "selfcheck L%s: %d rooms pinged, %d replied, ok=%s",
        "4" if include_artifact else "3",
        len(rooms_out),
        sum(1 for r in rooms_out if r["reply"]["ok"]),
        overall_ok,
    )
    return {
        "level": "L3" if not include_artifact else "L4",
        "ok": overall_ok,
        "rooms": rooms_out,
        "checks": [],
    }


async def run_l3(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Room permission + ping round-trip (no artifact check)."""
    return await _run_l3_l4(cfg, include_artifact=False)


async def run_l4(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """End-to-end: ping round-trip + artifact presence."""
    return await _run_l3_l4(cfg, include_artifact=True)


async def run_all(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Run L0+L1+L2 and aggregate (L3/L4 are room-interactive, run on demand)."""
    l0 = run_l0()
    l1 = await run_l1(cfg)
    # run_l2 内含同步 httpx（超时 10s+15s）——调用点 to_thread。
    l2 = await asyncio.to_thread(run_l2, cfg)
    return {
        "ok": bool(l0["ok"] and l1["ok"] and l2["ok"]),
        "levels": [l0, l1, l2],
        "summary": {
            "L0": "✅" if l0["ok"] else "❌",
            "L1": "✅" if l1["ok"] else "❌",
            "L2": "✅" if l2["ok"] else "❌",
        },
    }
