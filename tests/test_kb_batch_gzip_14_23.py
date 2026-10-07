"""v0.5.0-beta.14.23（KBBATCH-GZ）：KB 批量读 gzip 信封（GZB1）+
/kb/agents 后 last-agent 预热接线单测（任务书 T1–T5）。

背景（外网 5Mbps 链路实测）：K1 单次 exec 批量读输出 = 1.8MB 原文
过 WAN ≈ 3–5s。gzip+base64 信封把传输体积压 ~5×；帧协议
（``===FRAME:<size>:<path>`` + 恰好 size 字节）一字不动——信封是帧
文本外层包装，解码后原样喂现有 _kb_parse_batch（_kb_parse_batch /
_kb_take_bytes 零改动）。信封损坏（b64/gzip 失败、无 ===END 收尾）
= 通道挂（None）→ 调用方回退逐文件路径（files-batch 端点 502，
源码 kb_files_batch 的 result is None 支）。

T1 新信封端到端：exec_spec 喂进程内编码的 GZB1 信封（复用
14_17 BATCH_OUT 对抗样本：跨行内容 + 内容内嵌 ===FRAME: + MISSING）
→ 200，解析与旧协议逐字节一致（不串帧、缺失进 missing）。
T2 旧协议兼容：无 magic 原始帧文本 → 同 T1（decoder 透传路径）。
T3 信封损坏：非 b64 / gzip 截断 → 通道挂 → 端点 502（以源码
回退语义为准）；_kb_batch_decode 直断（None/透传/无收尾/损坏）。
T4 脚本静态护栏：真实 exec argv（FakeClient.last_cmd[2]）含
gzip/base64/===GZB1===/1887436（预算未动）、旧直写已移除。
T5 预热触发：/kb/agents 后后台预热 last-agent 的 tree+graph
（monkeypatch _KB_PREWARM_HOOKS["refresh"] 假计数 + 自持 in-flight
模拟 _spawn_kb_refresh 单飞；agents 清单经 ["agents"] 假计算体喂）；
last-agent 不在清单 / 无记录 → 零调用；连续两次请求 → 各只一次。

隔离纪律（与 14_17/14_22 同款）：磁盘缓存 conftest autouse 重定向
tmp；Docker 通道全换假 GatedAsyncClient（零真实网络拨号）；
_FakeClient/_Resp/_frame/client fixture 自包含复制（不 import
14_17，避免跨测耦合）。
"""
from __future__ import annotations

import base64
import gzip
import json
import time

import pytest

from agentteams_connector import config as cfgmod
from agentteams_connector import kb_cache
from agentteams_connector import router as router_mod

WS = "/root/agentteams-fs/agents/big/.qwenpaw/workspaces/default"

# 对抗样本（与 test_kb_batch_14_17.BATCH_OUT 逐字一致）：a.md 跨行
# （10 字节恰两行）；b.md 内容内嵌 ===FRAME: 字样（23 字节）——帧
# 边界由 size 决定，不得串帧；c.md 缺失。
BATCH_OUT = (
    "===FRAME:10:a.md\n"
    "alpha\nbeta\n"
    "===FRAME:23:b.md\n"
    "===FRAME:5:fake.md\nreal\n"
    "===MISSING:c.md\n"
    "===END\n"
)

# 两协议共同 ground truth（T1/T2 逐字节对齐此常量即互证一致）。
EXPECTED_FILES = {"a.md": "alpha\nbeta",
                  "b.md": "===FRAME:5:fake.md\nreal"}
EXPECTED_MISSING = ["c.md"]


def _envelope(text: str) -> str:
    """合法帧文本 → GZB1 信封（与容器侧新脚本尾部同逻辑：
 单行 b64、magic 行、===END 收尾）。"""
    blob = base64.b64encode(gzip.compress(text.encode("utf-8"), 9)
                            ).decode("ascii")
    return "===GZB1===\n" + blob + "\n===END\n"


# ── 公共件（mock 风格与 test_kb_batch_14_17 一致，自包含副本）────────


def _frame(payload: bytes, stream: int = 1) -> bytes:
    """Docker exec 多路复用帧（8 字节头 + payload）。"""
    return bytes([stream, 0, 0, 0]) + len(payload).to_bytes(4, "big") + payload


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
    last_cmd: list = []      # exec create 的 Cmd（供断言 argv 形态）

    def __init__(self, *a, **k):
        # GatedAsyncClient 构造签名透传（timeout/verify 实参）。
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


# ── T1/T2：信封可逆 + 旧协议透传（逐字节一致 = 无串帧）──────────────


def test_t1_gzb1_envelope_end_to_end(client):
    """T1：GZB1 信封端到端——对抗样本（跨行/内嵌 ===FRAME:/MISSING）
 解码后与旧协议 ground truth 逐字节一致。"""
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = [("budget = 1887436", _envelope(BATCH_OUT))]
    r = client.get("/kb/big/files-batch",
                   params={"paths": "a.md,b.md,c.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    # a.md 跨行内容完整；b.md 内嵌 ===FRAME: 不当帧头（不串帧）。
    assert body["files"] == EXPECTED_FILES
    # 缺失项进 missing；预算未触顶。
    assert body["missing"] == EXPECTED_MISSING
    assert body["truncated"] is False
    assert body["cached"] is False
    assert body["agent"] == "big"


def test_t2_old_protocol_passthrough_matches(client):
    """T2：无 magic 原始帧文本（旧协议）→ 与 T1 同一 ground truth
（decoder 首行非 ===GZB1=== → 原样透传给 _kb_parse_batch）。"""
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = [("budget = 1887436", BATCH_OUT)]
    r = client.get("/kb/big/files-batch",
                   params={"paths": "a.md,b.md,c.md"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["files"] == EXPECTED_FILES
    assert body["missing"] == EXPECTED_MISSING
    assert body["truncated"] is False


# ── T3：信封损坏 = 通道挂（端点 502；解码器直断）────────────────────


def test_t3_corrupt_envelope_channel_down(client):
    """T3：两种损坏信封 → _kb_files_batch_read=None → files-batch
端点 502（源码 kb_files_batch：result is None → HTTPException 502
「批量读通道失败」——回退逐文件由调用方 graph compute 的 None 支
负责，端点自身语义=502）。"""
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    # 形态 1：magic 后非 base64（validate=True → binascii.Error）。
    bad_b64 = "===GZB1===\n!!!not-base64!!!\n===END\n"
    _FakeClient.exec_spec = [("budget = 1887436", bad_b64)]
    r = client.get("/kb/big/files-batch", params={"paths": "a.md"})
    assert r.status_code == 502, r.text
    # 形态 2：b64 合法但 gzip 流截断（decompress → EOF/BadGzip）。
    full = _envelope(BATCH_OUT)
    cut = full.split("\n")[1][:int(len(full.split("\n")[1]) * 0.6)]
    _FakeClient.exec_spec = [
        ("budget = 1887436", "===GZB1===\n" + cut + "\n===END\n")]
    r2 = client.get("/kb/big/files-batch", params={"paths": "a.md"})
    assert r2.status_code == 502, r2.text


def test_t3b_decode_direct_semantics():
    """T3 直断：_kb_batch_decode 五语义（None/透传/合法/无收尾/损坏）。"""
    assert router_mod._kb_batch_decode(None) is None
    # 旧协议（首行非 magic）→ 原样返回。
    assert router_mod._kb_batch_decode(BATCH_OUT) == BATCH_OUT
    # 合法信封 → 逐字节还原。
    assert router_mod._kb_batch_decode(_envelope(BATCH_OUT)) == BATCH_OUT
    # 无 ===END 收尾 → None。
    blob = base64.b64encode(
        gzip.compress(BATCH_OUT.encode("utf-8"))).decode("ascii")
    assert router_mod._kb_batch_decode("===GZB1===\n" + blob) is None
    # 非 b64 → None。
    assert router_mod._kb_batch_decode(
        "===GZB1===\n!!!\n===END\n") is None


# ── T4：容器侧脚本静态护栏（真实 argv 取证）─────────────────────────


def test_t4_script_static_guardrails(client):
    """T4：真实发出的脚本（last_cmd[2]）含 gzip/base64/===GZB1===/
1887436（预算未动）；旧直写 ``sys.stdout.buffer.write(("\\n".join(out)
`` 已移除（raw 脚本文本内 \\n 为两字符转义序列，按字面匹配）。"""
    _FakeClient.head_spec = {f"archive?path={WS}": 200}
    _FakeClient.exec_spec = [("budget = 1887436", _envelope(BATCH_OUT))]
    r = client.get("/kb/big/files-batch", params={"paths": "a.md"})
    assert r.status_code == 200, r.text
    cmd = _FakeClient.last_cmd
    assert cmd[0] == "python3" and cmd[1] == "-c"
    script = cmd[2]
    assert "gzip" in script
    assert "base64" in script
    assert "===GZB1===" in script
    assert "1887436" in script
    assert 'sys.stdout.buffer.write(("\\n".join(out)' not in script


# ── T5：/kb/agents 后 last-agent 预热（单飞/防已删/静默）────────────


class _FakeRefresh:
    """假 refresh 入口（签名 (kind, agent) -> None）：记录调用 +
 自持 in-flight（模拟 _spawn_kb_refresh 的 _kb_inflight 单飞——
 在飞即跳过，任务期内不释放槽位）。"""

    def __init__(self):
        self.calls: list = []
        self._inflight: set = set()

    def __call__(self, kind: str, agent: str) -> None:
        key = f"{kind}-{agent}"
        if key in self._inflight:
            return
        self._inflight.add(key)
        self.calls.append((kind, agent))


def _seed_last_agent(agent: str) -> None:
    """经 kb_cache._file_for 直落 last-agent 磁盘记录（参照 14_17
 _seed_disk 姿势；key 无特殊字符，_file_for=last-agent.json）。
 conftest 只重定向 _CACHE_DIR 不预建目录（save 内部才 mkdir）→
 直写前先建父目录。"""
    p = kb_cache._file_for("last-agent")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps({"ts": time.time() - 10,
                    "payload": {"agent": agent}}),
        encoding="utf-8")


def _wait_calls(fake: _FakeRefresh, n: int, timeout: float = 3.0) -> None:
    """轮询等 create_task 在 portal 循环里跑完（避免固定 sleep 竞态）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(fake.calls) >= n:
            return
        time.sleep(0.02)


def test_t5a_prewarm_fires_once_and_single_flight(client, monkeypatch):
    """T5a：last-agent 在清单 → /kb/agents 后后台预热 tree+graph 各
 一次；第二次请求（内存门命中路径）→ 单飞跳过零累加。"""
    fake = _FakeRefresh()
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "refresh", fake)

    async def fake_agents():
        return {"agents": [{"name": "alpha"}, {"name": "beta"}],
                "count": 2}
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "agents",
                        fake_agents)
    _seed_last_agent("alpha")

    r = client.get("/kb/agents")
    assert r.status_code == 200, r.text
    assert [a["name"] for a in r.json()["agents"]] == ["alpha", "beta"]
    _wait_calls(fake, 2)
    assert fake.calls == [("tree", "alpha"), ("graph", "alpha")]

    # 第二次请求（_kb_agents_cache 命中）→ 再次 create_task →
    # 假 refresh 自持 in-flight 跳过 → 零累加。
    r2 = client.get("/kb/agents")
    assert r2.status_code == 200, r2.text
    time.sleep(0.05)
    assert fake.calls == [("tree", "alpha"), ("graph", "alpha")]


def test_t5b_prewarm_skips_agent_not_in_list(client, monkeypatch):
    """T5b：last-agent 指向不在本次清单的 agent（已删除）→ 零预热
 调用（防预热已删 agent 的护栏）。"""
    fake = _FakeRefresh()
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "refresh", fake)

    async def fake_agents():
        return {"agents": [{"name": "alpha"}], "count": 1}
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "agents",
                        fake_agents)
    _seed_last_agent("ghost")

    r = client.get("/kb/agents")
    assert r.status_code == 200, r.text
    time.sleep(0.05)
    assert fake.calls == []


def test_t5c_prewarm_silent_without_last_agent(client, monkeypatch):
    """T5c：无 last-agent 磁盘记录（首次使用）→ 静默零调用，主响应
 不受影响。"""
    fake = _FakeRefresh()
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "refresh", fake)

    async def fake_agents():
        return {"agents": [{"name": "alpha"}], "count": 1}
    monkeypatch.setitem(router_mod._KB_PREWARM_HOOKS, "agents",
                        fake_agents)

    r = client.get("/kb/agents")
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1
    time.sleep(0.05)
    assert fake.calls == []
