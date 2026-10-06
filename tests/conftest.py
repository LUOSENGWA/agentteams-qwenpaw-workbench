# v0.5.0-beta.14.7：测试间隔离——模块级缓存逐测清空。
#
# 背景：router.py 的模块级缓存（approval/KB/working 等）在测试间共享，
# T4a 引入 _kb_tree_cache/_kb_graph_cache 后，4 个 KB 树测试互污
# （单跑全过、全跑必挂的经典形态）。本 fixture 用「属性名后缀匹配」通用
# 清空，未来新增的 *_cache dict 自动纳入，避免每加一个缓存回来逐个修补。
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_kb_disk_cache(tmp_path, monkeypatch):
    """v0.5.0-beta.14.10：KB SWR 磁盘缓存目录重定向到本测 tmp——
 冷取/后台刷新路径会写盘，不隔离则真实 secret 目录被测试假数据
 （如 agent=big 的假 tree）污染，且可能被真实前端当 stale 值秒回。
 个别测试可再 monkeypatch _CACHE_DIR 覆盖（LIFO 后设生效）。"""
    from agentteams_connector import kb_cache

    monkeypatch.setattr(kb_cache, "_CACHE_DIR", tmp_path / "kb-cache")
    yield


@pytest.fixture(autouse=True)
def _clear_module_caches():
    try:
        from agentteams_connector import router as router_mod

        for name in dir(router_mod):
            if not name.endswith("_cache"):
                continue
            cache = getattr(router_mod, name, None)
            if isinstance(cache, dict):
                cache.clear()
    except Exception:  # noqa: BLE001 - 清理失败不影响被测目标
        pass
    yield
