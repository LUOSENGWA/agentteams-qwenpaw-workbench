# 14.30「默认值假成功」语义堵链批的回归锁（10/8 wipe 根因链封口）：
# 10/8 机制 = 读失败→GET 200 默认值（假成功）→前端 ready→保存
# （force_persist 自动携带）→全默认值盖盘。本批在链上三点封口：
#   a) 状态细分 fresh（首启合法）/ read-error（文件在但读失败=假状态）
#   b) GET /config：read-error → 503（默认值永远进不了用户决策面）
#   c) PUT /config：read-error → 409（force_persist 不豁免）；
#      无 config_rev + 磁盘有文件 → 409（默认表单/脚本/旧标签页堵死）
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


class TestStateRefinement:
    def test_fresh_when_no_file_no_backup(self, tmp_config):
        """主文件从未存在（首启）→ state=fresh（合法初始态，可保存）。"""
        assert not tmp_config.exists()
        cfg = config_mod.load_config()
        assert config_mod.config_load_state() == "fresh"
        assert cfg["controller_urls"] == []

    def test_read_error_when_file_corrupt_no_backup(self, tmp_config):
        """文件存在但损坏 + 无备份 → state=read-error（假状态，不可保存）。"""
        tmp_config.write_text("{not valid json", encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        cfg = config_mod.load_config()
        assert config_mod.config_load_state() == "read-error"
        assert cfg["controller_urls"] == []  # 默认值兜底（内存）

    def test_restored_from_backup_beats_read_error(self, tmp_config):
        """文件损坏但有备份 → 备份自愈优先（restored-from-backup，200 语义）。"""
        bak = tmp_config.parent / "config.bak.json"
        _seed(tmp_config)
        bak.write_text(tmp_config.read_text(encoding="utf-8"), encoding="utf-8")
        tmp_config.write_text("{broken", encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        config_mod.load_config()
        assert config_mod.config_load_state() == "restored-from-backup"


class TestGetSemantics:
    def test_get_503_on_read_error(self, client, tmp_config):
        """read-error → 503：绝不 200 默认值（10/8 wipe 链堵点 a）。"""
        tmp_config.write_text("{not valid json", encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        config_mod.load_config()
        resp = client.get("/config")
        assert resp.status_code == 503
        assert "暂不可读" in resp.json()["detail"]

    def test_get_200_fresh_exposes_state(self, client, tmp_config):
        """首启（无文件）→ 200 + state=fresh（首启流程不被 503 误伤）。"""
        config_mod.load_config()
        resp = client.get("/config")
        assert resp.status_code == 200
        assert resp.json()["config_health"]["state"] == "fresh"


class TestPutGuards:
    def test_put_409_read_error_even_with_force(self, client, tmp_config):
        """read-error → 409（handler 层），force_persist 不豁免。"""
        tmp_config.write_text("{not valid json", encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        config_mod.load_config()
        resp = client.put(
            "/config",
            json={"config": {"address_mode": "wan"}, "force_persist": True},
        )
        assert resp.status_code == 409
        on_disk = tmp_config.read_text(encoding="utf-8")
        assert on_disk == "{not valid json"  # 磁盘原样，未被默认值覆盖

    def test_put_409_no_rev_when_file_exists(self, client, tmp_config):
        """无 config_rev + 磁盘有文件 → 409（默认表单/脚本/旧标签页堵死）。"""
        _seed(tmp_config)
        config_mod.load_config()
        resp = client.put(
            "/config",
            json={
                "config": {
                    "address_mode": "auto",
                    "controller_urls": [],  # 10/8 wipe 的完整默认表单形态
                }
            },
        )
        assert resp.status_code == 409
        on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
        assert on_disk["address_mode"] == "wan"  # 未被盖
        assert on_disk["controller_urls"][0]["auth"]["password"] == "secret-pw"

    def test_put_200_no_rev_fresh_first_write(self, client, tmp_config):
        """无 rev + 磁盘无文件（首启首写）→ 放行（合法首写，非覆盖）。"""
        config_mod.load_config()  # fresh
        resp = client.put(
            "/config",
            json={
                "config": {
                    "address_mode": "wan",
                    "controller_urls": ["https://first:7113"],
                }
            },
        )
        assert resp.status_code == 200
        on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
        assert on_disk["controller_urls"] == ["https://first:7113"]

    def test_put_200_with_rev_regression(self, client, tmp_config):
        """正常保存（带 rev）→ 200（回归：正常路径不受影响）。"""
        _seed(tmp_config)
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        config_mod.load_config()
        rev = config_mod.config_rev()
        assert rev is not None
        resp = client.put(
            "/config",
            json={
                "config": {"address_mode": "lan"},
                "config_rev": rev,
            },
        )
        assert resp.status_code == 200
        on_disk = json.loads(tmp_config.read_text(encoding="utf-8"))
        assert on_disk["address_mode"] == "lan"


class TestUpdateConfigDefense:
    def test_update_config_refused_read_error(self, tmp_config):
        """config.py 层纵深：read-error → IOError（任何调用路径兜住）。"""
        tmp_config.write_text("{not valid json", encoding="utf-8")
        config_mod._config_read_cache.update(
            {"mtime_ns": None, "size": None, "data": None}
        )
        config_mod.load_config()
        assert config_mod.config_load_state() == "read-error"
        with pytest.raises(IOError):
            config_mod.update_config(
                {"address_mode": "auto"},
                source="t-defense",
                force_persist=True,  # 显式恢复也不豁免
            )
        assert tmp_config.read_text(encoding="utf-8") == "{not valid json"
