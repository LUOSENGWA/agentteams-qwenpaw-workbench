# v0.5.0-beta.14.20：探测重试语义 + 验证地址排序回归。
#
# 用户 14.19 验收「保存配置和连通性测试又慢了 / Controller token 认证一直
# 转圈圈」的系统修复（非点补丁）：
#  ① _probe_with_retry：超时烧满（≥80% 预算）= 确定性死地址 → 不重试
#     （5M 外网线死地址成本 2×timeout → 1×timeout）；快失败（拒连/DNS）
#     仍重试（瞬断语义保留，14.12 用户「连通失败重试」诉求不变）。
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
