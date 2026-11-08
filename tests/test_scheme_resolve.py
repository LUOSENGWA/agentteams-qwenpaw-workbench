# -*- coding: utf-8 -*-
"""N：无协议地址（host:port）的 https/http 识别。

背景（用户实测）：设置页填 `host:port`（省略 `https://`）被强制补
`http://`；服务端是 TLS 端口，明文请求被拒 400 "plain HTTP request was
sent to HTTPS port"。业界口径（浏览器 HTTPS-first、curl --proto-default、
nginx 400）——无协议时 https 优先，失败回退 http；都探测不通按 https
保存并回 warning（安全默认，绝不静默降级）；显式 http/https 不覆盖。

覆盖：
1. 显式 scheme 原样返回、不探测；
2. 无协议 → https 命中；
3. 无协议 → https 失败回退 http；
4. 两者都不通 → 按 https + warning=scheme_unresolved；
5. host:port 结果缓存 10 分钟（第二次不再探测）；
6. path / 尾斜杠处理；
7. PUT /config：保存前解析，落盘为解析后的 URL；
8. PUT /config：都探测不通 → 按 https 落盘 + 响应 warnings；
9. /config/test：行 url=解析后，resolved_from=原输入（仅当不同）。
"""
from __future__ import annotations

import asyncio

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector import selfcheck_probes as probes_mod
from agentteams_connector.router import build_router


@pytest.fixture(autouse=True)
def _clear_scheme_cache():
    """协议缓存逐测清空——相邻用例不得拿上一测的 host:port 结果。"""
    probes_mod._SCHEME_CACHE.clear()
    yield
    probes_mod._SCHEME_CACHE.clear()


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """TestClient + 配置隔离 tmp + 后台探测假 no-op（不碰真实网络）。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")

    async def noop_probe(cfg, kinds=("matrix", "controller")):
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", noop_probe)
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def _fake_probe(ok_schemes):
    """协议探测桩：只有 ok_schemes 里的 scheme 视为可通。"""
    calls = []

    def _probe(url: str, timeout: float) -> bool:
        calls.append(url)
        return any(url.startswith(f"{s}://") for s in ok_schemes)

    return _probe, calls


# ── 1) resolve_scheme 单元面 ─────────────────────────────────────────


def test_explicit_scheme_is_never_overridden(monkeypatch):
    """显式 http:// 不升级、显式 https:// 不降级，且不发起探测。"""
    probe, calls = _fake_probe(("https",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    http_res = asyncio.run(selfcheck_mod.resolve_scheme("http://10.0.0.5:6866"))
    https_res = asyncio.run(selfcheck_mod.resolve_scheme("https://ctl.example.com:7113/"))

    assert http_res["url"] == "http://10.0.0.5:6866"
    assert http_res["auto"] is False and http_res["warning"] is None
    assert https_res["url"] == "https://ctl.example.com:7113"
    assert https_res["auto"] is False
    assert calls == [], "显式协议不得触发探测（也绝不覆盖用户选择）"


def test_schemeless_prefers_https(monkeypatch):
    """无协议 → 先探 https，命中即用（TLS 端口不再被 http 撞 400）。"""
    probe, calls = _fake_probe(("https",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    res = asyncio.run(selfcheck_mod.resolve_scheme("10.0.0.5:6866"))

    assert res["url"] == "https://10.0.0.5:6866"
    assert res["auto"] is True and res["warning"] is None
    assert res["input"] == "10.0.0.5:6866"
    assert calls == ["https://10.0.0.5:6866"], "https 命中后不得再探 http"


def test_schemeless_falls_back_to_http(monkeypatch):
    """https 探测失败 → 回退 http（失败才降级，非默认 http）。"""
    probe, calls = _fake_probe(("http",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    res = asyncio.run(selfcheck_mod.resolve_scheme("192.168.1.10:8090"))

    assert res["url"] == "http://192.168.1.10:8090"
    assert res["warning"] is None
    assert calls == [
        "https://192.168.1.10:8090",
        "http://192.168.1.10:8090",
    ]


def test_unresolved_defaults_to_https_with_warning(monkeypatch):
    """两者都不通 → 按 https 保存并带 warning（绝不静默按 http）。"""
    probe, _ = _fake_probe(())
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    res = asyncio.run(selfcheck_mod.resolve_scheme("dead.example.com:8443"))

    assert res["url"] == "https://dead.example.com:8443"
    assert res["auto"] is True
    assert res["warning"] == "scheme_unresolved"


def test_scheme_result_is_cached_per_host_port(monkeypatch):
    """同一 host:port 10 分钟内只探测一次（保存+测试连续调用不重复拨号）。"""
    probe, calls = _fake_probe(("https",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    first = asyncio.run(selfcheck_mod.resolve_scheme("cache.example.com:9443"))
    second = asyncio.run(selfcheck_mod.resolve_scheme("cache.example.com:9443/api"))

    assert first["url"] == "https://cache.example.com:9443"
    assert second["url"] == "https://cache.example.com:9443/api"
    assert len(calls) == 1, "缓存命中不得再次探测"


def test_schemeless_keeps_path_and_trims_slash(monkeypatch):
    """path/query 原样保留，尾斜杠去掉（避免 /api 拼成 //api）。"""
    probe, _ = _fake_probe(("https",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    res = asyncio.run(selfcheck_mod.resolve_scheme("node1:8090/api/"))

    assert res["url"] == "https://node1:8090/api"


# ── 2) PUT /config：保存前解析协议 ──────────────────────────────────


def test_put_config_saves_resolved_url(client, monkeypatch):
    """无协议条目 → 落盘为解析后的 URL（显式协议条目不变）。"""
    probe, _ = _fake_probe(("https",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    r = client.put(
        "/config",
        json={
            "config": {
                "matrix_homeservers": ["10.0.0.5:6866"],
                "controller_urls": ["http://10.0.0.6:8090"],
            }
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "warnings" not in body
    saved = config_mod.load_config()
    assert saved["matrix_homeservers"] == ["https://10.0.0.5:6866"]
    assert saved["controller_urls"] == ["http://10.0.0.6:8090"]


def test_put_config_unresolved_saves_https_and_warns(client, monkeypatch):
    """都探测不通 → 按 https 落盘 + 响应 warnings=["scheme_unresolved"]。"""
    probe, _ = _fake_probe(())
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    r = client.put(
        "/config",
        json={"config": {"controller_urls": ["10.0.0.7:8090"]}},
    )
    assert r.status_code == 200, r.text
    assert r.json().get("warnings") == ["scheme_unresolved"]
    assert config_mod.load_config()["controller_urls"] == [
        "https://10.0.0.7:8090"
    ]


# ── 3) /config/test：解析后探测 + resolved_from ─────────────────────


def test_config_test_reports_resolved_from(client, monkeypatch):
    """草稿 host:port → 按解析后的 URL 探测，行带 resolved_from=原输入。"""
    probe, _ = _fake_probe(("https",))
    monkeypatch.setattr(probes_mod, "_scheme_probe_url", probe)

    async def _fake_test_addresses(
        matrix_urls, controller_urls, sglang_urls, token="", **kwargs
    ):
        def _rows(urls):
            return [
                {"url": u, "ok": True, "http_ok": True, "ms": 1, "detail": "HTTP 200"}
                for u in urls
            ]

        return {
            "matrix": _rows(matrix_urls),
            "controller": _rows(controller_urls),
            "sglang": _rows(sglang_urls),
            "gateway": _rows(kwargs.get("gateway_urls") or []),
        }

    monkeypatch.setattr(selfcheck_mod, "test_addresses", _fake_test_addresses)

    r = client.post(
        "/config/test",
        json={
            "matrix": ["10.0.0.5:6866"],
            "controller": ["https://ctl.example.com:7113"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    matrix_row = body["matrix"][0]
    assert matrix_row["url"] == "https://10.0.0.5:6866"
    assert matrix_row["resolved_from"] == "10.0.0.5:6866"
    # 显式协议行不被改写，也不带 resolved_from。
    controller_row = body["controller"][0]
    assert controller_row["url"] == "https://ctl.example.com:7113"
    assert "resolved_from" not in controller_row
