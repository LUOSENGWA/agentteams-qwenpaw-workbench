# 测试间隔离——模块级缓存逐测清空。
# 背景：router.py 的模块级缓存（approval/KB/working 等）在测试间共享，
# T4a 引入 _kb_tree_cache/_kb_graph_cache 后，4 个 KB 树测试互污
# （单跑全过、全跑必挂的经典形态）。本 fixture 用「属性名后缀匹配」通用
# 清空，未来新增的 *_cache dict 自动纳入，避免每加一个缓存回来逐个修补。
# build_router 按域拆到 routers/ 包后，
# 各域模块经 `from ..router import X` 在自己的命名空间持有共享名的独立
# 引用——rebind 型 monkeypatch（把 router 模块属性整体替换）对域 handler
# 侧不可见，须同步 rebind 各域模块。patch_shared_name 统一处理。
from __future__ import annotations

import importlib

import pytest

# build_router 的 8 个域子路由模块（rebind 同步用；hasattr
# 过滤，域未持有该属性时跳过）。
_DOMAIN_MODULES = (
    "agentteams_connector.routers.status_api",
    "agentteams_connector.routers.teams_api",
    "agentteams_connector.routers.config_api",
    "agentteams_connector.routers.gateway_api",
    "agentteams_connector.routers.matrix_api",
    "agentteams_connector.routers.kb_api",
    "agentteams_connector.routers.live_api",
    "agentteams_connector.routers.approval_api",
)


def patch_shared_name(monkeypatch, name, value):
    """rebind router 模块共享名并同步到持有该属性的各域模块。

    拆分前 handler 与测试同处 router 模块命名空间，rebind router 属性即可；
    拆分后域 handler 经 from-import 持有自己的绑定，必须逐模块 rebind，
    否则 patch 失效 → 测试走真实拨号（挂死/误断言）。"""
    from agentteams_connector import router as router_mod

    monkeypatch.setattr(router_mod, name, value)
    for mod_name in _DOMAIN_MODULES:
        mod = importlib.import_module(mod_name)
        if hasattr(mod, name):
            monkeypatch.setattr(mod, name, value)


@pytest.fixture(autouse=True)
def _isolate_kb_disk_cache(tmp_path, monkeypatch):
    """KB SWR 磁盘缓存目录重定向到本测 tmp——
 冷取/后台刷新路径会写盘，不隔离则真实 secret 目录被测试假数据
 （如 agent=big 的假 tree）污染，且可能被真实前端当 stale 值秒回。
 个别测试可再 monkeypatch _CACHE_DIR 覆盖（LIFO 后设生效）。"""
    from agentteams_connector import kb_cache

    monkeypatch.setattr(kb_cache, "_CACHE_DIR", tmp_path / "kb-cache")
    yield


@pytest.fixture(autouse=True)
def _isolate_real_config(tmp_path, monkeypatch):
    """配置主文件/secret 目录重定向到本测 tmp——与 KB 缓存同款隔离。

 背景（10/9 16:39:49 实案）：test_update_config_address_mode 历史上
 无隔离直调 update_config，每次全量跑对真实 config 连写三次
 （wan→auto→auto），把用户「固定外网」静默打回 auto——10/8 之后
 一系列「没人动过又变回自动」的磁盘 wan→auto 翻转均为本测试所写
 （pytest 进程日志被捕获、审计环随进程消失，故主日志零痕迹）。
 个别测试可再 monkeypatch _CONFIG_PATH 覆盖（LIFO 后设生效）。"""
    from agentteams_connector import config as config_mod

    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    yield


@pytest.fixture(scope="session", autouse=True)
def _real_config_sentinel():
    """session 哨兵：真实 config 文件在整个测试运行期间必须零变化
 （mtime+sha256）。任何测试再写真实 secret 目录 → 全量跑失败并指名
 实案（10/9 16:39:49 回归锁——与 _isolate_real_config 双保险：
 前者按路径挡，本哨兵按结果挡）。"""
    import hashlib
    import os

    from agentteams_connector import config as config_mod

    p = config_mod._CONFIG_PATH  # session 启动时的真实路径（早于任何测试重定向）

    def _snap():
        try:
            st = os.stat(p)
            h = hashlib.sha256(p.read_bytes()).hexdigest()
            return (st.st_mtime_ns, h)
        except OSError:
            return None

    before = _snap()
    yield
    after = _snap()
    assert before == after, (
        f"真实 config 文件在测试运行期间被修改（{p}）——测试禁止写真实 secret 目录"
    )


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
