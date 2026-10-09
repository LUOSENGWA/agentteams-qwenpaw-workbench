# -*- coding: utf-8 -*-
"""持久化硬化 + 诊断端点。

覆盖：
1. update_config 写验证（save_config 写后回读）：
 - 正常写盘 → 磁盘内容 = 内存合并态（往返一致）；
 - 回读不一致（monkeypatch 配置文件对象的 read_text 返回异值——
 最小注入点，模拟磁盘写异常/并发破坏）→ 抛 IOError。
2. PUT /config 错误路径分类：
 - update_config 抛 IOError → 500 且 detail 含「配置保存失败（磁盘写入
 问题）」；
 - 非 IO 异常（兜底分支）→ 仍 500 且 detail 含「配置写入失败」、
 不命中磁盘分类措辞（两分支互不串扰）。
3. GET /config 含持久化诊断三字段 configPath/configSavedAt/configWritable，
 类型正确（tmp 路径隔离，沿用现有 config 测试的 tmp_path 模式）。
4. GET /debug/tasks → 200 且含 total/byCoroutine（聚合计数 = total，
 零副作用）。

隔离：config 模块重定向 tmp_path；后台探测 monkeypatch 假 no-op，不碰
真实 secret 目录与真实网络。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod
from agentteams_connector.router import build_router


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    """配置文件/目录隔离到 tmp_path（真实 secret 目录零接触）。"""
    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    yield cfg_dir / "config.json"


@pytest.fixture()
def client(monkeypatch, tmp_path):
    """TestClient + config 重定向 tmp + 后台探测假 no-op（不碰真实网络）。"""
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


# ── 1) update_config 写验证（写后回读）─────────────────────────────────


def test_update_config_write_readback_roundtrip(tmp_config):
    """正常路径：合并值真实落盘（磁盘回读 = 写入内容）。"""
    merged = config_mod.update_config({"address_mode": "lan"})
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk == merged
    assert on_disk["address_mode"] == "lan"


def test_update_config_readback_mismatch_raises_ioerror(tmp_config, monkeypatch):
    """回读不一致 → 抛 IOError（不静默假装保存成功）。"""
    config_mod.update_config({"address_mode": "lan"})  # 先一次正常写（文件存在）
    # 最小注入点：类级 patch Path.read_text，仅对配置文件路径返回异值
    # （模拟磁盘写异常/并发破坏；其余路径透传原实现）。
    real_read_text = Path.read_text

    def poisoned(self, *a, **k):
        if str(self) == str(config_mod._CONFIG_PATH):
            return '{"poisoned": true}'
        return real_read_text(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", poisoned)
    with pytest.raises(IOError, match="配置写盘校验不一致"):
        config_mod.update_config({"address_mode": "wan"})


# ── 2) PUT /config 错误路径分类 ─────────────────────────────────────────


def test_put_config_ioerror_reports_disk_write_issue(client, monkeypatch):
    """IOError（写盘校验失败/磁盘异常）→ 500 + detail 含「配置保存失败
 （磁盘写入问题）」。"""
    tc = client

    def boom(patch, **kw):
        raise IOError("配置写入失败：配置写盘校验不一致（磁盘内容与内存态不同）")

    monkeypatch.setattr(config_mod, "update_config", boom)
    with tc:
        r = tc.put("/config", json={"config": {"address_mode": "lan"}})
    assert r.status_code == 500
    detail = r.json()["detail"]
    assert "配置保存失败" in detail
    assert "磁盘写入问题" in detail


def test_put_config_non_io_error_keeps_t17_generic_500(client, monkeypatch):
    """非 IO 异常 → 仍走 通用兜底分支（「配置写入失败」），不命中
 磁盘写入分类措辞。"""
    tc = client

    def boom(patch, **kw):
        raise ValueError("unexpected-shape-error")

    monkeypatch.setattr(config_mod, "update_config", boom)
    with tc:
        r = tc.put("/config", json={"config": {"address_mode": "lan"}})
    assert r.status_code == 500
    detail = r.json()["detail"]
    assert "配置写入失败" in detail
    assert "unexpected-shape-error" in detail
    assert "配置保存失败" not in detail


# ── 3) GET /config 持久化诊断字段 ───────────────────────────────────────


def test_get_config_persistence_diagnostic_fields(client):
    """三字段类型正确 + 值合理（tmp 隔离：路径指向本测 tmp 文件）。"""
    tc = client
    with tc:
        config_mod.update_config({"address_mode": "auto"})  # 让配置文件存在
        r = tc.get("/config")
    assert r.status_code == 200
    body = r.json()
    assert body["configPath"] == str(config_mod._CONFIG_PATH)
    assert body["configPath"].endswith("config.json")
    assert isinstance(body["configSavedAt"], int)
    assert body["configSavedAt"] > 0
    assert body["configWritable"] is True


# ── 4) /debug/tasks 诊断端点 ────────────────────────────────────────────


def test_debug_tasks_lists_asyncio_tasks(client):
    """200 + total/byCoroutine；聚合计数 = total（零副作用、无遗漏）。"""
    tc = client
    with tc:
        r = tc.get("/debug/tasks")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert isinstance(body["total"], int)
    assert body["total"] >= 1  # 至少含当前请求自身任务
    assert isinstance(body["byCoroutine"], dict)
    assert len(body["byCoroutine"]) >= 1
    assert sum(body["byCoroutine"].values()) == body["total"]
