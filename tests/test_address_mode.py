# -*- coding: utf-8 -*-
"""address_mode（手动固定内网/外网）回归测试（）。

语义（用户 2026-09-30，14.1 同批落地）：

- ``address_mode ∈ {"auto","lan","wan"}``（默认 auto=现状：后台探测自动重排
 + 请求层 failover）。
- 固定档（lan/wan）：请求**只用固定地址**，失败**诚实报错**（502 detail 追加
 「固定档不自动切换」提示），**不静默 failover**；后台探测循环照跑（连通性
 测试可见另一条路径状态），但不再影响路由。
- 列表顺序约定 = [内网, 外网]（设置页内网/外网两个显式输入框同源，
 见 WorkbenchPage 配置区）。lan=索引 0；wan=索引 1。
- 固定索引不存在（如只配了内网却固定外网）→ 回退到唯一/首个地址
 （没有可切的东西，仍诚实报错语义）。
- 旧配置垃圾值（非三选一）一律降级 auto——不 400、不崩。

护栏（防打回）：

- auto 模式**现有语义零变化**：working cache 优先、miss 回退首个、
 failover 链完整（cache-first + 全列表）。
- 探测/显示层：固定地址当选（即使另一条更快）；固定地址本轮不可达时
 显示层回退最快可达（对用户诚实：显示「固定地址挂了」），但请求层
 仍拨固定地址并在失败时报错——两层不混。
"""
from __future__ import annotations

import asyncio

from agentteams_connector import config as config_mod
from agentteams_connector import router as router_mod
from agentteams_connector import selfcheck

LAN = "http://10.0.0.10:6867"
WAN = "https://agentteams.example.com:6867"
CTL_LAN = "http://10.0.0.10:8090"
CTL_WAN = "https://agentteams.example.com:8090"
SG_LAN = "http://10.0.0.10:30000"
SG_WAN = "https://agentteams.example.com:30000"


def _cfg(mode: str = "auto", **over) -> dict:
    base = {
        "address_mode": mode,
        "matrix_homeservers": [LAN, WAN],
        "controller_urls": [CTL_LAN, CTL_WAN],
        "sglang": {"enabled": True, "urls": [SG_LAN, SG_WAN]},
    }
    base.update(over)
    return base


def _clean_cache() -> None:
    with router_mod._cache_lock:
        router_mod._working_cache.clear()


def _row(url: str, ms, ok: bool = True, http_ok: bool = True) -> dict:
    return {"url": url, "ok": ok, "http_ok": http_ok, "ms": ms}


# ── config：默认 / 合并 / 净化 ─────────────────────────────────────


def test_config_default_auto() -> None:
    assert config_mod._DEFAULTS["address_mode"] == "auto"


def test_config_load_merges_and_sanitizes(tmp_path, monkeypatch) -> None:
    p = tmp_path / "config.json"
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", p)
    p.write_text('{"address_mode": "lan"}', encoding="utf-8")
    assert config_mod.load_config()["address_mode"] == "lan"
    p.write_text('{"address_mode": "banana"}', encoding="utf-8")
    assert config_mod.load_config()["address_mode"] == "auto"
    p.write_text("{}", encoding="utf-8")
    assert config_mod.load_config()["address_mode"] == "auto"


def test_update_config_address_mode() -> None:
    merged = config_mod.update_config({"address_mode": "wan"})
    assert merged["address_mode"] == "wan"
    merged = config_mod.update_config({"address_mode": "garbage"})
    assert merged["address_mode"] == "auto"
    # 空串 = 不覆盖（同 token 字段的占位符语义一致：无效即不动/归 auto）
    merged = config_mod.update_config({"address_mode": ""})
    assert merged["address_mode"] in ("auto",)


# ── router：解析器三件 ─────────────────────────────────────────────


def test_address_mode_garbage_degrades_to_auto() -> None:
    assert router_mod._address_mode(_cfg("banana")) == "auto"
    assert router_mod._address_mode({}) == "auto"
    assert router_mod._address_mode(_cfg("lan")) == "lan"


def test_pinned_url_lan_wan() -> None:
    assert router_mod._pinned_url(_cfg("lan"), "matrix") == LAN
    assert router_mod._pinned_url(_cfg("wan"), "matrix") == WAN
    assert router_mod._pinned_url(_cfg("wan"), "controller") == CTL_WAN
    assert router_mod._pinned_url(_cfg("lan"), "sglang") == SG_LAN
    # 固定索引不存在（只有一个地址）→ 回退唯一地址
    assert router_mod._pinned_url(_cfg("wan", matrix_homeservers=[LAN]), "matrix") == LAN
    # auto → None（不固定）
    assert router_mod._pinned_url(_cfg("auto"), "matrix") is None
    # 地址列表空 → None
    assert router_mod._pinned_url(_cfg("lan", matrix_homeservers=[]), "matrix") is None


def test_pinned_note() -> None:
    assert router_mod._pinned_note(_cfg("auto")) == ""
    assert router_mod._pinned_note({}) == ""
    note_lan = router_mod._pinned_note(_cfg("lan"))
    assert "固定内网" in note_lan and "不自动切换" in note_lan
    note_wan = router_mod._pinned_note(_cfg("wan"))
    assert "固定外网" in note_wan and "不自动切换" in note_wan


def test_pinned_map() -> None:
    # 固定档映射扩为四类（补 gateway）——
    # 本测试 _cfg 未配 gateway 地址，故 gateway 固定值 None。
    m = router_mod._pinned_map(_cfg("lan"))
    assert m == {
        "matrix": LAN,
        "controller": CTL_LAN,
        "sglang": SG_LAN,
        "gateway": None,
    }
    m = router_mod._pinned_map(_cfg("wan"))
    assert m["matrix"] == WAN and m["controller"] == CTL_WAN and m["sglang"] == SG_WAN
    assert m["gateway"] is None
    m = router_mod._pinned_map(_cfg("auto"))
    assert m == {"matrix": None, "controller": None, "sglang": None, "gateway": None}


def test_pick_address_auto_cache_first() -> None:
    _clean_cache()
    router_mod._mark_working("matrix", WAN)
    assert router_mod._pick_address(_cfg("auto"), "matrix") == WAN
    # cache 值不在列表（陈旧）→ 列表首个
    with router_mod._cache_lock:
        router_mod._working_cache["matrix"] = "http://stale:1"
    assert router_mod._pick_address(_cfg("auto"), "matrix") == LAN
    # 空列表 → ""
    assert router_mod._pick_address(_cfg("auto", matrix_homeservers=[]), "matrix") == ""


def test_pick_address_pinned_overrides_cache() -> None:
    _clean_cache()
    router_mod._mark_working("matrix", WAN)  # 探测把外网标为生效
    assert router_mod._pick_address(_cfg("lan"), "matrix") == LAN  # 固定内网压过缓存
    assert router_mod._pick_address(_cfg("wan"), "matrix") == WAN
    _clean_cache()
    assert router_mod._pick_address(_cfg("lan", controller_urls=[CTL_LAN, CTL_WAN]), "controller") == CTL_LAN


def test_ordered_addresses_pinned_single() -> None:
    _clean_cache()
    router_mod._mark_working("matrix", WAN)
    # 固定档 = 单元素链（无 failover）
    assert router_mod._ordered_addresses(_cfg("lan"), "matrix") == [LAN]
    assert router_mod._ordered_addresses(_cfg("wan"), "matrix") == [WAN]
    # auto 保持现有语义：cache 优先 + 全链
    assert router_mod._ordered_addresses(_cfg("auto"), "matrix") == [WAN, LAN]
    # 空列表
    assert router_mod._ordered_addresses(_cfg("lan", matrix_homeservers=[]), "matrix") == []


def test_ordered_addresses_sglang_synthetic_cfg() -> None:
    # SGLang 请求路径用合成 cfg（只有 sglang.urls）——必须能携带 address_mode。
    cfg = {
        "sglang": {"urls": [SG_LAN, SG_WAN]},
        "address_mode": "wan",
    }
    assert router_mod._ordered_addresses(cfg, "sglang") == [SG_WAN]
    cfg2 = {"sglang": {"urls": [SG_LAN, SG_WAN]}}  # 无 address_mode 键 = auto
    assert router_mod._ordered_addresses(cfg2, "sglang") == [SG_LAN, SG_WAN]


# ── selfcheck：显示层选优尊重固定档 ────────────────────────────────


def test_select_and_mark_pinned_wins_over_faster() -> None:
    _clean_cache()
    rows = [_row(LAN, 120), _row(WAN, 8)]  # 外网快 15 倍
    assert selfcheck._select_and_mark("matrix", rows, WAN) == WAN
    assert selfcheck._working_cache().get("matrix") == WAN
    # 固定内网：慢也选内网（显示层跟固定值）
    assert selfcheck._select_and_mark("matrix", rows, LAN) == LAN
    assert selfcheck._working_cache().get("matrix") == LAN
    # 不传固定 → 最快胜出（现状语义）
    _clean_cache()
    assert selfcheck._select_and_mark("matrix", rows) == WAN


def test_select_and_mark_pinned_unreachable_falls_back() -> None:
    _clean_cache()
    # 固定地址本轮不可达 → 显示层回退最快可达（对用户诚实），
    # 但请求层仍拨固定地址并在失败时报错（两层不混）。
    rows = [_row(LAN, None, ok=False, http_ok=False), _row(WAN, 8)]
    assert selfcheck._select_and_mark("matrix", rows, LAN) == WAN
    # 全部不可达 → ""（现状语义）
    assert selfcheck._select_and_mark("matrix", [_row(LAN, None, ok=False, http_ok=False)], LAN) == ""


def test_refresh_effective_respects_pinned(monkeypatch) -> None:
    _clean_cache()
    rows = {
        "matrix": [_row(LAN, 120), _row(WAN, 8)],
        "controller": [],
        "sglang": [],
    }

    async def fake_test_addresses(*a, **k):
        return rows

    monkeypatch.setattr(selfcheck, "test_addresses", fake_test_addresses)
    loop = asyncio.new_event_loop()
    try:
        out = loop.run_until_complete(
            selfcheck.refresh_effective(_cfg("lan"), ("matrix",))
        )
    finally:
        loop.close()
    # 固定 LAN：生效显示 = LAN（即使 WAN 更快）
    assert out.get("matrix") == LAN
    assert selfcheck._working_cache().get("matrix") == LAN
