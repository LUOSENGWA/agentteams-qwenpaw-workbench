# -*- coding: utf-8 -*-
"""运行时升级代理路由回归（1.2.5 #1364/#1343 消费端）。

代理 /upgrade/{check,run,status} → 同宿主 QwenPaw 的 agentteams-upgrade
插件（127.0.0.1 回环，QWENPAW_PORT）。护栏（8 例）：

- check 200 透传：body 原样返回；verify=true 客户端超时放宽（300s）。
- check 回环不可达 → 归一 404 "upgrade service unavailable"（前端降级空态）。
- check 上游 500 → 原样 500（不吞错）。
- run 缺 version → 400（不拨上游）。
- run 白名单过滤：白名单外键不透传（调用方不可注入）。
- run 202 透传 job handle。
- run 上游 409（已有 job）→ 409 + detail 保留。
- status 200 透传 / 上游 404 job_not_found → 404。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector.routers import upgrade_api


class _Resp:
    def __init__(self, status_code: int, json_body: object = None):
        self.status_code = status_code
        self._json_body = json_body

    def json(self):
        if self._json_body is None:
            raise ValueError("no json body")
        return self._json_body


class _UpgClient:
    """GatedAsyncClient 替身：spec=[(url 子串, _Resp)]，按插入序首中。

    records=[(method, url, kwargs)] 供断言；timeouts 记录每次构造的
    timeout kwarg。raise_enter=True 时 __aenter__ 抛异常（模拟回环不可达）。
    """

    def __init__(self, spec: list, records: list, raise_enter: bool = False):
        self.spec = spec
        self.records = records
        self.raise_enter = raise_enter

    async def __aenter__(self):
        if self.raise_enter:
            raise ConnectionError("loopback refused")
        return self

    async def __aexit__(self, *a, **k):
        return False

    def _match(self, url: str) -> _Resp:
        for key, resp in self.spec:
            if key in url:
                return resp
        return _Resp(404, {"detail": "not found (fake)"})

    async def get(self, url, **k) -> _Resp:
        self.records.append(("GET", url, k))
        return self._match(url)

    async def post(self, url, **k) -> _Resp:
        self.records.append(("POST", url, k))
        return self._match(url)


@pytest.fixture
def upg(monkeypatch):
    state = {
        "spec": [],
        "records": [],
        "timeouts": [],
        "raise_enter": False,
    }

    def factory(*a, **k):
        state["timeouts"].append(k.get("timeout"))
        return _UpgClient(state["spec"], state["records"], state["raise_enter"])

    monkeypatch.setattr(upgrade_api, "GatedAsyncClient", factory)
    monkeypatch.setenv("QWENPAW_PORT", "8099")
    return state


def _app():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(upgrade_api.build_upgrade_router())
    return TestClient(app)


def test_check_200_passthrough(upg):
    body = {
        "current": "1.2.4",
        "candidates": [],
        "errors": [],
    }
    upg["spec"].append(("/api/upgrade/check", _Resp(200, body)))
    with _app() as tc:
        r = tc.get("/upgrade/check")
    assert r.status_code == 200
    assert r.json() == body
    # 回环地址 = 127.0.0.1:8099（QWENPAW_PORT 生效）
    assert "127.0.0.1:8099" in upg["records"][0][1]
    # verify 未开 → 基础超时
    assert upg["timeouts"][0] == 30.0


def test_check_verify_true_widens_timeout(upg):
    upg["spec"].append(("/api/upgrade/check", _Resp(200, {"current": "1.2.4"})))
    with _app() as tc:
        r = tc.get("/upgrade/check?verify=true")
    assert r.status_code == 200
    assert upg["timeouts"][0] == 300.0
    # query 原样透传
    assert upg["records"][0][2].get("params") == {"verify": "true"}


def test_check_loopback_unavailable(upg):
    upg["raise_enter"] = True
    with _app() as tc:
        r = tc.get("/upgrade/check")
    assert r.status_code == 404
    assert r.json()["detail"] == "upgrade service unavailable"


def test_check_upstream_500_preserved(upg):
    upg["spec"].append(("/api/upgrade/check", _Resp(500, {"detail": "boom"})))
    with _app() as tc:
        r = tc.get("/upgrade/check")
    assert r.status_code == 500
    assert r.json()["detail"] == "boom"


def test_run_missing_version_400(upg):
    with _app() as tc:
        r = tc.post("/upgrade/run", json={"mode": "in-container"})
    assert r.status_code == 400
    assert "version" in r.json()["detail"]
    assert upg["records"] == []  # 不拨上游


def test_run_whitelist_strips_foreign_keys(upg):
    upg["spec"].append(
        ("/api/upgrade/run", _Resp(202, {"job_id": "job-1", "state": "running"}))
    )
    with _app() as tc:
        r = tc.post(
            "/upgrade/run",
            json={"version": "1.2.5", "evil": "injected", "mode": "in-container"},
        )
    assert r.status_code == 202
    assert r.json() == {"job_id": "job-1", "state": "running"}
    sent = upg["records"][0][2]["json"]
    assert "evil" not in sent
    assert sent["version"] == "1.2.5"
    assert sent["mode"] == "in-container"


def test_run_upstream_409_job_exists(upg):
    upg["spec"].append(
        (
            "/api/upgrade/run",
            _Resp(409, {"error": "upgrade job already running: job-9"}),
        )
    )
    with _app() as tc:
        r = tc.post("/upgrade/run", json={"version": "1.2.5"})
    assert r.status_code == 409
    assert r.json()["detail"] == "upgrade job already running: job-9"


def test_status_200_and_404_job_not_found(upg):
    upg["spec"].append(
        ("/api/upgrade/status", _Resp(200, {"job_id": "job-1", "state": "success"}))
    )
    with _app() as tc:
        r = tc.get("/upgrade/status")
    assert r.status_code == 200
    assert r.json()["state"] == "success"

    upg["spec"].clear()
    upg["spec"].append(
        (
            "/api/upgrade/status",
            _Resp(404, {"error": "job_not_found", "detail": "no upgrade job"}),
        )
    )
    upg["records"].clear()
    with _app() as tc:
        r = tc.get("/upgrade/status?job_id=job-x")
    assert r.status_code == 404
    # 扁平错误体 error 字段优先透传
    assert r.json()["detail"] == "job_not_found"
