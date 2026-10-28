# -*- coding: utf-8 -*-
"""千锻编译/注入域回归（millforge_api：source/import/compile/inject/
prompt/parse/builds/injections）。

数据面 = 本地 pack（templates_api 共享导入底座，FakeGit 零真实网络）+
Controller 管理 API（monkeypatch millforge_api._ctl_call = 假 controller，
零真实拨号）。编译器 = fixture pack 内的自研假编译器（实现契约：读
team.json → 写 {role}.soul.md + fragments/ + received.json（组装结果
断言用）→ stdout 恒 JSON；exit 0/2/4 按 team 名触发）。

护栏：
- S1 源配置：GET 默认（派生 URL）/ PUT 持久化 + 合并语义（kind/repo 空
  保留现值，custom_url 空=清空回派生）/ 非法 kind·repo·custom_url → 400。
- S2 导入：走源配置派生 URL（fake git repos 键=派生 URL）+ has_compiler/
  has_core + 重复导入整包覆盖。
- C1 编译模板路径（INDEX teams 整队组合）：team.json 组装断言
  （name/mode/roles/roster/charter/skills 轮转/roster=human-owner）。
- C2 编译自定义路径（team_json）+ name 以 team 参数为准。
- C3 失败映射：exit 2（validate）/ exit 4（budget）→ 422 +
  {exit_code, stage, over_budget/errors}；半 build 清理。
- C4 前置：无 pack 400 / 无 compiler 400 / team 名非法 400 / 互斥 400 /
  budget_override 键与范围 400。
- C5 builds 留 20（造 21 个旧 build 再编译一次 → 清最旧 2）。
- I1 注入更新现有 Worker（PUT soul + GET 读回 verified）。
- I2 注入新建 Worker（POST 带 soul + 读回 verified）。
- I3 core skill（zip 解包断言 SKILL.md frontmatter + references/protocol/
  + scripts/；form scope=team；GET workers；PUT skills 追加）。
- I4 部分失败（PUT 404 → error + partial=true，HTTP 恒 200）/ 无 build
  404 / 预算不绿 400 / 无 token 401 / 无操作 400 / 无对象 400 /
  mapping 角色不在 build 400 / 无 core 的包 skipped。
- P1 prompt 组装（PHILOSOPHY 全文 + schema + §十行级填充 + 严格输出约束
  「只输出一个 JSON」+「需人确认」）。
- P2 parse 去围栏 ok / 无围栏 ok / 缺字段 path / 名 pattern / 垃圾文本。
- H1 builds 列表/详情/文件读（防穿越）+ injections 历史。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote

import pytest

import agentteams_connector.templates_api as tpl
import agentteams_connector.millforge_api as mfg
from agentteams_connector import config as cfgmod
from agentteams_connector.router import build_router

CTL_BASE = "http://10.0.0.1:8090"
GH = "https://github.com/LUOSENGWA/millforge.git"
GH_CAP = "https://github.com/LUOSENGWA/Millforge.git"  # 默认源派生 URL
GC = "https://gitcode.com/acme/millforge.git"


# ── 假 git（templates_api._run_git 单点注入；零真实网络/仓库）────────


class _FakeGit:
    def __init__(self, repos: dict, fail: bool = False):
        self.repos = repos
        self.fail = fail
        self.calls: list = []

    def __call__(self, args, timeout):
        self.calls.append(list(args))
        full = ["git"] + list(args)
        if args and args[0] == "clone":
            if self.fail:
                return subprocess.CompletedProcess(
                    args=full, returncode=128, stdout="",
                    stderr="fatal: repository not found\n",
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


# ── 假编译器（契约实现；received.json 供组装断言；fail-* 触发失败态）──

FAKE_COMPILER = '''#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json, os, sys


def main():
    args = sys.argv[1:]
    if not args or args[0] != "compile":
        print(json.dumps({"ok": False, "stage": "usage",
                          "error": "unknown subcommand"}))
        return 64
    team_path = out = None
    overrides = {}
    lang = "zh"
    i = 1
    while i < len(args):
        a = args[i]
        if a == "--out":
            i += 1; out = args[i]
        elif a == "--budget-override":
            i += 1; k, v = args[i].split("="); overrides[k] = int(v)
        elif a == "--lang":
            i += 1; lang = args[i]
        else:
            team_path = a
        i += 1
    with open(team_path, encoding="utf-8") as f:
        doc = json.load(f)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "received.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    if str(doc.get("name", "")).startswith("fail-validate"):
        print(json.dumps({"ok": False, "stage": "validate",
                          "error": "validate 失败：字段缺失",
                          "errors": [{"path": "roles",
                                      "message": "minItems 2"}]},
                         ensure_ascii=False))
        return 2
    if str(doc.get("name", "")).startswith("fail-budget"):
        print(json.dumps({"ok": False, "stage": "budget",
                          "error": "budget 超支",
                          "over_budget": [{"role": "w1", "lines": 200,
                                           "budget": 150}]},
                         ensure_ascii=False))
        return 4
    outputs = []
    for r in doc.get("roles", []):
        rid = r["id"]
        budget = overrides.get(r.get("kind"), r.get("budget", 150))
        body = "# SOUL " + rid + "\\n" + ("行\\n" * min(int(budget), 10))
        prov = ("<!-- MILLFORGE-COMPILED — 勿手编\\n"
                "     team: " + str(doc.get("name"))
                + " | role: " + rid + "(" + str(r.get("kind")) + ")"
                + " | mode: " + str(doc.get("mode")) + " | lang: " + lang + "\\n"
                "     template: T0-generic | experimental: False\\n"
                "     instance_fp: 0123456789abcdef"
                " | compiled: 2026-10-25T00:00:00Z | millforge: 1.0\\n"
                "     fragments: 1 | nmh@deadbeef\\n"
                "     layer1: core | layer2: template\\n"
                "     recompile: millforge compile team.json -->")
        soul = prov + "\\n\\n" + body
        with open(os.path.join(out, rid + ".soul.md"), "w",
                  encoding="utf-8") as f:
            f.write(soul)
        outputs.append({"role": rid, "kind": r.get("kind"),
                        "lines": len(soul.splitlines()), "budget": budget,
                        "budget_status": "ok", "rule_density": 0.1})
    os.makedirs(os.path.join(out, "fragments"), exist_ok=True)
    with open(os.path.join(out, "fragments", "nmh.md"), "w",
              encoding="utf-8") as f:
        f.write("# NMH 片段\\n")
    print(json.dumps({"ok": True, "team": doc.get("name"),
                      "mode": doc.get("mode"), "outputs": outputs,
                      "budget_gates": "pass",
                      "stages_run": ["validate", "assemble", "render"],
                      "deployed_fragments": ["nmh"],
                      "deterministic_note": ""}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''

INDEX_YAML = """\
version: "1.0"
skeletons:
  worker: { file: templates/skeleton/worker.md, budget: 150, source: production }
industry:
  software:
    file: templates/industry/software.md
    source: production
    applies_to: [worker, leader, critic]
domains:
  mobile: { file: templates/domain/mobile.md, source: production, applies_to: [worker] }
  llm-app: { file: templates/domain/llm-app.md, source: production, applies_to: [worker] }
protocol:
  nmh: { file: templates/fragments/nmh.md, resident: true, source: production, trigger: "常驻" }
teams:
  biz-market:
    name: 业务市场队
    industry: software
    members: { leader: 1, workers: 2, critic: 1 }
    domains: mobile, llm-app
    source: production
"""

TEAM_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["name", "mode", "charter", "roles", "protocol", "roster"],
    "additionalProperties": False,
    "properties": {
        "name": {"type": "string",
                 "pattern": "^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$"},
        "mode": {"enum": ["single_user", "multi_user"]},
        "lang": {"enum": ["zh", "en"]},
        "template": {"enum": ["software", "embedded", "data", "content",
                              "business", "custom", None]},
        "experimental": {"type": "boolean"},
        "charter": {
            "type": "object",
            "required": ["mission", "scope", "non_goals"],
            "additionalProperties": False,
            "properties": {
                "mission": {"type": "string", "minLength": 10,
                            "maxLength": 500},
                "scope": {"type": "array", "minItems": 1,
                          "items": {"type": "string"}},
                "non_goals": {"type": "array", "minItems": 1,
                              "items": {"type": "string"}},
            },
        },
        "roles": {
            "type": "array", "minItems": 2, "maxItems": 8,
            "items": {
                "type": "object",
                "required": ["id", "kind", "profile", "budget"],
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string",
                           "pattern": "^[a-z0-9][a-z0-9-]{0,31}[a-z0-9]$"},
                    "kind": {"enum": ["coordinator", "leader", "worker",
                                      "critic"]},
                    "profile": {"type": "string", "minLength": 10,
                                "maxLength": 2000},
                    "domains": {"type": "array",
                                "items": {"type": "string"}},
                    "skills": {"type": "array",
                               "items": {"type": "string"}},
                    "budget": {"type": "integer", "minimum": 60,
                               "maximum": 500},
                    "spawn": {"type": "boolean"},
                    "model": {"type": ["string", "null"]},
                },
            },
        },
        "protocol": {
            "type": "object",
            "required": ["nmh", "nma", "five_clauses", "attention"],
            "additionalProperties": False,
            "properties": {
                "nmh": {"type": "boolean"},
                "nma": {"type": "boolean"},
                "five_clauses": {"type": "boolean"},
                "attention": {"type": "boolean"},
                "dual_channel": {"type": "boolean"},
            },
        },
        "roster": {
            "type": "array", "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "role"],
                "additionalProperties": False,
                "properties": {
                    "id": {"type": "string"},
                    "role": {"enum": ["accountable", "approver", "informed"]},
                    "weight": {"type": "number", "minimum": 1.0,
                               "maximum": 4.0},
                },
            },
        },
    },
}

PHILOSOPHY_MD = """\
# 千锻设计哲学（PHILOSOPHY）

## 一 基本立场
千锻 = 编译器 + 模板库 + 核心层。SOUL 永远由编译器产出。

## 二 预算纪律
每个角色有行数预算，超支即零落盘。

## 十 给 LLM 的二次生成指令

```
你是千锻协议编译器的前端。以下是千锻设计哲学全文（PHILOSOPHY）。
我的团队情况：
- 成员：{N 个 Agent + 角色分工}
- 任务类型：{…}
- 运行时：AgentTeams/QwenPaw/Claude Code/其他
- 最痛的 3 个问题：{…}
请生成：一个完整 team.json（字段语义见 team.schema.json）。
约束：不得引入本哲学未覆盖的新机制；拿不准的 → 标注「需人确认」而不是猜。
```
"""

VALID_TEAM = {
    "name": "data-pipe-team",
    "mode": "multi_user",
    "charter": {
        "mission": "数据管道交付团队：完成 ETL 与报表管道交付",
        "scope": ["ETL", "报表"],
        "non_goals": ["生产发布"],
    },
    "roles": [
        {"id": "lead", "kind": "leader",
         "profile": "负责拆解派发与整合汇报",
         "domains": [], "skills": [], "budget": 250, "spawn": False},
        {"id": "w1", "kind": "worker",
         "profile": "负责执行 ETL 任务并附证据",
         "domains": ["etl"], "skills": ["etl"], "budget": 150,
         "spawn": True},
        {"id": "critic", "kind": "critic",
         "profile": "独立验收只审不做并输出证据",
         "domains": [], "skills": [], "budget": 150, "spawn": False},
    ],
    "protocol": {"nmh": True, "nma": True, "five_clauses": True,
                 "attention": True, "dual_channel": True},
    "roster": [{"id": "human-owner", "role": "accountable", "weight": 1.0}],
}


def _make_full_repo(base: Path, name: str = "millforge") -> Path:
    """完整千锻仓：templates/（INDEX 含 teams 段）+ compiler/（假编译器）
 + core/（README + schemas + protocol + scripts）+ 根 PHILOSOPHY 双语文本
 + requirements.txt。"""
    repo = base / f"repo-{name}"
    repo.mkdir(parents=True, exist_ok=True)
    t = repo / "templates"
    for d in ("skeleton", "industry", "domain", "fragments"):
        (t / d).mkdir(parents=True, exist_ok=True)
    (t / "INDEX.yaml").write_text(INDEX_YAML, encoding="utf-8")
    (t / "skeleton" / "worker.md").write_text("# sk-worker\n", encoding="utf-8")
    (t / "industry" / "software.md").write_text("# ind-software\n",
                                                encoding="utf-8")
    (t / "domain" / "mobile.md").write_text("# dom-mobile\n", encoding="utf-8")
    (t / "domain" / "llm-app.md").write_text("# dom-llm\n", encoding="utf-8")
    (t / "fragments" / "nmh.md").write_text("# frag-nmh\n", encoding="utf-8")
    c = repo / "compiler"
    c.mkdir()
    (c / "millforge-compile.py").write_text(FAKE_COMPILER, encoding="utf-8")
    core = repo / "core"
    (core / "schemas").mkdir(parents=True)
    (core / "protocol").mkdir()
    (core / "scripts").mkdir()
    (core / "README.md").write_text("# 千锻核心层\n", encoding="utf-8")
    (core / "schemas" / "team.schema.json").write_text(
        json.dumps(TEAM_SCHEMA, ensure_ascii=False, indent=1),
        encoding="utf-8")
    (core / "protocol" / "nmh.md").write_text("# NMH 协议\n", encoding="utf-8")
    (core / "scripts" / "x.sh").write_text("#!/bin/sh\necho x\n",
                                           encoding="utf-8")
    (repo / "PHILOSOPHY.md").write_text(PHILOSOPHY_MD, encoding="utf-8")
    (repo / "PHILOSOPHY.en.md").write_text("# Millforge Philosophy\n",
                                           encoding="utf-8")
    (repo / "requirements.txt").write_text("pyyaml>=6.0\njsonschema>=4.0\n",
                                           encoding="utf-8")
    return repo


def _make_nocore_repo(base: Path) -> Path:
    """有 compiler 但无 core/ 的仓（core skill skipped 态）。"""
    repo = _make_full_repo(base, "nocore")
    shutil.rmtree(repo / "core")
    return repo


def _seed_pack(name: str, with_compiler: bool = True,
               with_core: bool = True) -> Path:
    """直接落盘 pack（绕过 import——inject/builds 的隔离夹具）。"""
    pack = _pack_root() / name
    pack.mkdir(parents=True, exist_ok=True)
    (pack / "INDEX.yaml").write_text(INDEX_YAML, encoding="utf-8")
    (pack / "meta.json").write_text(
        json.dumps({"url": GH, "ref": "main", "commit": "c1",
                    "imported_at": "2026-10-25T00:00:00Z", "files": []}),
        encoding="utf-8")
    if with_compiler:
        c = pack / "compiler"
        c.mkdir()
        (c / "millforge-compile.py").write_text(FAKE_COMPILER,
                                                encoding="utf-8")
    if with_core:
        core = pack / "core"
        (core / "schemas").mkdir(parents=True)
        (core / "protocol").mkdir()
        (core / "scripts").mkdir()
        (core / "README.md").write_text("# 千锻核心层\n", encoding="utf-8")
        (core / "schemas" / "team.schema.json").write_text(
            json.dumps(TEAM_SCHEMA, ensure_ascii=False, indent=1),
            encoding="utf-8")
        (core / "protocol" / "nmh.md").write_text("# NMH\n",
                                                  encoding="utf-8")
        (core / "scripts" / "x.sh").write_text("#!/bin/sh\n",
                                               encoding="utf-8")
    (pack / "PHILOSOPHY.md").write_text(PHILOSOPHY_MD, encoding="utf-8")
    return pack


def _pack_root() -> Path:
    return cfgmod._CONFIG_DIR / "templates"


def _builds_root() -> Path:
    return cfgmod._CONFIG_DIR / "millforge-builds"


# ── 假 controller（millforge_api._ctl_call 单点注入；零真实拨号）────


class FakeCtl:
    def __init__(self):
        self.calls: list = []
        self.workers: dict = {}   # name -> {name, soul, runtime, model, skills}
        self.uploads: list = []   # {path, form, files}
        self.put_fail: set = set()  # PUT /workers/{name} → 404 的名集

    def seed_worker(self, name: str, soul: str = "", skills: list | None = None):
        self.workers[name] = {"name": name, "soul": soul, "runtime": "qwenpaw",
                              "model": None, "skills": list(skills or [])}

    async def __call__(self, method, path, token, json_body=None,
                       files=None, form=None):
        self.calls.append({"method": method, "path": path, "token": token,
                           "json_body": json_body, "files": files,
                           "form": form})
        assert token == "ctok123", f"token 应走 L1 解析链（收到 {token!r}）"
        if files is not None:
            assert method == "POST" and path.endswith("/api/v1/skills")
            self.uploads.append({"path": path, "form": dict(form or {}),
                                 "files": files})
            return 200, {"ok": True}
        if method == "POST" and path.endswith("/api/v1/workers"):
            name = json_body["name"]
            self.workers[name] = {
                "name": name, "soul": json_body.get("soul"),
                "runtime": json_body.get("runtime"),
                "model": json_body.get("model"), "skills": [],
            }
            return 201, {"ok": True}
        if method == "GET" and path.endswith("/api/v1/workers"):
            # Mirror the real controller: workers live under "workers" with a
            # "total" sibling (the old fake returned "items", which hid the
            # producer/consumer key mismatch).
            return 200, {"workers": list(self.workers.values()),
                         "total": len(self.workers)}
        m = re.search(r"/api/v1/workers/([^/]+)$", path)
        if m:
            name = unquote(m.group(1))
            if method == "GET":
                w = self.workers.get(name)
                if w is None:
                    return 404, {"detail": "worker not found"}
                return 200, w
            if method == "PUT":
                if name in self.put_fail or name not in self.workers:
                    return 404, {"detail": "worker not found"}
                w = self.workers[name]
                if "soul" in json_body:
                    w["soul"] = json_body["soul"]
                if "skills" in json_body:
                    w["skills"] = json_body["skills"]
                return 200, w
        return 404, {"detail": f"unhandled {method} {path}"}


@pytest.fixture
def client(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    state = {
        "data": {
            "controller_urls": [CTL_BASE],
            "controller_token": "ctok123",
            "matrix_homeservers": ["http://10.0.0.1:8008"],
            "matrix": {"user_id": "@human:hs", "access_token": "mtok123"},
        }
    }

    def fake_load():
        return json.loads(json.dumps(state["data"]))

    monkeypatch.setattr(cfgmod, "load_config", fake_load)
    monkeypatch.delenv("AGENTTEAMS_CONTROLLER_TOKEN", raising=False)

    repo = _make_full_repo(tmp_path)
    repo_nocore = _make_nocore_repo(tmp_path)
    repos = {GH: repo, GH_CAP: repo, GC: repo,
             "https://github.com/nocore/millforge-nc.git": repo_nocore}
    fake_git = _FakeGit(repos)
    monkeypatch.setattr(tpl, "_run_git", fake_git)

    fake_ctl = FakeCtl()
    monkeypatch.setattr(mfg, "_ctl_call", fake_ctl)

    app = FastAPI()
    app.include_router(build_router())
    return TestClient(app), state, fake_ctl, fake_git, repos


def _build_dir(build_id: str) -> Path:
    return _builds_root() / build_id


def _no_builds_left() -> bool:
    b = _builds_root()
    return not (b.is_dir() and any(b.iterdir()))


def _import_pack(tc, repo: str = "LUOSENGWA/millforge") -> dict:
    """PUT 源配置 + POST 导入（幂等整包覆盖）→ 成功断言 + 返回 payload。"""
    tc.put("/millforge/source", json={"kind": "github", "repo": repo})
    r = tc.post("/millforge/import", json={})
    assert r.status_code == 200, r.text
    return r.json()


def _compile_combo(tc, team: str, **extra) -> dict:
    """导入默认 pack 后走 INDEX teams 组合编译（成功断言 + 返回 payload）。"""
    _import_pack(tc)
    body = {"team": team,
            "template": {"team_combo": "biz-market"}}
    body.update(extra)
    r = tc.post("/millforge/compile", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── S1 源配置 ───────────────────────────────────────────────────────


def test_source_get_default(client):
    tc, *_ = client
    r = tc.get("/millforge/source")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["kind"] == "github"
    assert d["repo"] == "LUOSENGWA/Millforge"
    assert d["custom_url"] == ""
    assert d["resolved_url"] == GH_CAP
    assert d["updated_at"] == ""  # 未保存过


def test_source_put_persists_and_derives(client):
    tc, *_ = client
    r = tc.put("/millforge/source",
               json={"kind": "gitcode", "repo": "acme/millforge"})
    assert r.status_code == 200, r.text
    assert r.json()["resolved_url"] == GC
    assert r.json()["updated_at"]  # 落盘时间戳
    # 持久化：再 GET 读回
    d = tc.get("/millforge/source").json()
    assert d["kind"] == "gitcode"
    assert d["repo"] == "acme/millforge"
    assert d["resolved_url"] == GC


def test_source_put_merge_semantics(client):
    tc, *_ = client
    tc.put("/millforge/source", json={"kind": "gitcode", "repo": "a/b"})
    # 只给 repo → kind 保留现值（gitcode）
    r = tc.put("/millforge/source", json={"repo": "a/c"})
    assert r.json()["kind"] == "gitcode"
    assert r.json()["resolved_url"] == "https://gitcode.com/a/c.git"
    # custom_url 覆盖派生
    r = tc.put("/millforge/source",
               json={"custom_url": "https://gitee.com/m/m.git"})
    assert r.json()["resolved_url"] == "https://gitee.com/m/m.git"
    # custom_url 空 = 清空 → 回派生（kind/repo 仍保留）
    r = tc.put("/millforge/source", json={"custom_url": ""})
    assert r.json()["custom_url"] == ""
    assert r.json()["resolved_url"] == "https://gitcode.com/a/c.git"


def test_source_put_validation_400(client):
    tc, *_ = client
    # 非法 kind
    r = tc.put("/millforge/source", json={"kind": "gitlab"})
    assert r.status_code == 400
    assert "github / gitcode" in r.json()["detail"]
    # repo 无 org 段
    r = tc.put("/millforge/source", json={"kind": "github", "repo": "only"})
    assert r.status_code == 400
    assert "org/repo" in r.json()["detail"]
    # custom_url 非 https
    r = tc.put("/millforge/source",
               json={"custom_url": "http://github.com/a/b.git"})
    assert r.status_code == 400
    assert "https" in r.json()["detail"]
    # custom_url host 白名单外
    r = tc.put("/millforge/source",
               json={"custom_url": "https://evil.example.com/a/b.git"})
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]


# ── S2 导入（走源配置派生 URL）──────────────────────────────────────


def test_import_via_source_config(client):
    tc, state, ctl, fake_git, repos = client
    tc.put("/millforge/source", json={"kind": "github",
                                      "repo": "LUOSENGWA/millforge"})
    r = tc.post("/millforge/import", json={"ref": "main"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True
    assert d["pack"] == "millforge"
    assert d["url"] == GH  # 源配置派生
    assert d["has_compiler"] is True
    assert d["has_core"] is True
    assert d["commit"] == "deadbeef0123456789"
    pack = _pack_root() / "millforge"
    assert (pack / "compiler" / "millforge-compile.py").is_file()
    assert (pack / "core" / "schemas" / "team.schema.json").is_file()
    assert (pack / "PHILOSOPHY.md").is_file()
    meta = json.loads((pack / "meta.json").read_text(encoding="utf-8"))
    assert meta["source"] == "github"
    # git 拨号用的正是派生 URL
    clone_calls = [c for c in fake_git.calls if c and c[0] == "clone"]
    assert clone_calls and clone_calls[-1][-2] == GH


def test_import_default_source_and_override(client):
    tc, _, _, fake_git, repos = client
    # 默认源（未 PUT 过）→ 派生 GH_CAP
    r = tc.post("/millforge/import", json={})
    assert r.status_code == 200, r.text
    assert r.json()["url"] == GH_CAP
    assert r.json()["pack"] == "Millforge"
    # 重复导入 = 整包覆盖（仓库演进：删旧加新）
    (repos[GH_CAP] / "templates" / "fragments" / "nmh.md").unlink()
    (repos[GH_CAP] / "templates" / "fragments" / "new.md").write_text(
        "# new\n", encoding="utf-8")
    r = tc.post("/millforge/import", json={})
    assert r.status_code == 200
    pack = _pack_root() / "Millforge"
    assert not (pack / "fragments" / "nmh.md").exists()
    assert (pack / "fragments" / "new.md").is_file()
    meta = json.loads((pack / "meta.json").read_text(encoding="utf-8"))
    assert "fragments/nmh.md" not in meta["files"]
    assert "fragments/new.md" in meta["files"]


def test_import_failure_502(client, monkeypatch):
    tc, _, _, fake_git, _ = client
    monkeypatch.setattr(fake_git, "fail", True)
    r = tc.post("/millforge/import", json={})
    assert r.status_code == 502
    assert "git clone 失败" in r.json()["detail"]
    assert not _pack_root().exists()


# ── C1/C2 编译：两条输入路径 ────────────────────────────────────────


def test_compile_template_combo_assembles_team_doc(client):
    tc, *_ = client
    d = _compile_combo(tc, "biz-team")
    assert d["ok"] is True
    assert d["source"] == "template"
    assert d["team"] == "biz-team"
    assert d["pack"] == "millforge"
    roles = {x["role"]: x for x in d["roles"]}
    assert set(roles) == {"lead", "w1", "w2", "critic"}
    assert roles["lead"]["kind"] == "leader"
    assert roles["lead"]["budget"] == 250
    assert roles["w1"]["kind"] == "worker"
    assert roles["w1"]["budget"] == 150
    assert roles["critic"]["budget"] == 150
    for x in d["roles"]:
        assert x["budget_ok"] is True
        assert re.fullmatch(r"[0-9a-f]{64}", x["soul_sha256"])
        assert x["lines"] > 0
        assert "MILLFORGE-COMPILED" in x["soul"]
    assert d["fragments"] == ["fragments/nmh.md"]
    prov = d["provenance"]
    assert prov["team"] == "biz-team"
    assert prov["instance_fp"] == "0123456789abcdef"
    assert prov["experimental"] is False

    # 组装的 team.json（received.json）断言
    received = json.loads(
        (_build_dir(d["build_id"]) / "received.json").read_text("utf-8"))
    assert received["name"] == "biz-team"
    assert received["mode"] == "multi_user"
    assert received["template"] == "software"  # combo 自动带 industry
    assert received["experimental"] is False
    assert received["roster"] == [{"id": "human-owner",
                                   "role": "accountable", "weight": 1.0}]
    assert "coordinator" not in [x["kind"] for x in received["roles"]]
    by_id = {x["id"]: x for x in received["roles"]}
    assert by_id["lead"]["kind"] == "leader"
    assert by_id["lead"]["spawn"] is False
    assert by_id["w1"]["kind"] == "worker"
    assert by_id["w1"]["spawn"] is True
    # domains 轮转 + skills 同值
    assert by_id["w1"]["domains"] == ["mobile"]
    assert by_id["w1"]["skills"] == ["mobile"]
    assert by_id["w2"]["domains"] == ["llm-app"]
    assert by_id["w2"]["skills"] == ["llm-app"]
    assert "biz-team" in received["charter"]["mission"]
    # schema 自洽：组装产物过 Draft7 校验
    import jsonschema
    jsonschema.validate(received, TEAM_SCHEMA)


def test_compile_template_manual_industry_domains(client):
    tc, *_ = client
    _import_pack(tc)
    body = {"team": "manual-team",
            "template": {"industry": "software",
                         "domains": ["mobile"],
                         "members": {"leader": 1, "workers": 1}}}
    r = tc.post("/millforge/compile", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert [x["role"] for x in d["roles"]] == ["lead", "w1"]
    received = json.loads(
        (_build_dir(d["build_id"]) / "received.json").read_text("utf-8"))
    assert received["roles"][1]["domains"] == ["mobile"]
    # 无 critic（默认 0）
    assert received["charter"]["scope"] == ["mobile"]


def test_compile_team_json_path(client):
    tc, *_ = client
    _import_pack(tc)
    body = {"team": "custom-team", "team_json": dict(VALID_TEAM),
            "pack": "millforge"}
    r = tc.post("/millforge/compile", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["source"] == "custom"
    assert [x["role"] for x in d["roles"]] == ["lead", "w1", "critic"]
    received = json.loads(
        (_build_dir(d["build_id"]) / "received.json").read_text("utf-8"))
    assert received["name"] == "custom-team"  # name 以 team 参数为准
    assert received["lang"] == "zh"
    assert received["roles"] == VALID_TEAM["roles"]


def test_compile_budget_override_applied(client):
    tc, *_ = client
    d = _compile_combo(tc, "override-team", budget_override={"worker": 200})
    roles = {x["role"]: x for x in d["roles"]}
    assert roles["w1"]["budget"] == 200  # 假编译器按 kind 覆盖
    assert roles["lead"]["budget"] == 250  # leader 不受 worker 覆盖影响


def test_compile_en_lang_flag(client):
    tc, *_ = client
    d = _compile_combo(tc, "en-team", lang="en")
    received = json.loads(
        (_build_dir(d["build_id"]) / "received.json").read_text("utf-8"))
    assert received["lang"] == "en"


# ── C3 失败映射（非 0 退出 → 422 + 结构）────────────────────────────


def test_compile_exit2_validate_422(client):
    tc, *_ = client
    _import_pack(tc)
    r = tc.post("/millforge/compile",
                json={"team": "fail-validate-x",
                      "template": {"team_combo": "biz-market"}})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["exit_code"] == 2
    assert d["stage"] == "validate"
    assert d["error"]
    assert d["errors"] == [{"path": "roles", "message": "minItems 2"}]
    # 失败不留半 build
    assert _no_builds_left()


def test_compile_exit4_budget_422(client):
    tc, *_ = client
    _import_pack(tc)
    r = tc.post("/millforge/compile",
                json={"team": "fail-budget-x",
                      "template": {"team_combo": "biz-market"}})
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["exit_code"] == 4
    assert d["stage"] == "budget"
    assert d["over_budget"] == [{"role": "w1", "lines": 200, "budget": 150}]
    assert _no_builds_left()


# ── C4 编译前置校验 ─────────────────────────────────────────────────


def test_compile_prechecks_400(client):
    tc, *_ = client
    # 无 pack
    r = tc.post("/millforge/compile",
                json={"team": "no-pack-team",
                      "template": {"team_combo": "biz-market"}})
    assert r.status_code == 400
    assert "尚未导入模板包" in r.json()["detail"]
    # team 名非法（大写 / 过短）
    _seed_pack("seeded")
    r = tc.post("/millforge/compile",
                json={"team": "BadName",
                      "template": {"team_combo": "biz-market"}})
    assert r.status_code == 400
    assert "kebab-case" in r.json()["detail"]
    r = tc.post("/millforge/compile",
                json={"team": "ab", "team_json": dict(VALID_TEAM)})
    assert r.status_code == 400
    # 互斥：两个都给 / 都不给
    r = tc.post("/millforge/compile",
                json={"team": "both-team", "team_json": dict(VALID_TEAM),
                      "template": {"team_combo": "biz-market"}})
    assert r.status_code == 400
    assert "恰好给一个" in r.json()["detail"]
    r = tc.post("/millforge/compile", json={"team": "none-team"})
    assert r.status_code == 400
    # lang 非法
    r = tc.post("/millforge/compile",
                json={"team": "lang-team", "team_json": dict(VALID_TEAM),
                      "lang": "fr"})
    assert r.status_code == 400
    # budget_override 键 / 范围
    r = tc.post("/millforge/compile",
                json={"team": "bo-team", "team_json": dict(VALID_TEAM),
                      "budget_override": {"boss": 100}})
    assert r.status_code == 400
    assert "kind" in r.json()["detail"]
    r = tc.post("/millforge/compile",
                json={"team": "bo-team", "team_json": dict(VALID_TEAM),
                      "budget_override": {"worker": 10}})
    assert r.status_code == 400
    assert "60-500" in r.json()["detail"]
    # industry 不在 schema 枚举（对含编译器的包——组装校验先于编译器执行）
    r = tc.post("/millforge/compile",
                json={"team": "badind-team",
                      "template": {"industry": "aerospace",
                                   "members": {"workers": 2}}})
    assert r.status_code == 400
    assert "枚举" in r.json()["detail"]
    # domain 不在 INDEX
    r = tc.post("/millforge/compile",
                json={"team": "baddom-team",
                      "template": {"industry": "software",
                                   "domains": ["quantum"],
                                   "members": {"workers": 2}}})
    assert r.status_code == 400
    assert "INDEX domains" in r.json()["detail"]
    # members 非整数
    r = tc.post("/millforge/compile",
                json={"team": "badmem-team",
                      "template": {"members": {"workers": "很多"}}})
    assert r.status_code == 400
    assert "整数" in r.json()["detail"]
    # 角色数超 8
    r = tc.post("/millforge/compile",
                json={"team": "bigteam-team",
                      "template": {"members": {"leader": 1, "workers": 8}}})
    assert r.status_code == 400
    assert "≤8" in r.json()["detail"]
    # 无 compiler 的包（清掉 seeded 换 nocomp——tmp 目录内测试夹具）
    shutil.rmtree(_pack_root() / "seeded")
    _seed_pack("nocomp", with_compiler=False)
    r = tc.post("/millforge/compile",
                json={"team": "nocomp-team", "team_json": dict(VALID_TEAM),
                      "pack": "nocomp"})
    assert r.status_code == 400
    assert "未含编译器" in r.json()["detail"]
    # 不存在的 pack
    r = tc.post("/millforge/compile",
                json={"team": "ghost-team", "team_json": dict(VALID_TEAM),
                      "pack": "ghost"})
    assert r.status_code == 404


def test_compile_no_pack_before_import(client):
    """GET /millforge/packs 空态 + compile 400 文案一致（前端就地引导）。"""
    tc, *_ = client
    assert tc.get("/millforge/packs").json() == {"packs": []}
    r = tc.post("/millforge/compile",
                json={"team": "x-y-z", "team_json": dict(VALID_TEAM)})
    assert r.status_code == 400
    assert "选择源并导入" in r.json()["detail"]


# ── C5 builds 留 20 ─────────────────────────────────────────────────


def test_builds_keep_20(client):
    tc, *_ = client
    _import_pack(tc)
    root = _builds_root()
    base = time.time() - 600
    for i in range(21):
        d = root / f"mf-seed-{i:03d}"
        d.mkdir(parents=True, exist_ok=True)
        bj = d / "build.json"
        bj.write_text(json.dumps(
            {"build_id": f"mf-seed-{i:03d}",
             "created_at": f"2026-10-24T{i:02d}:00:00Z"}), encoding="utf-8")
        os.utime(bj, (base + i * 5, base + i * 5))
    d = _compile_combo(tc, "prune-team")
    new_id = d["build_id"]
    remaining = {p.name for p in root.iterdir() if p.is_dir()}
    assert len(remaining) == 20  # 21 旧 + 1 新 = 22 → 清最旧 2
    assert "mf-seed-000" not in remaining
    assert "mf-seed-001" not in remaining
    assert "mf-seed-020" in remaining
    assert new_id in remaining
    d = tc.get("/millforge/builds").json()
    assert len(d["builds"]) == 20
    assert d["builds"][0]["build_id"] == new_id  # created_at 倒序


# ── I 注入 ──────────────────────────────────────────────────────────


def _compile_and_build(tc, team: str, **extra) -> dict:
    return _compile_combo(tc, team, **extra)


def test_inject_update_existing_workers(client):
    tc, state, ctl, *_ = client
    _import_pack(tc)
    b = _compile_and_build(tc, "inject-team")
    ctl.seed_worker("lead-bot", soul="old")
    ctl.seed_worker("w1-bot")
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "inject-team",
        "mapping": {"lead": "lead-bot", "w1": "w1-bot"},
        "core_skill": False,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True and d["partial"] is False
    souls = {e["worker"]: e for e in d["souls"]}
    assert set(souls) == {"lead-bot", "w1-bot"}
    assert souls["lead-bot"]["status"] == "ok"
    assert souls["lead-bot"]["verified"] is True
    assert souls["lead-bot"]["role_id"] == "lead"
    # SOUL 真落到 controller（读回 = build 内 SOUL）
    assert ctl.workers["lead-bot"]["soul"] == b["roles"][
        next(i for i, x in enumerate(b["roles"]) if x["role"] == "lead")
    ]["soul"]
    # 调用序：PUT soul → GET 读回（每 worker 两发）
    methods = [(c["method"], c["path"].rstrip()) for c in ctl.calls]
    assert ("PUT", f"{CTL_BASE}/api/v1/workers/lead-bot") in methods
    assert ("GET", f"{CTL_BASE}/api/v1/workers/lead-bot") in methods
    assert d["core_skill"]["status"] == "skipped"
    # 注入历史落盘
    inj = tc.get("/millforge/injections").json()["injections"]
    assert len(inj) == 1
    assert inj[0]["build_id"] == b["build_id"]
    assert inj[0]["team"] == "inject-team"
    assert inj[0]["partial"] is False


def test_inject_create_workers(client):
    tc, state, ctl, *_ = client
    _import_pack(tc)
    b = _compile_and_build(tc, "create-team")
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "create-team",
        "create_workers": [
            {"name": "new-lead", "role_id": "lead", "role": "team_leader"},
            {"name": "new-w1", "role_id": "w1", "role": "worker",
             "model": "qwen3-max"},
        ],
        "core_skill": False,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["partial"] is False
    created = {e["name"]: e for e in d["created"]}
    assert set(created) == {"new-lead", "new-w1"}
    assert created["new-lead"]["status"] == "ok"
    assert created["new-lead"]["verified"] is True
    assert created["new-w1"]["status"] == "ok"
    # POST /workers 带 SOUL + model
    assert "new-lead" in ctl.workers
    assert ctl.workers["new-lead"]["soul"].startswith("<!-- MILLFORGE-COMPILED")
    assert ctl.workers["new-w1"]["model"] == "qwen3-max"
    # 无 PUT（新建路径不更新现有）
    assert all(c["method"] != "PUT" for c in ctl.calls)


def test_inject_core_skill_zip_and_assign(client):
    tc, state, ctl, *_ = client
    _import_pack(tc)
    b = _compile_and_build(tc, "skill-team")
    ctl.seed_worker("solo-bot", soul="x")
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "skill-team",
        "mapping": {"w1": "solo-bot"}, "core_skill": True,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    cs = d["core_skill"]
    assert cs["status"] == "ok"
    assert cs["skill"] == "millforge-core"
    assert cs["assigned"] == ["solo-bot"]
    # zip 内容断言
    assert len(ctl.uploads) == 1
    up = ctl.uploads[0]
    fn, data, ct = up["files"]["file"]
    assert fn == "millforge-core.zip"
    assert ct == "application/zip"
    assert up["form"] == {"scope": "team", "team": "skill-team"}
    zf = zipfile.ZipFile(BytesIO(data))
    names = zf.namelist()
    # 控制器要求单个顶层技能目录（目录名 = 技能名）；根级条目会被
    # "the zip must contain a single top-level skill directory" 400 拒。
    assert "millforge-core/SKILL.md" in names
    assert "millforge-core/references/protocol/nmh.md" in names
    assert "millforge-core/scripts/x.sh" in names
    assert all(n.split("/")[0] == "millforge-core" for n in names), names
    skill_md = zf.read("millforge-core/SKILL.md").decode("utf-8")
    assert skill_md.startswith("---\nname: millforge-core\n")
    assert "description:" in skill_md
    assert zf.read("millforge-core/references/protocol/nmh.md") == \
        "# NMH 协议\n".encode("utf-8")
    # worker skills 追加
    assert ctl.workers["solo-bot"]["skills"] == ["millforge-core"]


def test_inject_partial_failure_reports_honestly(client):
    tc, state, ctl, *_ = client
    _import_pack(tc)
    b = _compile_and_build(tc, "partial-team")
    ctl.seed_worker("good-bot")
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "partial-team",
        "mapping": {"lead": "good-bot", "w1": "ghost-bot"},
        "core_skill": False,
    })
    assert r.status_code == 200  # 部分失败 = HTTP 200 + partial
    d = r.json()
    assert d["ok"] is True
    assert d["partial"] is True
    souls = {e["worker"]: e for e in d["souls"]}
    assert souls["good-bot"]["status"] == "ok"
    assert souls["ghost-bot"]["status"] == "error"
    assert "404" in souls["ghost-bot"]["error"]
    # 历史也如实记 partial
    inj = tc.get("/millforge/injections").json()["injections"]
    assert inj[0]["partial"] is True


def test_inject_core_skill_partial_when_worker_missing(client):
    """映射 worker 无 skills 数据 → core_skill partial（不炸全队）。"""
    tc, state, ctl, *_ = client
    _import_pack(tc)
    b = _compile_and_build(tc, "skill2-team")
    # 不 seed 任何 worker → PUT soul 404（souls error）+ skills 无数据
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "skill2-team",
        "mapping": {"w1": "nowhere-bot"}, "core_skill": True,
    })
    assert r.status_code == 200
    d = r.json()
    assert d["partial"] is True
    assert d["souls"][0]["status"] == "error"
    assert d["core_skill"]["status"] == "partial"
    assert "无 skills 数据" in d["core_skill"]["detail"]


def test_inject_core_skill_skipped_without_core(client):
    tc, state, ctl, *_ = client
    # 无 core 的包（独立 slug "millforge-nc"，避免与默认 pack 同名覆盖）
    d = _import_pack(tc, repo="nocore/millforge-nc")
    assert d["pack"] == "millforge-nc"
    assert d["has_core"] is False
    r = tc.post("/millforge/compile", json={
        "team": "nocore-team", "pack": "millforge-nc",
        "template": {"team_combo": "biz-market"}})
    assert r.status_code == 200, r.text
    b = r.json()
    ctl.seed_worker("nc-bot")
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "nocore-team",
        "mapping": {"w1": "nc-bot"}, "core_skill": True,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["core_skill"]["status"] == "skipped"
    assert "core/" in d["core_skill"]["detail"]
    assert d["partial"] is False  # skipped 不算失败
    assert ctl.uploads == []


def test_inject_prechecks(client):
    tc, state, ctl, *_ = client
    # 无 build → 404
    r = tc.post("/millforge/inject",
                json={"build_id": "mf-none", "team": "t",
                      "mapping": {"w1": "x"}})
    assert r.status_code == 404
    # 预算不绿 → 400（手工造一个 budget_ok=false 的 build）
    _import_pack(tc)
    b = _compile_and_build(tc, "red-team")
    bdir = _build_dir(b["build_id"])
    meta = json.loads((bdir / "build.json").read_text("utf-8"))
    meta["roles"][0]["budget_ok"] = False
    (bdir / "build.json").write_text(json.dumps(meta), encoding="utf-8")
    r = tc.post("/millforge/inject", json={
        "build_id": b["build_id"], "team": "red-team",
        "mapping": {"lead": "x"}, "core_skill": False})
    assert r.status_code == 400
    assert "预算未全绿" in r.json()["detail"]
    # 无注入对象 → 400
    b2 = _compile_and_build(tc, "empty-map-team")
    r = tc.post("/millforge/inject",
                json={"build_id": b2["build_id"], "team": "t"})
    assert r.status_code == 400
    assert "无注入对象" in r.json()["detail"]
    # 无操作（apply_soul=false + core_skill=false）→ 400
    r = tc.post("/millforge/inject", json={
        "build_id": b2["build_id"], "team": "t",
        "mapping": {"w1": "x"}, "apply_soul": False, "core_skill": False})
    assert r.status_code == 400
    assert "无操作" in r.json()["detail"]
    # mapping 角色不在 build → 400
    r = tc.post("/millforge/inject", json={
        "build_id": b2["build_id"], "team": "t",
        "mapping": {"nobody": "x"}, "core_skill": False})
    assert r.status_code == 400
    assert "不在 build" in r.json()["detail"]
    # create_workers role_id 不在 build → 400
    r = tc.post("/millforge/inject", json={
        "build_id": b2["build_id"], "team": "t",
        "create_workers": [{"name": "n1", "role_id": "nobody"}],
        "core_skill": False})
    assert r.status_code == 400
    assert "不在 build" in r.json()["detail"]
    # 无 token → 401
    state["data"]["controller_token"] = ""
    r = tc.post("/millforge/inject", json={
        "build_id": b2["build_id"], "team": "t",
        "mapping": {"w1": "x"}, "core_skill": False})
    assert r.status_code == 401
    assert "token" in r.json()["detail"].lower()


# ── P1 prompt ───────────────────────────────────────────────────────


def test_prompt_assembly(client):
    tc, *_ = client
    _import_pack(tc)
    form = {
        "members": "1 个 Leader + 2 个 Worker",
        "task_types": "内容生产与分发",
        "runtime": "QwenPaw",
        "pains": "验收无证据、scope 漂移、预算失控",
        "team_name": "content-team",
    }
    r = tc.post("/millforge/prompt", json={"pack": "millforge",
                                           "form": form})
    assert r.status_code == 200, r.text
    p = r.json()["prompt"]
    # PHILOSOPHY 全文 + schema 全文
    assert "## 一 基本立场" in p
    assert '"additionalProperties": false' in p or \
        '"additionalProperties": False' in p
    # §十骨架行级填充段（占位全部被表单值替换；PHILOSOPHY 原文段本身
    # 含占位——只查填充段）
    seg = p.split("# 千锻二次生成指令")[1].split("# team.schema.json")[0]
    assert "成员：1 个 Leader + 2 个 Worker" in seg
    assert "任务类型：内容生产与分发" in seg
    assert "运行时：QwenPaw" in seg
    assert "最痛的 3 个问题：验收无证据、scope 漂移、预算失控" in seg
    assert "{…}" not in seg  # 占位不留
    assert "N 个 Agent + 角色分工" not in seg
    # 严格输出约束
    assert "只输出一个 JSON" in p
    assert "需人确认" in p
    assert "name 用 content-team" in p
    assert "multi_user" in p


def test_prompt_missing_pack_or_philosophy_400(client):
    tc, *_ = client
    r = tc.post("/millforge/prompt", json={})
    assert r.status_code == 400
    assert "尚未导入模板包" in r.json()["detail"]
    # 有 pack 但无 PHILOSOPHY.md
    pack = _seed_pack("nophi", with_compiler=False)
    (pack / "PHILOSOPHY.md").unlink()
    r = tc.post("/millforge/prompt", json={"pack": "nophi"})
    assert r.status_code == 400
    assert "PHILOSOPHY.md" in r.json()["detail"]


def test_prompt_empty_form_fallbacks(client):
    tc, *_ = client
    _import_pack(tc)
    r = tc.post("/millforge/prompt", json={"pack": "millforge",
                                           "form": {}})
    assert r.status_code == 200, r.text
    p = r.json()["prompt"]
    assert "（未提供" in p
    assert "name 用 小写 kebab-case" in p


# ── P2 parse-team-json ──────────────────────────────────────────────


def _seed_schema_pack(client, name: str = "mf", drop_schema: bool = False):
    pack = _seed_pack(name)
    if drop_schema:
        (pack / "core" / "schemas" / "team.schema.json").unlink()
    return pack


def test_parse_fenced_json_ok(client):
    tc, *_ = client
    _import_pack(tc)
    text = ("好的，这是团队 JSON：\n```json\n"
            + json.dumps(VALID_TEAM, ensure_ascii=False, indent=1)
            + "\n```\n希望有帮助！")
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "millforge", "text": text})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True
    assert d["team"] == VALID_TEAM


def test_parse_raw_json_and_error_paths(client):
    tc, *_ = client
    _import_pack(tc)
    # 无围栏裸 JSON
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "millforge",
                      "text": json.dumps(VALID_TEAM, ensure_ascii=False)})
    assert r.json()["ok"] is True
    # 缺字段（roles）→ path
    bad = dict(VALID_TEAM)
    del bad["roles"]
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "millforge",
                      "text": json.dumps(bad, ensure_ascii=False)})
    d = r.json()
    assert d["ok"] is False
    assert any(e["path"] == "roles" for e in d["errors"])
    # name pattern 违规
    bad2 = dict(VALID_TEAM)
    bad2["name"] = "Bad_Name"
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "millforge",
                      "text": json.dumps(bad2, ensure_ascii=False)})
    d = r.json()
    assert d["ok"] is False
    assert any(e["path"] == "name" for e in d["errors"])
    # additionalProperties 违规（多余字段）
    bad3 = dict(VALID_TEAM)
    bad3["vibes"] = "great"
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "millforge",
                      "text": json.dumps(bad3, ensure_ascii=False)})
    d = r.json()
    assert d["ok"] is False
    assert any(e["path"] == "vibes" for e in d["errors"])
    # 垃圾文本 → 提取失败
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "millforge", "text": "这里没有 JSON 对象。"})
    d = r.json()
    assert d["ok"] is False
    assert d["errors"][0]["path"] == ""
    assert "无法" in d["errors"][0]["message"]
    # 无 schema 的包 → 400
    _seed_schema_pack(client, "noschema", drop_schema=True)
    r = tc.post("/millforge/parse-team-json",
                json={"pack": "noschema", "text": "{}"})
    assert r.status_code == 400
    assert "team.schema.json" in r.json()["detail"]


# ── H1 builds 列表/详情/文件 + injections ───────────────────────────


def test_builds_list_detail_and_file(client):
    tc, *_ = client
    _import_pack(tc)
    b = _compile_and_build(tc, "hist-team")
    bid = b["build_id"]
    # 列表
    d = tc.get("/millforge/builds").json()
    assert d["builds"][0]["build_id"] == bid
    assert d["builds"][0]["team"] == "hist-team"
    assert "soul" not in d["builds"][0]["roles"][0]  # 列表不含 SOUL 全文
    # 详情
    d = tc.get(f"/millforge/builds/{bid}").json()
    assert d["build_id"] == bid
    assert d["source"] == "template"
    # 文件读（SOUL 全文 + team.json）
    r = tc.get(f"/millforge/builds/{bid}/file",
               params={"path": "lead.soul.md"})
    assert r.status_code == 200, r.text
    assert "MILLFORGE-COMPILED" in r.json()["content"]
    r = tc.get(f"/millforge/builds/{bid}/file",
               params={"path": "team.json"})
    assert r.status_code == 200
    # 防穿越 / 扩展名
    r = tc.get(f"/millforge/builds/{bid}/file",
               params={"path": "../secret.md"})
    assert r.status_code == 400
    r = tc.get(f"/millforge/builds/{bid}/file",
               params={"path": "/etc/passwd"})
    assert r.status_code == 400
    r = tc.get(f"/millforge/builds/{bid}/file", params={"path": ""})
    assert r.status_code == 400
    # 不存在的 build
    assert tc.get("/millforge/builds/mf-ghost").status_code == 404
    # injections 空态
    assert tc.get("/millforge/injections").json() == {"injections": []}


def test_packs_list_and_file_preview(client):
    tc, *_ = client
    _import_pack(tc)
    d = tc.get("/millforge/packs").json()
    assert len(d["packs"]) == 1
    p = d["packs"][0]
    assert p["pack"] == "millforge"
    assert p["meta"]["has_compiler"] is True
    assert p["meta"]["has_core"] is True
    # INDEX teams 段可解析（整队组合列表源）
    assert p["parse_error"] is None
    teams = {e["id"]: e for e in p["index"]["teams"]}
    assert teams["biz-market"]["industry"] == "software"
    assert teams["biz-market"]["members"] == {"leader": "1",
                                              "workers": "2",
                                              "critic": "1"}
    # 文件预览：.json/.py 允许（templates 域只 .md/.yaml）
    r = tc.get("/millforge/packs/millforge/file",
               params={"path": "core/schemas/team.schema.json"})
    assert r.status_code == 200, r.text
    r = tc.get("/millforge/packs/millforge/file",
               params={"path": "compiler/millforge-compile.py"})
    assert r.status_code == 200
    # 防穿越
    r = tc.get("/millforge/packs/millforge/file",
               params={"path": "../../evil.md"})
    assert r.status_code == 400


def test_ctl_call_normalizes_full_url_and_path_only(monkeypatch):
    """回归：_ctl_call 的契约是 path-only（base 由内部 ordered 地址拼），但历史
    调用点传的是完整 URL `f"{base}/api/v1/..."`；朴素拼接产生双 base
    （``https://h:7113https://h:7113/api/v1/...``）→ 网关回 301 或挂到超时，
    千锻所有 SOUL 更新 / 新建 Worker / core skill 调用全部失败。入口必须把
    两种形态归一成同一个单 base URL。
    """
    import asyncio

    import agentteams_connector.ctl_client as ctlmod

    cfg = {
        "controller_urls": ["http://ctrl.test:8080"],
        "address_mode": "auto",
        "controller_token": "test-token",
    }
    monkeypatch.setattr(cfgmod, "load_config", lambda: cfg)

    seen: list = []

    async def fake_ctl_json(method, url, token, json_body=None):
        seen.append(url)
        return 404, {"message": "get worker for update: not found"}, ""

    monkeypatch.setattr(ctlmod, "ctl_json", fake_ctl_json)

    async def run():
        # 历史调用点形态：完整 URL
        await mfg._ctl_call(
            "PUT",
            "http://ctrl.test:8080/api/v1/workers/w1",
            "test-token",
            json_body={"soul": "s"},
        )
        # 契约形态：path-only
        await mfg._ctl_call(
            "PUT", "/api/v1/workers/w1", "test-token", json_body={"soul": "s"}
        )

    asyncio.run(run())

    assert seen == [
        "http://ctrl.test:8080/api/v1/workers/w1",
        "http://ctrl.test:8080/api/v1/workers/w1",
    ], seen


def test_compile_writer_member_role(client):
    """千锻 writer 角色：members.writer > 0 → build 里出现 writer 角色。"""
    tc, state, ctl, *_ = client
    _import_pack(tc)
    r = tc.post("/millforge/compile", json={
        "team": "writer-team",
        "template": {
            "team_combo": "biz-market",
            "members": {"leader": 1, "workers": 1, "writer": 1,
                        "critic": 1},
        },
    })
    assert r.status_code == 200, r.text
    b = r.json()
    roles = b.get("roles") or []
    ids = [x.get("role") or x.get("id") for x in roles]
    assert "writer" in ids, ids
    kinds = [x.get("kind") for x in roles if x.get("kind")]
    if kinds:
        assert "writer" in kinds, kinds
