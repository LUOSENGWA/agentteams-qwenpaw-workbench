# v0.5.0-beta.14.7：测试间隔离——模块级缓存逐测清空。
#
# 背景：router.py 的模块级缓存（approval/KB/working 等）在测试间共享，
# T4a 引入 _kb_tree_cache/_kb_graph_cache 后，4 个 KB 树测试互污
# （单跑全过、全跑必挂的经典形态）。本 fixture 用「属性名后缀匹配」通用
# 清空，未来新增的 *_cache dict 自动纳入，避免每加一个缓存回来打地鼠。
from __future__ import annotations

import pytest


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
