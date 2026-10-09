# -*- coding: utf-8 -*-
"""Worker 状态聚合器单测。

覆盖 worker_status 的对外钉死语义：

1. ``snapshot()`` 初始形状（workers={} / scanning=False / scanAt=0，零副作用）；
2. sweep 成功路径：名单 2 worker（其一 chats 含 running/updated_at）→
 ``_agg["workers"]`` 归约正确；另一 worker 取数抛异常 → 不下发其值
 （保旧语义，旧值原样保留）；
3. ``ensure_fresh`` 在 TTL 内（scan_at 新鲜）不触发扫描 → scanning 保持
 False、零取数调用。

取数函数以 monkeypatch 假 ``worker_status._ctl_get`` 注入（模块内唯一
取数注入点）；asyncio 直跑 ``_sweep``（不依赖 tick 循环）；断言直接看
模块内部状态与快照。不碰真实网络与配置文件。
"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.parse as _up
from datetime import datetime, timezone

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import worker_status as ws

CFG = {
    "address_mode": "auto",
    "controller_urls": ["http://ctl.test"],
    "controller_token": "tok",
}

W1_RUNNING_TS = "2026-10-05T10:00:00Z"
W1_RUNNING_MS = int(
    datetime.fromisoformat(W1_RUNNING_TS.replace("Z", "+00:00")).timestamp()
    * 1000
)


class _FakeCtlGet:
    """假取数：按 URL path 分发（名单 / 各 worker chats）；w2 恒抛异常。"""

    def __init__(self):
        self.calls: list[str] = []

    async def __call__(self, url: str, token: str):
        self.calls.append(url)
        assert token == "tok"  # token 经 _resolve_controller_token 解析链传入
        p = _up.urlparse(url).path
        if p == "/api/v1/workers":
            return 200, {"workers": [{"name": "w1"}, {"name": "w2"}]}, ""
        if p == "/api/v1/workers/w1/chats":
            return 200, [
                {"status": "running", "updated_at": W1_RUNNING_TS},
                {"status": "idle", "updated_at": "2026-10-05T09:00:00Z"},
            ], ""
        if p == "/api/v1/workers/w2/chats":
            raise RuntimeError("boom")
        return 404, {}, ""


@pytest.fixture(autouse=True)
def _reset_and_cfg(monkeypatch):
    """模块级聚合态逐测归零（conftest 通用清空只覆盖 router 的 *_cache）。"""
    ws._agg["workers"] = {}
    ws._agg["scan_at"] = 0.0
    ws._agg["scanning"] = False
    ws._names_cache["names"] = []
    ws._names_cache["ts"] = 0.0
    monkeypatch.setattr(
        cfgmod, "load_config", lambda: json.loads(json.dumps(CFG))
    )
    yield


def test_snapshot_initial_shape():
    """1) 初始快照形状：workers 空表 / scanning False / scanAt 0。"""
    snap = ws.snapshot()
    assert snap == {
        "ok": True,
        "workers": {},
        "scanAt": 0,
        "scanning": False,
    }
    # 零副作用：快照不触发扫描、不改内部态。
    assert ws._agg["scanning"] is False
    assert ws._names_cache["names"] == []


def test_sweep_reduce_and_keep_old(monkeypatch):
    """2) sweep 成功：w1 归约正确（running + max updated_at）；w2 取数
 抛异常 → 保旧值（预置旧值原样保留，不被空值覆盖/清除）。"""
    fake = _FakeCtlGet()
    monkeypatch.setattr(ws, "_ctl_get", fake)
    ws._agg["workers"]["w2"] = {"running": False, "lastUpdated": 111}  # 旧值

    asyncio.run(ws._sweep())

    # 名单 + 2 个 worker chats 各拨一次（token 链已在上游解析）。
    assert [
        _up.urlparse(u).path for u in fake.calls
    ] == ["/api/v1/workers", "/api/v1/workers/w1/chats", "/api/v1/workers/w2/chats"]
    # w1：任一 session running → True；lastUpdated 取最大（10:00 > 09:00）。
    assert ws._agg["workers"]["w1"] == {
        "running": True,
        "lastUpdated": W1_RUNNING_MS,
    }
    # w2：失败保旧值（原样，非空值、非清除）。
    assert ws._agg["workers"]["w2"] == {"running": False, "lastUpdated": 111}
    # 完成态：scanning 回落 False；scan_at 已刷新；快照可见。
    assert ws._agg["scanning"] is False
    assert ws._agg["scan_at"] > 0
    snap = ws.snapshot()
    assert snap["scanning"] is False
    assert snap["workers"]["w1"]["running"] is True
    assert snap["workers"]["w1"]["lastUpdated"] == W1_RUNNING_MS
    assert snap["workers"]["w2"] == {"running": False, "lastUpdated": 111}
    # 名单已入 60s 缓存（下轮不再拨名单）。
    assert ws._names_cache["names"] == ["w1", "w2"]
    assert ws._names_cache["ts"] > 0


def test_ensure_fresh_within_ttl_no_sweep(monkeypatch):
    """3) TTL 内（scan_at 新鲜）→ ensure_fresh 不触发：scanning 保持
 False、零取数调用。"""
    fake = _FakeCtlGet()
    monkeypatch.setattr(ws, "_ctl_get", fake)
    ws._agg["scan_at"] = time.time()  # 新鲜

    ws.ensure_fresh()  # 同步调用；TTL 未过期 → 立即返回（不建 task）

    assert ws._agg["scanning"] is False
    assert fake.calls == []
