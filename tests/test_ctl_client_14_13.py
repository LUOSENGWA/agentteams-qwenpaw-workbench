# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.13（·技术债治理）ctl_client 单一实现单测。

去重目标：「ordered 地址 failover」此前在 router._ctl_json（超集闭包）与
worker_status._ctl_get（GET 版）双实现，现唯一实现在 ctl_client.ctl_json；
两处旧名保留薄包装（注入点/调用面语义不变）。

覆盖：

1. ``worker_status._ctl_get`` 委派——monkeypatch ``ctl_client.ctl_json``
 （计数 + 返回哨兵）→ 调 ``_ctl_get(url, token)`` → 断言收到
 ("GET", url, token)、无 body，且原样返回哨兵；
2. router 的 ``_ctl_json`` 闭包已退化为薄包装——源码级断言包装体委派
 ``ctl_client.ctl_json``、无旧 failover 实现体残留（防回归为双实现）。

failover 语义回归由既有套件覆盖（168 全绿）：既有测试经 _ctl_get /
_KB_PREWARM_HOOKS 注入点打桩，不依赖旧实现体存在。不碰真实网络。
"""
from __future__ import annotations

import asyncio
import inspect

from agentteams_connector import ctl_client
from agentteams_connector import router as router_mod
from agentteams_connector import worker_status as ws


def test_worker_status_ctl_get_delegates(monkeypatch):
    """1) _ctl_get 薄包装：原样委派 ctl_client.ctl_json("GET", url, token)。"""
    calls: list[tuple] = []
    sentinel = (200, {"sentinel": True}, "raw-sentinel")

    async def fake_ctl_json(method, url, token, json_body=None):
        calls.append((method, url, token, json_body))
        return sentinel

    monkeypatch.setattr(ctl_client, "ctl_json", fake_ctl_json)

    result = asyncio.run(ws._ctl_get("http://x/y", "tok-1"))

    # 方法固定 GET、url/token 原样、不带 body。
    assert calls == [("GET", "http://x/y", "tok-1", None)]
    # 返回值原样透传（哨兵对象同一性）。
    assert result is sentinel


def test_router_ctl_json_is_thin_wrapper():
    """2) 源码级断言：router._ctl_json 闭包体是薄包装（防回归为双实现）。"""
    lines = inspect.getsource(router_mod).splitlines()
    start = next(
        (
            i
            for i, line in enumerate(lines)
            if line.strip().startswith("async def _ctl_json")
        ),
        None,
    )
    assert start is not None, "router 源码缺 _ctl_json 定义"
    # 包装体 = def 起至下一行缩进回 0（下一个模块级 def）；
    # 任务 190：_ctl_json 自 build_router 闭包提升为模块级（def 0 空格/体 4 空格），
    # 探针按新缩进收集。
    body: list[str] = []
    for line in lines[start + 1:]:
        if line.strip() and not line.startswith("    "):
            break
        body.append(line)
    text = "\n".join(body)
    # 委派唯一实现：
    assert "ctl_client.ctl_json" in text
    # 旧实现体特征（地址 failover 循环/拨号/判障）不得残留：
    assert "path_and_query" not in text
    assert "GatedAsyncClient" not in text
    assert "should_failover_status" not in text
