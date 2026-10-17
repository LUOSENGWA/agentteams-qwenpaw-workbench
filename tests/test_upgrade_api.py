# -*- coding: utf-8 -*-
"""运行时升级域（/upgrade/{check,run,status}）回归——15.25 docker exec 重接。

10/17 实锤：worker 容器未加载 agentteams-upgrade 插件（v1.2.5 打包缺口，
_prepare_default_plugins 漏接线）→ 旧版 127.0.0.1 回环代理恒 404。
重接=per-worker docker exec 镜像内置 CLI（checker/upgrade 脚本）。

护栏：
- U1 L1 门：无 controller token → 403（docker 代理=ActionGateway）。
- U2 轻探成功：/check?worker=X → {current, checker: HAS, supported}。
- U3 完整检查：/check?worker=X&version=V → checker --json 透传
  （stdout 前导 note 行容忍：取首个 JSON 对象）。
- U4 checker 缺失（<1.2.5 镜像）→ 404 明确文案。
- U5 QwenPaw only：runtime != qwenpaw → 400「仅支持 qwenpaw」。
- U6 非法 worker/version/job_id → 400（不进 shell 串）。
- U7 run 202：detached exec（create Detach:true + nohup 命令含
  --phase pre-restart/--job-id/--restart-mode kill），job_id 回显。
- U8 run 缺 worker/version → 400（零拨号）。
- U9 status：state-file JSON + pending 解析。
- U10 status 无 job → 404 job_not_found。
- U11 版本注入面：version 带 shell 元字符 → 400 且 exec 命令零泄漏。
"""
from __future__ import annotations

import json

import pytest

from conftest import patch_shared_name

from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

WORKER_QP = {"name": "sysdev-lead", "runtime": "qwenpaw"}
WORKER_OC = {"name": "legacy-oc", "runtime": "openclaw"}

CHECKER_JSON = {
    "target": "2.3.0",
    "qwenpaw_dir": "/opt/agentteams",
    "overall": "PASS",
    "exit_code": 0,
    "checks": [{"name": "C1", "ok": True}],
}

STATE_JSON = {
    "job_id": "upg-1786445000-abc123",
    "state": "running",
    "phase": "pre-restart",
    "target": "2.3.0",
}

PENDING_JSON = {"job_id": "upg-1786445000-abc123", "target": "2.3.0"}


def _frame(payload: bytes) -> bytes:
    """docker exec 非 TTY 单帧：8 字节头（首字节=stdout）+ 载荷。"""
    return b"\x01" + b"\x00" * 3 + len(payload).to_bytes(4, "big") + payload


class _FakeResponse:
    def __init__(self, status_code: int, json_body=None,
                 content: bytes = b"", text: str = ""):
        self.status_code = status_code
        self.headers = {}
        self._json_body = json_body
        self.content = content
        self.text = text or (json.dumps(json_body) if json_body is not None else "")

    def json(self):
        if self._json_body is None:
            raise AttributeError("no json body")
        return self._json_body


class _FakeClient:
    instances: list = []
    get_spec: dict = {}
    write_spec: dict = {}

    def __init__(self, *a, **k):
        self.calls: list = []
        _FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    @classmethod
    def _match(cls, url: str, spec: dict):
        for key, val in spec.items():
            if key in url:
                st, body = val[0], val[1]
                content = val[2] if len(val) > 2 and val[2] is not None else b""
                return _FakeResponse(st, body, content=content)
        return None

    async def get(self, url, headers=None, **k):
        self.calls.append(("GET", url))
        r = self._match(url, _FakeClient.get_spec)
        return r if r is not None else _FakeResponse(404)

    async def post(self, url, json=None, headers=None, **k):
        self.calls.append(("POST", url, json))
        r = self._match(url, _FakeClient.write_spec)
        return r if r is not None else _FakeResponse(404)

    @classmethod
    def exec_create_bodies(cls) -> list:
        out = []
        for inst in cls.instances:
            for c in inst.calls:
                m, u = c[0], c[1]
                j = c[2] if len(c) > 2 else None
                if m == "POST" and "/exec" in u and "/start" not in u:
                    out.append(j)
        return out

    @classmethod
    def all_post_urls(cls) -> list:
        return [c[1] for inst in cls.instances for c in inst.calls
                if c[0] == "POST"]


@pytest.fixture
def client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "data": {
            "controller_urls": ["http://10.0.0.1:8090"],
            "controller_token": "ctok123",
            "matrix_homeservers": [],
            "matrix": {"user_id": "", "access_token": ""},
        }
    }

    def fake_load():
        return json.loads(json.dumps(state["data"]))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)
    _FakeClient.instances = []
    _FakeClient.get_spec = {}
    _FakeClient.write_spec = {}
    patch_shared_name(monkeypatch, "GatedAsyncClient",
                      lambda *a, **k: _FakeClient(*a, **k))

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state


def _specs(worker: dict, exec_content: bytes):
    g = {f"/api/v1/workers/{worker['name']}": (200, worker)}
    w = {
        f"/containers/agentteams-worker-{worker['name']}/exec": (
            201, {"Id": "exec1"}),
        "/exec/exec1/start": (200, None, exec_content),
    }
    _FakeClient.get_spec, _FakeClient.write_spec = g, w


# ── U1 L1 门 ─────────────────────────────────────────────────────────
def test_upgrade_no_token_403(client):
    tc, state = client
    state["data"]["controller_token"] = ""
    r = tc.get("/upgrade/check", params={"worker": "sysdev-lead"})
    assert r.status_code == 403, r.text


# ── U2 轻探成功 ───────────────────────────────────────────────────────
def test_check_light(client):
    tc, _ = client
    _specs(WORKER_QP, _frame(b"2.2.1\nHAS\nHAS"))
    r = tc.get("/upgrade/check", params={"worker": "sysdev-lead"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["current"] == "2.2.1"
    assert d["supported"] is True


def test_check_light_unsupported_image(client):
    tc, _ = client
    _specs(WORKER_QP, _frame(b"1.9.0\nNONE\nNONE"))
    r = tc.get("/upgrade/check", params={"worker": "sysdev-lead"})
    assert r.status_code == 200
    assert r.json()["supported"] is False


# ── U3 完整检查（前导 note 行容忍） ───────────────────────────────────
def test_check_full(client):
    tc, _ = client
    body = ("note: --qwenpaw-dir /opt/agentteams is not a QwenPaw repo "
            "checkout; using the installed qwenpaw_worker package "
            "(in-image context)\n"
            + json.dumps(CHECKER_JSON)).encode()
    _specs(WORKER_QP, _frame(body))
    r = tc.get("/upgrade/check",
               params={"worker": "sysdev-lead", "version": "2.3.0"})
    assert r.status_code == 200, r.text
    assert r.json()["check"] == CHECKER_JSON
    # 命令带 --target 与 checker 路径
    bodies = _FakeClient.exec_create_bodies()
    cmd = bodies[0]["Cmd"][2]
    assert "--target 2.3.0 --json" in cmd
    assert "check_qwenpaw_upgrade.py" in cmd


# ── U4 checker 缺失 ──────────────────────────────────────────────────
def test_check_checker_missing_404(client):
    tc, _ = client
    _specs(WORKER_QP, _frame(b"CHECKER_MISSING"))
    r = tc.get("/upgrade/check",
               params={"worker": "sysdev-lead", "version": "2.3.0"})
    assert r.status_code == 404
    assert "1.2.5" in r.json()["detail"]


# ── U5 QwenPaw only 门控 ─────────────────────────────────────────────
def test_run_non_qwenpaw_400(client):
    tc, _ = client
    _specs(WORKER_OC, _frame(b"OK"))
    r = tc.post("/upgrade/run",
                json={"worker": "legacy-oc", "version": "2.3.0"})
    assert r.status_code == 400
    assert "qwenpaw" in r.json()["detail"]


def test_check_non_qwenpaw_400(client):
    tc, _ = client
    _specs(WORKER_OC, _frame(b"1.0\nHAS\nHAS"))
    r = tc.get("/upgrade/check", params={"worker": "legacy-oc"})
    assert r.status_code == 400
    assert "qwenpaw" in r.json()["detail"]


# ── U6/U11 注入面 ────────────────────────────────────────────────────
@pytest.mark.parametrize("bad", ["1.2.5; rm -rf /", "1.2.5 && x",
                                 "$(reboot)", "a b", ""])
def test_bad_version_400_no_dial(client, bad):
    tc, _ = client
    _specs(WORKER_QP, _frame(b"{}"))
    r = tc.get("/upgrade/check",
               params={"worker": "sysdev-lead", "version": bad})
    assert r.status_code == 400, (bad, r.text)
    # 零 exec 拨号（版本校验在命令构造前）
    assert not _FakeClient.exec_create_bodies()


def test_bad_worker_400(client):
    tc, _ = client
    _specs(WORKER_QP, _frame(b"{}"))
    r = tc.get("/upgrade/check", params={"worker": "a.b"})
    assert r.status_code == 400


# ── U7 run 202（detached + 两阶段命令形态） ──────────────────────────
def test_run_202_detached(client):
    tc, _ = client
    _specs(WORKER_QP, _frame(b"OK"))
    r = tc.post("/upgrade/run",
                json={"worker": "sysdev-lead", "version": "2.3.0"})
    assert r.status_code == 202, r.text
    d = r.json()
    assert d["state"] == "running"
    assert d["job_id"].startswith("upg-")
    assert d["worker"] == "sysdev-lead"
    bodies = _FakeClient.exec_create_bodies()
    cmd = bodies[0]["Cmd"][2]
    assert bodies[0]["Detach"] is True
    assert "--phase pre-restart" in cmd
    assert f"--job-id {d['job_id']}" in cmd
    assert "--restart-mode kill" in cmd
    assert "--target 2.3.0" in cmd
    assert "nohup" in cmd
    assert "upgrade_qwenpaw_runtime.sh" in cmd


# ── U8 run 缺参零拨号 ────────────────────────────────────────────────
def test_run_missing_params_400(client):
    tc, _ = client
    r = tc.post("/upgrade/run", json={"worker": "sysdev-lead"})
    assert r.status_code == 400
    assert not _FakeClient.exec_create_bodies()


# ── U9 status 解析（state + pending） ────────────────────────────────
def test_status_ok(client):
    tc, _ = client
    payload = (json.dumps(STATE_JSON).encode()
               + b"\n---PENDING---\n" + json.dumps(PENDING_JSON).encode())
    _specs(WORKER_QP, _frame(payload))
    r = tc.get("/upgrade/status",
               params={"worker": "sysdev-lead",
                       "job_id": "upg-1786445000-abc123"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["state"]["state"] == "running"
    assert d["pending"]["target"] == "2.3.0"
    assert d["job_id"] == "upg-1786445000-abc123"


# ── U10 无 job → 404 ─────────────────────────────────────────────────
def test_status_missing_404(client):
    tc, _ = client
    payload = b"MISSING\n---PENDING---\n"
    _specs(WORKER_QP, _frame(payload))
    r = tc.get("/upgrade/status",
               params={"worker": "sysdev-lead",
                       "job_id": "upg-1786445000-abc123"})
    assert r.status_code == 404
    assert r.json()["detail"] == "job_not_found"
