# -*- coding: utf-8 -*-
"""拨号闸门/计数/ 判定（，//）。"""
from __future__ import annotations

import asyncio
import pathlib

import httpx

from agentteams_connector import dial_gate as dg


def test_should_failover_status_table():
    assert dg.should_failover_status(401) is True
    assert dg.should_failover_status(403) is True
    assert dg.should_failover_status(408) is True
    assert dg.should_failover_status(429) is True
    assert dg.should_failover_status(500) is True
    assert dg.should_failover_status(503) is True
    assert dg.should_failover_status(400) is False
    assert dg.should_failover_status(404) is False
    assert dg.should_failover_status(409) is False
    assert dg.should_failover_status(422) is False


def test_gate_caps_concurrency(monkeypatch):
    monkeypatch.setenv("AGENTTEAMS_DIAL_CAP", "3")
    dg._reset_for_tests()
    state = {"cur": 0, "max": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.05)
        state["cur"] -= 1
        return httpx.Response(200, json={"ok": True})

    async def main():
        async with dg.GatedAsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            await asyncio.gather(
                *[client.get("http://example.test/api/x") for _ in range(12)]
            )

    asyncio.run(main())
    assert state["max"] <= 3, f"并发超上限: {state['max']}"
    assert state["max"] >= 2  # 确实并发过（防退化为串行）


def test_gate_stats_and_top_paths(monkeypatch):
    monkeypatch.setenv("AGENTTEAMS_DIAL_CAP", "8")
    dg._reset_for_tests()

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    async def main():
        async with dg.GatedAsyncClient(
            transport=httpx.MockTransport(handler)
        ) as client:
            for i in range(5):
                await client.get(f"http://example.test/api/thing{i % 2}")

    asyncio.run(main())
    stats = dg.dial_stats()
    assert stats["async"]["total"] == 5
    assert stats["async"]["inflight"] == 0
    assert stats["async"]["peak"] >= 1
    paths = {p["path"]: p["count"] for p in stats["async"]["top_paths"]}
    assert paths.get("/api/thing0") == 3
    assert paths.get("/api/thing1") == 2
    # 字节计量。
    assert stats["async"]["bytes_total"] > 0
    by_path = {p["path"]: p for p in stats["async"]["top_paths"]}
    assert by_path["/api/thing0"].get("bytes", 0) > 0


def test_sync_filter_slim_and_typed():
    """sync filter 瘦身（limit≤2）+ types 白名单。"""
    from agentteams_connector import sync_watcher

    tl = sync_watcher._SYNC_FILTER["room"]["timeline"]
    assert tl["limit"] <= 2
    assert "m.room.message" in tl.get("types", [])
    assert "m.room.member" in tl.get("types", [])


def test_no_ungated_async_client_in_connector():
    """静态护栏：connector 源码不允许残留裸 httpx.AsyncClient(。"""
    root = pathlib.Path(__file__).resolve().parent.parent / "agentteams_connector"
    offenders = []
    for f in sorted(root.glob("*.py")):
        if f.name == "dial_gate.py":
            continue  # 子类定义处除外
        for i, line in enumerate(
            f.read_text(encoding="utf-8").splitlines(), 1
        ):
            if line.strip().startswith("#"):
                continue
            # 捕一切别名形态
            # （httpx.AsyncClient / _h.AsyncClient / _httpx.AsyncClient），
            # 仅放行 GatedAsyncClient(。
            if ".AsyncClient(" in line and "GatedAsyncClient(" not in line:
                offenders.append(f"{f.name}:{i}")
    assert not offenders, f"未走闸门的异步拨号点: {offenders}"


def test_sync_sites_all_gated():
    """静态护栏：connector 内 httpx.Client( 行必须带 sync_dial_slot。"""
    root = pathlib.Path(__file__).resolve().parent.parent / "agentteams_connector"
    offenders = []
    for f in sorted(root.glob("*.py")):
        if f.name == "dial_gate.py":
            continue
        for i, line in enumerate(
            f.read_text(encoding="utf-8").splitlines(), 1
        ):
            if line.strip().startswith("#"):
                continue
            # 捕一切形态（httpx.Client / _h.Client / _httpx.Client），
            # 仅放行带 sync_dial_slot() 的行。
            if (
                ".Client(" in line
                and "GatedAsyncClient(" not in line
                and "sync_dial_slot" not in line
            ):
                offenders.append(f"{f.name}:{i}")
    assert not offenders, f"未走闸门的同步拨号点: {offenders}"
