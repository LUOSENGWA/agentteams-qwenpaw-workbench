# -*- coding: utf-8 -*-
"""Higress 连通性探测 + 凭据记忆重做回归（v0.5.0-beta.14.17 / C2）。

罗总 10/6 反馈「连通性测试也要测试 Higress」「每个账号密码的认证都要分开」。
C2 修复：``test_addresses`` 增加 ``gateway_urls`` 段（Higress Console 可达性
+ 会话三态：有效/过期/该版本不支持），与 matrix/controller/sglang 同层
全并行（诊断面——不参与自动重排，后台 refresh 不传=零开销）。

护栏：
- 只测探测结构与并行不变式，不碰真实网络（monkeypatch ``_probe_gateway``
  与 ``GatedAsyncClient``）。
- 同步驱动（``asyncio.run``）——与 test_conn_parallel_14_16 同款。
"""
from __future__ import annotations

import asyncio
import time

from agentteams_connector import selfcheck


def test_gateway_rows_returned_in_parallel(monkeypatch) -> None:
    """四类地址各一、每类 T 秒 → 总耗时≈T（并行），gateway 行独立返回。"""
    t = 0.25

    def _slow(delay: float, detail: str):
        async def _probe(*a, **k) -> dict:
            await asyncio.sleep(delay)
            return {"ok": True, "http_ok": True, "ms": int(delay * 1000),
                    "detail": detail}

        return _probe

    monkeypatch.setattr(selfcheck, "_probe_matrix", _slow(t, "m"))
    monkeypatch.setattr(selfcheck, "_probe_controller", _slow(t, "c"))
    monkeypatch.setattr(selfcheck, "_probe_sglang", _slow(t, "s"))
    monkeypatch.setattr(selfcheck, "_probe_gateway", _slow(t, "g"))

    async def main() -> tuple[float, dict]:
        t0 = time.monotonic()
        res = await selfcheck.test_addresses(
            matrix_urls=["http://10.0.0.1:6867"],
            controller_urls=["http://10.0.0.1:8090"],
            sglang_urls=["http://10.0.0.1:30000"],
            gateway_urls=["http://10.0.0.1:18001"],
        )
        return time.monotonic() - t0, res

    elapsed, res = asyncio.run(main())
    assert len(res["gateway"]) == 1
    assert res["gateway"][0]["ok"]
    assert elapsed < t * 2.2, (
        f"四类地址疑似串行：elapsed={elapsed:.3f}s（并行应≈T={t:.3f}s）"
    )


def test_no_gateway_urls_empty_list() -> None:
    """未传 gateway（后台 refresh 路径）→ 返回空列表，不崩、不额外探测。"""
    calls = []

    async def _pg(url: str, *a, **k) -> dict:
        calls.append(url)
        return {"ok": True, "http_ok": True, "ms": 1, "detail": ""}

    orig = selfcheck._probe_gateway
    selfcheck._probe_gateway = _pg
    try:

        async def main() -> dict:
            return await selfcheck.test_addresses(
                matrix_urls=["http://10.0.0.1:6867"],
                controller_urls=[],
                sglang_urls=[],
            )

        res = asyncio.run(main())
    finally:
        selfcheck._probe_gateway = orig
    assert res["gateway"] == []
    assert calls == []


def _fake_client_factory(responses: dict):
    """GatedAsyncClient 替身：responses={url 子串: status_code}。"""

    class _Resp:
        def __init__(self, code: int):
            self.status_code = code
            self.headers = {}
            self.content = b""

        @property
        def text(self) -> str:
            return ""

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a, **k):
            return False

        async def get(self, url: str, **k) -> _Resp:
            for key in sorted(responses, key=len, reverse=True):  # 最长键优先
                if key in url:
                    return _Resp(responses[key])
            return _Resp(404)

    return _Client


def test_probe_gateway_session_tri_state(monkeypatch) -> None:
    """会话三态：200=有效 / 401=过期 / 404=该版本不支持 / 无 cookie 不探会话。"""
    url = "http://gw.example"

    async def _run(session: str, code: int) -> dict:
        monkeypatch.setattr(
            selfcheck, "GatedAsyncClient",
            _fake_client_factory({"/": 200, "/v1/ai/routes": code}),
        )
        return await selfcheck._probe_gateway(url, 4.0, None, session)

    r = asyncio.run(_run("cookie=abc", 200))
    assert r["ok"] and r["http_ok"]
    assert "会话有效" in r["detail"]

    r = asyncio.run(_run("cookie=abc", 401))
    assert r["ok"] and r["http_ok"]  # 可达性不受会话态影响
    assert "会话已过期" in r["detail"]

    r = asyncio.run(_run("cookie=abc", 404))
    assert "不支持会话自检" in r["detail"]

    r = asyncio.run(_run("", 200))  # 无会话 cookie → 不探会话
    assert r["ok"] and "会话" not in r["detail"]


def test_probe_gateway_unreachable(monkeypatch) -> None:
    """网络层失败 → ok=False（可达性主判据）。"""

    class _BoomClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            raise OSError("connection refused")

        async def __aexit__(self, *a, **k):
            return False

    monkeypatch.setattr(selfcheck, "GatedAsyncClient", _BoomClient)

    async def main() -> dict:
        return await selfcheck._probe_gateway("http://gw.dead", 4.0, None, "")

    r = asyncio.run(main())
    assert not r["ok"] and not r["http_ok"]


def test_probe_gateway_auth_override(monkeypatch) -> None:
    """地址覆盖凭据（basic）→ Authorization 头走 Basic（与其余族同口径）。"""
    seen_headers = {}

    class _Resp:
        status_code = 200
        headers = {}
        content = b""

        @property
        def text(self) -> str:
            return ""

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a, **k):
            return False

        async def get(self, url: str, **k) -> _Resp:
            seen_headers.update(k.get("headers") or {})
            return _Resp()

    monkeypatch.setattr(selfcheck, "GatedAsyncClient", _Client)

    async def main() -> dict:
        return await selfcheck._probe_gateway(
            "http://gw.example", 4.0,
            {"type": "basic", "username": "u", "password": "p"}, "",
        )

    r = asyncio.run(main())
    assert r["ok"]
    assert seen_headers.get("Authorization", "").startswith("Basic ")
