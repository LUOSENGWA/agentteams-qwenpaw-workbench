# 探测重试语义 + 验证地址排序回归。
# 「保存配置和连通性测试又慢了 / Controller token 认证一直转圈圈」
# 的系统修复（非点补丁）：
#  ① _probe_with_retry：超时烧满（≥80% 预算）= 确定性死地址 → 不重试
#     （5M 外网线死地址成本 2×timeout → 1×timeout）；快失败（拒连/DNS）
#     仍重试（瞬断语义保留，「连通失败重试」诉求不变）。
#  ② verify-admin 路径 B：_ordered_ctl_urls——working-cache（最后已知可达）
#     前置，外网场景 LAN 死地址不再烧首槽。
#  ③ test_addresses 默认 timeout 6→4（14.16）→3s（本批）。
from __future__ import annotations

import asyncio
import time

import pytest

from agentteams_connector import selfcheck
from agentteams_connector import router as router_mod


# ── ① _probe_with_retry ─────────────────────────────────────────────


class _FailProbe:
    """可配置延迟/结果的假 probe。"""

    def __init__(self, delay_s: float, result: dict):
        self.delay_s = delay_s
        self.result = result
        self.calls = 0

    async def __call__(self, url, token, timeout):
        self.calls += 1
        await asyncio.sleep(self.delay_s)
        return dict(self.result)


@pytest.mark.asyncio
async def test_retry_skipped_on_timeout_burn() -> None:
    """烧满超时（1.0s 延迟 vs 1.0s 预算 ≥80%）→ 只拨一次。"""
    probe = _FailProbe(1.0, {"ok": False, "http_ok": False, "ms": None})
    out = await selfcheck._probe_with_retry(probe, "http://x", "", 1.0)
    assert probe.calls == 1, f"超时烧满不应重试，实际拨 {probe.calls} 次"
    assert out["ok"] is False


@pytest.mark.asyncio
async def test_retry_kept_on_fast_failure() -> None:
    """快失败（拒连，0.05s << 80%×3s）→ 仍重试一次（瞬断语义）。"""
    probe = _FailProbe(0.05, {"ok": False, "http_ok": False, "ms": None})
    out = await selfcheck._probe_with_retry(probe, "http://x", "", 3.0)
    assert probe.calls == 2, f"快失败应重试一次，实际拨 {probe.calls} 次"
    assert out["ok"] is False


@pytest.mark.asyncio
async def test_no_retry_when_ok() -> None:
    """已连通（含 401）不重试——14.12 既有语义不回归。"""
    probe = _FailProbe(0.0, {"ok": True, "http_ok": True, "ms": 5})
    out = await selfcheck._probe_with_retry(probe, "http://x", "", 3.0)
    assert probe.calls == 1
    assert out["ok"] is True


# ── ② _ordered_ctl_urls（working-cache 前置）────────────────────────


def test_ordered_ctl_urls_cache_first(monkeypatch) -> None:
    cfg = {
        "controller_urls": ["http://lan:8080/", "http://wan:8080"],
    }
    monkeypatch.setattr(
        router_mod, "_working_cache", {"controller": "http://wan:8080"},
    )
    out = router_mod._ordered_ctl_urls(cfg)
    assert out[0] == "http://wan:8080", "working-cache 地址应前置"
    assert out == ["http://wan:8080", "http://lan:8080"]


def test_ordered_ctl_urls_no_cache_keeps_order(monkeypatch) -> None:
    cfg = {
        "controller_urls": ["http://lan:8080/", "http://wan:8080"],
    }
    monkeypatch.setattr(router_mod, "_working_cache", {})
    out = router_mod._ordered_ctl_urls(cfg)
    assert out == ["http://lan:8080", "http://wan:8080"]


def test_ordered_ctl_urls_cache_not_in_list_ignored(monkeypatch) -> None:
    """cache 指向的地址已不在列表（用户删了）→ 忽略，不注入幽灵地址。"""
    cfg = {"controller_urls": ["http://lan:8080/"]}
    monkeypatch.setattr(
        router_mod, "_working_cache", {"controller": "http://gone:8080"},
    )
    out = router_mod._ordered_ctl_urls(cfg)
    assert out == ["http://lan:8080"]


def test_ordered_ctl_urls_dict_entries_wan_basic(monkeypatch) -> None:
    """回归：controller_urls 的 WAN 条目常态=带 basic
 凭据的 dict（{url, auth}）——旧版直接 u.strip() 对 dict 抛 AttributeError
 （verify-admin 500 真根因；14.20 单测只覆盖 str 形态漏网）。
 现走 _address_list 归一化：dict→url、尾斜杠去除、顺序保留。"""
    cfg = {
        "controller_urls": [
            "http://lan:8080/",
            {
                "url": "https://ctlr.example.com:7113",
                "auth": {"type": "basic", "username": "u", "password": "p"},
            },
        ],
    }
    monkeypatch.setattr(router_mod, "_working_cache", {})
    out = router_mod._ordered_ctl_urls(cfg)
    assert out == [
        "http://lan:8080",
        "https://ctlr.example.com:7113",
    ], f"dict 条目应归一化为 url（去尾斜杠、保序），实际 {out}"


def test_ordered_ctl_urls_dict_entry_cache_first(monkeypatch) -> None:
    """dict（WAN）地址命中 working-cache → 前置（外网场景常态=首槽活地址）。"""
    cfg = {
        "controller_urls": [
            "http://lan:8080/",
            {"url": "https://ctlr.example.com:7113/"},
        ],
    }
    monkeypatch.setattr(
        router_mod, "_working_cache", {"controller": "https://ctlr.example.com:7113"},
    )
    out = router_mod._ordered_ctl_urls(cfg)
    assert out == ["https://ctlr.example.com:7113", "http://lan:8080"]


# ── ③ 连通性测试墙钟：探测段与诊断段各自并行（族间不串行）────────────


@pytest.mark.asyncio
async def test_dead_address_wall_clock_bounded() -> None:
    """4 族各 1 死地址（3s 超时）+ with_diag：墙钟上界 ≈ 2×timeout
 （探测段 max + 诊断段 max）。旧版族间串行 _attach → 4×timeout 诊断段
 （实测 12s）；2 死地址旧版 9s。上界取 4.5×timeout=13.5s 防回归到
 串行形态（串行=12s 起步，再加探测段必超）。"""
    dead = "http://10.255.255.1"
    t0 = time.monotonic()
    res = await selfcheck.test_addresses(
        [f"{dead}:8008"], [f"{dead}:8080"], [f"{dead}:8000"], "",
        timeout=3.0, with_diag=True, gateway_urls=[f"{dead}:8001"],
    )
    wall = time.monotonic() - t0
    assert wall < 4.5 * 3.0, f"墙钟 {wall:.1f}s 超上界——族间诊断疑似回退串行"
    # 形态回归：sglang/gateway 有地址=列表，空族语义保持
    assert res["matrix"] and res["controller"] and res["sglang"] and res["gateway"]
    assert all(row["ok"] is False for row in res["matrix"] + res["controller"])


@pytest.mark.asyncio
async def test_empty_families_keep_shape() -> None:
    """无 sglang/gateway 配置 → None/[] 形态不回归（前端依赖）。"""
    res = await selfcheck.test_addresses(
        ["http://127.0.0.1:9"], [], [], "", timeout=1.0, with_diag=True,
    )
    assert res["sglang"] is None
    assert res["gateway"] == []
    assert res["matrix"] and res["matrix"][0]["ok"] is False
