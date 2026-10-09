# -*- coding: utf-8 -*-
"""地址覆盖凭据（WAN Basic 门 / API key 门）单测。

覆盖：
- 地址条目解析（str | {url, auth?} 归一化）
- 凭据匹配（url rstrip 口径 / 无效 auth 降级）
- headers_with_auth（basic base64 / bearer / 无 auth 原样）
- merge_address_entries（位置合并 / 显式降级 / *** 继承 / 空 url 丢弃）
- redact（password/token 脱敏，username 保留）
- update_config 集成（PUT 语义全链路）
- _classify_challenge（401 三看分诊：Basic 质询 / 空 body key 门 / JSON token 拒）
"""

import base64

import pytest

from agentteams_connector import config as config_mod
from agentteams_connector.selfcheck import _classify_challenge, _challenge_hint


# ── 地址条目解析 ────────────────────────────────────────────────────────────


def test_address_url_str_passthrough():
    assert config_mod.address_url("http://a:1") == "http://a:1"
    assert config_mod.address_url("  http://a:1  ") == "http://a:1"
    assert config_mod.address_url("") == ""
    assert config_mod.address_url(None) == ""
    assert config_mod.address_url(123) == ""


def test_address_url_dict():
    assert config_mod.address_url({"url": "https://b:2"}) == "https://b:2"
    assert config_mod.address_url({"url": ""}) == ""
    assert config_mod.address_url({"auth": {"type": "basic"}}) == ""


# ── 凭据匹配 ────────────────────────────────────────────────────────────────


def test_auth_for_url_basic_hit():
    entries = ["http://lan", {"url": "https://wan/", "auth": {"type": "basic", "username": "u", "password": "p"}}]
    # rstrip 口径：查时不带尾斜杠也要命中
    got = config_mod.auth_for_url(entries, "https://wan")
    assert got == {"type": "basic", "username": "u", "password": "p"}


def test_auth_for_url_bearer_hit():
    entries = [{"url": "https://higress:7113", "auth": {"type": "bearer", "token": "k1"}}]
    assert config_mod.auth_for_url(entries, "https://higress:7113/") == {"type": "bearer", "token": "k1"}


def test_auth_for_url_miss_or_invalid():
    entries = ["https://a"]
    assert config_mod.auth_for_url(entries, "https://a") is None
    # 缺凭据 = 无效 → None（= 用服务原生认证）
    entries = [{"url": "https://a", "auth": {"type": "basic", "username": "u", "password": ""}}]
    assert config_mod.auth_for_url(entries, "https://a") is None
    entries = [{"url": "https://a", "auth": {"type": "weird", "x": 1}}]
    assert config_mod.auth_for_url(entries, "https://a") is None
    # *** 占位符 = 无效
    entries = [{"url": "https://a", "auth": {"type": "bearer", "token": "***"}}]
    assert config_mod.auth_for_url(entries, "https://a") is None


def test_headers_with_auth_basic_b64():
    h = config_mod.headers_with_auth(
        {"type": "basic", "username": "testuser", "password": "secret"},
        {"X-Keep": "1"},
    )
    expect = "Basic " + base64.b64encode(b"testuser:secret").decode("ascii")
    assert h["Authorization"] == expect
    assert h["X-Keep"] == "1"


def test_headers_with_auth_bearer_and_none():
    h = config_mod.headers_with_auth({"type": "bearer", "token": "k"}, {})
    assert h["Authorization"] == "Bearer k"
    orig = {"Authorization": "Bearer native"}
    assert config_mod.headers_with_auth(None, orig) == orig
    # 不改动入参（新 dict）
    config_mod.headers_with_auth({"type": "bearer", "token": "k"}, orig)
    assert orig == {"Authorization": "Bearer native"}


def test_build_auth_map_skips_invalid():
    entries = [
        "http://plain",
        {"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "p"}},
        {"url": "https://bad", "auth": {"type": "basic", "username": "u"}},
        {"url": "", "auth": {"type": "bearer", "token": "t"}},
    ]
    m = config_mod.build_auth_map(entries)
    assert list(m.keys()) == ["https://w"]


# ── merge_address_entries（PUT /config 合并语义）────────────────────────────


def test_merge_new_str_downgrades_auth():
    old = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "p"}}]
    # 新条目=纯字符串 → 显式降级：凭据丢弃
    assert config_mod.merge_address_entries(old, ["https://w"]) == ["https://w"]


def test_merge_inherit_credentials_on_asterisk():
    old = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "p"}}]
    # 脱敏回传 *** → 保持旧值
    new = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "***"}}]
    got = config_mod.merge_address_entries(old, new)
    assert got == [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "p"}}]


def test_merge_partial_inherit_password():
    old = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "old"}}]
    # 用户只改 username（password 空=保持旧值）
    new = [{"url": "https://w", "auth": {"type": "basic", "username": "newuser", "password": ""}}]
    got = config_mod.merge_address_entries(old, new)
    assert got == [{"url": "https://w", "auth": {"type": "basic", "username": "newuser", "password": "old"}}]


def test_merge_new_password_wins():
    old = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "old"}}]
    new = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "newpass"}}]
    got = config_mod.merge_address_entries(old, new)
    assert got[0]["auth"]["password"] == "newpass"


def test_merge_bearer_and_clear():
    new = [{"url": "https://w", "auth": {"type": "bearer", "token": "k1"}}]
    got = config_mod.merge_address_entries([], new)
    assert got == [{"url": "https://w", "auth": {"type": "bearer", "token": "k1"}}]
    # auth type=none → 显式清除凭据 → 字符串条目
    new = [{"url": "https://w", "auth": {"type": "none"}}]
    assert config_mod.merge_address_entries(old := got, new) == ["https://w"]


def test_merge_drops_empty_url_and_old_tail():
    old = ["http://a", "http://b"]
    new = ["http://a", "", "http://c"]
    # 空 url 丢弃；旧表更长的尾部……这里 new 更长（c 无旧凭据可继承，纯 URL 保留）
    assert config_mod.merge_address_entries(old, new) == ["http://a", "http://c"]


def test_merge_invalid_auth_falls_back_to_str():
    # 类型选了但凭据缺（且无旧值可继承）→ 降级字符串，诚实不装
    new = [{"url": "https://w", "auth": {"type": "basic", "username": "u", "password": ""}}]
    assert config_mod.merge_address_entries([], new) == ["https://w"]


# ── redact ──────────────────────────────────────────────────────────────────


def test_redact_masks_entry_secrets():
    raw = {
        "matrix_homeservers": [
            "http://lan",
            {"url": "https://w", "auth": {"type": "basic", "username": "u", "password": "p"}},
        ],
        "controller_urls": [{"url": "https://cw", "auth": {"type": "bearer", "token": "k"}}],
        "sglang": {"enabled": True, "urls": [{"url": "https://s", "auth": {"type": "bearer", "token": "sk"}}]},
        "controller_token": "tok",
    }
    out = config_mod.redact(raw)
    assert out["matrix_homeservers"][0] == "http://lan"
    assert out["matrix_homeservers"][1]["auth"] == {"type": "basic", "username": "u", "password": "***"}
    assert out["controller_urls"][0]["auth"] == {"type": "bearer", "token": "***"}
    assert out["sglang"]["urls"][0]["auth"] == {"type": "bearer", "token": "***"}
    assert out["controller_token"] == "***"


# ── _classify_challenge（401 三看分诊，#728）────────────────────────────────


class _FakeResp:
    def __init__(self, status, headers=None, text=""):
        self.status_code = status
        self.headers = headers or {}
        self.text = text


def test_challenge_basic_gate():
    # 8/23 Caddy 实锤形态：WWW-Authenticate: Basic + 空 body
    r = _FakeResp(401, {"www-authenticate": "Basic realm=restricted"}, "")
    assert _classify_challenge(r) == "basic"


def test_challenge_key_gate_empty_body():
 # higress 实锤形态：无质询头 + 空 body
    r = _FakeResp(401, {}, "")
    assert _classify_challenge(r) == "key"


def test_challenge_token_reject_json_body():
    # Controller 服务层：401 + JSON M_ 错误
    r = _FakeResp(401, {}, '{"errcode": 401, "error": "M_UNKNOWN_TOKEN"}')
    assert _classify_challenge(r) == "token"


def test_challenge_403_and_200():
    assert _classify_challenge(_FakeResp(403)) == "forbidden"
    assert _classify_challenge(_FakeResp(200)) == ""


def test_challenge_hint_actionable():
    assert "设置页" in _challenge_hint("basic", has_auth=False)
    assert "被网关拒绝" in _challenge_hint("basic", has_auth=True)
    assert "API key" in _challenge_hint("key", has_auth=False)
    assert "token 被服务拒绝" in _challenge_hint("token", has_auth=False)
    assert _challenge_hint("", has_auth=False) == ""


# ── update_config 集成（PUT 全链路：str 兼容 + 凭据合并 + 脱敏回传）──────────


@pytest.fixture()
def tmp_config(monkeypatch, tmp_path):
    p = tmp_path / "config.json"
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", p)
    yield p


def test_update_config_str_entries_backward_compat(tmp_config):
    cfg = config_mod.update_config(
        {"matrix_homeservers": ["http://a", "http://b"], "controller_urls": ["http://c"]}
    )
    assert cfg["matrix_homeservers"] == ["http://a", "http://b"]
    # 落盘形态 = 纯字符串（无 auth 痕迹）
    import json

    raw = json.loads(tmp_config.read_text(encoding="utf-8"))
    assert raw["matrix_homeservers"] == ["http://a", "http://b"]


def test_update_config_with_auth_roundtrip(tmp_config):
    patch = {
        "controller_urls": [
            "http://lan",
            {"url": "https://wan", "auth": {"type": "basic", "username": "u", "password": "p"}},
        ]
    }
    cfg = config_mod.update_config(patch)
    assert cfg["controller_urls"][1] == {"url": "https://wan", "auth": {"type": "basic", "username": "u", "password": "p"}}
    # 脱敏回传
    out = config_mod.redact(cfg)
    assert out["controller_urls"][1]["auth"]["password"] == "***"
    # 二次 PUT：*** 保持旧值
    cfg2 = config_mod.update_config(
        {"controller_urls": ["http://lan", {"url": "https://wan", "auth": {"type": "basic", "username": "u", "password": "***"}}]}
    )
    assert cfg2["controller_urls"][1]["auth"]["password"] == "p"
