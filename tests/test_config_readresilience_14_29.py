# 「basic 密码要重新填 / 内外网变回自动」根治批的回归锁：
# 1) load_config 读失败重试（挂载层瞬时抖动不再误判文件损坏→默认值）
# 2) 防 wipe 守卫（污染内存基线 + 单字段补丁 不得抹掉磁盘上的地址/凭据）
# 3) credential_state（逐条凭据存在态自证——UI 显形「已存/只存用户名/无」）
import json

import pytest

from agentteams_connector import config as config_mod


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    cfg_dir = tmp_path / "agentteams-qwenpaw-workbench"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config_mod, "_SECRET_DIR", tmp_path)
    monkeypatch.setattr(config_mod, "_CONFIG_DIR", cfg_dir)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", cfg_dir / "config.json")
    config_mod._CONFIG_WRITE_AUDIT.clear()
    config_mod._last_load_state = "unknown"
    config_mod._config_read_cache.update(
        {"mtime_ns": None, "size": None, "data": None}
    )
    yield cfg_dir / "config.json"


def _seed(path, controller_urls, mode="wan"):
    path.write_text(
        json.dumps(
            {
                "address_mode": mode,
                "controller_urls": controller_urls,
                "controller_token": "stub-token-value",
            }
        ),
        encoding="utf-8",
    )


class _FlakyPath:
    """read_text 前 N 次抛 OSError（模拟 NFS/FUSE 瞬时读失败），之后真实读。"""

    def __init__(self, real, fail_times):
        self._real = real
        self._fails_left = fail_times

    def read_text(self, *a, **k):
        if self._fails_left > 0:
            self._fails_left -= 1
            raise OSError("simulated transient read failure")
        return self._real.read_text(*a, **k)

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_load_config_retries_transient_read_failure(tmp_config, monkeypatch):
    """瞬时读失败一次→重试成功→ok+真实数据（不再误判损坏→默认值）。"""
    _seed(tmp_config, ["https://wan:7113"], mode="wan")
    flaky = _FlakyPath(config_mod._CONFIG_PATH, fail_times=1)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", flaky)
    config_mod._config_read_cache.update({"mtime_ns": None, "size": None, "data": None})

    cfg = config_mod.load_config()
    assert config_mod._last_load_state == "ok"
    assert cfg["controller_urls"] == ["https://wan:7113"]
    assert cfg["address_mode"] == "wan"


def test_load_config_persistent_failure_read_error(tmp_config, monkeypatch):
    """连续两次都失败（文件在）→ read-error（14.30 状态细分：文件
    存在但读失败=假状态，GET 503/保存 409；原 defaults-fallback 语义
    由 fresh/read-error 接管）。"""
    _seed(tmp_config, ["https://wan:7113"], mode="wan")
    flaky = _FlakyPath(config_mod._CONFIG_PATH, fail_times=99)
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", flaky)
    config_mod._config_read_cache.update({"mtime_ns": None, "size": None, "data": None})

    cfg = config_mod.load_config()
    assert config_mod._last_load_state == "read-error"
    assert cfg["controller_urls"] == []


def test_update_config_wipe_blocked_on_poisoned_baseline(tmp_config, monkeypatch):
    """污染内存基线（load 返回无 controller_urls 的旧/默认态）+ 单字段补丁
    （只改 address_mode）→ 落盘前对照磁盘发现会抹掉 controller_urls → 拦截，
    磁盘原样保留（10/8 wipe 的机制封锁）。"""
    _seed(
        tmp_config,
        ["https://wan:7113"],
        mode="wan",
    )
    # 模拟 load_config 返回被污染的基线：无 controller_urls、模式 auto
    # （状态非 defaults-fallback，确保走的是防 wipe 守卫而非上游防呆）。
    poisoned = json.loads(json.dumps(config_mod._DEFAULTS))
    poisoned["controller_token"] = "stub-token-value"
    monkeypatch.setattr(config_mod, "load_config", lambda: poisoned)
    config_mod._last_load_state = "restored-from-backup"

    with pytest.raises(IOError):
        config_mod.update_config({"address_mode": "auto"}, source="t-wipe")

    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["controller_urls"] == ["https://wan:7113"]
    assert on_disk["address_mode"] == "wan"  # 未被污染写入


def test_update_config_wipe_allowed_when_patch_sets_family(tmp_config, monkeypatch):
    """补丁**显式**携带 controller_urls（用户意图整体换地址）→ 允许覆盖，
    不触发防 wipe（守卫只拦「未触碰却被丢」，不拦「用户主动改」）。"""
    _seed(tmp_config, ["https://wan:7113"], mode="wan")
    new_urls = ["https://newwan:9999"]
    monkeypatch.setattr(config_mod, "load_config", lambda: {
        "address_mode": "wan",
        "controller_urls": [],
        "controller_token": "stub-token-value",
    })
    config_mod._last_load_state = "ok"

    merged = config_mod.update_config(
        {"controller_urls": new_urls}, source="t-explicit"
    )
    assert merged["controller_urls"] == new_urls
    on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert on_disk["controller_urls"] == new_urls


def test_credential_state_values(tmp_config):
    """credential_state：saved/username-only/none 三态判定。"""
    _seed(
        tmp_config,
        [
            "http://lan:6866",  # 裸 URL → none
            {
                "url": "https://wan:7113",
                "auth": {"type": "basic", "username": "testuser", "password": "pw123"},
            },  # 完整 → saved
        ],
    )
    config_mod._config_read_cache.update({"mtime_ns": None, "size": None, "data": None})
    cfg = config_mod.load_config()
    st = config_mod.credential_state(cfg)
    assert st["controller_urls"] == ["none", "saved"]

    # username-only：只存了用户名、密码缺失
    cfg2 = {
        "matrix_homeservers": [],
        "controller_urls": [
            {
                "url": "https://wan:7113",
                "auth": {"type": "basic", "username": "testuser", "password": ""},
            }
        ],
        "gateway_admin_urls": [],
        "sglang": {"enabled": False, "urls": []},
        "admin_password": "",
    }
    st2 = config_mod.credential_state(cfg2)
    assert st2["controller_urls"] == ["username-only"]
    assert st2["admin_password"] == "none"


def test_get_config_exposes_credential_state(tmp_config, monkeypatch):
    """GET /config 带 credential_state（redact 前对原始态计算）。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    _seed(
        tmp_config,
        [
            "http://lan:6866",
            {
                "url": "https://wan:7113",
                "auth": {"type": "basic", "username": "testuser", "password": "pw123"},
            },
        ],
    )
    config_mod._config_read_cache.update({"mtime_ns": None, "size": None, "data": None})

    from agentteams_connector.routers.config_api import build_config_router

    app = FastAPI()
    app.include_router(build_config_router())
    client = TestClient(app)
    out = client.get("/config").json()
    assert "credential_state" in out
    assert out["credential_state"]["controller_urls"] == ["none", "saved"]
    # 脱敏仍生效（credential_state 只暴露有无，不泄露值）
    assert out["controller_urls"][1]["auth"]["password"] == "***"
