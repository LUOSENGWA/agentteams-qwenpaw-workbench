from __future__ import annotations

import asyncio
import os

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request

from .. import config as config_mod, router as router_mod, selfcheck
from ..dial_gate import GatedAsyncClient
from ..router import (
    ConfigPatch,
    ConfigTestRequest,
    TokenValidationError,
    VerifyAdminRequest,
    _address_list,
    _count_gateway_aliases,
    _headers_for,
    _ordered_ctl_urls,
    _pick_address,
    _pinned_map,
    _resolve_controller_token,
    _safe_refresh_effective,
    _sanitize_token,
    _validate_config_shape,
    invalidate_data_caches,
)


def build_config_router() -> APIRouter:
    """config 域子路由（build_router 原段逐字搬移，任务 190）。"""
    router = APIRouter()
    @router.get("/config")
    async def get_config() -> Dict[str, Any]:
        """Config with secrets redacted + current effective addresses."""
        cfg = config_mod.load_config()
        out = config_mod.redact(cfg)
        # v0.5.0-beta.12：token 可来自粘贴或 env 时 config.controller_token
        # 为空——前端门控（hasToken/l1TokenMode）需要知道 L1 管理 API 可用。
        # 只暴露来源标记，token 值永不离开连接器进程。
        # 取值："config"|"env"=可用；"invalid"=配置了但坏了。（v0.5.0-beta.12：
        # token 文件路径删除——file/file_unreadable 取值不复存在。）
        try:
            _t, _src = _resolve_controller_token(cfg)
            if _t:
                out["controllerTokenSource"] = _src
            else:
                out["controllerTokenSource"] = ""
        except TokenValidationError:
            out["controllerTokenSource"] = "invalid"
        # v0.5.0-beta.14.1: effective 走 _pick_address（固定档=固定值；auto
        # = cache 优先、miss 回退首个——比原来「cache 空=空串」更诚实）。
        out["effective"] = {
            "matrix": _pick_address(cfg, "matrix"),
            "controller": _pick_address(cfg, "controller"),
            # v0.5.0-beta.14.7：effective 补 gateway（固定档同源）。
            "gateway": _pick_address(cfg, "gateway"),
        }
        # v0.5.0-beta.14.12：持久化诊断——路径/挂载可见性/
        # 上次写盘时间（帮助定位"设置不落盘"的环境问题）。
        out["configPath"] = str(config_mod._CONFIG_PATH)
        try:
            _st = config_mod._CONFIG_PATH.stat()
            out["configSavedAt"] = int(_st.st_mtime)
            out["configWritable"] = os.access(str(config_mod._CONFIG_DIR), os.W_OK)
        except Exception:  # noqa: BLE001
            out["configSavedAt"] = 0
            out["configWritable"] = False
        return out

    @router.get("/auth-status")
    async def get_auth_status() -> Dict[str, Any]:
        """v0.5.0-beta.14.19: 登录态/凭据健康（纯进程内状态，零外发请求）。

 前端 30s 低频轮询驱动「登录已失效」横幅——此前 token 失效后
 @通知静默全断且无人知晓（改密/踢设备/重置 token 是高频运维动作）。
 - matrix_token: none=未登录 / invalid=/sync 401+auth errcode 判死
 - console_session: none=未验证 / expired=网关面 401 被动判死
 - controller_token: config|env|invalid|none（与 /config 同源逻辑）
 """
        from .. import sync_watcher as _sw  # noqa: PLC0415

        cfg = config_mod.load_config()
        matrix = cfg.get("matrix") or {}
        has_matrix = bool(str(matrix.get("access_token") or "").strip())
        out: Dict[str, Any] = {
            "matrix_token": ("none" if not has_matrix else _sw.auth_status()),
            "console_session": (
                "none"
                if not str(cfg.get("console_session") or "").strip()
                # 任务 190：跨域共享状态，经 router 模块属性访问（勿改回局部绑定）
                else ("expired" if router_mod._console_session_expired else "active")
            ),
            "controller_token": "none",
        }
        try:
            _t, _src = _resolve_controller_token(cfg)
            if _t:
                out["controller_token"] = _src
        except TokenValidationError:
            out["controller_token"] = "invalid"
        return out

    @router.put("/config")
    async def put_config(patch: ConfigPatch) -> Dict[str, Any]:
        """Persist config fields. Never accept a redacted token back."""
        incoming = patch.config or {}
        matrix_in = incoming.get("matrix") or {}
        if matrix_in.get("access_token") == "***":
            matrix_in.pop("access_token", None)
        if incoming.get("controller_token") == "***":
            incoming.pop("controller_token", None)
        prev = config_mod.load_config()
        # v0.5.0-beta.14.22：凭据意图检查——用户选了覆盖凭据（basic/
        # bearer）但凭据为空且旧条目无可继承同类型凭据时，merge 会静默
        # 降级为无凭据条目（网关恒 401）而保存仍报成功（「已保存但
        # 没记住」的根因）。保存前拦截 400，错误文案点名地址位置。
        _fam_names = {
            "matrix": ("matrix_homeservers", "Matrix"),
            "controller": ("controller_urls", "Controller"),
            "sglang": (None, "SGLang"),
            "gateway": ("gateway_admin_urls", "Higress"),
        }
        _gap_msgs: List[str] = []
        for _fam, (_key, _label) in _fam_names.items():
            if _key is not None:
                _new_entries = incoming.get(_key)
                if _new_entries is None:
                    continue
                _old_entries = prev.get(_key)
            else:
                _sg_in = incoming.get("sglang")
                if not isinstance(_sg_in, dict) or "urls" not in _sg_in:
                    continue
                _new_entries = _sg_in.get("urls")
                _old_entries = (prev.get("sglang") or {}).get("urls")
            _gaps = config_mod.credential_gaps(_old_entries, _new_entries)
            for _g in _gaps:
                _pos = _g["index"] + 1
                _who = _g.get("username") or ""
                _gap_msgs.append(
                    f"{_label} 第 {_pos} 个地址选了"
                    f"{'Basic 认证' if _g['type'] == 'basic' else 'API Key'}"
                    + (f"（用户名 {_who}）" if _who else "")
                    + "但凭据为空，也没有已存凭据可沿用——请填完整凭据再保存"
                )
        if _gap_msgs:
            raise HTTPException(status_code=400, detail="；".join(_gap_msgs))
        # v0.5.0-beta.14.12：保存失败显性化——落盘失败（磁盘
        # 满/权限）此前裸抛 = 500 无详情；现明确报原因（前端可显示）。
        # v0.5.0-beta.14.12：config 写盘校验失败（写+回读
        # 不一致/磁盘异常）统一为 IOError——分类报「配置保存失败（磁盘写入
        # 问题）」；其余异常仍走 通用兜底。
        try:
            merged = config_mod.update_config(incoming)
        except IOError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"配置保存失败（磁盘写入问题）：{exc}",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - 落盘失败显性化（兜底）
            raise HTTPException(
                status_code=500, detail=f"配置写入失败：{exc}"
            )
        # v0.5.0-beta.12: 登录身份变更（同 /login 语义）→ 清聚合缓存 + 重启 sync 游标。
        # 只按 user_id 判定——普通保存配置（未换账号）不触发重启。
        if (prev.get("matrix") or {}).get("user_id") != (
            merged.get("matrix") or {}
        ).get("user_id"):
            invalidate_data_caches("config.matrix")
            from .. import sync_watcher as _sw  # noqa: PLC0415

            await _sw.restart("config.matrix")
        # v0.5.0-beta.14.12：地址探测转后台——保存即时返回
        # （<1s），effective 状态随后自动刷新（前端下次 GET /config 可见）。
        # 旧行为=同步 await 全地址探测（本机实测 ~4.8s，WAN 高延迟下保存
        # 几乎保存不了）；后台任务经 _safe_refresh_effective 错误自保。
        asyncio.create_task(_safe_refresh_effective(merged))
        _resp = config_mod.redact(merged)
        # v0.5.0-beta.14.22：凭据回读校验——四类地址逐位置落盘形态
        # （str=无凭据/basic/bearer），前端与表单意图对表；不一致=显形。
        _resp["credential_check"] = {
            "matrix": config_mod.persisted_credential_kinds(
                merged.get("matrix_homeservers")),
            "controller": config_mod.persisted_credential_kinds(
                merged.get("controller_urls")),
            "sglang": config_mod.persisted_credential_kinds(
                (merged.get("sglang") or {}).get("urls")),
            "gateway": config_mod.persisted_credential_kinds(
                merged.get("gateway_admin_urls")),
        }
        return _resp

    # ── v0.5.0-beta.14.14：完整配置备份/恢复 ─────────────────
    # 安全边界：同源本地、面向用户自己的备份用途（换环境/装包后一键还原）。
    # GET /config 保持脱敏不动（前端展示面）；export/import 是独立通道——
    # 导出返回含明文凭据的完整配置，导入校验 → 备份当前态 → 覆盖。

    @router.get("/config/export")
    async def config_export() -> Dict[str, Any]:
        """v0.5.0-beta.14.14：完整配置导出（含明文凭据）。

 同源本地、面向用户自己的备份用途——输出即落盘同形的完整配置对象，
 原样复制保存；换环境/装包/配置丢失后贴回 /config/import 即还原。
 """
        return config_mod.load_config()

    @router.post("/config/import")
    async def config_import(request: Request) -> Dict[str, Any]:
        """v0.5.0-beta.14.14：完整配置导入（覆盖式恢复）。

 同源本地、面向用户自己的备份用途（与 GET /config/export 一对）。
 流程：① schema 级校验（顶层 dict + 关键键类型 + 无脱敏占位符，
 失败 400 可读错误、零落盘）→ ② 先自动备份当前配置（config.bak.json，
 备份失败即中止不覆盖）→ ③ 原子覆盖（save_config 内置写后回读验证，
 备份保持为覆盖前恢复点）→ ④ 身份变更自动重启同步（同 PUT /config）。

 返回 restart: "none"=已 live 生效（同步自动重启）/ "page"=建议刷新
 workbench 页面确认生效。
 """
        try:
            data = await request.json()
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="导入失败：请求体不是合法 JSON")
        # 容错：接受 {"config": {...}} 包裹（与 PUT /config 同形；正常配置无
        # 顶层 "config" 键，仅在包裹结构独占 body 时拆包，不误伤裸配置）。
        if (
            isinstance(data, dict)
            and set(data.keys()) == {"config"}
            and isinstance(data.get("config"), dict)
        ):
            data = data["config"]
        if not isinstance(data, dict):
            raise HTTPException(status_code=400, detail="导入失败：配置顶层必须是 JSON 对象")
        errors = _validate_config_shape(data)
        if errors:
            raise HTTPException(
                status_code=400,
                detail="导入失败：" + "；".join(errors),
            )
        prev = config_mod.load_config()
        try:
            config_mod.write_backup(prev)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=500,
                detail=f"导入中止：当前配置备份失败（未覆盖任何内容）：{exc}",
            ) from exc
        try:
            # refresh_backup=False：备份保持覆盖前状态（用户回滚点）。
            config_mod.save_config(data, refresh_backup=False)
        except IOError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"配置导入失败（磁盘写入问题）：{exc}",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"配置导入失败：{exc}") from exc
        # 身份变更 → 同 PUT /config 语义（清缓存 + 自动重启同步游标）。
        restart = "page"
        if (prev.get("matrix") or {}).get("user_id") != (
            (data.get("matrix") or {}).get("user_id")
        ):
            invalidate_data_caches("config.import")
            from .. import sync_watcher as _sw  # noqa: PLC0415

            await _sw.restart("config.import")
            restart = "none"
        # 生效地址探测转后台（同 PUT /config——effective 随后自动刷新）。
        asyncio.create_task(_safe_refresh_effective(config_mod.load_config()))
        return {
            "ok": True,
            "restart": restart,
            "config": config_mod.redact(config_mod.load_config()),
        }

    @router.post("/config/test")
    async def config_test(patch: ConfigTestRequest) -> Dict[str, Any]:
        """v0.5.0-beta.12: 连通性测试——逐地址测延迟，返回 {url, ok, ms, detail}。

 可传未保存的表单值（测试草稿地址）；不传则测已配置列表。
 仅当传入列表与已配置一致时才更新 working cache（applied=true）——
 草稿测试不动生效地址。
 """
        cfg = config_mod.load_config()
        # v0.5.0-beta.14.3: 条目 str | {url, auth?}——统一取 url 再测。
        def _urls(entries: Any) -> List[str]:
            return [config_mod.address_url(u) for u in (entries or []) if config_mod.address_url(u)]

        cfg_matrix = _urls(cfg.get("matrix_homeservers"))
        cfg_ctl = _urls(cfg.get("controller_urls"))
        matrix_list = _urls(patch.matrix or cfg_matrix)
        ctl_list = _urls(patch.controller or cfg_ctl)
        # v0.5.0-beta.12: SGLang 双地址（传草稿列表则测草稿，否则测已配置；兼容旧 "url"）。
        cfg_sg = cfg.get("sglang") or {}
        cfg_sg_urls = _urls(
            cfg_sg.get("urls")
            or ([cfg_sg.get("url")] if cfg_sg.get("url") else [])
        )
        sglang_list = _urls(patch.sglang or cfg_sg_urls)
        # v0.5.0-beta.14.17: Higress 双地址（传草稿列表则测草稿，否则测已配置）。
        cfg_gw_urls = _urls(cfg.get("gateway_admin_urls"))
        gateway_list = _urls(patch.gateway or cfg_gw_urls)
        # v0.5.0-beta.14.3: 草稿凭据随测——条目级 auth 图（未保存也能验）。
        auth_maps = {
            "matrix": config_mod.build_auth_map(patch.matrix if patch.matrix is not None else cfg.get("matrix_homeservers")),
            "controller": config_mod.build_auth_map(patch.controller if patch.controller is not None else cfg.get("controller_urls")),
            "sglang": config_mod.build_auth_map(
                (patch.sglang if patch.sglang is not None else cfg_sg.get("urls"))
            ),
            # v0.5.0-beta.14.17: Higress 覆盖凭据（同口径）。
            "gateway": config_mod.build_auth_map(
                (patch.gateway if patch.gateway is not None else cfg.get("gateway_admin_urls"))
            ),
        }
        token = (cfg.get("controller_token") or "").strip()

        prev = {
            "matrix": _pick_address(cfg, "matrix"),
            "controller": _pick_address(cfg, "controller"),
        }
        results = await selfcheck.test_addresses(
            matrix_list, ctl_list, sglang_list, token, with_diag=True,
            auth_maps=auth_maps,
            gateway_urls=gateway_list,
            # v0.5.0-beta.14.17: 会话三态——已配置且持有会话才探会话有效性。
            gateway_session_cookie=str(
                cfg.get("console_session") or ""
            ).strip(),
        )
        applied = False
        same_lists = (matrix_list == cfg_matrix) and (ctl_list == cfg_ctl)
        if same_lists and (matrix_list or ctl_list):
            await selfcheck.refresh_effective(cfg)
            applied = True
        effective = {
            "matrix": _pick_address(cfg, "matrix"),
            "controller": _pick_address(cfg, "controller"),
        }
        # v0.5.0-beta.12：测完自动切换要可见——switched 标记哪些类型换了生效地址。
        switched = {
            kind: bool(effective.get(kind) and effective[kind] != prev[kind])
            for kind in ("matrix", "controller")
        }
        return {
            "ok": True,
            "matrix": results["matrix"],
            "controller": results["controller"],
            "sglang": results["sglang"],
            # v0.5.0-beta.14.17: Higress 探测行（诊断面；未配置=空列表）。
            "gateway": results.get("gateway", []),
            "effective": effective,
            # v0.5.0-beta.14.1: 固定档回报——三类地址各自的固定值（None=未固定）。
            "pinned": _pinned_map(cfg),
            "applied": applied,
            "switched": switched,
        }

    @router.post("/config/verify-admin")
    async def verify_admin(body: VerifyAdminRequest) -> Dict[str, Any]:
        """v0.5.0-beta.12: L1 管理员验证（admin 账号密码 或 Controller token 二选一）。

 密码路径换不来 Controller 管理 API 凭据（controller 无 token 签发端点，
 不收 level-1 matrix token）——成功只授予 Console 会话（网关面）；
 Controller 管理 API 仍需 controller_token（UI 明示，与 dashboard
 「密码→env SA」的差异源于插件零凭据终端无服务端 SA）。
 """
        from .. import config as cfgmod

        cfg = await asyncio.to_thread(cfgmod.load_config)

        username = (body.admin_username or "").strip()
        password = (body.admin_password or "").strip()
        if password == "***":
            password = str(cfg.get("admin_password") or "")
        # v0.5.0-beta.14.23（N1 验证分离）：Controller token 解析**只在
        # 路径 B 内**做——Higress 账密验证（路径 A）不触碰 token：旧版在
        # 分支前无条件 _resolve_controller_token，config 里 token 含非法
        # 字符时点「Higress 验证」会报 token 错（两套凭证互相牵连）。
        # 两验证器现在各自独立：A 只验 Console 账密，B 只验 Controller token。
        # v0.5.0-beta.14.7: 双地址——body 列表/单值优先，配置次之；按序尝试，
        # 传输错误换下一地址，凭据错误立即报（地址无关）。
        console_urls: List[str] = []
        for u in list(body.gateway_admin_urls or []):
            su = str(u or "").strip().rstrip("/")
            if su and su not in console_urls:
                console_urls.append(su)
        if body.gateway_admin_url and str(body.gateway_admin_url).strip():
            su = str(body.gateway_admin_url).strip().rstrip("/")
            if su and su not in console_urls:
                console_urls.insert(0, su)
        if not console_urls:
            console_urls = [u.rstrip("/") for u in _address_list(cfg, "gateway") if u]
        console_url = console_urls[0] if console_urls else ""

        # --- 路径 A：admin 账号密码 → Console /session/login ---
        if username and password:
            # Higress 地址（v0.5.0-beta.12 设计，「同主机 8001/6868
            # 顺序探测行不通，每个人映射的端口都不一样」）：Higress Console 与
            # Controller 同容器不同端口（源码实锤：install 脚本
            # `docker exec agentteams-controller curl 127.0.0.1:8001`），但宿主
            # 端口是安装时用户自选（AGENTTEAMS_PORT_CONSOLE，默认 18001，
            # 某部署=6868）→ 固定端口探测必然漏，**改为必填**：留空=可操作错误
            # （不再盲探）。
            if not console_url:
                return {
                    "ok": False,
                    "error": (
                        "Higress 地址未配置：Higress Console 与 Controller "
                        "同机（同容器）不同端口，但宿主端口是部署时自选的（安装"
                        "脚本 AGENTTEAMS_PORT_CONSOLE，默认 18001）——请在设置里"
                        "填写「Higress 地址」后重试"
                    ),
                }
            # v0.5.0-beta.14.7: 逐地址尝试（传输错误换下一地址；凭据错误=地址
            # 无关，立即报；会话 cookie 由 Console 后端校验、跨入口通用）。
            rr = None
            last_exc: Optional[Exception] = None
            for cu in console_urls:
                try:
                    async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                        rr = await client.post(
                            f"{cu}/session/login",
                            json={"username": username, "password": password},
                        )
                    console_url = cu
                    break
                except Exception as exc:  # noqa: BLE001 - 逐地址降级
                    last_exc = exc
                    continue
            if rr is None:
                return {
                    "ok": False,
                    "error": (
                        f"Higress 地址不可达（已试 {len(console_urls)} 个："
                        f"{last_exc.__class__.__name__ if last_exc else '未知'}）。"
                        "请检查端口——Console 宿主端口是部署时自选的（默认 "
                        "18001），与 Controller 端口不同"
                    ),
                }
            if rr.status_code in (400, 401, 403):
                # 地址通但凭据错 = 直接报（不再换端口试）。
                return {"ok": False, "error": "管理员账号验证失败（账号或密码不正确）"}
            if rr.status_code not in (200, 201, 204):
                return {
                    "ok": False,
                    "error": f"Higress 地址异常：HTTP {rr.status_code}（{console_url}）",
                }
            r = rr
            # 会话 cookie：整个 Set-Cookie 首段（cookie 名随 Higress 版本不定，
            # 存整值、回放时原样带 Cookie 头，最稳）。
            set_cookie = r.headers.get("set-cookie", "")
            session_cookie = set_cookie.split(";")[0].strip() if set_cookie else ""
            await asyncio.to_thread(
                cfgmod.update_config,
                {
                    "admin_username": username,
                    "admin_password": password,
                    "gateway_admin_url": console_url,
                    "gateway_admin_urls": console_urls,
                    "console_session": session_cookie,
                },
            )
            # v0.5.0-beta.14.19: 新会话到手 → 过期标记清零。
            # 任务 190：跨域共享状态，经 router 模块属性写入（勿改回 global）。
            router_mod._console_session_expired = False
            # v0.5.0-beta.12：会话到手立即自检 alias 层（有会话≠有 alias——
            # 解包/形状断点要在验证时就暴露，而不是等模型下拉静默平铺）。
            gw_routes, gw_aliases = 0, []
            if session_cookie:
                try:
                    async with GatedAsyncClient(timeout=8.0, verify=False) as client:
                        gr = await client.get(
                            f"{console_url}/v1/ai/routes",
                            headers={"Cookie": session_cookie},
                        )
                        gp = await client.get(
                            f"{console_url}/v1/ai/providers",
                            headers={"Cookie": session_cookie},
                        )
                    if gr.status_code == 200 and gp.status_code == 200:
                        gw_routes, gw_aliases = _count_gateway_aliases(
                            gr.json(), gp.json()
                        )
                except Exception:  # noqa: BLE001 — 自检失败不挡验证主流程
                    pass
            return {
                "ok": True,
                "mode": "password",
                "console": console_url,
                "has_console_session": bool(session_cookie),
                "gateway_routes": gw_routes,
                "gateway_aliases": gw_aliases,
                "note": "管理员身份验证通过，Higress Console 会话已持有（Higress 面可用）；Controller 管理 API（CRD）仍需配置 Controller 管理员 token。",
            }

        # --- 路径 B：Controller 管理员 token ---
        # v0.5.0-beta.14.23：token 解析在此处（路径 A 早退后）——见函数头
        # N1 注释；token_source ∈ {"input", "config", "env"}。
        token = (body.controller_token or "").strip()
        token_source = ""
        if token == "***" or not token:
            try:
                token, token_source = _resolve_controller_token(cfg)
            except TokenValidationError as e:
                return {"ok": False, "error": str(e), "tokenPath": False}
        else:
            try:
                token = _sanitize_token(token)
            except TokenValidationError as e:
                return {"ok": False, "error": str(e), "tokenPath": False}
            token_source = "input"
        if token:
            cfg_ctl = _ordered_ctl_urls(cfg)
            if not cfg_ctl:
                return {"ok": False, "error": "请先配置 Controller 地址"}
            # v0.5.0-beta.14.21：韧性 + 诊断增强（外网验证 500 根因治理）。
            # 实测：LAN 活地址 /api/v1/teams Bearer JWT = 200 <1s；外网路径
            # （Higress 网关→Controller）偶发 500 = 网关/上游瞬时错（非 token 错）。
            # 旧版把任何非 200 一律报「token 无效」且 3s 超时（5M WAN 偏紧）
            # → 真 500 被误诊为凭据错、慢验证「一直转圈」。现：
            # ① 5xx = 网关/上游瞬时 → 退避 1s 重试一次（同一活地址再探）；
            # ② 4xx = 凭据/权限（地址无关）→ 立即报、不重试不换址；
            # ③ 超时/连接错 = 地址级 → 换下一地址（不重试）；
            # ④ 透出 5xx body 供 UI 显示真实原因（不再被通用文案掩盖）。
            headers_ctl = lambda b: _headers_for(  # noqa: E731
                cfg, "controller", b, {"Authorization": f"Bearer {token}"}
            )
            ok = False
            last_err = ""
            last_status = 0
            last_body = ""
            for base in cfg_ctl:
                for attempt in (1, 2):
                    try:
                        # 5s：5M WAN 活地址 <1s，给瞬时抖动留余量；死地址
                        # 因超时/连接错直接换址（不重试），最坏成本受控。
                        async with GatedAsyncClient(timeout=5.0, verify=False) as client:
                            rr = await client.get(
                                f"{base}/api/v1/teams",
                                headers=headers_ctl(base),
                            )
                    except Exception as exc:  # noqa: BLE001 - 地址级，换下一地址
                        last_err = exc.__class__.__name__
                        last_status = 0
                        break  # 本地址不可达 → 不重试，换下一地址
                    if rr.status_code == 200:
                        ok = True
                        break
                    last_status = rr.status_code
                    last_err = f"HTTP {rr.status_code}"
                    last_body = (rr.text or "")[:300]
                    if rr.status_code < 500:
                        break  # 4xx 凭据错：地址无关，立即报
                    # 5xx 瞬时：退避后重试一次（同地址）。
                    if attempt == 1:
                        await asyncio.sleep(1.0)
                        continue
                    break  # 重试仍 5xx → 换下一地址
                if ok:
                    break
            if not ok:
                if 400 <= last_status < 500:
                    return {
                        "ok": False,
                        "error": f"Controller 管理员 token 无效或凭据错误（HTTP {last_status}）",
                    }
                if last_status >= 500:
                    return {
                        "ok": False,
                        "error": (
                            f"外网/网关异常（HTTP {last_status}）：{last_body}——"
                            "瞬时的网关或上游错误，非 token 问题，请稍后重试或检查外网路径"
                        ),
                    }
                return {
                    "ok": False,
                    "error": f"无法连接 Controller（{last_err}）——请检查 Controller 地址与网络",
                }
            # env 来源不落盘：保持 config 为空让 env 保持唯一事实源
            # （token 轮换=更新 QwenPaw env，不会被旧 config 值遮蔽）。
            if token_source in ("input", "config"):
                await asyncio.to_thread(
                    cfgmod.update_config, {"controller_token": token}
                )
            return {
                "ok": True,
                "mode": "token",
                "tokenSource": token_source,
                "message": (
                    "Controller 管理员 token 验证通过（来源=环境变量 AGENTTEAMS_CONTROLLER_TOKEN，未写入本地配置——token 轮换时更新 QwenPaw 宿主 env 即可）。"
                    if token_source == "env"
                    else "Controller 管理员 token 验证通过：已保存。"
                ),
            }

        return {
            "ok": False,
            "error": "请填写管理员账号与密码，或 Controller 管理员 token（二选一；token 获取命令见设置页提示，或部署期注入 env AGENTTEAMS_CONTROLLER_TOKEN）",
        }
    return router
