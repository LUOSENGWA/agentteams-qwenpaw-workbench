# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.17（KBBATCH）：KB 冷读批读 / tree 合并探测 / merged 缓存 /
file 缓存单测（任务书 §二 测试 4 项）。

背景（实测 9/30）：冷读 tree 13.8s / graph 12.1s / merged 40.7s——根因是
HTTP 往返次数（顶层 find + 两子树 find + 6 次档案单文件 archive 探测 +
graph N 次逐文件读 + merged N×全量 graph），不是容器侧扫描。本任务四处
收敛：

K1 files-batch：graph 冷读 N 次逐文件往返 → 单次 exec 分帧批读
   （``===FRAME:<size>:<path>`` + 恰好 size 字节；内容含 ``===FRAME:``
   字样不串帧；≤200 路径；1.8MB 预算 → truncated；敏感 → missing；
   通道挂 → 502，调用方 graph compute 区分并回退逐文件）。
K2 tree 合并探测：3 find + 6 档案 stat → 1 exec（``###SECTION:`` 标记；
   无收尾标记 / 通道挂 → 原双通道 fallback，输出逐字段一致）。
K3 merged 缓存：/kb/graph/merged 30s 内存 + 磁盘 SWR（键
   ``merged-<sorted(agents) 逗号连>``；冷算抽 kb_graph_merged_compute，
   供端点与后台单飞复用）。
K5 file 缓存：/kb/{agent}/file 30s 内存 + 磁盘 SWR（键
   ``file-<agent>-<path>``；只缓存文本类返回——415 二进制 / 413 超限
   HTTPException 终止天然不缓存；WSF 兜底 source:"controller" 在
   _store_kb 单点收口不缓存，14.7 不变式）。

隔离纪律：磁盘缓存目录由 conftest autouse fixture 重定向到本测 tmp
（不碰真实 secret 目录）；Docker 通道全换假 GatedAsyncClient（与
test_kb_listing_channels 同款 mock 风格）；merged 计算体经模块级注册表
``_KB_PREWARM_HOOKS`` 换假函数（与 test_kb_swr_14_10 同款注入点）——
零真实网络拨号。TestClient 以 ``with`` 上下文持有 = portal 事件循环跨
请求存活（后台刷新任务不被请求收尾切断）。
"""
from __future__ import annotations

import io
import json
import tarfile
import threading
import time

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import kb_cache
from agentteams_connector import router as router_mod

WS = "/root/agentteams-fs/agents/big/.qwenpaw/workspaces/default"
MGR_WS = "/root/manager-workspace/.qwenpaw/workspaces/default"


# ── 公共件（mock 风格与 test_kb_listing_channels / test_kb_swr_14_10 一致）──


def _frame(payload: bytes, stream: int = 1) -> bytes:
    """Docker exec 多路复用帧（8 字节头 + payload）。"""
    return bytes([stream, 0, 0, 0]) + len(payload).to_bytes(4, "big") + payload


def _tar(root: str, members: dict) -> bytes:
    """构造 Docker archive 形态 tar：root=所请求路径 basename 前缀。
    members={相对路径: 字节|None(目录)}；rel="" → 单文件档案（full=root）。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for rel, payload in members.items():
            full = f"{root}/{rel}" if rel else root
            info = tarfile.TarInfo(full)
            if payload is None:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tf.addfile(info)
            else:
                info.size = len(payload)
                info.mtime = 1758000000
                tf.addfile(info, io.BytesIO(payload))
    return buf.getvalue()


class _Resp:
    def __init__(self, status_code: int, json_body=None, content: bytes = b""):
        self.status_code = status_code
        self._j = json_body
        self.content = content
        self.headers = {}

    def json(self):
        if self._j is None:
            raise AttributeError("no json body")
        return self._j


class _FakeClient:
    calls: list = []
    get_spec: dict = {}      # url 子串 → (status, json|None, content?)
    head_spec: dict = {}     # url 子串 → status
    exec_spec: list = []     # [(cmd 子串, stdout str)] 首个命中优先
    exec_create_status: int = 201
    last_cmd: list = []      # 类级（exec create 的 Cmd，供断言 argv 形态）

    def __init__(self, *a, **k):
        # GatedAsyncClient 构造签名透传（router._kb_docker 以
        # timeout/verify 实参构造）——缺 __init__ 则构造即 TypeError，
        # 被 _kb_docker 吞为通道失败（隐蔽 404 的根因）。
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a, **k):
        return False

    async def get(self, url, headers=None, **k):
        _FakeClient.calls.append(("GET", url))
        for key, val in _FakeClient.get_spec.items():
            if key in url:
                st = val[0]
                body = val[1] if len(val) > 1 else None
                content = val[2] if len(val) > 2 else b""
                return _Resp(st, body, content)
        return _Resp(404)

    async def head(self, url, headers=None, **k):
        _FakeClient.calls.append(("HEAD", url))
        for key, st in _FakeClient.head_spec.items():
            if key in url:
                return _Resp(st)
        return _Resp(404)

    async def post(self, url, json=None, headers=None, **k):
        _FakeClient.calls.append(("POST", url))
        if url.endswith("/exec"):
            if _FakeClient.exec_create_status != 201:
                return _Resp(_FakeClient.exec_create_status)
            _FakeClient.last_cmd = (json or {}).get("Cmd", [])
            return _Resp(201, {"Id": "exec-1"})
        if "/exec/exec-1/start" in url:
            cmd_s = " ".join(_FakeClient.last_cmd or [])
            for key, out in _FakeClient.exec_spec:
                if key in cmd_s:
                    return _Resp(200, content=_frame(out.encode()))
            return _Resp(200, content=_frame(b""))
        return _Resp(404)


class _FakeCompute:
    """假计算体：记录调用次数、set 事件（供等待完成）、返回固定 payload。"""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.event = threading.Event()
        self.calls = 0

    async def __call__(self, *a, **k):
        self.calls += 1
        self.event.set()
        return self.payload


def _seed_disk(key: str, ts: float, payload: dict) -> None:
    """直接向隔离磁盘目录 seed 一条旧缓存（绕过 save 的时间戳）。

    注意：必须经 ``kb_cache._file_for`` 落路径——merged 键含逗号
    （a1,a2），_file_for 会把特殊字符替换为 _（与 load/save 同源）。"""
    p = kb_cache._file_for(key)
    p.write_text(json.dumps({"ts": ts, "payload": payload}),
                 encoding="utf-8")


def _wait_disk(key: str, older_than: float, timeout: float = 5.0):
    """轮询等磁盘缓存出现新值（ts > older_than）。后台刷新是
    fire-and-forget 任务（portal 循环在 with 块内持续运转），轮询等
    ts 更新避免「事件已 set 但 _store_kb 尚未写盘」的竞态。"""
    deadline = time.time() + timeout
    while True:
        hit = kb_cache.load(key)
        if hit is not None and hit[0] > older_than:
            return hit
        if time.time() >= deadline:
            return kb_cache.load(key)
        time.sleep(0.02)


@pytest.fixture
def client(monkeypatch):
    """TestClient（with 上下文 = portal 循环跨请求存活）+ 最小配置 +
    假 GatedAsyncClient（Docker 通道零真实拨号）。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    cfg = {
        "controller_urls": ["http://10.0.0.1:8090"],
        "controller_token": "ctok123",
        "matrix_homeservers": [],
        "matrix": {"user_id": "", "access_token": ""},
    }
    monkeypatch.setattr(
        cfgmod, "load_config", lambda: json.loads(json.dumps(cfg))
    )
    _FakeClient.calls = []
    _FakeClient.get_spec = {"/json": (200, {})}
    _FakeClient.head_spec = {}
    _FakeClient.exec_spec = []
    _FakeClient.exec_create_status = 201
    _FakeClient.last_cmd = []

    monkeypatch.setattr(
        "agentteams_connector.router.GatedAsyncClient",
        lambda *a, **k: _FakeClient(*a, **k),
    )
    app = FastAPI()
    app.include_router(router_mod.build_router())
    with TestClient(app) as tc:
        yield tc


def _exec_posts() -> list:
    return [u for m, u in _FakeClient.calls
            if m == "POST" and u.endswith("/exec")]


def _archive_gets() -> list:
    return [u for m, u in _FakeClient.calls
            if m == "GET" and "archive" in u]


def _dir_archive_gets() -> list:
    """目录级 archive GET（整树/整子树下载）——K2 修复目标面。"""
    return [u for u in _archive_gets()
            if u.endswith(f"archive?path={WS}")
            or u.endswith(f"archive?path={WS}/memory")
            or u.endswith(f"archive?path={WS}/digest")]


# ── 1) K1 files-batch：分帧 / missing / 拒绝 / 敏感 / 200 截断 ─────────


# 对抗样本：a.md 内容跨行（10 字节恰两行）；b.md 内容内嵌 ``===FRAME:``
# 字样（23 字节=18+换行+4）——帧边界由 size 决定，不得串帧；c.md 缺失。
BATCH_OUT = (
    "===FRAME:10:a.md\n"
    "alpha\nbeta\n"
    "===FRAME:23:b.md\n"
    "===FRAME:5:fake.md\nreal\n"
    "===MISSING:c.md\n"
    "===END\n"
)


def test_files_batch_framing_missing_and_limits(client):
    """分帧正确（对抗内容不串帧）/ 缺失进 missing / .. 与绝对路径拒绝 /
    敏感进 missing / 超 200 截断 / 全敏感不发 exec。"""
    tc = client
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = [("budget = 1887436", BATCH_OUT)]

    r = tc.get(
        "/kb/big/files-batch",
        params={"paths": "a.md,b.md,c.md,../etc/passwd,/etc/passwd,"
                         "credentials.yaml"})
    assert r.status_code == 200, r.text
    body = r.json()
    # 分帧正确性：帧边界由 size 决定——b.md 内容内嵌 ===FRAME: 不当帧头。
    assert body["files"]["a.md"] == "alpha\nbeta"
    assert body["files"]["b.md"] == "===FRAME:5:fake.md\nreal"
    # 敏感（_kb_is_sensitive：credentials.yaml，dashboard 同款清单）→
    # missing（不读不报错，tree 过滤口径一致）；缺失 → missing。
    assert body["missing"] == ["credentials.yaml", "c.md"]
    # .. / 绝对路径静默拒绝（不入 files 也不入 missing）。
    for bad in ("../etc/passwd", "/etc/passwd"):
        assert bad not in body["files"]
        assert bad not in body["missing"]
    assert body["truncated"] is False
    assert body["cached"] is False
    assert body["agent"] == "big"
    # 单次 exec：路径独立 argv（非 csv，防文件名逗号），ws=argv[3]。
    cmd = _FakeClient.last_cmd
    assert cmd[0] == "python3" and cmd[1] == "-c"
    assert cmd[3] == WS
    assert cmd[4:] == ["a.md", "b.md", "c.md"]
    assert len(_exec_posts()) == 1, _exec_posts()

    # >200 路径 → 只读前 200（静默截断；truncated 标志专指 1.8MB 预算）。
    paths205 = ",".join(f"p{i}.md" for i in range(205))
    r2 = tc.get("/kb/big/files-batch", params={"paths": paths205})
    assert r2.status_code == 200, r2.text
    assert len(_FakeClient.last_cmd[4:]) == 200
    assert _FakeClient.last_cmd[4:][:3] == ["p0.md", "p1.md", "p2.md"]

    # 全部敏感/非法 → 直接返回，不发 exec。
    n_before = len(_exec_posts())
    r3 = tc.get("/kb/big/files-batch",
                params={"paths": "credentials.yaml,../x"})
    assert r3.status_code == 200, r3.text
    assert r3.json()["files"] == {}
    assert r3.json()["missing"] == ["credentials.yaml"]
    assert len(_exec_posts()) == n_before


# ── 2) K2 tree 合并探测 ───────────────────────────────────────────────


# 合并探测四段输出（top 首行 = find 根的 %P 空行，解析器跳过 rel 空）。
MERGED_OUT = (
    "###SECTION:top\n"
    "d 4096 1758000000.0 \n"
    "f 1234 1758000000.0 AGENTS.md\n"
    "f 42 1758000001.0 notes.txt\n"
    "d 4096 1758000002.0 memory\n"
    "d 4096 1758000003.0 digest\n"
    "d 4096 1758000004.0 docs\n"
    "###SECTION:memory\n"
    "f 100 1758000100.0 2026-09-17.md\n"
    "###SECTION:digest\n"
    "f 200 1758000200.0 wiki/x.md\n"
    "###SECTION:profile\n"
    f"{WS}/AGENTS.md 1234 1758000000\n"
    "###SECTION:end\n"
)

# 合并模式与 fallback 模式的公共期望（输出逐字段一致——任务书 §二 K2）。
# 排序 = 分类（profile<daily<digest<file）→ 可打开优先 → 路径。
EXPECTED_FILES = [
    {"path": "AGENTS.md", "name": "AGENTS.md", "size": 1234,
     "mtime": 1758000000, "category": "profile", "openable": True},
    {"path": "memory/2026-09-17.md", "name": "2026-09-17.md", "size": 100,
     "mtime": 1758000100, "category": "daily", "openable": True},
    # name=basename（与 path 工作区相对全路径区分；tree 列取既有口径）
    {"path": "digest/wiki/x.md", "name": "x.md", "size": 200,
     "mtime": 1758000200, "category": "digest", "openable": True},
    {"path": "notes.txt", "name": "notes.txt", "size": 42,
     "mtime": 1758000001, "category": "file", "openable": True},
]
EXPECTED_DIRS = [{"path": "docs", "name": "docs", "isdir": True,
                 "category": "file"}]

# fallback（原双通道）的 3 段 find 输出——与 MERGED_OUT 各段逐条对应
# （同一份目录内容，两种取数通道）。
TOP_FIND = (
    "d 4096 1758000000.0 \n"
    "f 1234 1758000000.0 AGENTS.md\n"
    "f 42 1758000001.0 notes.txt\n"
    "d 4096 1758000002.0 memory\n"
    "d 4096 1758000003.0 digest\n"
    "d 4096 1758000004.0 docs\n"
)
MEM_FIND = "f 100 1758000100.0 2026-09-17.md\n"
DIG_FIND = "f 200 1758000200.0 wiki/x.md\n"


def _exec_find_spec():
    # find 通道 spec（首个命中优先）。合并脚本同时含三段 find 子串 →
    # 命中 memory 键（无收尾标记）→ 合并探测判失败 → fallback。
    return [
        (f"find -H {WS}/memory", MEM_FIND),
        (f"find -H {WS}/digest", DIG_FIND),
        (f"find -H {WS} -maxdepth 1", TOP_FIND),
    ]


def test_tree_merged_probe_single_exec_no_archive(client):
    """合并探测成功：1 exec（3 find + 6 档案 stat 段）、零 archive
    GET（④ stat 段替代 6 次单文件探测）、输出四分类正确。"""
    tc = client
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = [("###SECTION:end", MERGED_OUT)]

    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["files"] == EXPECTED_FILES
    assert body["dirs"] == EXPECTED_DIRS
    assert body["count"] == 4
    # K2 核心：仅 1 次 exec；④ stat 段免 6 次档案 archive 探测；
    # ②③ find 段免子树下载——零 archive GET。
    assert len(_exec_posts()) == 1, _exec_posts()
    assert _archive_gets() == [], _archive_gets()
    # 合并脚本形态：sh -c 一段含 3 个 find + stat 循环。
    joined = " ".join(_FakeClient.last_cmd)
    assert joined.startswith("sh -c")
    assert joined.count("find -H") == 3
    assert "stat -c" in joined


def test_tree_merged_probe_fallback_equivalence(client):
    """合并探测无收尾标记（模拟 sh 缺失 / find 中途挂）→ 原双通道
    fallback 整段照跑：输出与合并模式逐字段一致（同一 EXPECTED_* 常量）；
    ④ 档案单文件 archive 探测恢复（5 缺失 404，既有行为）。"""
    tc = client
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = _exec_find_spec()

    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["files"] == EXPECTED_FILES
    assert body["dirs"] == EXPECTED_DIRS
    # fallback = 合并探测 1（返回 find 输出、无收尾标记）+ 原 3 段 find。
    assert len(_exec_posts()) == 4, _exec_posts()
    # ④ 档案单文件探测恢复：5 个缺失档案 → 404（AGENTS.md 已随顶层
    # 列出不重复探）——既有行为，不在断言面。


def test_tree_merged_probe_exec_down_tar_fallback(client):
    """/exec 500（通道挂）→ 合并/主通道全 None → tar 兜底整段照跑：
    顶层只返一层、子树全递归（与 13.9 双通道护栏同语义）。"""
    tc = client
    _FakeClient.exec_create_status = 500
    # 工作区解析仍走 HEAD 探测（与 exec 通道独立）——须给 200。
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    top_tar = _tar("default", {
        "AGENTS.md": b"agents",
        "notes.txt": b"notes notes",
        "docs": None,
    })
    mem_tar = _tar("memory", {"2026-09-17.md": b"x" * 100})
    dig_tar = _tar("digest", {"wiki/x.md": b"y" * 200})
    # 更具体的键在前（archive?path=WS 是 archive?path=WS/memory 的子串）。
    _FakeClient.get_spec = {
        "/json": (200, {}),
        f"archive?path={WS}/memory": (200, None, mem_tar),
        f"archive?path={WS}/digest": (200, None, dig_tar),
        f"archive?path={WS}": (200, None, top_tar),
    }

    r = tc.get("/kb/big/tree")
    assert r.status_code == 200, r.text
    body = r.json()
    files = {f["path"]: f for f in body["files"]}
    assert files["AGENTS.md"]["category"] == "profile"
    assert files["AGENTS.md"]["size"] == 6
    assert files["notes.txt"]["category"] == "file"
    assert files["notes.txt"]["openable"] is True
    assert files["memory/2026-09-17.md"]["category"] == "daily"
    assert files["memory/2026-09-17.md"]["size"] == 100
    assert files["digest/wiki/x.md"]["category"] == "digest"
    assert {d["path"] for d in body["dirs"]} == {"docs"}
    # 兜底确走目录 archive（顶层/memory/digest 三次）。
    assert len(_dir_archive_gets()) == 3, _dir_archive_gets()


# ── 3) K3 merged 30s 缓存 + 后台单飞 ──────────────────────────────────


def test_merged_cache_swr_single_flight(client, monkeypatch):
    """merged 端点 SWR：冷算一次（计算体只跑一次）→ 内存命中不重算 →
    磁盘 fresh 命中（cached/age，不刷新）→ 磁盘 stale 秒回旧值 +
    后台单飞刷新（磁盘更新为新值）。键 = sorted(agents) 逗号连。"""
    tc = client
    payload = {
        "nodes": [
            {"id": "a1::AGENTS.md", "agent": "a1", "name": "AGENTS.md"},
            {"id": "a2::AGENTS.md", "agent": "a2", "name": "AGENTS.md"},
        ],
        "edges": [{"src": "a1::AGENTS.md", "dst": "a1::memory/x.md",
                   "agent": "a1"}],
        "agents": ["a1", "a2"],
    }
    fake = _FakeCompute(payload)
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "merged", fake)

    # ① 冷算：计算体只跑一次、无 cached 标记；内存+磁盘按 csv 键落位。
    r1 = tc.get("/kb/graph/merged", params={"agents": "a2,a1"})
    assert r1.status_code == 200, r1.text
    assert r1.json() == payload
    assert fake.calls == 1
    assert "a1,a2" in router_mod._kb_merged_cache  # 键=sorted 逗号连
    assert kb_cache.load("merged-a1,a2") is not None

    # ② 二次内存命中：不重算，原 payload 原样返回（无 cached 标记）。
    r2 = tc.get("/kb/graph/merged", params={"agents": "a1,a2"})
    assert r2.status_code == 200
    assert r2.json() == payload
    assert fake.calls == 1

    # ③ 内存清空 → 磁盘 fresh 命中：cached=true、age≈0、不触发刷新。
    router_mod._kb_merged_cache.clear()
    r3 = tc.get("/kb/graph/merged", params={"agents": "a1,a2"})
    b3 = r3.json()
    assert b3["cached"] is True
    assert 0 <= b3["age"] <= 2
    assert {k: v for k, v in b3.items() if k not in ("cached", "age")} \
        == payload
    assert fake.calls == 1

    # ④ 磁盘 stale（ts=now-120s > TTL 60s）→ 旧值秒回 + 后台单飞刷新。
    old = {"nodes": [], "edges": [], "agents": []}
    old_ts = time.time() - 120
    _seed_disk("merged-a1,a2", old_ts, old)
    router_mod._kb_merged_cache.clear()
    r4 = tc.get("/kb/graph/merged", params={"agents": "a1,a2"})
    b4 = r4.json()
    assert b4["cached"] is True
    assert 110 <= b4["age"] <= 130
    assert b4["nodes"] == []  # stale 原样秒回（旧值）
    # 后台单飞刷新：计算体再跑一次（合计 2），磁盘更新为新值。
    assert fake.event.wait(5.0), "刷新任务未在 5s 内运行"
    hit = _wait_disk("merged-a1,a2", old_ts)
    assert hit is not None, "刷新未更新磁盘缓存"
    assert hit[1] == payload
    assert hit[0] > old_ts
    assert fake.calls == 2  # 单飞：冷 1 + 刷新 1，无重复任务


# ── 4) K5 file 30s 缓存：文本类命中不重读；二进制分支不缓存 ───────────


def test_file_cache_text_hit_binary_not_cached(client):
    """file 端点 SWR（manager agent，免 WSF 兜底分支）：文本类二次命中
    不重读（archive GET 计数不变）；二进制 415 分支不缓存（二次仍重读）。"""
    tc = client
    text_content = b"# Agents\nhello kb\n"
    bin_content = b"\x00\x01\xff\xfe"  # 非法 UTF-8 → 415
    text_tar = _tar("AGENTS.md", {"": text_content})
    bin_tar = _tar("blob.bin", {"": bin_content})
    _FakeClient.head_spec = {f"archive?path={MGR_WS}": 200}
    _FakeClient.get_spec = {
        "/json": (200, {}),
        f"archive?path={MGR_WS}/AGENTS.md": (200, None, text_tar),
        f"archive?path={MGR_WS}/blob.bin": (200, None, bin_tar),
    }

    def _file_gets(name: str) -> int:
        return len([u for m, u in _FakeClient.calls
                    if m == "GET" and "archive" in u and name in u])

    # ① 文本类冷读：200、无 cached 标记、1 次文件 archive 读。
    r1 = tc.get("/kb/manager/file", params={"path": "AGENTS.md"})
    assert r1.status_code == 200, r1.text
    b1 = r1.json()
    assert b1["path"] == "AGENTS.md"
    assert b1["size"] == len(text_content)
    assert b1["content"] == text_content.decode("utf-8")
    assert "cached" not in b1
    assert _file_gets("AGENTS.md") == 1

    # ② 二次内存命中：不重读（archive GET 计数不变）、内容同值。
    r2 = tc.get("/kb/manager/file", params={"path": "AGENTS.md"})
    assert r2.status_code == 200
    assert r2.json()["content"] == b1["content"]
    assert _file_gets("AGENTS.md") == 1

    # ③ 二进制 → 415 且**不缓存**：二次仍重读（GET +1）。
    r3 = tc.get("/kb/manager/file", params={"path": "blob.bin"})
    assert r3.status_code == 415, r3.text
    assert _file_gets("blob.bin") == 1
    r4 = tc.get("/kb/manager/file", params={"path": "blob.bin"})
    assert r4.status_code == 415, r4.text
    assert _file_gets("blob.bin") == 2
