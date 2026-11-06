"""代理重定向/二进制体修复回归（F1 尾斜杠 / F2 Location 改写 / F3 二进制体）。

实测定位的问题（宿主侧 curl 证据）：
1. GET /api/agentteams-proxy/controller/api/v1/humans/luo/files → 301 且无
   Location 头：旧归一化 split 丢空段把尾斜杠吃掉（/files/ → /files），
   上游 301，_passthrough_headers 又不透传 Location → 客户端只能点 body
   里的链接，落进宿主不存在的 /api/v1/... 路径（宿主 404）；
2. PUT octet-stream 上传 → 200 但 {"size":0}：旧版一律 request.json()
   → 二进制解析失败 body=None → 上游收空体，文件被清空。

护栏（8 例）：
- T1  尾斜杠保留：上游收到 /files/（不是 /files）；
- T1b 连续双斜杠仍被压成单个；
- T2  同源绝对 Location → 改写为代理内部路径，status/body 不变；
- T2b Location 已是 /api/agentteams-proxy/ 开头 → 原样，不重复加前缀；
- T3  外部域 Location → 原样透传，不改写；
- T4  二进制体（octet-stream）→ 上游收到原始字节 + 原 Content-Type + Authorization；
- T5  JSON 体（application/json）→ 上游收到 json=（解析后等值，不回归）；
- T6  非法 JSON（CT 是 json 但内容不是）→ 回退原始字节，不是 None。
"""
from __future__ import annotations

import json

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as cfgmod
from agentteams_connector import router as router_mod

LAN = "http://10.0.0.1:8090"
FILES = "/api/v1/humans/luo/files"


class _Resp:
    def __init__(
        self,
        status_code: int,
        content: bytes = b"",
        json_body: object = None,
        headers: dict | None = None,
    ):
        self.status_code = status_code
        self.content = content
        self._json_body = json_body
        self.headers = headers or {"content-type": "application/json"}

    def json(self):
        if self._json_body is None:
            raise ValueError("no json body")
        return self._json_body

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")


class _Client:
    """httpx.AsyncClient 替身：记录每次 (method, url, kwargs)。

    spec = [(url 子串, _Resp)]，按插入序首中。
    """

    def __init__(self, spec: list) -> None:
        self.spec = spec
        self.calls: list[tuple[str, str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def request(self, method: str, url: str, **k) -> _Resp:
        self.calls.append((method, url, k))
        for key, resp in self.spec:
            if key in url:
                return resp
        return _Resp(404)

    async def get(self, url, **k) -> _Resp:
        return await self.request("GET", url, **k)

    async def head(self, url, **k) -> _Resp:
        return await self.request("HEAD", url, **k)


@pytest.fixture
def prb(monkeypatch):
    state = {
        "controller_urls": [LAN],
        "controller_token": "ctok",
        "matrix_homeservers": ["http://matrix.example"],
        "matrix": {"user_id": "@me:matrix.example", "access_token": "mtok"},
    }

    def fake_load():
        return json.loads(json.dumps(state))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    clients: list[_Client] = []
    spec: list = []  # [(url 子串, _Resp)]，测试填充

    def factory(*a, **k):
        c = _Client(spec)
        clients.append(c)
        return c

    patch_shared_name(monkeypatch, "GatedAsyncClient", factory)
    monkeypatch.setattr(router_mod, "_working_cache", {})
    return clients, spec


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(router_mod.build_router())
    # 301 断言必须关掉自动跟随：否则 TestClient 会跟到 /api/v1/...
    # （catch-all 看到 target="api" → 400），测试永远拿不到 302。
    return TestClient(app, follow_redirects=False)


def _last_call(clients: list[_Client]) -> tuple[str, str, dict]:
    for c in reversed(clients):
        if c.calls:
            return c.calls[-1]
    raise AssertionError("未记录到任何上游调用")


# ── F1 尾斜杠 ──────────────────────────────────────────────────────────


def test_trailing_slash_preserved(prb):
    """T1：/controller/api/v1/humans/luo/files/ → 上游 path 保留 /files/ 结尾。"""
    clients, spec = prb
    spec.append((LAN, _Resp(401, b"")))
    with _app() as tc:
        tc.get(f"/controller{FILES}/")
    _m, u, _k = _last_call(clients)
    assert u == f"{LAN}{FILES}/", f"尾斜杠被吃掉: {u}"


def test_consecutive_slashes_still_collapsed(prb):
    """T1b：连续双斜杠仍被压成单个（含 path 自带前导 / 的畸形输入）。"""
    clients, spec = prb
    spec.append((LAN, _Resp(401, b"")))
    with _app() as tc:
        tc.get("/controller//api//v1/humans/luo/files")
    _m, u, _k = _last_call(clients)
    assert u == f"{LAN}{FILES}", f"连续斜杠未压平: {u}"


# ── F2 Location 改写 ───────────────────────────────────────────────────


def test_location_same_origin_absolute_rewritten(prb):
    """T2：上游 301 同源绝对 Location → 代理内部路径，status/body 不变。"""
    clients, spec = prb
    body = b'<a href="/api/v1/humans/luo/files/">Moved Permanently</a>.'
    spec.append(
        (
            LAN,
            _Resp(
                301,
                body,
                headers={
                    "content-type": "text/html; charset=utf-8",
                    "location": f"{LAN}{FILES}/",
                },
            ),
        )
    )
    with _app() as tc:
        r = tc.get(f"/controller{FILES}")
    assert r.status_code == 301
    assert r.content == body
    assert r.headers.get("location") == f"/api/agentteams-proxy/controller{FILES}/"


def test_location_already_proxy_path_untouched(prb):
    """T2b：Location 已是 /api/agentteams-proxy/ 开头 → 原样，不重复加前缀。"""
    clients, spec = prb
    loc = f"/api/agentteams-proxy/controller{FILES}/"
    spec.append(
        (
            LAN,
            _Resp(
                301,
                b"moved",
                headers={"content-type": "text/plain", "location": loc},
            ),
        )
    )
    with _app() as tc:
        r = tc.get(f"/controller{FILES}")
    assert r.status_code == 301
    assert r.headers.get("location") == loc


def test_location_external_untouched(prb):
    """T3：外部域 Location → 原样透传，不改写。"""
    clients, spec = prb
    spec.append(
        (
            LAN,
            _Resp(
                302,
                b"see other",
                headers={"content-type": "text/plain", "location": "https://example.com/x"},
            ),
        )
    )
    with _app() as tc:
        r = tc.get(f"/controller{FILES}")
    assert r.status_code == 302
    assert r.headers.get("location") == "https://example.com/x"


# ── F3 请求体 ──────────────────────────────────────────────────────────


def test_binary_body_forwarded_with_content_type(prb):
    """T4：PUT octet-stream → 上游收到原始字节 + 原 Content-Type + Authorization。"""
    clients, spec = prb
    payload = b"\x00binary\xff"
    spec.append((LAN, _Resp(200, b'{"size":9}', {"size": 9})))
    with _app() as tc:
        r = tc.put(
            f"/controller{FILES}/probe-test.txt",
            content=payload,
            headers={"Content-Type": "application/octet-stream"},
        )
    assert r.status_code == 200
    _m, _u, k = _last_call(clients)
    assert k.get("content") == payload, "二进制体未原样转发"
    assert "json" not in k
    h = k.get("headers") or {}
    assert h.get("Content-Type") == "application/octet-stream"
    assert h.get("Authorization") == "Bearer ctok"


def test_json_body_unchanged(prb):
    """T5：PUT application/json → 上游收到 json=（解析后等值，不回归）。"""
    clients, spec = prb
    spec.append((LAN, _Resp(200, b'{"ok":true}', {"ok": True})))
    with _app() as tc:
        r = tc.put(
            f"/controller{FILES}/probe-test.json",
            json={"a": 1},
        )
    assert r.status_code == 200
    _m, _u, k = _last_call(clients)
    assert k.get("json") == {"a": 1}, "JSON 体语义回归"
    assert "content" not in k


def test_bad_json_falls_back_to_raw_body(prb):
    """T6：CT 是 application/json 但内容不是 JSON → 上游收到原始字节，不是 None。"""
    clients, spec = prb
    spec.append((LAN, _Resp(200, b'{"ok":true}', {"ok": True})))
    with _app() as tc:
        r = tc.put(
            f"/controller{FILES}/probe-test.txt",
            content=b"not-json",
            headers={"Content-Type": "application/json"},
        )
    assert r.status_code == 200
    _m, _u, k = _last_call(clients)
    assert k.get("content") == b"not-json", "非法 JSON 未回退原始体"
    assert "json" not in k
    h = k.get("headers") or {}
    assert h.get("Content-Type") == "application/json"
