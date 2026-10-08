# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.22（D4）：/kb/agents runtime/runtimeDeprecated 端点级透传单测（A 组）。

任务书 A1-A6 + A7（超出 spec，加测兜底端点路径）。helper 层（
_kb_apply_runtime_fields 直测）已由同批外部落盘的
test_kb_agents_fallback_runtime_14_22.py 覆盖——本文件不重复该层，
钉端点级链路：

- A1 docker 主路径：worker 带 runtime + runtimeDeprecated → 响应条目带两键
  （compute 补全循环 → _kb_apply_runtime_fields 单一实现）；
- A2 旧 Controller（无两字段）→ 键缺失，不是 None（前端 undefined 放行）；
- A3 runtime 空串 → runtime 键不写（`if rt:` 口径）；
- A4 runtimeDeprecated=False → 键不写（真值才写口径）；
- A5 磁盘缓存命中 → 载荷原样透传（cached/age 标记，runtime 键完好，
  TTL 内无刷新改写）；
- A6 Controller token 未配 → 401（文案以 _kb_require_token 真实行为为准）；
- A7（超出 spec）docker 403 → ctl 兜底（ctl_client.ctl_json →
  client.request）→ runtime 键同样透传 + manager 占位。

网络隔离：monkeypatch router 模块属性 GatedAsyncClient——L43 模块级导入
与 _kb_docker/compute 函数内 `from .dial_gate import GatedAsyncClient`
在调用时都解析到同一模块属性，单点 patch 即拦截全部三个拨号点
（_kb_docker 主路径 / compute workers 补全循环 / ctl 兜底）。
配置走 load_config monkeypatch（单地址 + 固定 token）。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from conftest import patch_shared_name
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentteams_connector import config as cfgmod
from agentteams_connector import kb_cache
from agentteams_connector import router as router_mod


class _FakeResp:
    """假 httpx 响应：仅提供 status_code / content / text / json()。"""

    def __init__(self, status_code: int, body):
        self.status_code = status_code
        self._body = body
        self.content = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.text = self.content.decode("utf-8")

    def json(self):
        return self._body


class _FakeGatedClient:
    """假 GatedAsyncClient：按 URL 后缀路由 canned 响应。

    - .../docker/v1.41/containers/json → get()（_kb_docker 主路径）
    - .../api/v1/workers → get()（compute 补全循环）/ request()（ctl 兜底）
    """

    def __init__(self, containers=None, workers=None, docker_status=200):
        self.containers = containers or []
        self.workers = {"workers": workers or []}
        self.docker_status = docker_status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None, **kw):
        if url.endswith("/docker/v1.41/containers/json"):
            return _FakeResp(self.docker_status, self.containers)
        if url.endswith("/api/v1/workers"):
            return _FakeResp(200, self.workers)
        return _FakeResp(404, {"error": url})

    async def request(self, method, url, json=None, headers=None, **kw):
        # ctl_client.ctl_json 路径（兜底）：client.request(method, u, json=..., headers=...)
        return await self.get(url, headers=headers)


def _install_fake_dial(monkeypatch):
    """patch router.GatedAsyncClient → 返回同一 fake 的工厂（覆盖全部拨号点）。

    工厂签名 *a/**k 透传构造参（timeout 标量或 Timeout 对象、verify）——
    假构造器必须接受任意参（任务 180 教训：构造 TypeError 会被宽 except
    吞成隐蔽失败）。"""
    fake = _FakeGatedClient()

    def _factory(*a, **kw):
        return fake

    patch_shared_name(monkeypatch, "GatedAsyncClient", _factory)
    return fake


def _containers(*names):
    return [{"Names": ["/" + n], "State": "running"} for n in names]


def _worker(name, **extra):
    w = {"name": name}
    w.update(extra)
    return w


def _entry(body, name):
    for a in body["agents"]:
        if a["name"] == name:
            return a
    raise AssertionError(f"entry {name!r} not in response agents: {body}")


@pytest.fixture()
def client(monkeypatch):
    """TestClient（with 块保 portal 事件循环跨请求存活）+ 假配置 + 假拨号器。

    fake 挂在 tc._fake_dial 上，各测试请求前设置 canned 响应。"""
    cfg = {
        "controller_urls": ["http://ctl.test"],
        "controller_token": "ctok123",
    }
    monkeypatch.setattr(
        cfgmod, "load_config", lambda: json.loads(json.dumps(cfg)))
    fake = _install_fake_dial(monkeypatch)

    app = FastAPI()
    app.include_router(router_mod.build_router())
    with TestClient(app) as tc:
        tc._fake_dial = fake
        yield tc


@pytest.fixture()
def client_no_token(monkeypatch):
    """controller_token 未配置的客户端（A6 401 场景）。"""
    cfg = {
        "controller_urls": ["http://ctl.test"],
        "controller_token": "",
    }
    monkeypatch.setattr(
        cfgmod, "load_config", lambda: json.loads(json.dumps(cfg)))
    app = FastAPI()
    app.include_router(router_mod.build_router())
    with TestClient(app) as tc:
        yield tc


def test_a1_docker_main_path_runtime_fields(client):
    """A1：docker 主路径 worker 带 runtime + runtimeDeprecated → 条目带两键。

    链路：/kb/agents 冷取 → _kb_agents_compute → _kb_docker（fake 200）→
    GatedAsyncClient GET /api/v1/workers（fake 200）→ 补全循环（role/team）
    → _kb_apply_runtime_fields（router L4632 调用点）→ 响应。"""
    fake = client._fake_dial
    fake.containers = _containers(
        "agentteams-manager", "agentteams-worker-w-oc")
    fake.workers = {"workers": [
        _worker("w-oc", runtime="openclaw", runtimeDeprecated=True,
                role="team_leader", team="t1"),
    ]}
    r = client.get("/kb/agents")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    oc = _entry(body, "w-oc")
    assert oc["runtime"] == "openclaw"
    assert oc["runtimeDeprecated"] is True
    assert oc["role"] == "leader"      # team_leader → leader（补全循环口径）
    assert oc["team"] == "t1"
    assert oc["kind"] == "worker"
    mg = _entry(body, "manager")
    assert "runtime" not in mg         # manager 不在 workers → 不补透传
    assert "runtimeDeprecated" not in mg
    assert mg["kind"] == "manager"


def test_a2_legacy_controller_keys_absent_not_none(client):
    """A2：旧 Controller（worker 对象无两字段）→ 键缺失，不是 None。"""
    fake = client._fake_dial
    fake.containers = _containers("agentteams-worker-w-old")
    fake.workers = {"workers": [_worker("w-old", role="worker", team="t9")]}
    r = client.get("/kb/agents")
    assert r.status_code == 200
    entry = _entry(r.json(), "w-old")
    assert "runtime" not in entry
    assert "runtimeDeprecated" not in entry
    assert entry.get("runtime") is None
    # role/team 补全不受影响
    assert entry["role"] == "worker"
    assert entry["team"] == "t9"


def test_a3_empty_runtime_key_not_written(client):
    """A3：runtime="" → runtime 键不写（`if rt:` 口径，空串 falsy）。"""
    fake = client._fake_dial
    fake.containers = _containers("agentteams-worker-w-empty")
    fake.workers = {"workers": [_worker("w-empty", runtime="")]}
    r = client.get("/kb/agents")
    assert r.status_code == 200
    entry = _entry(r.json(), "w-empty")
    assert "runtime" not in entry


def test_a4_false_deprecated_key_not_written(client):
    """A4：runtimeDeprecated=False → 键不写（真值才写）；runtime 照常写。"""
    fake = client._fake_dial
    fake.containers = _containers("agentteams-worker-w-partial")
    fake.workers = {"workers": [
        _worker("w-partial", runtime="openclaw", runtimeDeprecated=False)]}
    r = client.get("/kb/agents")
    assert r.status_code == 200
    entry = _entry(r.json(), "w-partial")
    assert entry["runtime"] == "openclaw"
    assert "runtimeDeprecated" not in entry


def test_a5_disk_cache_hit_payload_passthrough(client):
    """A5：磁盘缓存命中 → 载荷原样透传（cached/age；runtime 键完好；TTL 内不刷新）。

    先向 kb-cache 写入含 runtime 键的 agents 条目（ts=now-10s，在 60s TTL 内
    → 不触发后台刷新），GET 走磁盘分支。TTL 取自 _kb_swr_ttl_now() 读
    load_config().address_mode（本 fixture 配置无该键 → "auto" → 60s）。"""
    seed_agents = [
        {"name": "w-cache", "container": "agentteams-worker-w-cache",
         "state": "running", "kind": "worker", "team": "t", "role": "worker",
         "runtime": "openclaw", "runtimeDeprecated": True},
        {"name": "manager", "container": "agentteams-manager",
         "state": "", "kind": "manager"},
    ]
    ts = time.time() - 10
    (Path(kb_cache.cache_dir()) / "agents.json").write_text(
        json.dumps({"ts": ts, "payload": {"agents": seed_agents, "count": 2}},
                   ensure_ascii=False),
        encoding="utf-8",
    )
    r = client.get("/kb/agents")
    assert r.status_code == 200
    body = r.json()
    assert body["cached"] is True
    assert 9 <= body["age"] <= 120
    assert body["agents"] == seed_agents
    # runtime 键随载荷原样透传（缓存往返不丢键）
    assert body["agents"][0]["runtime"] == "openclaw"
    assert body["agents"][0]["runtimeDeprecated"] is True
    # age < TTL → 未触发后台刷新 → 磁盘 ts 未被改写
    assert kb_cache.load("agents")[0] == ts


def test_a6_missing_controller_token_401(client_no_token):
    """A6：Controller token 未配 → 401（文案以 _kb_require_token 真实行为为准）。"""
    r = client_no_token.get("/kb/agents")
    assert r.status_code == 401
    assert r.json()["detail"] == (
        "远端团队知识库需要 Controller 管理员 token（配置页填写后刷新）")


def test_a7_beyond_spec_docker_403_fallback_runtime_fields(client):
    """A7（超出 spec，加测）：docker 403 → ctl 兜底路径 → runtime 键同样透传。

    任务书 A1-A4 钉主（Docker）路径；本部署 Docker 通道实测不可用（全量走
    兜底），此测验证同一 _kb_apply_runtime_fields 单一实现在兜底路径
    （经 ctl_client.ctl_json → client.request，同一 fake 拦截）同样生效。"""
    fake = client._fake_dial
    fake.docker_status = 403
    fake.containers = []
    fake.workers = {"workers": [
        _worker("w-fb", runtime="openclaw", runtimeDeprecated=True,
                role="team_leader", team="t7"),
    ]}
    r = client.get("/kb/agents")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    fb = _entry(body, "w-fb")
    assert fb["runtime"] == "openclaw"
    assert fb["runtimeDeprecated"] is True
    assert fb["role"] == "leader"
    mg = _entry(body, "manager")
    assert mg["kind"] == "manager"
    assert mg["role"] == "leader"       # 兜底 manager 占位
    assert "runtime" not in mg
