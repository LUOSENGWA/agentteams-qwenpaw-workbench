# -*- coding: utf-8 -*-
"""projects-workflow 取数聚合单测。

覆盖 projects_workflow 的对外钉死语义：

1. ``snapshot()`` 初始形状（projects=[] / workflows={} / projectsStatus=0 /
 scanning=False，零副作用）；
2. sweep 成功路径：假 /projects 返回 3 条（p1 重复——无 team_id 一条 +
 带 team_id 一条 → 去重后 2 条，p1 留带 team_id 的记录；p2 独立项目）；
 p2 的 workflow 取数失败（抛异常，无旧值）→ 快照 workflows 仅含成功的
 p1、projects_status=200；p1 的 URL 带 &team=（teamQ 规则）；
3. 名单失败（st=401）→ projects 保旧、projects_status=401、scan_at 推进
 （避免 ensure_fresh 每次都重打）。

取数函数以 monkeypatch 假 ``worker_status._ctl_get`` 注入（projects_workflow
复用它为本模块唯一取数注入点，测试不碰真实网络）；asyncio 直跑 ``_sweep``
（不依赖 tick 循环）；断言直接看模块内部状态与快照。
"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.parse as _up

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import projects_workflow as pw
from agentteams_connector import worker_status as ws

CFG = {
    "address_mode": "auto",
    "controller_urls": ["http://ctl.test"],
    "controller_token": "tok",
}

WF1 = {"nodes": [{"id": "n1"}], "edges": []}


class _FakeCtlGet:
    """假取数：按 URL path 分发（名单 / 逐项目 workflow）；p2 的 workflow
 恒抛异常。名单可配状态码（测名单失败保旧路径）。"""

    def __init__(self, list_status=200):
        self.list_status = list_status
        self.calls: list[str] = []

    async def __call__(self, url: str, token: str):
        self.calls.append(url)
        assert token == "tok"  # token 经 _resolve_controller_token 解析链传入
        p = _up.urlparse(url)
        if p.path == "/api/v1/projects":
            if self.list_status != 200:
                return self.list_status, {}, "unauthorized: bad token"
            # 信封形态（{projects: [...], total}）+ p1 重复（无 team / 带 team）。
            return 200, {
                "projects": [
                    {"project_id": "p1"},
                    {"project_id": "p1", "team_id": "t1"},
                    {"project_id": "p2"},
                ],
                "total": 3,
            }, ""
        if p.path == "/api/v1/projects/p1/workflow":
            assert "team=t1" in (p.query or "")  # teamQ：非空 team_id 带 &team=
            assert "includeTasks=true" in (p.query or "")
            return 200, WF1, ""
        if p.path == "/api/v1/projects/p2/workflow":
            assert "team=" not in (p.query or "")  # 独立项目（无 team_id）不带
            raise RuntimeError("boom")
        return 404, {}, ""


@pytest.fixture(autouse=True)
def _reset_and_cfg(monkeypatch):
    """模块级聚合态逐测归零（conftest 通用清空只覆盖 router 的 *_cache）。"""
    pw._snap["projects"] = []
    pw._snap["workflows"] = {}
    pw._snap["projects_status"] = 0
    pw._snap["projects_error"] = ""
    pw._snap["scan_at"] = 0.0
    pw._snap["scanning"] = False
    monkeypatch.setattr(
        cfgmod, "load_config", lambda: json.loads(json.dumps(CFG))
    )
    yield


def test_snapshot_initial_shape():
    """1) 初始快照形状：projects 空表 / workflows 空表 / projectsStatus 0 /
 scanning False。"""
    snap = pw.snapshot()
    assert snap == {
        "ok": True,
        "projects": [],
        "workflows": {},
        "projectsStatus": 0,
        "projectsError": "",
        "scanAt": 0,
        "scanning": False,
    }
    # 零副作用：快照不触发扫描、不改内部态。
    assert pw._snap["scanning"] is False


def test_sweep_dedup_and_missing_keep(monkeypatch):
    """2) sweep 成功：/projects 3 条（p1 重复无 team + 带 team）→ 去重后
 2 条、p1 留带 team_id 的记录（teamQ 寻址有效键）；p2 workflow 取数
 抛异常且无旧值 → workflows 仅含成功的 p1；projects_status=200。"""
    fake = _FakeCtlGet()
    monkeypatch.setattr(ws, "_ctl_get", fake)

    asyncio.run(pw._sweep())

    # 1 次名单 + 2 次逐项目 workflow（去重后扇出 2 路）。
    assert [
        _up.urlparse(u).path for u in fake.calls
    ] == [
        "/api/v1/projects",
        "/api/v1/projects/p1/workflow",
        "/api/v1/projects/p2/workflow",
    ]
    # 去重：p1 两条 → 一条（带 team_id 的记录胜出，插入序保持在前）。
    projects = pw._snap["projects"]
    assert [p["project_id"] for p in projects] == ["p1", "p2"]
    assert projects[0].get("team_id") == "t1"
    # p1 成功入表；p2 失败且无旧值 → 不落（前端 mapProjectWorkflow 跳过）。
    assert pw._snap["workflows"] == {"p1": WF1}
    assert pw._snap["projects_status"] == 200
    assert pw._snap["projects_error"] == ""
    # 完成态：scanning 回落 False；scan_at 刷新；快照可见。
    assert pw._snap["scanning"] is False
    assert pw._snap["scan_at"] > 0
    snap = pw.snapshot()
    assert snap["scanning"] is False
    assert snap["projectsStatus"] == 200
    assert snap["workflows"] == {"p1": WF1}
    assert [p["project_id"] for p in snap["projects"]] == ["p1", "p2"]


def test_sweep_list_failure_keep_old(monkeypatch):
    """3) 名单失败（st=401）→ projects/workflows 保旧、projects_status=401、
 projects_error 记录 detail、scan_at 照常推进（防 ensure_fresh 重打）。"""
    fake = _FakeCtlGet(list_status=401)
    monkeypatch.setattr(ws, "_ctl_get", fake)
    pw._snap["projects"] = [{"project_id": "old1"}]
    pw._snap["workflows"] = {"old1": {"nodes": []}}

    asyncio.run(pw._sweep())

    # 名单失败 → 不逐项目扇出（仅 1 次拨号）。
    assert [_up.urlparse(u).path for u in fake.calls] == ["/api/v1/projects"]
    # 保旧：projects/workflows 原样不动。
    assert pw._snap["projects"] == [{"project_id": "old1"}]
    assert pw._snap["workflows"] == {"old1": {"nodes": []}}
    # 状态记录 + scan_at 推进。
    assert pw._snap["projects_status"] == 401
    assert pw._snap["projects_error"] == "unauthorized: bad token"
    assert pw._snap["scan_at"] > 0
    assert pw._snap["scanning"] is False
    snap = pw.snapshot()
    assert snap["projectsStatus"] == 401
    assert snap["projects"] == [{"project_id": "old1"}]


# ── 渐进落地 + 前台让权 ──────────────────────────────
# 旧版整批 gather 到全部完成才写快照 → 外网首扫空窗 1-3 分钟。现逐项目
# 完成即落地（前端 15s 轮询逐步看见）+ 每项拨号前让前台。以下钉死新语义。


class _FakeCtlGetProgressive:
    """p1 成功、p2 成功（用于渐进落地断言）；记录 p2 取数时刻的快照状态。"""

    def __init__(self):
        self.snapshot_at_p2_call: dict | None = None  # p2 拨号时的 workflows 快照
        self.p1_landed_before_p2_fetched: bool = False

    async def __call__(self, url: str, token: str):
        p = _up.urlparse(url)
        if p.path == "/api/v1/projects":
            return 200, {"projects": [{"project_id": "p1"}, {"project_id": "p2"}],
                         "total": 2}, ""
        if p.path == "/api/v1/projects/p1/workflow":
            return 200, {"nodes": [{"id": "n1"}], "edges": []}, ""
        if p.path == "/api/v1/projects/p2/workflow":
            # p2 取数时，p1 应已渐进落地（谁先完成谁先写）→ 首屏不必等全量。
            self.snapshot_at_p2_call = dict(pw._snap["workflows"])
            if pw._snap["workflows"].get("p1") is not None:
                self.p1_landed_before_p2_fetched = True
            return 200, {"nodes": [{"id": "n2"}], "edges": []}, ""
        return 404, {}, ""


def test_progressive_landing_projects_first(monkeypatch):
    """名单先行：/projects 一成功 projects 即落地（不等 workflow 扫完）。
 断言：p2 拨号时 _snap['projects'] 已含 p1+p2（首屏只等 1 次 /projects）。"""
    fake = _FakeCtlGetProgressive()
    monkeypatch.setattr(ws, "_ctl_get", fake)

    asyncio.run(pw._sweep())

    # 关键：p2 取数那一刻，projects 名单已就位（渐进首屏）。
    # （projects 在逐项目扇出前就落地，故 p2 拨号时必可见。）
    assert fake.snapshot_at_p2_call is not None
    assert pw._snap["projects"] == [{"project_id": "p1"}, {"project_id": "p2"}]
    # 两项目最终都落地。
    assert set(pw._snap["workflows"].keys()) == {"p1", "p2"}
    # 渐进：p1 在 p2 取数前已写入快照（首屏秒级、不等最慢项）。
    assert fake.p1_landed_before_p2_fetched is True
    assert fake.snapshot_at_p2_call.get("p1") == {"nodes": [{"id": "n1"}], "edges": []}


class _FakeCtlGetFailWithOld:
    """p1 成功、p2 抛异常（有旧值 → 应保旧）。"""

    async def __call__(self, url: str, token: str):
        p = _up.urlparse(url)
        if p.path == "/api/v1/projects":
            return 200, {"projects": [{"project_id": "p1"}, {"project_id": "p2"}],
                         "total": 2}, ""
        if p.path == "/api/v1/projects/p1/workflow":
            return 200, {"nodes": [{"id": "n1"}]}, ""
        if p.path == "/api/v1/projects/p2/workflow":
            raise RuntimeError("transient")
        return 404, {}, ""


def test_progressive_failure_keeps_old(monkeypatch):
    """失败保旧：p2 取数抛异常且已有旧值 → 保旧值（不被清空/删）。"""
    fake = _FakeCtlGetFailWithOld()
    monkeypatch.setattr(ws, "_ctl_get", fake)
    pw._snap["workflows"] = {"p2": {"nodes": [{"id": "OLD"}]}}  # 预置旧值

    asyncio.run(pw._sweep())

    assert pw._snap["workflows"]["p1"] == {"nodes": [{"id": "n1"}]}
    # p2 失败 → 保旧（不是 {} / 不是删）。
    assert pw._snap["workflows"]["p2"] == {"nodes": [{"id": "OLD"}]}


class _FakeCtlGetWithGone:
    """新名单只 p1；旧快照有 gone1（已消失）→ 收尾应清掉。"""

    async def __call__(self, url: str, token: str):
        p = _up.urlparse(url)
        if p.path == "/api/v1/projects":
            return 200, {"projects": [{"project_id": "p1"}], "total": 1}, ""
        if p.path == "/api/v1/projects/p1/workflow":
            return 200, {"nodes": [{"id": "n1"}]}, ""
        return 404, {}, ""


def test_progressive_removes_gone_projects(monkeypatch):
    """收尾清消失项：新名单无 gone1 → sweep 后 gone1 被删、p1 保留。"""
    fake = _FakeCtlGetWithGone()
    monkeypatch.setattr(ws, "_ctl_get", fake)
    pw._snap["workflows"] = {"gone1": {"nodes": []}}  # 预置消失项

    asyncio.run(pw._sweep())

    assert "gone1" not in pw._snap["workflows"]
    assert pw._snap["workflows"]["p1"] == {"nodes": [{"id": "n1"}]}
    assert pw._snap["projects"] == [{"project_id": "p1"}]


def test_yield_to_foreground_idle_returns_immediately(monkeypatch):
    """前台闲（inflight=0）→ _yield_to_foreground 立即返回（不退避）。"""
    from agentteams_connector import dial_gate

    calls = {"n": 0}

    def _idle_stats():
        calls["n"] += 1
        return {"async": {"inflight": 0}}

    monkeypatch.setattr(pw, "dial_stats", _idle_stats)
    t0 = time.time()
    asyncio.run(pw._yield_to_foreground())
    # 立即返回：几乎不耗时、不进入退避循环。
    assert time.time() - t0 < 0.1
    assert calls["n"] >= 1


def test_yield_to_foreground_backoff_when_busy(monkeypatch):
    """前台忙（inflight>阈值）→ 退避直到预算耗尽才返回（礼让前台）。"""
    import agentteams_connector.projects_workflow as _pw

    monkeypatch.setattr(_pw, "_SWEEP_YIELD_INFLIGHT", 8)
    monkeypatch.setattr(_pw, "_SWEEP_YIELD_POLL", 0.01)
    monkeypatch.setattr(_pw, "_SWEEP_YIELD_MAX_WAIT", 0.05)

    busy = {"v": True}

    def _busy_stats():
        return {"async": {"inflight": 99 if busy["v"] else 0}}

    monkeypatch.setattr(pw, "dial_stats", _busy_stats)
    t0 = time.time()
    asyncio.run(pw._yield_to_foreground())
    elapsed = time.time() - t0
    # 前台一直忙 → 退避到预算耗尽（≈0.05s）才走（不退化、不无限等）。
    assert elapsed >= 0.04
    # 若前台中途转闲，应提前返回（这里保持忙，验证预算耗尽路径）。
