# 14.31「fresh 误判洞」锁（10/9 16:15 实案回归）：
# 14.30 的 fresh/read-error 判别用 Path.exists()——CPython 对
# 「stat 不出来」的路径一律返回 False（"doesn't exist or can't be
# accessed"）。挂载层瞬时故障（EMFILE/EIO：virtiofsd fd 耗尽、DD
# 重启后冷挂载）→ exists()=False → 误判「文件从未存在」→ fresh →
# GET 200 + 可编辑默认值表单（自动+空密码）——用户照单保存=默认值
# 盖盘（与 10/8 wipe 同链，只是入口从 GET 假成功变成 fresh 假身份）。
# 14.31 按错误类型判别：FileNotFoundError=真不存在（fresh）；
# 其他 OSError=存在性未知（read-error → 503，前端重试链自愈合）。
import errno
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentteams_connector import config as config_mod
from agentteams_connector import selfcheck as selfcheck_mod


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


@pytest.fixture()
def client(tmp_config, monkeypatch):
    async def noop_probe(cfg, kinds=("matrix", "controller")):
        return {}

    monkeypatch.setattr(selfcheck_mod, "refresh_effective", noop_probe)
    from agentteams_connector.router import build_router

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app)


def _seed(path, mode="wan"):
    path.write_text(
        json.dumps(
            {
                "address_mode": mode,
                "controller_urls": [
                    {
                        "url": "https://wan:7113",
                        "auth": {
                            "type": "basic",
                            "username": "u",
                            "password": "secret-pw",
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def _install_emfile(monkeypatch, sample_path):
    """stat/read_text 全量 EMFILE（模拟挂载层 fd 耗尽）。"""

    def fake_stat(self, *a, **k):
        raise OSError(errno.EMFILE, "Too many open files")

    def fake_read(self, *a, **k):
        raise OSError(errno.EMFILE, "Too many open files")

    monkeypatch.setattr(type(sample_path), "stat", fake_stat)
    monkeypatch.setattr(type(sample_path), "read_text", fake_read)


class TestPresenceClassification:
    def test_emfile_everywhere_is_read_error_not_fresh(self, tmp_config, monkeypatch):
        """10/9 16:15 实案：stat/read/bak 全 EMFILE → read-error（非 fresh）。"""
        _seed(tmp_config)
        bak = tmp_config.parent / "config.bak.json"
        bak.write_text(tmp_config.read_text(encoding="utf-8"), encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        _install_emfile(monkeypatch, tmp_config)
        cfg = config_mod.load_config()
        assert config_mod.config_load_state() == "read-error"
        assert cfg["address_mode"] == "auto"  # 默认值兜底（内存，不冒充真实）

    def test_emfile_get_returns_503_not_200_defaults(self, client, tmp_config, monkeypatch):
        """EMFILE → GET 503：默认值绝不进用户决策面（16:15 洞的 HTTP 封口）。"""
        _seed(tmp_config)
        bak = tmp_config.parent / "config.bak.json"
        bak.write_text(tmp_config.read_text(encoding="utf-8"), encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        _install_emfile(monkeypatch, tmp_config)
        resp = client.get("/config")
        assert resp.status_code == 503

    def test_true_absent_is_still_fresh(self, tmp_config):
        """FileNotFoundError（真不存在）→ fresh 不受本修影响（首启不被误伤）。"""
        assert not tmp_config.exists()
        config_mod.load_config()
        assert config_mod.config_load_state() == "fresh"

    def test_stat_ok_read_emfile_bak_missing_is_read_error(self, tmp_config, monkeypatch):
        """stat 正常（文件在）但 read EMFILE + 无备份 → read-error（present 分支）。"""
        _seed(tmp_config)
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )

        def fake_read(self, *a, **k):
            raise OSError(errno.EMFILE, "Too many open files")

        monkeypatch.setattr(type(tmp_config), "read_text", fake_read)
        config_mod.load_config()
        assert config_mod.config_load_state() == "read-error"

    def test_emfile_then_recovery_self_heals(self, tmp_config, monkeypatch):
        """EMFILE 一次失败后挂载恢复 → 下一次 load 自愈（ok+真实数据）。"""
        _seed(tmp_config)
        bak = tmp_config.parent / "config.bak.json"
        bak.write_text(tmp_config.read_text(encoding="utf-8"), encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        _install_emfile(monkeypatch, tmp_config)
        config_mod.load_config()
        assert config_mod.config_load_state() == "read-error"
        # 挂载恢复——只还原 stat/read_text（不能 monkeypatch.undo()，
        # 那会连 fixture 的 _CONFIG_PATH 补丁一起撤掉）
        cls = type(tmp_config)
        import pathlib as _pl

        monkeypatch.setattr(cls, "stat", _pl.Path.stat, raising=False)
        monkeypatch.setattr(cls, "read_text", _pl.Path.read_text, raising=False)
        cfg = config_mod.load_config()
        assert config_mod.config_load_state() == "ok"
        assert cfg["address_mode"] == "wan"
        assert cfg["controller_urls"][0]["auth"]["password"] == "secret-pw"
