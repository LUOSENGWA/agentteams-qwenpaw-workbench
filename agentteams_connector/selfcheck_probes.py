# -*- coding: utf-8 -*-
"""自检域探针层：错误分类 + 四大探针 + 重试 + IP 提示 + 目标诊断。

自 selfcheck.py 逐字搬移（模块级函数，无缩进变化）。GatedAsyncClient
拨号点经 selfcheck 模块对象调用时属性读（单测 monkeypatch 目标是
selfcheck 模块属性）；_ip_hint_cache 为模块级状态 dict（无测试 patch，
搬移后行为不变）。
"""
from __future__ import annotations

import asyncio
import datetime
import json
import os
import platform
import re
import socket
import ssl
import time
import traceback
import urllib.parse
from typing import Any, Dict, List, Optional

import httpx

from . import config as config_mod
from . import selfcheck as selfcheck_mod
from .dial_gate import sync_dial_slot


def _classify_error(exc: Exception) -> str:
    """Map transport errors to a fixable hint (e.g., domain unreachable).

 三层语义修正（用户真机 bug）——「TLS 证书错误」只允许用于
 证书**校验**失败；握手被中断（EOF/alert）≠ 证书错误，是另一类问题。
 """
    if isinstance(exc, httpx.ConnectTimeout):
        return "连接超时（网络慢或地址不可达）"
    if isinstance(exc, httpx.ReadTimeout):
        return "响应超时（服务慢或无响应）"
    if isinstance(exc, httpx.ConnectError):
        cause = str(exc)
        if "Name or service not known" in cause or "getaddrinfo" in cause:
            return "DNS 解析失败——检查域名拼写或内网 IP"
        if "Connection refused" in cause or "errno 111" in cause:
            return "连接被拒——端口未开放或服务未启动"
        # 真正的证书错误：只有校验失败类才算（修正——此前
        # "TLS" in cause 子串匹配把一切 TLS 层错误都误报成证书错误）
        if (
            "CERTIFICATE_VERIFY_FAILED" in cause
            or "certificate verify failed" in cause.lower()
            or "certificate has expired" in cause.lower()
            or "self-signed" in cause.lower()
            or "unable to get local issuer" in cause.lower()
        ):
            return "TLS 证书校验失败——证书不被信任（自签/过期/链不完整）"
        # 其他 TLS 层错误（握手被中断等）：单独一类，不甩锅给证书
        if "TLS" in cause or "ssl" in cause.lower() or "EOF" in cause:
            return (
                "TLS 握手失败（加密协商阶段被中断）——可能：本机代理/中间设备"
                "拦截、DNS 解析到非公网地址（fake-ip）、服务器协议不匹配"
                f"｜详情：{type(exc).__name__}: {cause[:220]}"
            )
        return f"连接失败：{cause[:120]}"
    return f"未知错误：{exc!r}"[:160]


def _classify_challenge(resp: "httpx.Response") -> str:
    """401/403 质询三看分诊（教训 #728）——
 WWW-Authenticate 头 / 空 body vs JSON body / Server 头链。

 返回:
 "basic" —— WWW-Authenticate: Basic（网关层 Basic 门，Caddy 等）
 "key" —— 无质询头 + 空 body（网关层 API key 门，higress 等）
 "token" —— 无质询头 + JSON body（服务层 token 被拒，M_ 错误等）
 "forbidden" —— 403
 "" —— 其他
 """
    if resp.status_code == 403:
        return "forbidden"
    if resp.status_code != 401:
        return ""
    wa = str(resp.headers.get("www-authenticate") or "").strip()
    if wa.lower().startswith("basic"):
        return "basic"
    body = (resp.text or "").strip()
    if not body:
        return "key"
    try:
        json.loads(body)
        return "token"
    except Exception:  # noqa: BLE001 - 非 JSON 的 401 正文按 key 门口径
        return "key"


def _challenge_hint(challenge: str, has_auth: bool) -> str:
    """质询 → 用户可操作的提示后缀（已配对应凭据仍被拒 → 指向凭据本身）。"""
    if challenge == "basic" and not has_auth:
        return "｜公网入口需 Basic 认证——设置页该地址填「公网凭据」"
    if challenge == "basic" and has_auth:
        return "｜Basic 凭据被网关拒绝（用户名/密码不符）"
    if challenge == "key" and not has_auth:
        return "｜入口要求 API key——设置页该地址填「公网凭据」（API Key）"
    if challenge == "key" and has_auth:
        return "｜API key 被网关拒绝（key 不符）"
    if challenge == "token":
        return "｜token 被服务拒绝（检查该地址对应 token）"
    if challenge == "forbidden":
        return "｜HTTP 403 禁止（权限不足）"
    return ""


async def _probe_matrix(
    homeserver: str, timeout: float = 6.0, auth: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """GET /_matrix/client/versions — protocol check, not just reachability.

 带延迟测量（ms）——外/内网自动识别靠延迟排序。
 直连语义（trust_env=False——探测=测「插件直连该地址」，
 不被本机代理环境变量扭曲）+ 连通/HTTP 双层模型：
 ok = 网络层连通（收到 HTTP 响应即连通，401/403 也算），
 http_ok = 状态码 <400（才具备当选生效地址的资格）。
 auth=该地址覆盖凭据（bearer 门时探测也带，否则该
 地址永远 401 当不上生效地址）+ 401/403 质询三看分类（challenge）。
 """
    base = homeserver.rstrip("/")
    url = f"{base}/_matrix/client/versions"
    from . import config as config_mod  # noqa: PLC0415 - 延迟防循环

    headers = config_mod.headers_with_auth(auth, {})

    def _call() -> Dict[str, Any]:
        t0 = time.monotonic()
        with sync_dial_slot(), httpx.Client(
            timeout=timeout, verify=False, trust_env=False
        ) as client:
            resp = client.get(url, headers=headers)
        ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code < 400:
            return {
                "ok": True,
                "http_ok": True,
                "ms": ms,
                "detail": f"HTTP {resp.status_code}，协议正常",
            }
        if resp.status_code in (401, 403):
            # 401/403 = TLS 已通、服务在响应——连通（需要鉴权），不是失败
            challenge = _classify_challenge(resp)
            return {
                "ok": True,
                "http_ok": False,
                "ms": ms,
                "challenge": challenge,
                "detail": f"已连通，HTTP {resp.status_code}（需要鉴权）{_challenge_hint(challenge, bool(auth))}",
            }
        return {
            "ok": True,
            "http_ok": False,
            "ms": ms,
            "detail": f"已连通，HTTP {resp.status_code}（异常状态）",
        }

    try:
        return await asyncio.wait_for(asyncio.to_thread(_call), timeout)
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "http_ok": False,
            "ms": None,
            "detail": "连接超时（网络慢或地址不可达）",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "http_ok": False,
            "ms": None,
            "detail": _classify_error(exc),
        }


async def _probe_controller(
    controller_url: str, token: str, timeout: float = 6.0,
    auth: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    # 覆盖凭据优先（basic 门地址不带 Bearer——Caddy 只认
    # Basic，Bearer 首拨必 401）；无覆盖则原生 Bearer。
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers = config_mod.headers_with_auth(auth, headers)
    try:
        t0 = time.monotonic()
        # trust_env=False 直连探测；401/403 = 已连通（需鉴权）
        async with selfcheck_mod.GatedAsyncClient(
            timeout=timeout, verify=False, trust_env=False
        ) as client:
            resp = await client.get(
                f"{controller_url.rstrip('/')}/healthz", headers=headers
            )
        ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code < 400:
            return {
                "ok": True,
                "http_ok": True,
                "ms": ms,
                "detail": f"HTTP {resp.status_code}，JSON 正常",
            }
        if resp.status_code in (401, 403):
            # 质询三看分诊（#728）——detail 附可操作提示。
            challenge = _classify_challenge(resp)
            return {
                "ok": True,
                "http_ok": False,
                "ms": ms,
                "challenge": challenge,
                "detail": f"已连通，HTTP {resp.status_code}（需要鉴权）{_challenge_hint(challenge, bool(auth))}",
            }
        return {
            "ok": True,
            "http_ok": False,
            "ms": ms,
            "detail": f"已连通，HTTP {resp.status_code}，{resp.text[:100]}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "http_ok": False,
            "ms": None,
            "detail": _classify_error(exc),
        }


async def _probe_sglang(
    url: str, timeout: float = 6.0, auth: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """GET /v1/loads — 轻量（~3KB JSON），顺带验证路由可用。

 auth=覆盖凭据（WAN key 门=bearer；无则无头裸拨）。
 """
    if not url:
        return {"ok": False, "http_ok": False, "ms": None, "detail": "未配置 SGLang 地址"}
    headers = config_mod.headers_with_auth(auth, {})
    try:
        t0 = time.monotonic()
        async with selfcheck_mod.GatedAsyncClient(
            timeout=timeout, verify=False, trust_env=False
        ) as client:
            resp = await client.get(f"{url.rstrip('/')}/v1/loads", headers=headers)
        ms = int((time.monotonic() - t0) * 1000)
        ok = resp.status_code < 400
        if not ok:
            challenge = _classify_challenge(resp)
            return {
                "ok": resp.status_code in (401, 403),
                "http_ok": ok,
                "ms": None,
                "challenge": challenge,
                "detail": f"已连通，HTTP {resp.status_code}{_challenge_hint(challenge, bool(auth))}",
            }
        return {
            "ok": True,
            "http_ok": True,
            "ms": ms,
            "detail": f"HTTP {resp.status_code}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "http_ok": False,
            "ms": None,
            "detail": _classify_error(exc),
        }


async def _probe_gateway(
    url: str,
    timeout: float = 6.0,
    auth: Optional[Dict[str, str]] = None,
    session_cookie: str = "",
) -> Dict[str, Any]:
    """Higress Console 探测——可达性 + 会话三态。

 ① GET /（Console 页面入口）——可达性主判据。
 ② 持有 console_session 时 GET /v1/ai/routes（带 Cookie，与 verify-admin
 自检同路径）：200=会话有效 / 401|403=会话已过期 / 404=该版本无此端点
 （只报可达，不臆断会话态）。会话自检失败不拖可达判定（只记 detail）。
 """
    if not url:
        return {"ok": False, "http_ok": False, "ms": None, "detail": "未配置 Higress 地址"}
    headers = config_mod.headers_with_auth(auth, {})
    try:
        t0 = time.monotonic()
        async with selfcheck_mod.GatedAsyncClient(
            timeout=timeout, verify=False, trust_env=False
        ) as client:
            resp = await client.get(f"{url.rstrip('/')}/", headers=headers)
        ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code >= 500:
            # # 外网 console 地址多为隧道（frp/云转发）暴露——503 = 隧道活着但
            # 后端 Console 服务暂不可用（重启/断流）。点破方向，不甩锅插件。
            return {
                "ok": True,
                "http_ok": False,
                "ms": ms,
                "detail": (
                    f"已连通，HTTP {resp.status_code}（Console 服务暂不可用）"
                    "——该外网地址若为隧道/端口转发，隧道或后端可能瞬断；"
                    "内网环境建议地址模式改 auto/内网（内网直连不经隧道）"
                ),
            }
        detail = f"已连通，HTTP {resp.status_code}"
        if session_cookie:
            try:
                async with selfcheck_mod.GatedAsyncClient(
                    timeout=timeout, verify=False, trust_env=False
                ) as client:
                    sr = await client.get(
                        f"{url.rstrip('/')}/v1/ai/routes",
                        headers={"Cookie": session_cookie},
                    )
                if sr.status_code == 200:
                    detail += "｜Higress 会话有效"
                elif sr.status_code in (401, 403):
                    detail += "｜Higress 会话已过期（需重新验证）"
                elif sr.status_code == 404:
                    detail += "｜该版本不支持会话自检"
            except Exception:  # noqa: BLE001 - 会话自检失败不影响可达判定
                pass
        return {"ok": True, "http_ok": True, "ms": ms, "detail": detail}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "http_ok": False, "ms": None, "detail": _classify_error(exc)}


async def _probe_with_retry(
    probe, url: str, token: str, timeout: float
) -> Dict[str, Any]:
    """探测失败重试一次（300ms 后）——
 切网瞬间的瞬断不应被判 ❌ 或触发误切换（用户「连通失败重试」）。
 两次都败才记失败。已连通（ok=True，含 401）不重试——
 只重试网络层失败。"""
    t0 = time.monotonic()
    result = await probe(url, token, timeout)
    if result.get("ok"):
        return result
    # 超时烧满（≥80%
    # 预算）= 确定性死地址（外网线对端不可达），重试只翻倍成本、无恢复概率
    # ——跳过（后台自适应重测负责捡回恢复）；快失败（拒连/DNS）仍重试，
    # 瞬断语义不变。5M 外网线死地址成本 2×timeout → 1×timeout。
    if (time.monotonic() - t0) >= (timeout or 4.0) * 0.8:
        return result
    await asyncio.sleep(0.3)  # 0.5→0.3s（重试间隔收紧）
    return await probe(url, token, timeout)


# fake-ip / 私有地址段检测——DNS 被代理劫持时解析结果落在这些段，
# 直接点破「不是服务器证书问题，是本机 DNS/代理问题」。
_FAKE_IP_HINTS = (
    (lambda ip: ip.startswith("198.18.") or ip.startswith("198.19."), "fake-ip 段（代理/Clash 常用，非公网）"),
    (lambda ip: ip.startswith("fdfe:") or ip.startswith("fc") or ip.startswith("fd"), "IPv6 ULA 私有段（非公网）"),
    (lambda ip: ip.startswith("10.") or ip.startswith("192.168.") or ip.startswith("172.16.") or ip.startswith("172.17.") or ip.startswith("172.18.") or ip.startswith("172.19.") or ip.startswith("172.2") or ip.startswith("172.30.") or ip.startswith("172.31.") or ip.startswith("127.") or ip.startswith("169.254."), "内网/保留段（非公网）"),
    (lambda ip: ip.startswith("::ffff:198.18.") or ip.startswith("::ffff:198.19."), "fake-ip 段（v4-mapped，代理 DNS 劫持典型）"),
)


# 60s TTL 缓存——探测失败风暴时避免重复 getaddrinfo（阻塞）。
_ip_hint_cache: Dict[str, Any] = {}  # url -> (expiry_monotonic, hint)


def _resolve_ip_hint(url: str) -> str:
    """60s TTL 缓存包装（原实现 = `_resolve_ip_hint_uncached`）。"""
    _now = time.monotonic()
    _c = _ip_hint_cache.get(url)
    if _c and _c[0] > _now:
        return _c[1]
    _hint = _resolve_ip_hint_uncached(url)
    _ip_hint_cache[url] = (_now + 60.0, _hint)
    return _hint


def _resolve_ip_hint_uncached(url: str) -> str:
    """解析 URL 主机名 → IP 列表（最多 3 个）+ 非公网地址提示。

 用户真机 bug 的关键诊断数据：域名解析到 fake-ip/私有段时，
 错误表面是 TLS 失败，根因在本机 DNS/代理——把解析结果摆出来，
 一眼定位。返回 "" 表示无异常（纯公网）。
 """
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
        if not host:
            return ""
        port = urllib.parse.urlsplit(url).port or (443 if url.startswith("https") else 80)
        infos = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        ips = []
        for _fam, _t, _p, _cn, sockaddr in infos:
            ip = sockaddr[0]
            if ip not in ips:
                ips.append(ip)
        if not ips:
            return ""
        bad = [ip for ip in ips if any(fn(ip) for fn, _ in _FAKE_IP_HINTS)]
        if bad:
            hints = []
            for fn, label in _FAKE_IP_HINTS:
                if any(fn(ip) for ip in bad):
                    if label not in hints:
                        hints.append(label)
            return (
                f"解析到 {', '.join(ips[:3])}——含{'/'.join(hints)}："
                "本机 DNS 可能被代理劫持，检查系统代理/DNS 配置（服务器证书本身未必有问题）"
            )
        return ""
    except Exception:  # noqa: BLE001 - 解析失败不影响探测主流程
        return ""


# ---------------------------------------------------------------------------
# 连通性测试结构化诊断（点击展开详情）
# 背景：外网连通问题定性=运营商 DPI 按「SNI 域族+旧 TLS 栈指纹」拦截。
# 一句话结果定位全靠手动补命令——本段把测试过程本身变成可见的结构化数据：
# DNS→TCP→TLS→HTTP→响应 分步计时 + 全栈 traceback + 客户端环境（TLS 指纹锚点）。
# 边界：**不碰现有判定路径**——httpx 探测的 ok/http_ok/ms/detail 与超时阈值
# 原样不动；诊断走独立连接，仅丰富结果结构与呈现。
# ---------------------------------------------------------------------------

def _client_env() -> Dict[str, Any]:
    """客户端环境（TLS 指纹定位锚点）——代理密码打码。

 DPI 按 SNI+TLS 栈指纹拦截时，Python/OpenSSL 版本就是定位锚点：
 新栈客户端同地址全绿 + 旧栈红 = 秒级定性。
 """
    proxies: Dict[str, str] = {}
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
              "no_proxy", "NO_PROXY"):
        v = os.environ.get(k)
        if v:
            # user:pass@host → user:****@host
            proxies[k] = re.sub(r"://([^:/@]+):([^@]+)@", r"://\1:****@", v)
    return {
        "python": platform.python_version(),
        "openssl": ssl.OPENSSL_VERSION,
        "httpx": httpx.__version__,
        "platform": platform.platform(),
        "proxies": proxies,
    }


def _failing_process_identity() -> str:
    """失败进程身份块（issue #7298 维护者要求，Check 2）。

 在失败 TLS 握手**之前**捕获执行身份（哪个解释器/哪个进程在跑
 selfcheck），附加到失败步骤的 detail 里——与 WinError 10054 在
 同一次运行、同一份输出中出现。每个字段单独守卫：身份捕获本身
 绝不能弄坏探测（Win 上 os.getppid 在 3.13 前不可用等）。
 """
    import shutil
    import sys

    def _f(label: str, fn) -> str:
        try:
            return f"{label}: {fn()}"
        except Exception:  # noqa: BLE001
            return f"{label}: n/a"

    try:
        import _ssl

        ssl_file = getattr(_ssl, "__file__", "n/a (frozen)")
    except Exception:  # noqa: BLE001
        ssl_file = "n/a"
    return "\n".join(
        [
            "=== FAILING PROCESS IDENTITY ===",
            _f("executable", lambda: sys.executable),
            _f("frozen", lambda: getattr(sys, "frozen", False)),
            _f("pid", lambda: os.getpid()),
            _f("parent_pid", lambda: os.getppid()),
            _f("python", lambda: sys.version.splitlines()[0]),
            _f("openssl", lambda: ssl.OPENSSL_VERSION),
            f"_ssl: {ssl_file}",
            _f("sys_prefix", lambda: sys.prefix),
            _f("PATH_python", lambda: shutil.which("python")),
            _f(
                "bundled_helper_env",
                lambda: os.environ.get("QWENPAW_DESKTOP_PY_RUNTIME"),
            ),
        ]
    )


def diagnose_target(url: str, timeout: float = 6.0) -> Dict[str, Any]:
    """单地址分步诊断（独立连接，失败即停）。

 步骤：DNS 解析（含 IP）→ TCP 连接 → TLS 握手（协议版本+密码套件）
 → HTTP 请求（method+URL）→ 响应（状态码行）。
 返回 {target, steps:[{name,ok,ms,detail}], error:{message,traceback}|null,
 env, ts}。任何异常都不外抛——诊断本身坏了只降级（diag 缺省）。
 """
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme or "http"
    host = parsed.hostname or ""
    port = parsed.port or (443 if scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    is_https = scheme == "https"

    steps: List[Dict[str, Any]] = []
    error: Optional[Dict[str, Any]] = None
    state: Dict[str, Any] = {}

    def _step(name: str, fn) -> bool:
        nonlocal error
        t0 = time.monotonic()
        try:
            steps.append({
                "name": name,
                "ok": True,
                "ms": int((time.monotonic() - t0) * 1000),
                "detail": fn(),
            })
            return True
        except Exception as exc:  # noqa: BLE001
            detail = f"{type(exc).__name__}: {exc}"
            # 失败步骤 detail 前缀身份块（仅 _tls 之后已捕获时）
            if state.get("identity"):
                detail = state["identity"] + "\n" + detail
            steps.append({
                "name": name,
                "ok": False,
                "ms": int((time.monotonic() - t0) * 1000),
                "detail": detail,
            })
            error = {
                "message": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            }
            return False

    def _dns() -> str:
        infos = socket.getaddrinfo(
            host, port, socket.AF_UNSPEC, socket.SOCK_STREAM
        )
        ips: List[str] = []
        for _f, _t, _p, _c, sa in infos:
            if sa[0] not in ips:
                ips.append(sa[0])
        if not ips:
            raise socket.gaierror("解析结果为空")
        state["ips"] = ips
        return f"→ {', '.join(ips[:3])}（{len(ips)} 条记录）"

    def _tcp() -> str:
        sock = None
        fails: List[str] = []
        for ip in state.get("ips", []):
            try:
                sock = socket.create_connection((ip, port), timeout)
                break
            except Exception as e:  # noqa: BLE001
                fails.append(f"{ip} {type(e).__name__}")
        if sock is None:
            raise ConnectionError(
                "全部地址连接失败：" + "；".join(fails or state.get("ips", [])[:3])
            )
        state["sock"] = sock
        return f"{ip}:{port}"

    def _tls() -> str:
        # 握手前先捕获执行身份（issue #7298 维护者 Check 2）
        state["identity"] = _failing_process_identity()
        # 与探测 verify=False 语义一致：只测握手通不通，不校验证书
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        s = ctx.wrap_socket(state["sock"], server_hostname=host)
        state["sock"] = s
        return f"{s.version()} / {s.cipher()[0]}"

    def _send() -> str:
        s: socket.socket = state["sock"]
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"User-Agent: agentteams-qwenpaw-workbench-probe\r\n"
            f"Accept: */*\r\n"
            f"Connection: close\r\n\r\n"
        ).encode()
        s.sendall(req)
        return f"GET {path} HTTP/1.1"

    def _recv_head() -> str:
        s: socket.socket = state["sock"]
        s.settimeout(timeout)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                raise ConnectionError("对端关闭连接（未返回响应头）")
            buf += chunk
            if len(buf) > 65536:
                break
        return buf.split(b"\r\n", 1)[0].decode("latin-1", "replace")

    try:
        if _step("DNS 解析", _dns) and _step("TCP 连接", _tcp) and (
            not is_https or _step("TLS 握手", _tls)
        ) and _step("HTTP 请求", _send) and _step("响应", _recv_head):
            pass  # 全绿
    finally:
        s = state.get("sock")
        if s is not None:
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass

    return {
        "target": url,
        "steps": steps,
        "error": error,
        "env": _client_env(),
        "ts": datetime.datetime.now().astimezone().strftime(
            "%Y-%m-%d %H:%M:%S %Z"
        ),
    }


