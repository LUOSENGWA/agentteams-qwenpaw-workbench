# -*- coding: utf-8 -*-
"""14.34 实装反馈三修回归——「401 逼重填密码」根治 + 感知件配套。

实装反馈（beta.14.33 装后）：设置页显示「固定外网 + 已保存」，但 401
逼着重填密码，而 controller 测试明明能连上。取证定案（本机实跑）：

1. **selfcheck L2 恒 401 红叉=密码重填循环的误导源**——L2「Controller
   projects (L2)」走 Matrix token 路径，上游只放行 level-2/3 Human，
   level-1 管理员账号**恒 401**（与外网 Basic 账密无关）；而 L1 管理员
   token 正源同刻 200（「controller 能连上」）。旧实现 L1 在 L2 之后
   探测、无法判预期态，L2 行红 ❌「HTTP 401」被用户读成「密码错」
   → 反复重填保存。修：L1 探测提前，L2 401 且 L1 正源可用时判**预期
   态**（ok=True + warn=True，前端 ⚠️ 琥珀），detail 点明「与 Basic
   账密无关，无需重填」。
2. **config/test 同组交叉核对**——同族另一地址 200 可达（同凭据）时，
   401 行 detail 追加「更可能是隧道/网关瞬时故障，不一定是密码错」：
   外网隧道瞬断时边缘网关可能直接 401，旧文案一律怪密码。

护栏：
- run_l2：L1 200 + L2 401 → L2 行 ok=True warn=True 预期态，L2 整体 ok。
- run_l2：无 L1 token + L2 401 → 仍 ok=False（真失败不误判预期态）。
- run_l2：L1 token 401 失效 + L2 401 → 仍 ok=False（L1 不可用不兜预期）。
- run_l2 显示顺序不变（L1 行仍在 L2 行后）。
- config/test：controller 双地址 [200, 401-basic] → 401 行 detail 追加
  隧道提示；全 401 → 不加。
"""
from __future__ import annotations

import json

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector import matrix_client
from agentteams_connector.router import build_router


# ── 公共替身 ───────────────────────────────────────────────────────────


class _Resp:
    def __init__(self, status_code: int, body: str = ""):
        self.status_code = status_code
        self._body = body
        self.headers = {}

    @property
    def text(self) -> str:
        return self._body

    def json(self):
        return json.loads(self._body) if self._body else {}


class _FakeSyncClient:
    """sync httpx.Client 替身：按 Authorization 头区分 L1/L2 路径。

    matrix_token → matrix 401（level-1 管理员恒 401 的真实形态）；
    ctl_token    → 按 ctl_status 回（200=正源可用 / 401=token 失效）。
    """

    def __init__(self, ctl_status: int = 200):
        self.ctl_status = ctl_status
        self.calls: list[str] = []

    def __call__(self, *a, **kw):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        auth = str((headers or {}).get("Authorization") or "")
        if "CTL_TOKEN" in auth:
            self.calls.append("L1")
            return _Resp(self.ctl_status, "{}" if self.ctl_status == 200 else "denied")
        self.calls.append("L2")
        return _Resp(401, '{"error":"M_FORBIDDEN"}')


def _l2_cfg(token: str = "") -> dict:
    return {
        "matrix": {"access_token": "MX_TOKEN", "user_id": "@luo:test"},
        "matrix_homeservers": ["http://mx.local:6867"],
        "controller_urls": ["http://ctl.local:6866"],
        "controller_token": token,
    }


def _run_l2(monkeypatch, token: str = "", ctl_status: int = 200):
    fake = _FakeSyncClient(ctl_status=ctl_status)
    monkeypatch.setattr(selfcheck_mod.httpx, "Client", fake)
    monkeypatch.setattr(matrix_client, "whoami", lambda hs, tk: {"user_id": "@luo:test"})
    monkeypatch.setattr(matrix_client, "joined_rooms", lambda hs, tk: {"joined_rooms": ["!r1:test"]})
    # working cache 清空 → 用配置首个地址。
    from agentteams_connector import router as router_mod

    with router_mod._cache_lock:
        router_mod._working_cache.clear()
    r = selfcheck_mod.run_l2(_l2_cfg(token))
    return r, fake


# ── run_l2 预期态 ──────────────────────────────────────────────────────


def test_l2_401_expected_when_l1_ok(monkeypatch):
    """L1 正源 200 + L2 恒 401 → L2 行预期态（ok=True warn=True），整体 ok。"""
    r, fake = _run_l2(monkeypatch, token="CTL_TOKEN", ctl_status=200)
    l2 = next(c for c in r["checks"] if c["name"] == "Controller projects (L2)")
    assert l2["ok"] is True, "L1 可用时 L2 的 401 是预期态，不得显失败"
    assert l2.get("warn") is True, "预期态必须带 warn 标记（前端 ⚠️ 渲染）"
    assert "401" in l2["detail"]
    assert "Basic" in l2["hint"], "必须点明与 Basic 账密无关"
    assert "重新填写" in l2["hint"] or "重填" in l2["hint"] or "无需" in l2["hint"]
    l1 = next(c for c in r["checks"] if c["name"] == "Controller projects (L1 正源)")
    assert l1["ok"] is True
    assert r["ok"] is True, "预期态不得把 L2 整体拖成 ❌"
    # L1 探测必须先于 L2（预期态判定的数据依赖）。
    assert fake.calls.index("L1") < fake.calls.index("L2")
    # 显示顺序不变：L1 行仍在 L2 行后。
    assert r["checks"].index(l2) < r["checks"].index(l1)


def test_l2_401_still_fails_without_token(monkeypatch):
    """无 L1 token + L2 401 → 仍真失败（不误判预期态）。"""
    r, _ = _run_l2(monkeypatch, token="")
    l2 = next(c for c in r["checks"] if c["name"] == "Controller projects (L2)")
    assert l2["ok"] is False
    assert l2.get("warn") is not True
    assert r["ok"] is False
    assert not any(c["name"].startswith("Controller projects (L1") for c in r["checks"])


def test_l2_401_still_fails_when_l1_dead(monkeypatch):
    """L1 token 失效（401）+ L2 401 → L2 仍真失败（L1 不可用不兜预期）。"""
    r, _ = _run_l2(monkeypatch, token="CTL_TOKEN", ctl_status=401)
    l2 = next(c for c in r["checks"] if c["name"] == "Controller projects (L2)")
    assert l2["ok"] is False
    assert l2.get("warn") is not True
    l1 = next(c for c in r["checks"] if c["name"] == "Controller projects (L1 正源)")
    assert l1["ok"] is False
    assert r["ok"] is False


# ── config/test 同组交叉核对 ───────────────────────────────────────────


@pytest.fixture()
def client(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    config_mod._last_load_state = "unknown"

    async def noop_probe(cfg, kinds=("matrix", "controller")):
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", noop_probe)
    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def _fake_probe_results(controller_rows: list[dict]) -> dict:
    return {
        "matrix": [{"url": "http://mx.local", "ok": True, "http_ok": True, "ms": 5, "detail": "HTTP 200"}],
        "controller": controller_rows,
        "sglang": [],
        "gateway": [],
    }


def test_config_test_401_tunnel_hint_when_sibling_ok(client, monkeypatch):
    """同族另一地址 200（同凭据）→ 401 行 detail 追加隧道瞬断提示。"""
    rows = [
        {"url": "http://ctl.lan", "ok": True, "http_ok": True, "ms": 8, "detail": "HTTP 200，JSON 正常"},
        {
            "url": "https://ctl.wan",
            "ok": True,
            "http_ok": False,
            "ms": 12,
            "challenge": "basic",
            "detail": "已连通，HTTP 401（需要鉴权）｜Basic 凭据被网关拒绝（用户名/密码不符）",
        },
    ]
    async def _fake(*a, **kw):
        return _fake_probe_results(rows)

    monkeypatch.setattr(selfcheck_mod, "test_addresses", _fake)
    r = client.post("/config/test", json={}).json()
    wan = next(x for x in r["controller"] if x["url"] == "https://ctl.wan")
    assert "隧道" in wan["detail"], "同组 200 可达时 401 行必须提示隧道/网关瞬断"
    assert "不一定是密码错" in wan["detail"]
    lan = next(x for x in r["controller"] if x["url"] == "http://ctl.lan")
    assert "隧道" not in lan["detail"], "200 行不得被追加"


def test_config_test_401_no_hint_when_all_dead(client, monkeypatch):
    """同族全 401（无 200 可达）→ 不加隧道提示（凭据问题照旧显形）。"""
    rows = [
        {
            "url": "http://ctl.lan",
            "ok": True,
            "http_ok": False,
            "ms": 8,
            "challenge": "basic",
            "detail": "已连通，HTTP 401（需要鉴权）｜Basic 凭据被网关拒绝（用户名/密码不符）",
        },
        {
            "url": "https://ctl.wan",
            "ok": True,
            "http_ok": False,
            "ms": 12,
            "challenge": "basic",
            "detail": "已连通，HTTP 401（需要鉴权）｜Basic 凭据被网关拒绝（用户名/密码不符）",
        },
    ]
    async def _fake(*a, **kw):
        return _fake_probe_results(rows)

    monkeypatch.setattr(selfcheck_mod, "test_addresses", _fake)
    r = client.post("/config/test", json={}).json()
    for x in r["controller"]:
        assert "隧道" not in x["detail"]
