# -*- coding: utf-8 -*-
"""X1c：地址免填协议（scheme-less）按条目候选组回归测试。

方案（最终版）：地址栏可省略 http(s)://，拨号点按**条目**展开候选
URL（address_candidates），不做全局展平：
- 显式 scheme（http/https 大小写不敏感，及其他 scheme）→ [原样]
  单候选——旧配置（显式写法）零行为变化。
- 无 scheme → 先显式规则拆 host/port（**禁止 urlsplit 推断**——实测
  陷阱：urlsplit("ctlr.example.com:7113") 把 host 误读成 scheme、
  port 误读成 path），再按「端口优先于主机类型」定序：
  443→https 在前 / 80→http 在前 / 其他端口或无端口 →
  IPv4/IPv6 字面量、localhost、单标签（无点）主机 → http 在前
  （curl 裸主机默认 http/80 同口径），含点域名 → https 在前
  （浏览器 HTTPS-First 公开行为）。

按条目分组（lan=第 0 组 / wan=第 1 组）保住固定档索引语义——
全局展平会把 _pinned 的 URL 位置索引打散（X1 教训）。

覆盖：
- address_candidates：定序全规则 + port/path 保留 + 显式 scheme
  透传 + 空串 + urlsplit 陷阱回归 + 幂等
- _candidate_groups / _address_list：组数 / 展平长度 / 顺序
- _pinned_candidates / _pinned_url：固定档按条目分组、auto 档空、
  固定索引缺失回退、thin wrapper 取组内首个
- _ordered_addresses 固定档：只返回该组（不跨组、不吃另一条目的 URL）
- auth_for_url：两侧去 scheme 归一（裸条目 ↔ 任一候选同 auth）
- _select_and_mark：pinned 兼容 str 与候选组 list
"""
from __future__ import annotations

from agentteams_connector import config as config_mod
from agentteams_connector import router as router_mod
from agentteams_connector import selfcheck
from agentteams_connector.config_entries import address_candidates

CTL_LAN = "10.0.0.5:6866"  # 裸内网（IPv4 字面量 + 常规端口）
CTL_WAN = "ctlr.example.com:7113"  # 裸外网（含点域名 + 常规端口）
BASIC = {"type": "basic", "username": "u", "password": "p"}
LAN_GROUPS = ["http://10.0.0.5:6866", "https://10.0.0.5:6866"]
WAN_GROUPS = ["https://ctlr.example.com:7113", "http://ctlr.example.com:7113"]


def _clean_cache() -> None:
    with router_mod._cache_lock:
        router_mod._working_cache.clear()


def _cfg(mode: str = "auto", **over) -> dict:
    base = {
        "address_mode": mode,
        "matrix_homeservers": [
            "http://10.0.0.10:6867",
            "https://agentteams.example.com:6867",
        ],
        "controller_urls": [CTL_LAN, CTL_WAN],
    }
    base.update(over)
    return base


# ── address_candidates：纯函数规则 ─────────────────────────────────


def test_candidates_ip_port_http_first():
    assert address_candidates(CTL_LAN) == LAN_GROUPS


def test_candidates_domain_https_first():
    assert address_candidates(CTL_WAN) == WAN_GROUPS


def test_candidates_port_443_https_first_over_host_type():
    # 端口优先于主机类型：IP 字面量 + 443 也走 https 在前
    assert address_candidates("10.0.0.5:443") == [
        "https://10.0.0.5:443",
        "http://10.0.0.5:443",
    ]
    assert address_candidates("ctlr.example.com:443") == [
        "https://ctlr.example.com:443",
        "http://ctlr.example.com:443",
    ]


def test_candidates_port_80_http_first_over_host_type():
    # 端口优先于主机类型：含点域名 + 80 也走 http 在前
    assert address_candidates("ctlr.example.com:80") == [
        "http://ctlr.example.com:80",
        "https://ctlr.example.com:80",
    ]
    assert address_candidates("10.0.0.5:80") == [
        "http://10.0.0.5:80",
        "https://10.0.0.5:80",
    ]


def test_candidates_localhost_and_single_label_http_first():
    assert address_candidates("localhost:30000") == [
        "http://localhost:30000",
        "https://localhost:30000",
    ]
    # 单标签（无点）主机名 → http 在前
    assert address_candidates("controller") == ["http://controller", "https://controller"]


def test_candidates_ipv6_bracket_port_extracted():
    # [::1]:6866 —— port 必须正确取到 6866（多冒号不误判）
    assert address_candidates("[::1]:6866") == ["http://[::1]:6866", "https://[::1]:6866"]


def test_candidates_path_query_preserved():
    # port 与 path 原样保留
    assert address_candidates("h:6866/api") == ["http://h:6866/api", "https://h:6866/api"]
    assert address_candidates("ctlr.example.com:7113/api") == [
        "https://ctlr.example.com:7113/api",
        "http://ctlr.example.com:7113/api",
    ]


def test_candidates_explicit_scheme_single_candidate():
    assert address_candidates("https://h:1") == ["https://h:1"]
    assert address_candidates("http://h:1") == ["http://h:1"]
    # 大小写不敏感判显式 scheme——原样单候选（不归一小写）
    assert address_candidates("HTTPS://CTLR.EXAMPLE.COM:443") == [
        "HTTPS://CTLR.EXAMPLE.COM:443"
    ]


def test_candidates_empty():
    assert address_candidates("") == []
    assert address_candidates("   ") == []


def test_urlsplit_trap_regression():
    # 实测陷阱：urlsplit("ctlr.example.com:7113") → scheme="ctlr.example.com"、
    # path="7113"。若用 urlsplit 推断会产出畸形 "ctlr.example.com://7113"。
    out = address_candidates(CTL_WAN)
    assert out[0] == "https://ctlr.example.com:7113"
    assert "ctlr.example.com://" not in "".join(out)
    # 幂等：候选再过一遍 = 原样单候选
    for raw in (CTL_LAN, CTL_WAN, "http://x:1", "https://x:1", "[::1]:6866"):
        once = address_candidates(raw)
        assert address_candidates(once[0]) == [once[0]]


# ── router：按条目候选组 / 展平列表 ───────────────────────────────


def test_candidate_groups_two_entries():
    cfg = _cfg()
    groups = router_mod._candidate_groups(cfg, "controller")
    assert len(groups) == 2
    assert groups[0] == LAN_GROUPS
    assert groups[1] == WAN_GROUPS
    # _address_list = 候选组按条目序展平（可拨号 URL 展平列表）
    flat = router_mod._address_list(cfg, "controller")
    assert len(flat) == len(groups[0]) + len(groups[1]) == 4
    assert flat == groups[0] + groups[1]


def test_address_list_explicit_scheme_unchanged():
    # 显式 scheme 配置 → 候选=单元素，展平结果与旧版逐字节一致
    cfg = _cfg(controller_urls=["http://10.0.0.5:6866", "https://ctlr.example.com:7113"])
    assert router_mod._address_list(cfg, "controller") == [
        "http://10.0.0.5:6866",
        "https://ctlr.example.com:7113",
    ]


# ── router：固定档按条目分组 ──────────────────────────────────────


def test_pinned_candidates_lan_wan_auto():
    # lan → 第 0 组（2 条）；wan → 第 1 组（2 条）；auto → 空
    assert router_mod._pinned_candidates(_cfg("lan"), "controller") == LAN_GROUPS
    assert router_mod._pinned_candidates(_cfg("wan"), "controller") == WAN_GROUPS
    assert router_mod._pinned_candidates(_cfg("auto"), "controller") == []
    # 固定索引不存在（只配 1 条却固定外网）→ 回退第 0 组
    # （旧 _pinned_url 的 urls[0] 回退语义）
    assert router_mod._pinned_candidates(
        _cfg("wan", controller_urls=[CTL_LAN]), "controller"
    ) == LAN_GROUPS
    # 无地址 → []
    assert (
        router_mod._pinned_candidates(_cfg("lan", controller_urls=[]), "controller") == []
    )


def test_pinned_url_first_candidate_wrapper():
    assert router_mod._pinned_url(_cfg("lan"), "controller") == "http://10.0.0.5:6866"
    assert router_mod._pinned_url(_cfg("wan"), "controller") == "https://ctlr.example.com:7113"
    assert router_mod._pinned_url(_cfg("auto"), "controller") is None


def test_ordered_addresses_fixed_no_cross_group():
    _clean_cache()
    # 固定档 = 组内候选链——只含该条目，不含另一条目的任何 URL
    wan = router_mod._ordered_addresses(_cfg("wan"), "controller")
    assert wan == WAN_GROUPS
    assert not any("10.0.0.5" in u for u in wan)
    lan = router_mod._ordered_addresses(_cfg("lan"), "controller")
    assert lan == LAN_GROUPS
    assert not any("ctlr.example.com" in u for u in lan)
    # working cache 指向另一条目的 URL，固定档也不跟 cache（组内不跨组）
    router_mod._mark_working("controller", "http://10.0.0.5:6866")
    assert router_mod._ordered_addresses(_cfg("wan"), "controller") == WAN_GROUPS
    # auto 保持现有语义：cache 优先 + 全量展平
    router_mod._mark_working("controller", "https://ctlr.example.com:7113")
    assert router_mod._ordered_addresses(_cfg("auto"), "controller") == [
        "https://ctlr.example.com:7113",
        "http://10.0.0.5:6866",
        "https://10.0.0.5:6866",
        "http://ctlr.example.com:7113",
    ]


# ── auth_for_url：两侧去 scheme 归一 ──────────────────────────────


def test_auth_for_url_bare_entry_hits_both_schemes():
    entries = [{"url": CTL_LAN, "auth": dict(BASIC)}]
    # 裸地址条目对 http:// 与 https:// 候选都命中同一份 auth
    assert config_mod.auth_for_url(entries, "http://10.0.0.5:6866") == BASIC
    assert config_mod.auth_for_url(entries, "https://10.0.0.5:6866") == BASIC
    # 查侧裸地址同样命中
    assert config_mod.auth_for_url(entries, "10.0.0.5:6866") == BASIC
    # 不同 host 不命中
    assert config_mod.auth_for_url(entries, "https://other.example.com:6866") is None


def test_auth_for_url_schemed_entry_scheme_agnostic():
    entries = [
        {"url": "https://ctlr.example.com:7113", "auth": {"type": "bearer", "token": "k"}}
    ]
    bearer = {"type": "bearer", "token": "k"}
    assert config_mod.auth_for_url(entries, "https://ctlr.example.com:7113") == bearer
    assert config_mod.auth_for_url(entries, "http://ctlr.example.com:7113") == bearer
    # 尾斜杠口径仍生效
    assert config_mod.auth_for_url(entries, "https://ctlr.example.com:7113/") == bearer


# ── selfcheck：_select_and_mark 兼容候选组 list ───────────────────


def _row(url: str, ms, ok: bool = True, http_ok: bool = True) -> dict:
    return {"url": url, "ok": ok, "http_ok": http_ok, "ms": ms}


def test_select_and_mark_pinned_list_candidate_hit():
    _clean_cache()
    rows = [
        _row("https://ctlr.example.com:7113", 8),
        _row("http://10.0.0.5:6866", 120),
    ]
    # 固定档候选组（wan 组）：任一候选命中 ok 行 → 标记该候选
    assert (
        selfcheck._select_and_mark("controller", rows, list(WAN_GROUPS))
        == "https://ctlr.example.com:7113"
    )
    assert selfcheck._working_cache().get("controller") == "https://ctlr.example.com:7113"
    # str 形态仍兼容（单 URL）
    _clean_cache()
    assert (
        selfcheck._select_and_mark("controller", rows, "http://10.0.0.5:6866")
        == "http://10.0.0.5:6866"
    )
    # 组内无候选命中 → 回退最快可达
    _clean_cache()
    assert (
        selfcheck._select_and_mark("controller", rows, ["https://other.example.com:1"])
        == "https://ctlr.example.com:7113"
    )
