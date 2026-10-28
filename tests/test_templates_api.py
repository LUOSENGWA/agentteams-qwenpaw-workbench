# -*- coding: utf-8 -*-
"""千锻模板导入域回归（templates_api：import/list/file/delete）。

数据面 = 千锻仓（millforge）``templates/``（INDEX.yaml + {skeleton,
industry,domain,fragments}/*.md）；本地 pack = ``<config_dir>/templates/
<slug>/``（conftest 已把 _CONFIG_DIR 重定向到 per-test tmp，天然隔离）。

护栏：
- I1 URL 安全：非 https → 400；host 白名单外 → 400；ref 白名单外
  （空白/超 100 字符）→ 400（零 git 拨号）。
- I2 成功路径：clone → 只取 .md/.yaml（junk.txt 不入库）→ pack 目录 +
  meta.json（url/ref/commit/imported_at/files）；重复导入整包覆盖。
- I3 clone 失败 → 502 + stderr 摘要；clone 超时 → 502；无 templates/ → 400；
  整包合计超 60MB（含 compiler/ core/）→ 400。
- L1 GET /templates：多 pack 并列 + INDEX 四组解析字段归一；单 pack
  INDEX 损坏只标该 pack parse_error（其余照常）；无 pack → 空列表。
- F1 文件预览：.md/.yaml 可读；扩展名外 400；../ / 绝对路径 / 反斜杠 /
  符号链接逃逸 400；不存在 404；包不存在 404。
- D1 DELETE 幂等：首删 deleted=true 目录消失；再删 deleted=false 仍 200。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import agentteams_connector.templates_api as tpl
from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router


# ── 假 git（_run_git 单点注入；零真实网络/仓库） ────────────────────


class _FakeGit:
    """dispatch：clone → 复制 fixture 仓库到 tmp；-C … rev-parse → 固定
  commit。fail/timeout 开关复现 502 两态。calls 记录全部参数（断言零拨号）。"""

    def __init__(
        self,
        repos: dict,
        fail: bool = False,
        timeout: bool = False,
    ):
        self.repos = repos
        self.fail = fail
        self.timeout = timeout
        self.calls: list = []

    def __call__(self, args, timeout):
        self.calls.append(list(args))
        full = ["git"] + list(args)
        if self.timeout:
            raise subprocess.TimeoutExpired(cmd=full, timeout=timeout)
        if args and args[0] == "clone":
            if self.fail:
                return subprocess.CompletedProcess(
                    args=full, returncode=128, stdout="",
                    stderr=(
                        "Cloning into '…'...\nfatal: repository "
                        "'x' not found\n"
                    ),
                )
            url, tmp = args[-2], args[-1]
            src = self.repos.get(url)
            if src is None:
                return subprocess.CompletedProcess(
                    args=full, returncode=128, stdout="",
                    stderr=f"fatal: repository '{url}' not found\n",
                )
            shutil.copytree(src, tmp, dirs_exist_ok=True)
            return subprocess.CompletedProcess(
                args=full, returncode=0, stdout="", stderr=""
            )
        if args and args[0] == "-C":
            return subprocess.CompletedProcess(
                args=full, returncode=0,
                stdout="deadbeef0123456789\n", stderr="",
            )
        return subprocess.CompletedProcess(args=full, returncode=0)


INDEX_YAML = """\
skeletons:
  - id: sk-full
    file: skeleton/full.md
    source: millforge-core
    applies_to: research, dev
    budget: 6 worker
industry:
  - id: ind-fin
    file: industry/finance.md
    source: millforge-industry
    applies_to: finance
    budget: 4 worker
domain:
  - id: dom-llm
    file: domain/llm-app.md
fragments:
  - id: frag-critic
    file: fragments/critic.md
    source: shared
"""


def _make_repo(base: Path, name: str = "millforge") -> Path:
    """fixture 仓库：README + templates/（INDEX + 四组 md + junk.txt）。"""
    repo = base / f"repo-{name}"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "README.md").write_text("# millforge\n", encoding="utf-8")
    t = repo / "templates"
    for d in ("skeleton", "industry", "domain", "fragments"):
        (t / d).mkdir(parents=True, exist_ok=True)
    (t / "INDEX.yaml").write_text(INDEX_YAML, encoding="utf-8")
    (t / "skeleton" / "full.md").write_text("# sk-full\n", encoding="utf-8")
    (t / "industry" / "finance.md").write_text("# ind-fin\n", encoding="utf-8")
    (t / "domain" / "llm-app.md").write_text("# dom-llm\n", encoding="utf-8")
    (t / "fragments" / "critic.md").write_text("# frag-critic\n", encoding="utf-8")
    (t / "junk.txt").write_text("not a template\n", encoding="utf-8")
    return repo


def _make_bare_repo(base: Path, name: str) -> Path:
    """无 templates/ 的仓库（I3：400 态）。"""
    repo = base / f"repo-{name}"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "README.md").write_text("# bare\n", encoding="utf-8")
    return repo


def _seed_pack(name: str, index_yaml: str | None = INDEX_YAML,
               meta: dict | None = None) -> Path:
    """直接在 pack 根落盘（绕过 import——list/file/delete 的隔离夹具）。"""
    pack = _pack_root() / name
    pack.mkdir(parents=True, exist_ok=True)
    if index_yaml is not None:
        (pack / "INDEX.yaml").write_text(index_yaml, encoding="utf-8")
    (pack / "skeleton").mkdir(exist_ok=True)
    (pack / "skeleton" / "full.md").write_text("# sk-full\n", encoding="utf-8")
    if meta is not None:
        (pack / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8"
        )
    return pack


def _pack_root() -> Path:
    return cfgmod._CONFIG_DIR / "templates"


GH = "https://github.com/LUOSENGWA/millforge.git"


@pytest.fixture
def client(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    repo = _make_repo(tmp_path)
    bare = _make_bare_repo(tmp_path, "bare")
    repos = {GH: repo, "https://gitee.com/mirror/millforge": bare}
    fake = _FakeGit(repos)
    monkeypatch.setattr(tpl, "_run_git", fake)

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), fake, repos


# ── I import 安全与成功路径 ─────────────────────────────────────────


def test_import_url_and_ref_validation(client):
    tc, fake, _ = client
    # 非 https → 400
    r = tc.post("/templates/import", json={"url": "http://github.com/a/b.git"})
    assert r.status_code == 400
    assert "https" in r.json()["detail"]
    # scheme 缺失（git@ scp 形态）→ 400
    r = tc.post("/templates/import",
                json={"url": "git@github.com:a/b.git", "ref": "main"})
    assert r.status_code == 400
    # host 白名单外 → 400
    r = tc.post(
        "/templates/import",
        json={"url": "https://evil.example.com/a/b.git"},
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]
    # ref 白名单外：空白 / 超 100 字符 → 400
    r = tc.post("/templates/import", json={"url": GH, "ref": "main branch"})
    assert r.status_code == 400
    r = tc.post("/templates/import", json={"url": GH, "ref": "a" * 101})
    assert r.status_code == 400
    assert fake.calls == []  # 校验前置：零 git 拨号


def test_import_success_copies_and_meta(client):
    tc, fake, _ = client
    r = tc.post("/templates/import", json={"url": GH, "ref": "main"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True
    assert d["pack"] == "millforge"
    assert d["files"] == 5  # INDEX.yaml + 4 md（junk.txt 排除）
    assert d["commit"] == "deadbeef0123456789"

    pack = _pack_root() / "millforge"
    assert (pack / "INDEX.yaml").is_file()
    assert (pack / "skeleton" / "full.md").is_file()
    assert not (pack / "junk.txt").exists()
    meta = json.loads((pack / "meta.json").read_text(encoding="utf-8"))
    assert meta["url"] == GH
    assert meta["ref"] == "main"
    assert meta["commit"] == "deadbeef0123456789"
    assert meta["imported_at"]
    assert "INDEX.yaml" in meta["files"]
    assert "skeleton/full.md" in meta["files"]
    assert "junk.txt" not in meta["files"]


def test_import_reimport_overrides(client):
    tc, fake, repos = client
    assert tc.post("/templates/import", json={"url": GH}).status_code == 200
    # 仓库演进：删旧文件、加新文件 → 重新导入整包覆盖（无残留）。
    (repos[GH] / "templates" / "domain" / "llm-app.md").unlink(missing_ok=True)
    (repos[GH] / "templates" / "domain").rmdir()
    (repos[GH] / "templates" / "fragments" / "new.md").write_text(
        "# new\n", encoding="utf-8"
    )
    assert tc.post("/templates/import", json={"url": GH}).status_code == 200
    pack = _pack_root() / "millforge"
    assert not (pack / "domain" / "llm-app.md").exists()
    assert (pack / "fragments" / "new.md").is_file()
    meta = json.loads((pack / "meta.json").read_text(encoding="utf-8"))
    assert "domain/llm-app.md" not in meta["files"]


def test_import_clone_failure_502(client, monkeypatch, tmp_path):
    tc, fake, _ = client
    monkeypatch.setattr(fake, "fail", True)
    r = tc.post("/templates/import", json={"url": GH, "ref": "main"})
    assert r.status_code == 502
    assert "git clone 失败" in r.json()["detail"]
    assert "fatal" in r.json()["detail"]  # stderr 摘要
    assert not _pack_root().exists()  # 失败不留半包


def test_import_clone_timeout_502(client, monkeypatch):
    tc, fake, _ = client
    monkeypatch.setattr(fake, "timeout", True)
    r = tc.post("/templates/import", json={"url": GH, "ref": "main"})
    assert r.status_code == 502
    assert "超时" in r.json()["detail"]


def test_import_no_templates_dir_400(client):
    tc, _, repos = client
    r = tc.post(
        "/templates/import",
        json={"url": "https://gitee.com/mirror/millforge", "ref": "main"},
    )
    assert r.status_code == 400
    assert "templates/" in r.json()["detail"]
    assert not (repos["https://gitee.com/mirror/millforge"] / "x").exists()


def test_import_size_limit_400(client, tmp_path):
    tc, fake, repos = client
    big = repos[GH] / "templates" / "skeleton" / "big.md"
    with open(big, "wb") as f:
        f.seek(61 * 1024 * 1024 - 1)
        f.write(b"\0")  # 稀疏文件：st_size=61MB 不实际占盘
    try:
        r = tc.post("/templates/import", json={"url": GH, "ref": "main"})
        assert r.status_code == 400
        assert "60MB" in r.json()["detail"]
        assert not _pack_root().exists()
    finally:
        big.unlink(missing_ok=True)


# ── L list + INDEX 解析 ────────────────────────────────────────────


def test_list_packs_index_and_parse_error_isolated(client):
    tc, _, _ = client
    _seed_pack(
        "good",
        meta={"url": GH, "ref": "main", "commit": "c1",
              "imported_at": "2026-10-25T00:00:00Z", "files": []},
    )
    _seed_pack("broken", index_yaml="skeletons: [unclosed\n  bad: yaml:")
    r = tc.get("/templates")
    assert r.status_code == 200, r.text
    packs = {p["pack"]: p for p in r.json()["packs"]}
    assert set(packs) == {"good", "broken"}

    good = packs["good"]
    assert good["parse_error"] is None
    assert good["meta"]["commit"] == "c1"
    idx = good["index"]
    assert [e["id"] for e in idx["skeletons"]] == ["sk-full"]
    e = idx["skeletons"][0]
    assert e["file"] == "skeleton/full.md"
    assert e["source"] == "millforge-core"
    assert e["applies_to"] == "research, dev"
    assert e["budget"] == "6 worker"
    assert [x["id"] for x in idx["industry"]] == ["ind-fin"]
    assert [x["id"] for x in idx["domain"]] == ["dom-llm"]
    assert [x["id"] for x in idx["fragments"]] == ["frag-critic"]

    broken = packs["broken"]
    assert broken["index"] is None
    assert broken["parse_error"]  # 单包隔离：只标该包，good 照常


def test_list_empty(client):
    tc, _, _ = client
    r = tc.get("/templates")
    assert r.status_code == 200
    assert r.json() == {"packs": []}


# ── F 文件预览 + 防穿越 ────────────────────────────────────────────


def test_file_read_md_and_yaml(client):
    tc, _, _ = client
    _seed_pack("good")
    r = tc.get("/templates/good/file", params={"path": "skeleton/full.md"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["pack"] == "good"
    assert d["path"] == "skeleton/full.md"
    assert d["content"] == "# sk-full\n"
    assert d["size"] > 0
    # INDEX.yaml（.yaml 允许）
    r = tc.get("/templates/good/file", params={"path": "INDEX.yaml"})
    assert r.status_code == 200
    assert "sk-full" in r.json()["content"]


def test_file_traversal_and_extension_rejected(client):
    tc, _, _ = client
    _seed_pack("good")
    outside = _pack_root().parent / "outside.md"
    outside.write_text("secret\n", encoding="utf-8")
    # ../ 穿越 → 400
    r = tc.get("/templates/good/file", params={"path": "../outside.md"})
    assert r.status_code == 400
    # 绝对路径 → 400
    r = tc.get("/templates/good/file", params={"path": "/etc/passwd"})
    assert r.status_code == 400
    # 反斜杠 → 400
    r = tc.get("/templates/good/file", params={"path": "..\\evil.md"})
    assert r.status_code == 400
    # 空 path → 400
    r = tc.get("/templates/good/file")
    assert r.status_code == 400
    # 扩展名白名单外（meta.json / junk 文本）→ 400
    r = tc.get("/templates/good/file", params={"path": "meta.json"})
    assert r.status_code == 400
    # 不存在 → 404
    r = tc.get("/templates/good/file", params={"path": "nope.md"})
    assert r.status_code == 404
    # 包不存在 → 404
    r = tc.get("/templates/ghost/file", params={"path": "a.md"})
    assert r.status_code == 404
    # 包名含 /（%2F 经 ASGI 解码为多段路径）→ 路由层即拒（400 catch-all
    # /404 无匹配）；handler 侧 _SLUG_RE 是第二道（直调不可达时兜底）。
    r = tc.get("/templates/a%2Fb/file", params={"path": "a.md"})
    assert r.status_code in (400, 404)
    assert r.status_code != 200


def test_file_symlink_escape_rejected(client):
    tc, _, _ = client
    pack = _seed_pack("good")
    outside = _pack_root() / "outside-secret.md"
    outside.write_text("secret\n", encoding="utf-8")
    link = pack / "link.md"
    link.symlink_to(outside)
    r = tc.get("/templates/good/file", params={"path": "link.md"})
    assert r.status_code == 400  # resolve 后越出 pack 根
    outside.unlink(missing_ok=True)


# ── D delete 幂等 ──────────────────────────────────────────────────


def test_delete_idempotent(client):
    tc, _, _ = client
    _seed_pack("good")
    r = tc.delete("/templates/good")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "deleted": True}
    assert not (_pack_root() / "good").exists()
    # 再删：不存在也 200 + deleted=false（幂等）
    r = tc.delete("/templates/good")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "deleted": False}
    # 非法包名（含 /）：不炸——路由层即拒（400/404），或 handler 按
    # 不存在处理（200 deleted=false）；绝不 500。
    r = tc.delete("/templates/a%2Fb")
    assert r.status_code in (200, 400, 404)
    assert r.status_code != 500


MAPPING_INDEX = """version: "1.0"
skeletons:
  coordinator:
    file: templates/skeleton/coordinator.md
    budget: 500
    source: production
industry:
  software:
    file: templates/industry/software.md
    source: production
    applies_to: [worker, leader, critic]
"""


def test_parse_index_mapping_form(client):
    """真实千锻 INDEX.yaml 形态：段是 id -> 字段 的映射（不是列表）。"""
    tc, _, _ = client
    _seed_pack("mf-map", index_yaml=MAPPING_INDEX)

    r = tc.get("/templates")
    assert r.status_code == 200, r.text
    packs = {p["pack"]: p for p in r.json()["packs"]}
    pack = packs["mf-map"]
    assert pack["parse_error"] is None

    idx = pack["index"]
    assert [e["id"] for e in idx["skeletons"]] == ["coordinator"]
    entry = idx["skeletons"][0]
    assert entry["file"] == "skeleton/coordinator.md"  # templates/ 前缀剥掉
    assert entry["budget"] == "500"
    assert entry["source"] == "production"
    assert [e["id"] for e in idx["industry"]] == ["software"]
    assert idx["industry"][0]["applies_to"] == "worker, leader, critic"
    assert idx["domain"] == []
    assert idx["fragments"] == []


def test_parse_index_real_section_names(client):
    """千锻真实段名：domains / protocol（API 仍用 domain / fragments 键）。"""
    real = """skeletons:
  worker: { file: templates/skeleton/worker.md, budget: 150, source: production }
domains:
  mobile: { file: templates/domain/mobile.md, source: production, applies_to: [worker] }
protocol:
  nmh: { file: templates/fragments/nmh.md, resident: true, source: production, trigger: "常驻" }
"""
    tc, _, _ = client
    _seed_pack("mf-real", index_yaml=real)
    r = tc.get("/templates")
    packs = {p["pack"]: p for p in r.json()["packs"]}
    idx = packs["mf-real"]["index"]
    assert [e["id"] for e in idx["domain"]] == ["mobile"]
    assert idx["domain"][0]["file"] == "domain/mobile.md"
    assert [e["id"] for e in idx["fragments"]] == ["nmh"]
    assert idx["fragments"][0]["resident"] == "True"
    assert idx["fragments"][0]["trigger"] == "常驻"
