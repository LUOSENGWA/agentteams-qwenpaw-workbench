# -*- coding: utf-8 -*-
"""User-level plugin configuration.

Config is stored on the user's machine under
``SECRET_DIR/agentteams-qwenpaw-workbench/config.json`` (SECRET_DIR comes from
``qwenpaw.constant``).

Address model (auto-failover): the Matrix homeserver and Controller are the
SAME backend reached through different network paths (e.g. LAN IP at home,
reverse-proxy domain outside). Both paths share one Matrix token, so the
backend simply probes the list in order and caches whichever answers.
No manual profile switching.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Union

# 地址条目 = 字符串（服务原生认证，
# 内网默认形态）或 {url, auth?}（显式覆盖凭据）。auth 类型：
# {"type": "basic", "username": ..., "password": ...} —— 网关 Basic 门
# {"type": "bearer", "token": ...} —— API key / 专用
# 无 auth = 用服务自身认证（controller token / matrix token / SGLang 无）。
# 单一出处：所有拨号点经 address_url()/auth_for_url()/headers_with_auth()
# 解析，不各写各的（逐个修补防护——新增拨号点只调 helper）。
AddressEntry = Union[str, Dict[str, Any]]

try:  # pragma: no cover - exercised inside QwenPaw at runtime
    from qwenpaw.constant import SECRET_DIR as _SECRET_DIR
except Exception:  # noqa: BLE001 - allow import in isolation for linting
    _SECRET_DIR = Path.home() / ".qwenpaw" / "secret"

_CONFIG_DIR = Path(_SECRET_DIR) / "agentteams-qwenpaw-workbench"
_CONFIG_PATH = _CONFIG_DIR / "config.json"

_lock = threading.Lock()
# load_config 读缓存（进程内单进程安全：同 _lock 保护；键=文件 mtime+size，
# 外部改文件自然失效；save_config 写盘后立即失效）。value=原始 raw dict
# （未合并 defaults），命中时仍走完整合并逻辑——只省 read/parse/chmod。
_config_read_cache: Dict[str, Any] = {"mtime_ns": None, "size": None, "data": None}

# 写盘审计环（最近 20 条）——每次真实
# 写盘记 source + 关键字段形态 diff（只记有无/模式，秘密值永不入日志）。
# 背景：config 曾被静默改写（address_mode 无人操作下自变）且全程无观测
# ——难查的真因=写路径零日志；本环让下次再犯一次日志即定凶。
_CONFIG_WRITE_AUDIT: Deque[Dict[str, Any]] = deque(maxlen=20)

# 最近一次 load_config 的加载结局（ok / defaults-fallback /
# restored-from-backup / unknown=尚未加载）——供 update_config 的
# 「defaults 态自动补丁不落盘」防呆与 /config 健康展示。
_last_load_state = "unknown"

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")


def config_rev() -> Optional[str]:
    """：配置修订号 = "mtime_ns:size"（文件不存在→None）。

 前端页面加载时取走、保存时回传；后端对不上即 409——挡住「页面加载后
 配置被外部改动（另一 tab/手工编辑/导入/自愈恢复）再被旧表单静默覆盖」。
 """
    try:
        st = _CONFIG_PATH.stat()
    except OSError:
        return None
    return f"{st.st_mtime_ns}:{st.st_size}"


def config_load_state() -> str:
    """最近一次 load_config 的结局（ok/fresh/read-error/
    restored-from-backup/defaults-fallback(兼容保留)/unknown）。"""
    return _last_load_state


def disk_has_config() -> bool:
    """磁盘上主配置文件是否存在（保存防呆用：无修订号的保存 +
    文件存在 = 拒——默认表单/脚本/旧标签页拿不到 rev，文件存在
    说明历史上有过用户配置，覆盖即高危）。首启（无文件）放行。"""
    try:
        return _CONFIG_PATH.exists()
    except OSError:
        return False


def config_health() -> Dict[str, Any]:
    """：配置健康态（/config 展示 + 前端横幅）。

 state 取值（=最近一次 load_config 的结局）：
   ok                   = 主文件存在且合法
   fresh                = 主文件从未存在（全新首启）→ 默认值=合法初始态，
                          表单可填可存（首写=创建）
   read-error           = 主文件存在但读失败（挂载层瞬时故障/损坏且无
                          备份）→ 假状态，GET /config 返回 503、保存拒
                          绝（防默认值盖盘——10/8 wipe 链堵点）
   defaults-fallback    = （兼容保留，现不再产生——已被 fresh/read-error
                          细分取代）
   restored-from-backup = 主文件缺失/损坏 → 已从 config.bak.json 恢复
   unknown              = 进程启动后尚未加载过
 """
    writable = False
    try:
        import os as _os

        writable = _os.access(str(_CONFIG_DIR), _os.W_OK)
    except Exception:  # noqa: BLE001
        pass
    out: Dict[str, Any] = {
        "state": _last_load_state,
        "path": str(_CONFIG_PATH),
        "mtime": 0,
        "size": 0,
        "writable": writable,
    }
    try:
        st = _CONFIG_PATH.stat()
        out["mtime"] = int(st.st_mtime)
        out["size"] = st.st_size
    except OSError:
        pass
    return out


def _config_signature(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """配置关键字段形态签名（审计用——只有有无/模式，无秘密值）。"""
    if not isinstance(data, dict):
        return {
            "mode": None,
            "admin_user": False,
            "admin_pass": False,
            "console_session": False,
            "matrix_token": False,
        }
    matrix = data.get("matrix") or {}
    return {
        "mode": data.get("address_mode"),
        "admin_user": bool(str(data.get("admin_username") or "").strip()),
        "admin_pass": bool(str(data.get("admin_password") or "").strip()),
        "console_session": bool(str(data.get("console_session") or "").strip()),
        "matrix_token": bool(str(matrix.get("access_token") or "").strip()),
    }


def _record_config_write(
    source: str, before: Optional[Dict[str, Any]], after: Dict[str, Any]
) -> None:
    """：记一次真实写盘（WARNING 日志 + 审计环）。

 before=None = 写前文件不存在（首写/删后恢复）。changed=签名差异键
 （空=仅秘密值变化——值本身不入审计）。
 """
    b, a = _config_signature(before), _config_signature(after)
    changed = sorted(k for k in b if b[k] != a[k])
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "before": b,
        "after": a,
        "changed": changed,
    }
    _CONFIG_WRITE_AUDIT.append(entry)
    logger.warning(
        "config write: source=%s before=%s after=%s changed=%s",
        source,
        b,
        a,
        changed or "-",
    )

# ── 地址条目（str | {url, auth?}）解析与凭据 helper ──

_AUTH_TYPES = ("basic", "bearer")


def address_url(entry: Any) -> str:
    """地址条目 → URL 字符串（str 原样；dict 取 .url；其他 → ""）。"""
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        return str(entry.get("url") or "").strip()
    return ""


def _normalize_auth(raw: Any) -> Optional[Dict[str, str]]:
    """校验并归一化 auth 块；无效/缺凭据 → None（= 用服务原生认证）。

 basic 需 username+password；bearer 需 token。空串凭据视为未填。
 """
    if not isinstance(raw, dict):
        return None
    atype = str(raw.get("type") or "").strip().lower()
    if atype == "basic":
        u = str(raw.get("username") or "").strip()
        p = str(raw.get("password") or "").strip()
        if not (u and p and p != "***"):
            return None
        return {"type": "basic", "username": u, "password": p}
    if atype == "bearer":
        t = str(raw.get("token") or "").strip()
        if not t or t == "***":
            return None
        return {"type": "bearer", "token": t}
    return None


def auth_for_url(entries: Any, url: str) -> Optional[Dict[str, str]]:
    """该 URL 对应的覆盖凭据（无/无效 → None）。

 url 匹配口径 = rstrip("/") 后精确相等（配置里的 url 可能带尾斜杠，
 拨号点也统一 rstrip 后再查——两侧同口径防不命中）。
 """
    target = url.rstrip("/")
    for entry in entries or []:
        if address_url(entry) and address_url(entry).rstrip("/") == target:
            return _normalize_auth((entry or {}).get("auth") if isinstance(entry, dict) else None)
    return None


def build_auth_map(entries: Any) -> Dict[str, Dict[str, str]]:
    """地址条目列表 → {url(rstrip 归一): 有效 auth}（无效/无凭据的条目不进表）。"""
    out: Dict[str, Dict[str, str]] = {}
    for entry in entries or []:
        u = address_url(entry)
        if not u or not isinstance(entry, dict):
            continue
        auth = _normalize_auth(entry.get("auth"))
        if auth:
            out[u.rstrip("/")] = auth
    return out


def headers_with_auth(auth: Optional[Dict[str, str]], headers: Dict[str, str]) -> Dict[str, str]:
    """应用覆盖凭据（无 auth/无效 → 原样返回 base headers）。

 只动 Authorization 一个头：basic → `Basic base64(u:p)` 整体替换；
 bearer → `Bearer <token>` 整体替换。不改写其他头。
 """
    if not auth:
        return headers
    out = dict(headers)
    if auth.get("type") == "basic":
        raw = f"{auth.get('username', '')}:{auth.get('password', '')}".encode("utf-8")
        out["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
    elif auth.get("type") == "bearer":
        out["Authorization"] = f"Bearer {auth.get('token', '')}"
    return out


def merge_address_entries(
    old_entries: Any, new_entries: Any
) -> List[AddressEntry]:
    """PUT /config 的地址列表合并（按位置配对，保留旧秘密）。

 规则（与 controller_token 的 "***" 占位符语义同源）：
 - 新条目=字符串 → 原样（显式降级：旧凭据丢弃）。
 - 新条目=dict：
 - auth 缺省/type=none → 字符串条目（显式清除凭据）。
 - 凭据字段空串或 "***" → 继承旧条目同名字段（脱敏回传=保持不变）。
 - url 为空 → 丢弃该条目（与旧 filter(v=>v.trim()) 行为一致）。
 - 旧列表更长的尾部条目 → 丢弃（前端始终提交完整两行）。
 """
    merged: List[AddressEntry] = []
    old_list = list(old_entries or [])
    for i, entry in enumerate(new_entries or []):
        if isinstance(entry, str):
            u = entry.strip()
            if u:
                merged.append(u)
            continue
        if not isinstance(entry, dict):
            continue
        u = str(entry.get("url") or "").strip()
        if not u:
            continue
        old_entry = old_list[i] if i < len(old_list) else None
        old_auth = (
            _normalize_auth((old_entry or {}).get("auth"))
            if isinstance(old_entry, dict)
            else None
        ) or {}
        auth_in = entry.get("auth")
        if not isinstance(auth_in, dict) or str(auth_in.get("type") or "").strip().lower() in ("", "none"):
            merged.append(u)
            continue
        atype = str(auth_in.get("type") or "").strip().lower()
        if atype == "basic":
            username = str(auth_in.get("username") or "").strip() or str(old_auth.get("username") or "")
            password = str(auth_in.get("password") or "").strip()
            if not password or password == "***":
                password = str(old_auth.get("password") or "")
            if username and password and password != "***":
                merged.append({"url": u, "auth": {"type": "basic", "username": username, "password": password}})
            else:
                merged.append(u)
        elif atype == "bearer":
            token = str(auth_in.get("token") or "").strip()
            if not token or token == "***":
                token = str(old_auth.get("token") or "")
            if token and token != "***":
                merged.append({"url": u, "auth": {"type": "bearer", "token": token}})
            else:
                merged.append(u)
        else:
            merged.append(u)
    return merged

def credential_gaps(
    old_entries: Any, new_entries: Any
) -> List[Dict[str, Any]]:
    """保存前凭据意图检查（）。

 找出「用户明确选择覆盖凭据（basic/bearer）但凭据字段为空、且旧条目
 在同位置没有可继承的凭据」的条目——按 merge_address_entries 的继承
 规则，这种条目会**静默降级为无凭据字符串条目**（网关门 → 401），
 而保存响应仍报成功。现由调用方在保存前拦截/保存后显形，杜绝
 「显示已保存、实际没凭据」的糊涂态。

 返回缺失清单：[{"index": i, "type": "basic"|"bearer", "username": ...}]
 （username 仅 basic 且已填时给出，供错误文案定位）。
 与 merge_address_entries 的配对口径完全一致（按位置配对；旧列表更短
 的尾部位置=无旧凭据）。
 """
    gaps: List[Dict[str, Any]] = []
    old_list = list(old_entries or [])
    for i, entry in enumerate(new_entries or []):
        if not isinstance(entry, dict):
            continue
        auth_in = entry.get("auth")
        if not isinstance(auth_in, dict):
            continue
        atype = str(auth_in.get("type") or "").strip().lower()
        if atype not in ("basic", "bearer"):
            continue  # none/缺省=显式清除，无继承语义
        old_entry = old_list[i] if i < len(old_list) else None
        old_auth = (
            _normalize_auth((old_entry or {}).get("auth"))
            if isinstance(old_entry, dict)
            else None
        )
        # 继承只认**同类型**旧凭据（merge_address_entries 的字段口径：
        # basic 继承 username/password，bearer 继承 token；类型不同=
        # 无字段可继承 → 静默降级 str 条目，同缺口）。
        if old_auth and old_auth.get("type") != atype:
            old_auth = None
        if atype == "basic":
            username = str(auth_in.get("username") or "").strip()
            password = str(auth_in.get("password") or "").strip()
            # 空/"***" = 走继承；旧凭据也在 = 继承成功（无缺口）。
            if (not password or password == "***") and not old_auth:
                gaps.append({"index": i, "type": "basic",
                             "username": username})
        else:
            token = str(auth_in.get("token") or "").strip()
            if (not token or token == "***") and not old_auth:
                gaps.append({"index": i, "type": "bearer"})
    return gaps


def persisted_credential_kinds(entries: Any) -> List[str]:
    """地址列表 → 逐位置凭据形态（回读校验用）：
 "str"=无凭据 / "basic" / "bearer"。口径=redact 后前端可见的结构
 （凭据值已脱敏，但条目形态与 auth 类型保留）。"""
    out: List[str] = []
    for entry in entries or []:
        if isinstance(entry, dict):
            auth = _normalize_auth(entry.get("auth"))
            out.append(auth.get("type") if auth else "str")
        else:
            out.append("str")
    return out


_DEFAULTS: Dict[str, Any] = {
    # Ordered address lists — first reachable wins (auto-failover).
    "matrix_homeservers": [],  # e.g. ["http://10.0.0.10:6867", "https://agentteams.example.com:6867"]
    "controller_urls": [],  # e.g. ["http://10.0.0.10:8090"]
    # Optional admin token for L1 full view (same token on both paths).
    "controller_token": "",
    # L1 管理员验证二选一（同 dashboard 语义，仅 L1）——
    # ① admin 账号+密码：POST {gateway_admin_url}/session/login 验证，
    # 成功后持有 Console 管理员会话（console_session），供网关面
    # （AI routes/providers = 模型选择 alias 层数据源）消费。
    # ② controller_token（上）：Controller 管理 API 全量（现状）。
    "admin_username": "",
    "admin_password": "",
    # Higress Console（管理面）地址。**必填**（设计）：
    # 留空 = 验证时报可操作错误——不从 Controller 地址推导、不盲探端口
    # （宿主端口是安装时自选的，AGENTTEAMS_PORT_CONSOLE 默认 18001）。
    # Higress Console 双地址（canonical；legacy 单值键保留为
    # urls[0] 镜像，老读者兼容）。条目不限 2 个，按序降级。
    "gateway_admin_urls": [],
    "gateway_admin_url": "",
    # 控制台特效安抚——停用上游 RunningGlow
    # 旋转光环/呼吸层的动画（保留光效视觉）。默认开（省 GPU）；可关。
    # 保留为兼容键（新键 console_effects
    # 三档取代其功能；load 迁移时以其值推导 console_effects 初值，
    # 之后不再读写，老配置/老读者兼容）。
    "console_calm": True,
    # 控制台特效三档——
    # "light"（默认：动画保留、模糊半径封顶 6px）/ "off"（动画与模糊全停，
    # 等价旧 console_calm 开启）/ "full"（上游原样，零覆盖）。
    "console_effects": "light",
    # Console 管理员会话 cookie（session/login 成功后的 Set-Cookie 值，
    # 服务端自持，redact 脱敏，永不进前端可见明文）。
    "console_session": "",
    # 可选模块：集群负载监控（L1 专属——不是每个部署都有本地 SGLang）。
    # enabled=false 时前端不渲染卡片、后端不注册语义（404），零痕迹。
    # 双地址（内网/外网）——有序数组，首个可达 + failover，
    # 与 matrix_homeservers/controller_urls 同构；旧版单地址 "url" 自动迁移。
    "sglang": {
        "enabled": False,
        "urls": [],  # e.g. ["http://192.168.x.x:30000", "https://你的域名:30000"]
    },
    # 地址手动固定档（"auto"=自动切换[默认] /
    # "lan"=固定内网[列表索引 0] / "wan"=固定外网[索引 1]）——固定档失败
    # 诚实报错不 failover，探测循环照跑只供显示。
    "address_mode": "auto",
    "matrix": {
        "user_id": "",
        "access_token": "",
        "device_id": "",
    },
}


def _ensure_dir() -> None:
    """：目录 700（内含明文凭据的 config）。"""
    import os as _os

    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _os.chmod(_CONFIG_DIR, 0o700)
    except Exception:  # noqa: BLE001
        pass


def _config_bak_path() -> Path:
    """备份文件路径——从 _CONFIG_PATH 派生
 （config.json 旁的 config.bak.json；测试 monkeypatch 主文件路径时自动
 跟随，零额外注入点）。"""
    return _CONFIG_PATH.with_name("config.bak.json")


def _atomic_write_config(path: Path, data: Dict[str, Any]) -> None:
    """原子落盘（tmp + os.replace + chmod 600）——保存与备份恢复共用。

 失败抛 IOError（调用方定语义：save → 报错给端点；恢复 → 放弃回退默认）。
 """
    import os as _os

    _ensure_dir()
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp.replace(path)
        # 文件含明文凭据（Basic 密码等）——收紧到
        # 600（best-effort，失败不影响功能）。
        try:
            _os.chmod(path, 0o600)
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        raise IOError(f"配置写入失败：{exc}") from exc


def write_backup(snapshot: Dict[str, Any]) -> None:
    """原子写 config.bak.json 快照。

 失败抛 IOError——调用方决定：save 路径仅告警（主文件已验证落盘，不
 拖累保存）；导入路径 = 中止不覆盖（「先备份再覆盖」安全契约）。
 """
    _atomic_write_config(_config_bak_path(), snapshot)


def _restore_from_backup() -> Optional[Dict[str, Any]]:
    """自愈——主配置缺失/损坏 → 从
 config.bak.json 恢复（原子写回主文件 + 日志明示）。

 无备份/备份损坏/写回失败 → None（调用方回默认值，不崩）。
 """
    bak = _config_bak_path()
    try:
        data = json.loads(bak.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        logger.warning(
            "config self-heal: backup %s unavailable (%s: %s) — falling back to defaults",
            bak,
            type(exc).__name__,
            exc,
        )
        return None
    if not isinstance(data, dict):
        logger.warning(
            "config self-heal: backup %s is not a JSON object — falling back to defaults",
            bak,
        )
        return None
    try:
        _atomic_write_config(_CONFIG_PATH, data)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "config self-heal: restore write failed: %s — falling back to defaults",
            exc,
        )
        return None
    logger.warning(
        "config self-heal: main config missing or corrupt — restored from %s",
        bak,
    )
    try:
        _record_config_write("self-heal(restore-from-backup)", None, data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("config write audit failed: %s", exc)
    return data


def load_config() -> Dict[str, Any]:
    """Load the config, merging with defaults for missing keys."""
    global _last_load_state
    with _lock:
        # 读缓存（mtime+size 判定）：命中跳 disk read/parse/chmod，返回深拷贝
        # （与未缓存路径同语义——调用方可自由改返回值不污染缓存）；
        # save_config 写盘后失效，外部改文件靠 mtime/size 变化自然失效。
        _cst = None
        try:
            _cst = _CONFIG_PATH.stat()
        except OSError:
            _cst = None
        if (
            _cst is not None
            and _config_read_cache["mtime_ns"] == _cst.st_mtime_ns
            and _config_read_cache["size"] == _cst.st_size
            and _config_read_cache["data"] is not None
        ):
            _last_load_state = "ok"
            return json.loads(json.dumps(_config_read_cache["data"]))
        _stat_key = (
            (_cst.st_mtime_ns, _cst.st_size) if _cst is not None else None
        )
        # 读失败重试一次再判损坏：挂载层（NFS/FUSE）抖动会瞬时返回
        # 空/截断内容——不重试会被误判「文件损坏」→ defaults-fallback
        # （地址模式回 auto、地址凭据显示全丢），后续保存又可能被
        # 防呆守卫拦成假成功。重试仍失败才走备份/默认值兜底。
        raw = None
        for _attempt in (1, 2):
            try:
                _text = _CONFIG_PATH.read_text(encoding="utf-8")
                raw = json.loads(_text)
                if not isinstance(raw, dict):
                    raise ValueError("top-level JSON must be an object")
                break
            except (FileNotFoundError, json.JSONDecodeError, ValueError, OSError):
                raw = None
                if _attempt == 1:
                    import time as _t

                    _t.sleep(0.25)
        if raw is None:
            # 自愈——主文件缺失/损坏
            # （含顶层非对象）→ 自动从备份恢复（日志明示）；无可用备份
            # → 默认值（不崩）。
            restored = _restore_from_backup()
            if restored is not None:
                _last_load_state = "restored-from-backup"
                raw = restored
            else:
                # 细分「兜底默认值」的两种语义——前端据此决定能否保存：
                #   fresh      = 主文件从未存在（全新首启）→ 合法初始态，
                #                表单应可填、可保存（首写=创建，非覆盖）
                #   read-error = 主文件存在但读失败（挂载层瞬时故障/损坏
                #                且无备份）→ 假状态。文件内容很可能仍正常，
                #                此时把默认值当真配置返回=10/8 wipe 链的
                #                起点（前端 ready→保存→全默认值盖盘）。
                #                GET 返回 503，前端进重试链而非填充表单。
                try:
                    _file_exists = _CONFIG_PATH.exists()
                except OSError:
                    _file_exists = False
                _last_load_state = (
                    "fresh" if not _file_exists else "read-error"
                )
                return json.loads(json.dumps(_DEFAULTS))

        # 存量 644 → 600 兜底（一次性收敛）。
        try:
            import os as _os

            _os.chmod(_CONFIG_PATH, 0o600)
        except Exception:  # noqa: BLE001
            pass

        merged = json.loads(json.dumps(_DEFAULTS))
        # New schema keys
        for key in (
            "matrix_homeservers",
            "controller_urls",
            "controller_token",
            "admin_username",
            "admin_password",
            # 双地址 canonical 列表（不加则落盘值重载时被丢）。
            "gateway_admin_urls",
            "gateway_admin_url",
            # 控制台特效安抚（bool，落盘值须重载保留）。
            "console_calm",
            # 控制台特效三档（落盘值须重载保留）。
            "console_effects",
            "console_session",
            "sglang",
            "matrix",
            "address_mode",
        ):
            if key in raw and raw[key] is not None:
                merged[key] = raw[key]
        # 旧配置垃圾值降级 auto（不 400 不崩）。
        if merged.get("address_mode") not in ("auto", "lan", "wan"):
            merged["address_mode"] = "auto"
        # console_effects 迁移——
        # 落盘缺省（老配置无此键）或非法值 → 按 console_calm 推导：
        # console_calm is False（用户曾选"完整特效"语义）→ "full"，否则
        # "light"（不 400 不崩，与 address_mode 降级先例一致）。
        _raw_fx = raw.get("console_effects")
        if _raw_fx is None or _raw_fx not in ("light", "off", "full"):
            merged["console_effects"] = (
                "full" if raw.get("console_calm") is False else "light"
            )
        # gateway 双地址——legacy 单值 → 列表（空列表时）；
        # 列表非空时 legacy 键镜像 urls[0]（老读者兼容）。
        if not merged.get("gateway_admin_urls"):
            legacy_gw = str(merged.get("gateway_admin_url") or "").strip()
            if legacy_gw:
                merged["gateway_admin_urls"] = [legacy_gw]
        elif merged.get("gateway_admin_urls"):
            merged["gateway_admin_url"] = (
                address_url(merged["gateway_admin_urls"][0]) or ""
            )
        # Legacy schema migration (v0.1.0 profiles) → auto-failover lists.
        if not merged["matrix_homeservers"] and isinstance(raw.get("profiles"), dict):
            homeservers: List[str] = []
            controller_urls: List[str] = []
            token = ""
            for name in ("home", "remote"):
                profile = raw["profiles"].get(name) or {}
                hs = (profile.get("matrix_homeserver") or "").strip()
                cu = (profile.get("controller_url") or "").strip()
                if hs and hs not in homeservers:
                    homeservers.append(hs)
                if cu and cu not in controller_urls:
                    controller_urls.append(cu)
                if not token and (profile.get("controller_token") or "").strip():
                    token = profile["controller_token"].strip()
            merged["matrix_homeservers"] = homeservers
            merged["controller_urls"] = controller_urls
            if token:
                merged["controller_token"] = token
        # sglang 旧版单地址 "url" → 双地址 "urls"（存量配置自动迁移）。
        # 迁移后 pop 旧键——否则旧 url 会作为第三个 failover 候选混入请求链。
        sg = merged.get("sglang")
        if isinstance(sg, dict) and not sg.get("urls"):
            legacy = str(sg.get("url") or "").strip()
            if legacy:
                sg["urls"] = [legacy]
            sg.pop("url", None)
        # 自愈/缺失路径（_stat_key=None，文件在调用中重写或不存在）不缓存
        # ——下次 load 按新文件 stat 判定，避免缓存与重写后内容失配。
        if _stat_key is not None:
            _config_read_cache.update(
                {"mtime_ns": _stat_key[0], "size": _stat_key[1], "data": raw}
            )
        # 仅「正常磁盘读」路径标 ok——无条件置 ok 会抹掉
        # restored-from-backup 标记（既有缺陷：14.27 加的「已从备份恢复，
        # 请核对」横幅因此从未显形过，state 到 GET 时已变 ok）。
        if _last_load_state != "restored-from-backup":
            _last_load_state = "ok"
        return merged


def save_config(
    config: Dict[str, Any],
    refresh_backup: bool = True,
    source: str = "unknown",
) -> None:
    """Persist the full config (caller is responsible for shape).

 成功保存后自动原子刷新 config.bak.json
 ——下次加载主文件丢失/损坏时从中自愈（见 load_config/_restore_from_backup）。
 备份失败仅告警（主文件已验证落盘，不拖累保存）；refresh_backup=False 供
 导入路径（导入前先手工备份覆盖前状态，覆盖后备份保持为恢复点，不被新值
 顶掉）。

 ：source=调用方标识（PUT /config / login /
 relogin / import / self-heal…），每次真实写盘记审计环 + WARNING 日志
 （关键字段形态 diff，秘密值永不入日志）——配置被谁改的，日志说了算。
 """
    global _last_load_state
    # 写前签名（文件不存在/损坏=None）——锁外读：审计用途，与并发写
    # 竞态时 before 可能偏新一格（可接受，不影响正确性）。
    try:
        _before = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(_before, dict):
            _before = None
    except (OSError, ValueError):
        _before = None
    with _lock:
        try:
            _atomic_write_config(_CONFIG_PATH, config)
            # 写后回读验证（小文件，成本可忽略）
            # ——「保存成功」必须以磁盘实况为准，读回不一致直接抛错（由端点
            # 转 500 详情）。
            _back = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
            if _back != config:
                raise IOError("配置写盘校验不一致（磁盘内容与内存态不同）")
        except Exception as exc:  # noqa: BLE001
            raise IOError(f"配置写入失败：{exc}") from exc
        # 写盘成功 → 读缓存立即失效（下次 load 必然回源读新内容）。
        _config_read_cache.update({"mtime_ns": None, "size": None, "data": None})
        _last_load_state = "ok"
        # 写盘审计（环 + WARNING 日志，
        # 关键字段形态 diff——下次配置被谁改的，日志即定凶）。
        try:
            _record_config_write(source, _before, config)
        except Exception as exc:  # noqa: BLE001 - 审计失败不影响主流程
            logger.warning("config write audit failed: %s", exc)
        if refresh_backup:
            try:
                write_backup(config)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "config backup refresh failed (main config saved OK): %s",
                    exc,
                )


def update_config(
    patch: Dict[str, Any],
    source: str = "update_config",
    force_persist: bool = False,
) -> Dict[str, Any]:
    """Apply a shallow patch and persist. Returns the merged config.

 防呆：若最近一次 load_config 是 defaults-fallback（主文件缺失/损坏
 且无备份），补丁与完整默认值合并落盘=用户配置被静默覆盖成全默认
 （address_mode/凭据瞬间丢）。此时跳过落盘：返回内存合并态（本次
 请求内行为不变），WARNING 明示「补丁未落盘」。主文件恢复后（用户
 重存/导入）补丁自然重新可写；用户确认用表单值重建文件时传
 force_persist=True 显式放行。文件不存在（全新安装首写）不受影响。
 """
    merged = load_config()
    # 地址条目 str | {url, auth?}——按位置合并（保留旧秘密）。
    for key in ("matrix_homeservers", "controller_urls"):
        if key in patch and isinstance(patch[key], list):
            merged[key] = merge_address_entries(merged.get(key), patch[key])
    if "controller_token" in patch and isinstance(patch["controller_token"], str):
        tok = patch["controller_token"].strip()
        # "***" 是脱敏占位符（导出再导入场景）——不覆盖真实 token。
        if tok and tok != "***":
            merged["controller_token"] = tok
    # L1 管理员验证字段（同 token 的脱敏占位符语义）。
    for key in ("admin_username", "admin_password", "gateway_admin_url", "console_session"):
        if key in patch and isinstance(patch[key], str):
            val = patch[key].strip()
            if val and val != "***":
                merged[key] = val
    # gateway 双地址（同 matrix/controller 的位置合并语义）；
    # legacy 单值仍可写（同步为单元素列表）。
    if "gateway_admin_urls" in patch and isinstance(patch["gateway_admin_urls"], list):
        merged["gateway_admin_urls"] = merge_address_entries(
            merged.get("gateway_admin_urls"), patch["gateway_admin_urls"]
        )
    if (
        "gateway_admin_url" in patch
        and isinstance(patch["gateway_admin_url"], str)
        and patch["gateway_admin_url"].strip()
        and patch["gateway_admin_url"].strip() != "***"
        and not patch.get("gateway_admin_urls")
    ):
        merged["gateway_admin_urls"] = [patch["gateway_admin_url"].strip()]
    # console_calm 直存（bool，非法忽略）。
    if isinstance(patch.get("console_calm"), bool):
        merged["console_calm"] = patch["console_calm"]
    # console_effects 三档直存
    # （非 {light, off, full} 的字符串/类型一律忽略，不 400）。
    if (
        isinstance(patch.get("console_effects"), str)
        and patch["console_effects"] in ("light", "off", "full")
    ):
        merged["console_effects"] = patch["console_effects"]
    # 地址模式（无效值归 auto；空串不动）。
    if "address_mode" in patch and isinstance(patch["address_mode"], str):
        val = patch["address_mode"].strip()
        if val:
            merged["address_mode"] = val if val in ("auto", "lan", "wan") else "auto"
    if "sglang" in patch and isinstance(patch["sglang"], dict):
        existing = merged.get("sglang") or {}
        incoming = dict(patch["sglang"])
        # 双地址列表；兼容旧前端/旧配置的单地址 "url"。
        # 条目 str | {url, auth?}（同 matrix/controller 合并语义）。
        if "urls" in incoming and isinstance(incoming["urls"], list):
            incoming["urls"] = merge_address_entries(
                (existing.get("urls") if isinstance(existing.get("urls"), list) else []),
                incoming["urls"],
            )
        if "url" in incoming:
            legacy_url = str(incoming.pop("url") or "").strip()
            if legacy_url:
                if not incoming.get("urls"):
                    incoming["urls"] = [legacy_url]
            elif "urls" not in incoming:
                # 旧前端传空 url = 清空地址（不清会残留旧值）。
                incoming["urls"] = []
        existing.update(incoming)
        merged["sglang"] = existing
    if "matrix" in patch and isinstance(patch["matrix"], dict):
        existing = merged.get("matrix") or {}
        incoming = dict(patch["matrix"])
        if incoming.get("access_token") == "***":
            incoming.pop("access_token", None)
        existing.update(incoming)
        merged["matrix"] = existing
    # 防呆：defaults-fallback 且主文件**存在**（=文件损坏且无备份）→
    # 默认禁止落盘：不拿全默认值盖掉损坏文件（保留现场供取证，UI 健康
    # 横幅已显形，用户走导入/显式恢复）。文件**不存在**（全新安装首写）
    # → 正常落盘（首写=创建，不是覆盖）。force_persist=True=用户显式
    # 恢复（横幅警示下的「保存写新文件」），跳过守卫。
    if _last_load_state == "defaults-fallback" and not force_persist:
        try:
            _file_present = _CONFIG_PATH.exists()
        except OSError:
            _file_present = False
        if _file_present:
            logger.warning(
                "update_config SKIPPED persist (source=%s): main config "
                "file exists but last load was defaults-fallback (corrupt "
                "file, no backup) — persisting would mask the corruption "
                "with full defaults; restore via import/re-save",
                source,
            )
            return merged
    # 纵深防线：read-error（文件存在但瞬时读失败）→ 无条件拒（force_
    # persist 不豁免——显式恢复的语义是「重建缺失文件」，而 read-error
    # 的文件很可能完好，落盘=拿默认值盖真数据，正是 10/8 wipe 链的
    # 最后一步。PUT handler 已先行 409；此层兜住任何其它调用路径。
    if _last_load_state == "read-error":
        logger.error(
            "update_config REFUSED (source=%s): last load was read-error "
            "(file present, transient read failure) — in-memory baseline "
            "is defaults; persisting any patch would overwrite likely-"
            "healthy disk data with defaults. force_persist does NOT "
            "exempt (10/8 wipe chain).",
            source,
        )
        raise IOError(
            "配置文件暂不可读（read-error）——为防止默认值覆盖你的已保存"
            "配置，拒绝保存。请稍后重试。"
        )
    # 防 wipe：patch 写不得丢失它**没碰**的数据。内存基线被瞬时读失败
    # 污染（误判损坏→默认值兜底）时，一个单字段补丁（如登录写
    # console_session / 切地址模式写 address_mode）落盘=把磁盘上的地址
    # 列表与凭据整个抹掉（10/8 实盘：lan→auto 静默改写，密码/地址全丢
    # 且零日志）。落盘前对照磁盘实况兜底拦截——即使 defaults-fallback
    # 守卫被 force_persist 显式放行也仍受此约束（显式恢复只豁免「默认
    # 值盖损坏文件」，不豁免「丢未触碰数据」）。
    try:
        _disk_now = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        _disk_now = None
    if isinstance(_disk_now, dict):
        for _k in ("matrix_homeservers", "controller_urls",
                   "gateway_admin_urls"):
            if (
                _k not in patch
                and _disk_now.get(_k)
                and not merged.get(_k)
            ):
                logger.error(
                    "update_config WIPES-BLOCKED (source=%s): disk %s "
                    "has values but merged result would drop them — "
                    "in-memory baseline is suspected poisoned "
                    "(transient read failure → defaults). Refusing to "
                    "persist; disk data preserved.",
                    source,
                    _k,
                )
                raise IOError(
                    f"配置写入被防 wipe 守卫拦截：磁盘 {_k} 有值而本次"
                    f"合并结果丢失（内存基线疑似瞬时读失败的默认值）。"
                    f"已拒绝落盘以保留磁盘数据，请刷新页面后重试。"
                )
    save_config(merged, source=source)
    return merged


def _redact_entry_list(entries: Any) -> None:
    """地址条目内的 auth 秘密脱敏（username 保留——非机密，前端回显）。"""
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        auth = entry.get("auth")
        if not isinstance(auth, dict):
            continue
        if auth.get("password"):
            auth["password"] = "***"
        if auth.get("token"):
            auth["token"] = "***"


def credential_state(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """逐条凭据存在态（UI 自证显形用，取值只看有无不看值）。

    saved=完整凭据在 / username-only=只存了用户名（密码缺失——
    显示必须与 saved 区分开，「看起来有其实没存」是 basic 密码
    「要重新填」类投诉的观感根源）/ none=裸 URL 或无 auth。
    在 redact 之前对原始内存态计算（脱敏副本上算不出有无）。
    """
    def _entry_state(e: Any) -> str:
        if not isinstance(e, dict):
            return "none"
        a = e.get("auth")
        if not isinstance(a, dict):
            return "none"
        t = str(a.get("type") or "").strip().lower()
        if t == "basic":
            user = str(a.get("username") or "").strip()
            pw = str(a.get("password") or "").strip()
            if user and pw:
                return "saved"
            return "username-only" if user else "none"
        if t == "bearer":
            return "saved" if str(a.get("token") or "").strip() else "none"
        return "none"

    out: Dict[str, Any] = {
        key: [_entry_state(e) for e in cfg.get(key) or []]
        for key in ("matrix_homeservers", "controller_urls",
                    "gateway_admin_urls")
    }
    sg = cfg.get("sglang")
    out["sglang_urls"] = [
        _entry_state(e) for e in ((sg or {}).get("urls") or [])
    ]
    out["admin_password"] = (
        "saved" if str(cfg.get("admin_password") or "").strip() else "none"
    )
    return out


def redact(config: Dict[str, Any]) -> Dict[str, Any]:
    """Config safe to send back to the frontend (no secrets)."""
    out = json.loads(json.dumps(config))
    if out.get("controller_token"):
        out["controller_token"] = "***"
    # 地址条目内凭据（basic password / bearer token）。
    # gateway 双地址条目同语义（防 GET /config 泄露）。
    for key in ("matrix_homeservers", "controller_urls", "gateway_admin_urls"):
        _redact_entry_list(out.get(key))
    sg = out.get("sglang")
    if isinstance(sg, dict):
        _redact_entry_list(sg.get("urls"))
    # L1 管理员凭据：密码与 Console 会话脱敏；用户名保留（非机密，前端回显）。
    if out.get("admin_password"):
        out["admin_password"] = "***"
    if out.get("console_session"):
        out["console_session"] = "***"
    matrix = out.get("matrix") or {}
    if matrix.get("access_token"):
        matrix["access_token"] = "***"
    return out
