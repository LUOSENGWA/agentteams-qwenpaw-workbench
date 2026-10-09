# -*- coding: utf-8 -*-
"""连通性测试并行化回归（/）。

连通性测试很慢。根因：``test_addresses`` 里三类地址
（matrix / controller / sglang）原先是**三段串行** ``await asyncio.gather``，
每段内部才并行。WAN 上每类都含一个不可达的内网地址吃满
``(timeout + 重试间隔 + timeout)``，三段相加≈3×12.5s=37.5s。

 修复：三段 ``gather`` 嵌套进同一个外层 ``asyncio.gather`` = 全并行，
总时长 = 最慢单地址。本测试锁住该不变式：三类地址各一个、每个探测耗时
≈T，则总耗时 ≈T（而非 3T）。

护栏：
- 只测并行结构，不碰逐地址语义（ok/ms/auth/重试）——那些由既有测试覆盖。
- 用 ``asyncio.sleep(T)`` 模拟探测延迟，monkeypatch 三个底层 probe，
 不发起真实网络。
- 同步驱动（``asyncio.run``）——本仓测试不依赖 pytest-asyncio（与既有
 test_dial_gate_14_6 / test_perf_save_bg_14_12 同款）。
"""
from __future__ import annotations

import asyncio
import time

from agentteams_connector import selfcheck


def _slow_probe(delay: float):
    """sleep delay 秒后返回 ok 的 fake probe（签名对齐各底层 probe）。"""

    async def _probe(*a, **k) -> dict:
        await asyncio.sleep(delay)
        return {"ok": True, "http_ok": True, "ms": int(delay * 1000),
                "detail": "fake"}

    return _probe


def test_three_categories_probe_in_parallel(monkeypatch) -> None:
    """三类地址各一、每类探测 T 秒 → 总耗时≈T（并行），而非 3T（串行）。"""
    t = 0.35  # 每个探测的模拟延迟

    monkeypatch.setattr(selfcheck, "_probe_matrix", _slow_probe(t))
    monkeypatch.setattr(selfcheck, "_probe_controller", _slow_probe(t))
    monkeypatch.setattr(selfcheck, "_probe_sglang", _slow_probe(t))

    async def main() -> float:
        t0 = time.monotonic()
        res = await selfcheck.test_addresses(
            matrix_urls=["http://10.0.0.1:6867"],
            controller_urls=["http://10.0.0.1:8090"],
            sglang_urls=["http://10.0.0.1:30000"],
        )
        elapsed = time.monotonic() - t0
        # 结果完整性：三类各返回一行。
        assert len(res["matrix"]) == 1
        assert len(res["controller"]) == 1
        assert len(res["sglang"]) == 1
        assert all(r["ok"] for r in
                   res["matrix"] + res["controller"] + res["sglang"])
        return elapsed

    elapsed = asyncio.run(main())
    # 并行不变式：总耗时 ≈ 单个探测延迟 T，绝不应接近串行 3T。
    # 上限 2.2T（远小于串行 3T），下限 0.9T（至少跑了一个探测）。
    assert elapsed < t * 2.2, (
        f"三类地址疑似串行：elapsed={elapsed:.3f}s 接近 3T={3 * t:.3f}s "
        f"（并行应≈T={t:.3f}s）"
    )
    assert elapsed >= t * 0.9, (
        f"elapsed={elapsed:.3f}s 小于单探测延迟，探针可能未真正执行"
    )


def test_empty_category_does_not_break_gather(monkeypatch) -> None:
    """某类地址为空（如未配 SGLang）时，外层 gather 不崩、其余类正常。"""

    async def _ok(*a, **k) -> dict:
        return {"ok": True, "http_ok": True, "ms": 5, "detail": "fake"}

    monkeypatch.setattr(selfcheck, "_probe_matrix", _ok)
    monkeypatch.setattr(selfcheck, "_probe_controller", _ok)
    monkeypatch.setattr(selfcheck, "_probe_sglang", _ok)

    async def main():
        return await selfcheck.test_addresses(
            matrix_urls=["http://10.0.0.1:6867"],
            controller_urls=["http://10.0.0.1:8090"],
            sglang_urls=[],  # 未配 SGLang
        )

    res = asyncio.run(main())
    assert len(res["matrix"]) == 1
    assert len(res["controller"]) == 1
    assert res["sglang"] is None  # 空列表 → None（既有形态）


def test_default_timeout_is_3s() -> None:
    """test_addresses 的 timeout 默认值 = 3.0s。

 演进：6.0→4.0（死地址上限收紧）→3.0（保存/连通性慢修——
 可达地址 <1s 不受影响，死地址再配
 _probe_with_retry 超时不重试 = 单程成本）。"""
    import inspect

    sig = inspect.signature(selfcheck.test_addresses)
    default = sig.parameters["timeout"].default
    assert default == 3.0, (
        f"test_addresses timeout 默认值 = {default}，期望 3.0"
    )
