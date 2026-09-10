# -*- coding: utf-8 -*-
"""Layered connectivity self-check (L0-L2 for the skeleton release).

L0 local environment: plugin backend alive + QwenPaw version.
L1 connectivity:     every configured Matrix/Controller address, with error
                     classification (DNS vs refused vs TLS vs timeout) and
                     the effective (working) address highlighted.
L2 auth/API:         Matrix whoami + joined_rooms (and optional Controller
                     project listing when a token is available).

L3 (per-room permission + ping message) and L4 (end-to-end) land after the
skeleton passes real-machine validation.
"""

from __future__ import annotations

import asyncio
import datetime
import logging
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

from . import matrix_client

logger = logging.getLogger("qwenpaw.plugins.agentteams_qwenpaw_workbench")

# Import lazily to avoid a circular import with router.py.
def _working_cache() -> Dict[str, str]:
    from . import router as router_mod

    return router_mod._working_cache


def _mark_working(kind: str, url: str) -> None:
    from . import router as router_mod

    router_mod._mark_working(kind, url)


def _classify_error(exc: Exception) -> str:
    """Map transport errors to a fixable hint (A5 lesson: domain unreachable).

    v0.4.93: 三层语义修正（用户真机 bug）——「TLS 证书错误」只允许用于
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
        # 真正的证书错误：只有校验失败类才算（v0.4.93 修正——此前
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


async def _probe_matrix(
    homeserver: str, timeout: float = 6.0
) -> Dict[str, Any]:
    """GET /_matrix/client/versions — protocol check, not just reachability.

    v0.4.92: 带延迟测量（ms）——外/内网自动识别靠延迟排序。
    v0.4.93: 直连语义（trust_env=False——探测=测「插件直连该地址」，
    不被本机代理环境变量扭曲）+ 连通/HTTP 双层模型：
    ok = 网络层连通（收到 HTTP 响应即连通，401/403 也算），
    http_ok = 状态码 <400（才具备当选生效地址的资格）。
    """
    base = homeserver.rstrip("/")
    url = f"{base}/_matrix/client/versions"

    def _call() -> Dict[str, Any]:
        t0 = time.monotonic()
        with httpx.Client(
            timeout=timeout, verify=False, trust_env=False
        ) as client:
            resp = client.get(url)
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
            return {
                "ok": True,
                "http_ok": False,
                "ms": ms,
                "detail": f"已连通，HTTP {resp.status_code}（需要鉴权）",
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
    controller_url: str, token: str, timeout: float = 6.0
) -> Dict[str, Any]:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        t0 = time.monotonic()
        # v0.4.93: trust_env=False 直连探测；401/403 = 已连通（需鉴权）
        async with httpx.AsyncClient(
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
            return {
                "ok": True,
                "http_ok": False,
                "ms": ms,
                "detail": f"已连通，HTTP {resp.status_code}（需要鉴权——检查 token 或 basic auth）",
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


async def _probe_sglang(url: str, timeout: float = 6.0) -> Dict[str, Any]:
    """GET /v1/loads — 轻量（~3KB JSON），顺带验证路由可用。"""
    if not url:
        return {"ok": False, "http_ok": False, "ms": None, "detail": "未配置 SGLang 地址"}
    try:
        t0 = time.monotonic()
        async with httpx.AsyncClient(
            timeout=timeout, verify=False, trust_env=False
        ) as client:
            resp = await client.get(f"{url.rstrip('/')}/v1/loads")
        ms = int((time.monotonic() - t0) * 1000)
        ok = resp.status_code < 400
        return {
            "ok": True if ok else resp.status_code in (401, 403),
            "http_ok": ok,
            "ms": ms if ok else None,
            "detail": (
                f"HTTP {resp.status_code}"
                if ok
                else f"已连通，HTTP {resp.status_code}"
            ),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "http_ok": False,
            "ms": None,
            "detail": _classify_error(exc),
        }


async def _probe_with_retry(
    probe, url: str, token: str, timeout: float
) -> Dict[str, Any]:
    """v0.4.92（再版）：探测失败重试一次（500ms 后）——切网瞬间的瞬断
    不应被判 ❌ 或触发误切换（用户「连通失败重试」）。两次都败才记失败。
    v0.4.93: 已连通（ok=True，含 401）不重试——只重试网络层失败。"""
    result = await probe(url, token, timeout)
    if result.get("ok"):
        return result
    await asyncio.sleep(0.5)
    return await probe(url, token, timeout)


# v0.4.93: fake-ip / 私有地址段检测——DNS 被代理劫持时解析结果落在这些段，
# 直接点破「不是服务器证书问题，是本机 DNS/代理问题」。
_FAKE_IP_HINTS = (
    (lambda ip: ip.startswith("198.18.") or ip.startswith("198.19."), "fake-ip 段（代理/Clash 常用，非公网）"),
    (lambda ip: ip.startswith("fdfe:") or ip.startswith("fc") or ip.startswith("fd"), "IPv6 ULA 私有段（非公网）"),
    (lambda ip: ip.startswith("10.") or ip.startswith("192.168.") or ip.startswith("172.16.") or ip.startswith("172.17.") or ip.startswith("172.18.") or ip.startswith("172.19.") or ip.startswith("172.2") or ip.startswith("172.30.") or ip.startswith("172.31.") or ip.startswith("127.") or ip.startswith("169.254."), "内网/保留段（非公网）"),
    (lambda ip: ip.startswith("::ffff:198.18.") or ip.startswith("::ffff:198.19."), "fake-ip 段（v4-mapped，代理 DNS 劫持典型）"),
)


def _resolve_ip_hint(url: str) -> str:
    """v0.4.93: 解析 URL 主机名 → IP 列表（最多 3 个）+ 非公网地址提示。

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
# v0.4.95: 连通性测试结构化诊断（点击展开详情）
#
# 背景：8/24 外网连通问题定性=运营商 DPI 按「SNI 域族+旧 TLS 栈指纹」拦截。
# 一句话结果定位全靠手动补命令——本段把测试过程本身变成可见的结构化数据：
# DNS→TCP→TLS→HTTP→响应 分步计时 + 全栈 traceback + 客户端环境（TLS 指纹锚点）。
#
# 边界：**不碰现有判定路径**——httpx 探测的 ok/http_ok/ms/detail 与超时阈值
# 原样不动；诊断走独立连接，仅丰富结果结构与呈现。
# ---------------------------------------------------------------------------

def _client_env() -> Dict[str, Any]:
    """v0.4.95: 客户端环境（TLS 指纹定位锚点）——代理密码打码。

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
    """v0.4.96: 失败进程身份块（issue #7298 维护者要求，Check 2）。

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
    """v0.4.95: 单地址分步诊断（独立连接，失败即停）。

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
            # v0.4.96: 失败步骤 detail 前缀身份块（仅 _tls 之后已捕获时）
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
        # v0.4.96: 握手前先捕获执行身份（issue #7298 维护者 Check 2）
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


async def test_addresses(
    matrix_urls: List[str],
    controller_urls: List[str],
    sglang_urls: List[str],
    token: str = "",
    timeout: float = 6.0,
    with_diag: bool = False,
) -> Dict[str, Any]:
    """v0.4.92: 连通性测试——全部地址并行探测（失败重试一次），
    返回每地址 {url, ok, ms, detail}。手动测试与后台自动重排共用。

    v0.4.95: with_diag=True（仅手动测试路径）时每地址附加 diag 结构化
    诊断（分步+全栈 traceback+客户端环境）——后台自动重排不传，零成本。
    """

    async def _probe_m(url: str, _token: str, t: float) -> Dict[str, Any]:
        return await _probe_matrix(url, t)

    async def _probe_c(url: str, _token: str, t: float) -> Dict[str, Any]:
        return await _probe_controller(url, token, t)

    matrix_rows = await asyncio.gather(
        *[_probe_with_retry(_probe_m, u, "", timeout) for u in matrix_urls]
    )
    controller_rows = await asyncio.gather(
        *[
            _probe_with_retry(_probe_c, u, token, timeout)
            for u in controller_urls
        ]
    )
    # v0.4.97: SGLang 双地址（内网/外网）逐地址探测（失败重试一次，与其他类型同构）。
    # wrapper 对齐 _probe_with_retry 的 (url, token, timeout) 签名（SGLang 无鉴权）。
    async def _probe_s(url: str, _token: str, t: float) -> Dict[str, Any]:
        return await _probe_sglang(url, t)

    sglang_rows = await asyncio.gather(
        *[_probe_with_retry(_probe_s, u, "", timeout) for u in sglang_urls]
    )

    def _attach(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # v0.4.93: 网络层失败时附加解析诊断（fake-ip/私有段提示）
        # v0.4.95: with_diag 时附结构化诊断（分步+traceback+环境）
        out = []
        for r in rows:
            if not r.get("ok"):
                hint = _resolve_ip_hint(r["url"])
                if hint:
                    r = {**r, "detail": f"{r['detail']}｜{hint}"}
            if with_diag:
                try:
                    r = {**r, "diag": diagnose_target(r["url"], timeout)}
                except Exception:  # noqa: BLE001 - 诊断坏了不拖垮测试
                    pass
            out.append(r)
        return out

    # v0.4.97: 列表形态（0 地址 → None，1/2 地址 → 逐地址行），_attach 统一挂诊断。
    sglang_out = (
        _attach([{"url": u, **r} for u, r in zip(sglang_urls, sglang_rows)])
        if sglang_urls
        else None
    )

    return {
        "matrix": _attach(
            [{"url": u, **r} for u, r in zip(matrix_urls, matrix_rows)]
        ),
        "controller": _attach(
            [
                {"url": u, **r}
                for u, r in zip(controller_urls, controller_rows)
            ]
        ),
        "sglang": sglang_out,
    }


# 防抖滞回：当前生效地址可达时，挑战者必须「明显更快」才切换——
# 差值 > max(100ms, 当前 30%)，防内/外网延迟抖动时来回翻。
_HYSTERESIS_MIN_MS = 100.0
_HYSTERESIS_RATIO = 0.3


def _select_and_mark(kind: str, rows: List[Dict[str, Any]]) -> str:
    """v0.4.92: 延迟排序选最优并写 working cache。返回选中的 url（无则 ""）。

    v0.4.93: 排序资格 = http_ok（状态码 <400）——401/403 是「已连通但
    未鉴权」，当选生效地址会让真实请求吃 401，不能入选。
    """
    ok_rows = [
        r
        for r in rows
        if r.get("ok") and r.get("http_ok") and r.get("ms") is not None
    ]
    if not ok_rows:
        return ""
    best = min(ok_rows, key=lambda r: r["ms"])
    cache = _working_cache()
    current = cache.get(kind, "")
    if current:
        cur_row = next((r for r in ok_rows if r["url"] == current), None)
        if cur_row is None:
            # 当前生效地址本轮不可达 → 切最快
            _mark_working(kind, best["url"])
            return best["url"]
        if best["url"] != current:
            gap = cur_row["ms"] - best["ms"]
            threshold = max(
                _HYSTERESIS_MIN_MS, _HYSTERESIS_RATIO * cur_row["ms"]
            )
            if gap <= threshold:
                return current  # 差异不显著，保持（防抖）
    _mark_working(kind, best["url"])
    return best["url"]


async def refresh_effective(
    cfg: Dict[str, Any], kinds: tuple = ("matrix", "controller")
) -> Dict[str, str]:
    """v0.4.92: 并行探测地址（测延迟），按「最快可达」更新 working cache。

    旧逻辑=按配置顺序取第一个可达（顺序即优先级，不测延迟、不重排）——
    切网后旧地址仍可达时会一直用慢路径。现在：后台自适应周期自动重排，
    外网/内网切换自动识别（延迟差异远超防抖阈值）。
    kinds: 只重排指定类型（后台循环省资源用——单地址类型跳过）。
    """
    token = (cfg.get("controller_token") or "").strip()
    matrix_urls = (
        [u for u in (cfg.get("matrix_homeservers") or []) if u]
        if "matrix" in kinds
        else []
    )
    controller_urls = (
        [u for u in (cfg.get("controller_urls") or []) if u]
        if "controller" in kinds
        else []
    )
    # v0.4.97: SGLang 双地址纳入自动重排（外/内网切换自动识别，与 matrix/controller 同机制）。
    sglang_urls = (
        [u for u in ((cfg.get("sglang") or {}).get("urls") or []) if u]
        if "sglang" in kinds
        else []
    )
    if not matrix_urls and not controller_urls and not sglang_urls:
        return {}
    results = await test_addresses(
        matrix_urls, controller_urls, sglang_urls, token, 4.0
    )
    effective: Dict[str, str] = {}
    if "matrix" in kinds:
        picked = _select_and_mark("matrix", results["matrix"])
        if picked:
            effective["matrix"] = picked
    if "controller" in kinds:
        picked = _select_and_mark("controller", results["controller"])
        if picked:
            effective["controller"] = picked
    if "sglang" in kinds and results.get("sglang"):
        picked = _select_and_mark("sglang", results["sglang"])
        if picked:
            effective["sglang"] = picked
    return effective


def run_l0() -> Dict[str, Any]:
    """Local environment: backend alive + QwenPaw version."""
    try:
        from importlib.metadata import version as _dist_version

        qwenpaw_version = _dist_version("qwenpaw")
    except Exception as exc:  # noqa: BLE001
        qwenpaw_version = f"unknown ({exc!r})"
    # v0.4.97: 版本门禁放宽到 2.1/2.2（plugin.json min 2.1.0 max 2.2.0）——
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

    homeservers = cfg.get("matrix_homeservers") or []
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
            result = await _probe_matrix(hs)
            if result["ok"] and effective is None:
                effective = hs
                _mark_working("matrix", hs)
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

    controller_urls = cfg.get("controller_urls") or []
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
            result = await _probe_controller(cu, token)
            if result["ok"] and effective is None:
                effective = cu
                _mark_working("controller", cu)
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
    homeservers = (cfg.get("matrix_homeservers") or [])
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

    controller_urls = cfg.get("controller_urls") or []
    if controller_urls:
        with router_mod._cache_lock:
            cached_ctl = router_mod._working_cache.get("controller")
        controller_url = (
            cached_ctl if cached_ctl in controller_urls else controller_urls[0]
        )
        # L2 Controller access: try Matrix-token auth (W-PR-1 composite
        # authenticator). 404 = endpoint/PR not deployed yet (distinguish
        # from 403 = permission denied).
        try:
            headers = {"Authorization": f"Bearer {token}"}
            with httpx.Client(timeout=10.0, verify=False) as client:
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

        # re17: L1 管理员 token 路径——正源数据的真实通道（L2 Matrix token
        # 路径按上游设计只对 level-2 人类开放，level-1 管理员恒 401）。
        # 500 + mc/minio 特征 = Controller 侧 MinIO 客户端故障（mc 别名未
        # 注册），不是权限问题——此前被前端「Controller 不可用」通用横幅
        # 掩盖，用户无从下手（8/30 真机事故根因）。
        ctl_token = (cfg.get("controller_token") or "").strip()
        if ctl_token:
            try:
                with httpx.Client(timeout=15.0, verify=False) as client:
                    resp2 = client.get(
                        f"{controller_url.rstrip('/')}/api/v1/projects",
                        headers={"Authorization": f"Bearer {ctl_token}"},
                    )
                body2 = (resp2.text or "")[:300]
                if resp2.status_code == 200:
                    checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": True,
                            "detail": "admin token 正源可用",
                        }
                    )
                elif resp2.status_code == 500 and (
                    "mc " in body2 or "minio" in body2.lower()
                ):
                    all_ok = False
                    checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": False,
                            "detail": f"HTTP 500: {body2[:200]}",
                            "hint": "Controller 的 MinIO 客户端（mc 别名）异常——在 Controller 宿主机执行: docker exec agentteams-controller sh -c 'mc alias set agentteams $AGENTTEAMS_FS_ENDPOINT $AGENTTEAMS_MINIO_USER $AGENTTEAMS_MINIO_PASSWORD && mc ls agentteams/ | head -5'",
                        }
                    )
                elif resp2.status_code in (401, 403):
                    all_ok = False
                    checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": False,
                            "detail": f"HTTP {resp2.status_code}",
                            "hint": "controller_token 已失效——在 Controller 宿主机重新读取 /var/run/agentteams/cli-token 填入配置页",
                        }
                    )
                else:
                    all_ok = False
                    checks.append(
                        {
                            "name": "Controller projects (L1 正源)",
                            "ok": False,
                            "detail": f"HTTP {resp2.status_code}: {body2[:200]}",
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                all_ok = False
                checks.append(
                    {
                        "name": "Controller projects (L1 正源)",
                        "ok": False,
                        "detail": _classify_error(exc),
                        "hint": "检查 Controller 地址",
                    }
                )

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
    homeservers = cfg.get("matrix_homeservers") or []
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
        rooms = matrix_client.joined_rooms(homeserver, token).get("joined_rooms", [])
        baseline = matrix_client.sync(homeserver, token, timeout_ms=0)
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
            members = matrix_client.joined_members(homeserver, token, room_id)
            entry["members"] = len(members.get("joined", {}))
        except Exception as exc:  # noqa: BLE001
            entry["members_error"] = _classify_error(exc)
        try:
            sent = matrix_client.send_message(
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
        sync_resp = matrix_client.sync(
            homeserver, token, since=since, timeout_ms=wait_ms
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

                async with _httpx.AsyncClient(timeout=15.0, verify=False) as client:
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
    l2 = run_l2(cfg)
    return {
        "ok": bool(l0["ok"] and l1["ok"] and l2["ok"]),
        "levels": [l0, l1, l2],
        "summary": {
            "L0": "✅" if l0["ok"] else "❌",
            "L1": "✅" if l1["ok"] else "❌",
            "L2": "✅" if l2["ok"] else "❌",
        },
    }
