# -*- coding: utf-8 -*-
"""千锻（Millforge）编译/注入域：源配置 → 导入 → 编译 → 注入 → LLM 二次生成。

「千锻注入」嵌入现有模块（建队表单 / 团队管理行操作），本域是其后端。
数据面 = 本地 pack（templates_api 共享导入底座）+ Controller 管理 API
（_ctl_call 单点注入，L1 token）。

端点（挂在 /agentteams-proxy 前缀下，固定路径须在 catch-all 之前注册）：

- ``GET/PUT /millforge/source``——源配置 ``{kind: github|gitcode, repo,
  custom_url}``；派生 URL：github→https://github.com/{repo}.git /
  gitcode→https://gitcode.com/{repo}.git / custom→原样（https + host
  白名单）；持久化 ``<state>/millforge-source.json``。
- ``POST /millforge/import`` ``{ref?}``——按源配置派生 URL → 共享导入管线
  （templates_api.run_pack_import：整包覆盖；meta 含 has_compiler/has_core）。
- ``GET /millforge/packs`` / ``GET /millforge/packs/{pack}/file``——复用
  templates 数据面（file 允许 .md/.yaml/.json/.py/.sh/.txt）。
- ``POST /millforge/compile``——两条输入路径二选一：``team_json``（完整
  team.json，LLM 二次生成产物）/ ``template``（INDEX teams 整队组合或
  industry+domains+members——后端确定性组装 team.json：mode=multi_user、
  无 coordinator——对齐工作台 team_leader/worker 形态）。只执行 pack 内
  ``compiler/millforge-compile.py``（subprocess list 参数不走 shell，
  120s 超时）。非 0 退出 → 422 ``{exit_code, stage, error, stderr_tail,
  +over_budget/errors/hits}``；build 落 ``<state>/millforge-builds/<id>/``
  （保留 20，按 mtime 清旧）。
- ``POST /millforge/inject``——SOUL→现有 Worker（PUT /workers/{name}）/
  新建 Worker 带 SOUL（POST /workers）/ core skill 打包（SKILL.md
  frontmatter + references=core/protocol + scripts=core/scripts）→
  POST /skills（scope=team）→ PUT /workers/{name} 追加 skills →
  读回验证；部分失败逐项如实回报（HTTP 200 + partial）；记录
  ``<state>/millforge-injections.json``（留 50）。
- ``POST /millforge/prompt``——提示词 = pack PHILOSOPHY.md 全文 +
  core/schemas/team.schema.json + §十指令骨架（已填充表单）+ 严格输出
  约束（只输出一个 JSON；拿不准标「需人确认」）。
- ``POST /millforge/parse-team-json``——去 ``` 围栏 → 提取首个 JSON 对象
  → jsonschema（Draft7）字段级校验 → ``{ok, team|errors[{path,message}]}``。
- ``GET /millforge/builds`` / ``GET /millforge/builds/{id}`` /
  ``GET /millforge/builds/{id}/file?path=``（.md/.json，防穿越）/
  ``GET /millforge/injections``——build/注入历史（只读）。

纪律：注入前必须编译成功且预算全绿（build 只在成功时落盘，inject 再查
一次）；LLM 只产 team.json，SOUL 永远由编译器产出。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import templates_api as _tpl

# ── 常量 ────────────────────────────────────────────────────────────

_SOURCE_KINDS = ("github", "gitcode")
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){1,3}$")
_TEAM_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
_WORKER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
DEFAULT_SOURCE = {"kind": "github", "repo": "LUOSENGWA/Millforge", "custom_url": ""}
_COMPILE_TIMEOUT = 120.0  # 编译器超时（s）
_KEEP_BUILDS = 20  # build 保留条数
_KEEP_INJECTIONS = 50  # 注入历史保留条数
_CORE_SKILL_NAME = "millforge-core"
_BUDGET_KINDS = ("coordinator", "leader", "worker", "critic")
_BUDGET_DEFAULTS = {"coordinator": 500, "leader": 250, "worker": 150, "critic": 150}
_TEAM_TEMPLATE_IDS = ("software", "embedded", "data", "content", "business", "custom")
_BUILD_FILE_EXTS = {".md", ".json"}

# 模板路径自动生成的文案（zh/en）——profile ≥10 字（schema 硬门）。
_TEXT = {
    "zh": {
        "leader": "团队 Leader：需求理解、任务拆解、派发与进度整合、验收汇总、双通道回报；只拆解派发审查整合，绝不自己实现。",
        "worker": "执行 Worker：按派发完成任务，实现细节全进 spawn 隔离；每次交付附工具证据（声明-验证绑定）。",
        "critic": "独立验收 Critic：新上下文独立验收（不继承被审者历史）；只审不做，输出证据化结论，争议升级人类终裁。",
        "writer": "文案/报告撰写 Writer：先大纲再素材再初稿，每个事实可溯源（无源不写）；实现全进 spawn 隔离，交付附证据。",
        "mission": "{team} 交付团队：以千锻协议完成{ind}域业务，每次交付必须附可验证证据",
        "scope_fallback": "{ind}域内交付任务（自动生成）",
        "non_goals": ["生产环境发布（人类终裁）", "范围外功能（防 scope 漂移）"],
    },
    "en": {
        "leader": "Team Leader: understand, decompose, dispatch, integrate and report via dual channel; never implements hands-on.",
        "worker": "Execution Worker: completes dispatched tasks in spawn isolation; every delivery carries tool evidence.",
        "critic": "Independent Critic: accepts in a fresh context (no auditee history); reviews only, evidence-based verdicts.",
        "writer": "Copy/report Writer: outline → sourced material → draft; every fact traceable (no source, no sentence); implementation in spawn isolation, deliveries carry evidence.",
        "mission": "{team} delivery team: run {ind}-domain work under the Millforge protocol; every delivery must carry verifiable evidence",
        "scope_fallback": "Delivery work in the {ind} domain (auto-generated)",
        "non_goals": ["Production releases (human final call)", "Out-of-scope features (anti scope drift)"],
    },
}


# ── 状态目录（<config_dir> 同源；conftest 按测重定向，天然隔离）──────


def _state_dir() -> Path:
    from . import config as config_mod  # noqa: PLC0415

    return config_mod._CONFIG_DIR


def _source_path() -> Path:
    return _state_dir() / "millforge-source.json"


def _builds_dir() -> Path:
    return _state_dir() / "millforge-builds"


def _injections_path() -> Path:
    return _state_dir() / "millforge-injections.json"


# ── 源配置 ──────────────────────────────────────────────────────────


def _load_source() -> Dict[str, str]:
    try:
        data = json.loads(_source_path().read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {
                "kind": str(data.get("kind") or DEFAULT_SOURCE["kind"]),
                "repo": str(data.get("repo") or DEFAULT_SOURCE["repo"]),
                "custom_url": str(data.get("custom_url") or ""),
            }
    except (OSError, ValueError):
        pass
    return dict(DEFAULT_SOURCE)


def _save_source(src: Dict[str, str]) -> Dict[str, str]:
    out = {**src, "updated_at": datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")}
    _source_path().parent.mkdir(parents=True, exist_ok=True)
    _source_path().write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return out


def _derive_url(kind: str, repo: str, custom_url: str) -> str:
    if custom_url:
        return custom_url  # custom → 原样（PUT 时已校验）
    host = "github.com" if kind == "github" else "gitcode.com"
    return f"https://{host}/{repo}.git"


# ── pack 选择 / build 读取 ──────────────────────────────────────────


def _pick_pack(name: str) -> Path:
    """指定 pack 名 → 该目录；空 → 唯一 pack 或最近导入的（meta.imported_at）。"""
    root = _tpl._templates_root()
    if name:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
            raise HTTPException(status_code=400, detail="pack 名非法")
        d = root / name
        if not d.is_dir():
            raise HTTPException(
                status_code=404, detail=f"模板包 {name} 不存在（先导入）"
            )
        return d
    if not root.is_dir():
        raise HTTPException(
            status_code=400, detail="尚未导入模板包——选择源并导入后再编译"
        )
    dirs = [d for d in root.iterdir() if d.is_dir()]
    if not dirs:
        raise HTTPException(
            status_code=400, detail="尚未导入模板包——选择源并导入后再编译"
        )
    if len(dirs) == 1:
        return dirs[0]
    import os  # noqa: PLC0415

    def _ts(d: Path) -> str:
        meta = _tpl._load_meta(d) or {}
        return str(meta.get("imported_at") or os.stat(d).st_mtime)

    return max(dirs, key=_ts)


def _stage_pack(pack_dir: Path, stage: Path) -> Path:
    """Rebuild the repo layout the compiler expects.

    The import flattens ``templates/`` into the pack root (INDEX.yaml +
    skeleton/industry/domain/fragments at top level) so the picker's
    relative file paths stay stable, while ``millforge-compile.py`` looks
    for ``<root>/templates/INDEX.yaml`` next to ``compiler/`` and
    ``core/``. Stage a temporary repo-shaped tree and return the staged
    compiler path.
    """
    tpl = stage / "templates"
    tpl.mkdir(parents=True, exist_ok=True)
    for name in ("INDEX.yaml", "skeleton", "industry", "domain", "fragments"):
        src = pack_dir / name
        if not src.exists():
            continue
        dst = tpl / name
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    for name in ("compiler", "core"):
        src = pack_dir / name
        if src.is_dir():
            shutil.copytree(src, stage / name)
    return stage / "compiler" / "millforge-compile.py"


def _load_build(build_id: str) -> Dict[str, Any]:

    if not re.fullmatch(r"[A-Za-z0-9._-]+", build_id or ""):
        raise HTTPException(status_code=404, detail="build 不存在")
    bj = _builds_dir() / build_id / "build.json"
    if not bj.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"build {build_id} 不存在（或已被 {KEEP_BUILDS_NOTE} 清理）",
        )
    try:
        data = json.loads(bj.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(status_code=404, detail="build 元数据损坏")
    if not isinstance(data, dict):
        raise HTTPException(status_code=404, detail="build 元数据损坏")
    return data


KEEP_BUILDS_NOTE = f"{_KEEP_BUILDS} 条保留策略"


def _prune_builds(keep: int = _KEEP_BUILDS) -> None:
    d = _builds_dir()
    if not d.is_dir():
        return
    builds = [
        x for x in d.iterdir() if x.is_dir() and (x / "build.json").is_file()
    ]
    if len(builds) <= keep:
        return
    builds.sort(key=lambda x: (x / "build.json").stat().st_mtime)
    for old in builds[: len(builds) - keep]:
        shutil.rmtree(old, ignore_errors=True)


def _parse_json_stdout(text: str) -> Optional[Dict[str, Any]]:
    """编译器 stdout 恒 JSON（成功/失败）——非 JSON（如缺依赖 traceback）→ None。"""
    t = (text or "").strip()
    if not t:
        return None
    try:
        data = json.loads(t)
        return data if isinstance(data, dict) else None
    except ValueError:
        # 尾随噪音（warn 行）→ 取首个 { 起的大括号块
        start = t.find("{")
        if start < 0:
            return None
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(t)):
            ch = t[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            data = json.loads(t[start : i + 1])
                            return data if isinstance(data, dict) else None
                        except ValueError:
                            return None
    return None


_PROV_PATTERNS = (
    ("team", r"team:\s*([^|\n]+)"),
    ("mode", r"mode:\s*([^|\n]+)"),
    ("template", r"template:\s*([^|\n]+)"),
    ("instance_fp", r"instance_fp:\s*(\S+)"),
    ("compiled", r"compiled:\s*(\S+)"),
    ("millforge", r"millforge:\s*(\S+)"),
)


def _parse_provenance(soul: str) -> Dict[str, Any]:
    """SOUL 头注释（MILLFORGE-COMPILED）→ provenance dict（解析不到 = 空）。"""
    m = re.search(r"<!--\s*MILLFORGE-COMPILED.*?-->", soul or "", re.S)
    if not m:
        return {}
    h = m.group(0)
    prov: Dict[str, Any] = {}
    for key, pat in _PROV_PATTERNS:
        mm = re.search(pat, h)
        if mm:
            prov[key] = mm.group(1).strip()
    mm = re.search(r"experimental:\s*(\w+)", h)
    if mm:
        prov["experimental"] = mm.group(1).strip() in ("True", "true")
    return prov


# ── 模板路径：team.json 确定性组装 ──────────────────────────────────


def _int_member(v: Any, key: str) -> int:
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400, detail=f"members.{key} 须为整数（收到 {v!r}）"
        )
    if n < 0:
        raise HTTPException(status_code=400, detail=f"members.{key} 不能为负")
    return n


def _assemble_team_doc(
    pack_dir: Path, team: str, template: Dict[str, Any], lang: str
) -> Dict[str, Any]:
    """INDEX teams 组合（或 industry+domains+members）→ 完整 team.json。

 形态对齐生产实例（bizmarket fixture）：mode=multi_user、无 coordinator
（工作台只有 team_leader/worker 两种运行形态）、roster=human-owner
accountable。charter/profile 自动生成（schema minLength 满足）；
worker 的 domains 轮转分配（skills 与 domains 同值——生产同式）。
 """
    try:
        idx = _tpl._parse_index(pack_dir)
    except Exception as exc:  # noqa: BLE001 - INDEX 损坏 → 明确 400
        raise HTTPException(
            status_code=400, detail=f"该包 INDEX.yaml 解析失败：{exc}"
        ) from exc
    combo_id = str(template.get("team_combo") or "").strip()
    industry = str(template.get("industry") or "").strip()
    domains = [str(x).strip() for x in (template.get("domains") or []) if str(x).strip()]
    members_in = template.get("members") or {}
    if not isinstance(members_in, dict):
        members_in = {}
    experimental = False
    if combo_id:
        combo = next(
            (e for e in idx.get("teams", []) if e["id"] == combo_id), None
        )
        if combo is None:
            raise HTTPException(
                status_code=400,
                detail=f"INDEX teams 无整队组合 {combo_id}（看 /millforge/packs）",
            )
        industry = industry or str(combo.get("industry") or "")
        for k in ("leader", "workers", "writer", "critic"):
            v = (combo.get("members") or {}).get(k) or ""
            if v and not str(members_in.get(k) or "").strip():
                members_in[k] = v
        if not domains:
            domains = [
                x.strip()
                for x in str(combo.get("domains") or "").split(",")
                if x.strip()
            ]
        experimental = str(combo.get("source") or "") == "llm"
    # 成员数
    n_leader = _int_member(members_in.get("leader") or 1, "leader")
    n_workers = _int_member(members_in.get("workers") or 2, "workers")
    n_writer = _int_member(members_in.get("writer") or 0, "writer")
    n_critic = _int_member(members_in.get("critic") or 0, "critic")
    if n_leader < 1:
        raise HTTPException(status_code=400, detail="至少需要 1 个 Leader")
    total = n_leader + n_workers + n_writer + n_critic
    if total < 2:
        raise HTTPException(
            status_code=400, detail="角色总数须 ≥2（schema roles minItems=2）"
        )
    if total > 8:
        raise HTTPException(
            status_code=400, detail="角色总数须 ≤8（schema roles maxItems=8）"
        )
    # 行业/域 预校验（尽早给出明确 400，不等编译器 exit 2/3）
    if industry and industry not in _TEAM_TEMPLATE_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"industry {industry} 不在 schema 枚举（{_TEAM_TEMPLATE_IDS}）",
        )
    idx_domains = [e.get("id", "") for e in idx.get("domain", [])]
    for d in domains:
        if idx_domains and d not in idx_domains:
            raise HTTPException(
                status_code=400,
                detail=f"domain {d} 不在该包 INDEX domains（可选：{', '.join(idx_domains)}）",
            )
    # 角色
    tx = _TEXT[lang]
    worker_domains: List[List[str]] = [[] for _ in range(n_workers)]
    for i, d in enumerate(domains):
        worker_domains[i % n_workers].append(d)
    roles: List[Dict[str, Any]] = []
    for i in range(n_leader):
        roles.append(
            {
                "id": "lead" if n_leader == 1 else f"lead-{i + 1}",
                "kind": "leader",
                "profile": tx["leader"],
                "domains": [],
                "skills": [],
                "budget": 250,
                "spawn": False,
                "model": None,
            }
        )
    for i in range(n_workers):
        wd = worker_domains[i]
        roles.append(
            {
                "id": f"w{i + 1}",
                "kind": "worker",
                "profile": tx["worker"],
                "domains": list(wd),
                "skills": list(wd),
                "budget": 150,
                "spawn": True,
                "model": None,
            }
        )
    # Writer：写作域专用角色（docs-content / research-reports / office-productivity）
    _WRITER_DOMAINS = ("docs-content", "research-reports", "office-productivity")
    writer_domains = [d for d in domains if d in _WRITER_DOMAINS]
    for i in range(n_writer):
        roles.append(
            {
                "id": "writer" if n_writer == 1 else f"writer-{i + 1}",
                "kind": "writer",
                "profile": tx["writer"],
                "domains": list(writer_domains),
                "skills": list(writer_domains),
                "budget": 150,
                "spawn": True,
                "model": None,
            }
        )
    for i in range(n_critic):
        roles.append(
            {
                "id": "critic" if n_critic == 1 else f"critic-{i + 1}",
                "kind": "critic",
                "profile": tx["critic"],
                "domains": [],
                "skills": [],
                "budget": 150,
                "spawn": False,
                "model": None,
            }
        )
    ind_label = industry or ("通用" if lang == "zh" else "general")
    return {
        "name": team,
        "mode": "multi_user",
        "lang": lang,
        "template": industry if industry in _TEAM_TEMPLATE_IDS else None,
        "experimental": experimental,
        "charter": {
            "mission": tx["mission"].format(team=team, ind=ind_label),
            "scope": domains or [tx["scope_fallback"].format(ind=ind_label)],
            "non_goals": list(tx["non_goals"]),
        },
        "roles": roles,
        "protocol": {
            "nmh": True,
            "nma": True,
            "five_clauses": True,
            "attention": True,
            "dual_channel": True,
        },
        "roster": [{"id": "human-owner", "role": "accountable", "weight": 1.0}],
    }


# ── Controller 调用单点（测试 monkeypatch 本函数 = 假 controller）──


def _require_token() -> tuple:
    """(token, base)——L1 管理员 token；401 无 token / 502 无地址。"""
    from . import config as config_mod  # noqa: PLC0415
    from . import router as router_mod  # noqa: PLC0415
    from .router_models import TokenValidationError, _resolve_controller_token

    cfg = config_mod.load_config()
    try:
        tok, _src = _resolve_controller_token(cfg)
    except TokenValidationError:
        tok = ""
    if not tok:
        raise HTTPException(
            status_code=401,
            detail="千锻注入需要 Controller 管理员 token（配置页填写后刷新）",
        )
    base = router_mod._pick_address(cfg, "controller")
    if not base:
        raise HTTPException(status_code=502, detail="未配置 Controller 地址")
    return tok, base.rstrip("/")


async def _ctl_call(
    method: str,
    path: str,
    token: str,
    json_body: Optional[Dict[str, Any]] = None,
    files: Optional[Dict[str, Any]] = None,
    form: Optional[Dict[str, str]] = None,
) -> tuple:
    """Controller 调用唯一入口。返回 (status, data)。

 - JSON（json_body 或裸 GET）：``ctl_client.ctl_json`` 语义（ordered 地址
   failover、200 即止、确定性 4xx 直返）。
 - multipart（files + form）：GatedAsyncClient 直拨 + ordered failover。
 单测 monkeypatch 本函数（假 controller，零真实拨号）。
 ``path`` = /api/v1/...（base 由 ordered 地址拼接）。
 """
    from . import config as config_mod  # noqa: PLC0415
    from . import router as router_mod  # noqa: PLC0415
    from .ctl_client import ctl_json

    cfg = config_mod.load_config()
    urls = [u.rstrip("/") for u in router_mod._ordered_addresses(cfg, "controller")]
    if not urls:
        raise HTTPException(status_code=502, detail="未配置 Controller 地址")
    # Normalize the target to path+query. The documented contract is
    # ``path = /api/v1/...`` (the base is prepended below), but several
    # call sites pass a full URL ``f"{base}/api/v1/..."``. Prepending the
    # base to that produced a double-base URL (e.g.
    # ``https://h:7113https://h:7113/api/v1/...``) which the gateway
    # answered with 301 / stalled until timeout — every Millforge SOUL /
    # create / core-skill call failed. Accepting both forms fixes the old
    # call sites and keeps this entry point robust for new ones.
    if "://" in path:
        from urllib.parse import urlparse as _urlparse

        _parsed = _urlparse(path)
        path = (_parsed.path or "") + (
            f"?{_parsed.query}" if _parsed.query else ""
        )
    if files is None:
        st, data, _text = await ctl_json(
            method, f"{urls[0]}{path}", token, json_body=json_body
        )
        return st, (data if isinstance(data, dict) else {})
    last: tuple = (0, {})
    for b in urls:
        try:
            async with router_mod.GatedAsyncClient(
                timeout=30.0, verify=False
            ) as client:
                r = await client.request(
                    method,
                    f"{b}{path}",
                    files=files,
                    data=form,
                    headers=router_mod._headers_for(
                        cfg,
                        "controller",
                        b,
                        {"Authorization": f"Bearer {token}"},
                    ),
                )
        except Exception:  # noqa: BLE001 - 试下一地址
            last = (0, {})
            continue
        try:
            data = r.json()
        except Exception:  # noqa: BLE001
            data = {}
        if not isinstance(data, dict):
            data = {}
        if r.status_code in (200, 201):
            return r.status_code, data
        if not router_mod.should_failover_status(r.status_code):
            return r.status_code, data
        last = (r.status_code, data)
    return last


def _ctl_err(st: int, data: Dict[str, Any]) -> str:
    detail = (
        data.get("detail") or data.get("message") or data.get("error") or ""
    )
    if isinstance(detail, (dict, list)):
        try:
            detail = json.dumps(detail, ensure_ascii=False)
        except (TypeError, ValueError):
            detail = str(detail)
    return f"HTTP {st} — {str(detail)[:300]}" if st else "Controller 不可达"


# ── core skill 打包（millforge-core）────────────────────────────────


def _build_core_skill_zip(pack_dir: Path) -> Optional[bytes]:
    """core/ → 技能 zip（SKILL.md frontmatter + references/protocol/* +
 scripts/*）。无 core/ → None（调用方标 skipped）。"""
    core = pack_dir / "core"
    if not core.is_dir():
        return None
    readme = core / "README.md"
    body = readme.read_text(encoding="utf-8", errors="replace") \
        if readme.is_file() else ""
    skill_md = (
        "---\n"
        "name: millforge-core\n"
        "description: 千锻核心协议参考与确定性脚本（core/protocol 全量文档 + "
        "core/scripts）——第 1 层触发装载的按需读文件\n"
        "---\n\n"
        f"{body}"
    )
    buf = BytesIO()
    # The controller's skill upload requires exactly one top-level skill
    # directory (its name becomes the skill name); root-level entries are
    # rejected with "the zip must contain a single top-level skill
    # directory". Wrap every entry under ``millforge-core/``.
    root = "millforge-core"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{root}/SKILL.md", skill_md)
        proto = core / "protocol"
        if proto.is_dir():
            for f in sorted(proto.rglob("*")):
                if not f.is_file():
                    continue
                rel = f.relative_to(core)
                if "__pycache__" in rel.parts:
                    continue
                z.writestr(
                    f"{root}/references/{rel.as_posix()}", f.read_bytes()
                )
        scripts = core / "scripts"
        if scripts.is_dir():
            for f in sorted(scripts.rglob("*")):
                if not f.is_file():
                    continue
                rel = f.relative_to(scripts)
                if "__pycache__" in rel.parts:
                    continue
                z.writestr(f"{root}/scripts/{rel.as_posix()}", f.read_bytes())
    return buf.getvalue()


def _record_injection(result: Dict[str, Any]) -> None:
    rec = {
        "id": uuid.uuid4().hex[:10],
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "build_id": result.get("build_id", ""),
        "team": result.get("team", ""),
        "partial": result.get("partial", False),
        "souls": result.get("souls", []),
        "created": result.get("created", []),
        "core_skill": result.get("core_skill", {}),
    }
    p = _injections_path()
    try:
        hist = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else []
        if not isinstance(hist, list):
            hist = []
    except (OSError, ValueError):
        hist = []
    hist.insert(0, rec)
    hist = hist[:_KEEP_INJECTIONS]
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(hist, ensure_ascii=False, indent=1), encoding="utf-8"
    )


# ── LLM 二次生成：提示词 / team.json 解析 ───────────────────────────


def _extract_ten_section(phi_text: str) -> str:
    """PHILOSOPHY.md §十（给 LLM 的二次生成指令）的 fenced 骨架。"""
    m = re.search(r"^##\s*十[^\n]*\n(.*?)(?=^##\s|\Z)", phi_text, re.M | re.S)
    if not m:
        return ""
    body = m.group(1)
    fence = re.search(r"```[a-z]*\n(.*?)```", body, re.S)
    return (fence.group(1) if fence else body).strip()


def _extract_json(text: str) -> Any:
    """从 LLM 文本提取首个 JSON 对象：``` 围栏优先，整体大括号匹配兜底。
 提取失败 → None。"""
    t = (text or "").strip()
    if not t:
        return None

    def _try(s: str) -> Any:
        if not s:
            return None
        try:
            return json.loads(s)
        except ValueError:
            return None

    def _brace_match(s: str) -> str:
        start = s.find("{")
        if start < 0:
            return ""
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(s)):
            ch = s[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        return s[start : i + 1]
        return ""

    fence = re.search(r"```[a-z]*\n(.*?)```", t, re.S)
    for cand in (fence.group(1) if fence else "", _brace_match(t)):
        v = _try(cand.strip() if cand else "")
        if v is not None:
            return v
        # 围栏内/整体仍非纯 JSON（前后缀文字）→ 大括号匹配再试
        v = _try(_brace_match(cand) if cand else "")
        if v is not None:
            return v
    return None


class MillforgeSourceRequest(BaseModel):
    kind: str = ""
    repo: str = ""
    custom_url: str = ""


class MillforgeImportRequest(BaseModel):
    ref: str = "main"


class MillforgeCompileRequest(BaseModel):
    pack: str = ""
    team: str = ""
    team_json: Optional[Dict[str, Any]] = None
    template: Optional[Dict[str, Any]] = None
    lang: str = "zh"
    budget_override: Optional[Dict[str, Any]] = None


class MillforgeCreateWorker(BaseModel):
    name: str = ""
    role_id: str = ""
    role: str = ""  # 工作台 CR 角色（team_leader/worker）；空 = 按 kind 派生
    model: str = ""
    runtime: str = "qwenpaw"


class MillforgeInjectRequest(BaseModel):
    build_id: str = ""
    team: str = ""
    mapping: Dict[str, str] = {}  # build role_id → 现有 worker 名
    create_workers: List[MillforgeCreateWorker] = []
    core_skill: bool = True
    apply_soul: bool = True


class MillforgePromptRequest(BaseModel):
    pack: str = ""
    form: Dict[str, Any] = {}


class MillforgeParseRequest(BaseModel):
    pack: str = ""
    text: str = ""


def build_millforge_router() -> APIRouter:
    """千锻编译/注入域 router（挂在 /agentteams-proxy 前缀下）。

 固定路径（/millforge*）——必须注册在 catch-all（approval_api）之前。
 """
    router = APIRouter(tags=["millforge"])

    # ── 源配置 ────────────────────────────────────────────────────

    @router.get("/millforge/source")
    async def millforge_source_get() -> Dict[str, Any]:
        src = _load_source()
        return {
            **src,
            "resolved_url": _derive_url(
                src["kind"], src["repo"], src["custom_url"]
            ),
            "updated_at": _json_field(_source_path(), "updated_at") or "",
        }

    @router.put("/millforge/source")
    async def millforge_source_put(req: MillforgeSourceRequest) -> Dict[str, Any]:
        cur = _load_source()
        kind = (req.kind or "").strip() or cur["kind"]
        if kind not in _SOURCE_KINDS:
            raise HTTPException(
                status_code=400, detail="kind 只允许 github / gitcode"
            )
        repo = (req.repo or "").strip() or cur["repo"]
        custom_url = (req.custom_url or "").strip()  # 空 = 清空（回到派生）
        if custom_url:
            _tpl.validate_repo_url(custom_url)  # https + host 白名单
            resolved = custom_url
        else:
            if not _REPO_RE.match(repo):
                raise HTTPException(
                    status_code=400,
                    detail="repo 格式 org/repo（字母/数字/. _ -，1-4 段）",
                )
            resolved = _derive_url(kind, repo, "")
        src = _save_source(
            {"kind": kind, "repo": repo, "custom_url": custom_url}
        )
        return {
            "kind": kind,
            "repo": repo,
            "custom_url": custom_url,
            "resolved_url": resolved,
            "updated_at": src["updated_at"],
        }

    # ── 导入 / 浏览 ───────────────────────────────────────────────

    @router.post("/millforge/import")
    async def millforge_import(req: MillforgeImportRequest) -> Dict[str, Any]:
        """按源配置导入（派生 URL → 共享导入管线 → 整包覆盖）。"""
        ref = _tpl.clean_ref(req.ref)
        src = _load_source()
        url = _derive_url(src["kind"], src["repo"], src["custom_url"])
        _tpl.validate_repo_url(url)
        meta = await _tpl.run_pack_import(
            url, ref, source="custom" if src["custom_url"] else src["kind"]
        )
        return {
            "ok": True,
            "pack": _tpl._slug_from_url(url),
            "url": url,
            "ref": ref,
            "commit": meta["commit"],
            "files": len(meta["files"]),
            "has_compiler": meta["has_compiler"],
            "has_core": meta["has_core"],
        }

    @router.get("/millforge/packs")
    async def millforge_packs() -> Dict[str, Any]:
        return await _tpl.list_packs_payload()

    @router.get("/millforge/packs/{pack}/file")
    async def millforge_pack_file(
        pack: str, path: str = ""
    ) -> Dict[str, Any]:
        return _tpl.read_pack_file(
            pack, path, {".md", ".yaml", ".json", ".py", ".sh", ".txt"}
        )

    # ── 编译 ──────────────────────────────────────────────────────

    @router.post("/millforge/compile")
    async def millforge_compile(req: MillforgeCompileRequest) -> Dict[str, Any]:
        """编译 team.json → build（SOUL + fragments + spawn-specs + provenance）。

 输入二选一：``team_json``（自定义，name 以 team 为准）/ ``template``
 （INDEX teams 组合或 industry+domains+members，后端组装）。
 非 0 退出 → 422 {exit_code, stage, error, stderr_tail, +extra}。
 """
        team = (req.team or "").strip()
        if not team:
            raise HTTPException(status_code=400, detail="team（团队名）必填")
        if not _TEAM_NAME_RE.match(team):
            raise HTTPException(
                status_code=400,
                detail="team 名须小写 kebab-case（3-63 字符，"
                "^[a-z0-9][a-z0-9-]*[a-z0-9]$）",
            )
        if req.lang not in ("zh", "en"):
            raise HTTPException(status_code=400, detail="lang 只允许 zh / en")
        lang = req.lang
        has_tj = req.team_json is not None and bool(req.team_json)
        has_tpl = req.template is not None and bool(req.template)
        if has_tj == has_tpl:
            raise HTTPException(
                status_code=400,
                detail="team_json（自定义）与 template（模板路径）恰好给一个",
            )
        pack_dir = _pick_pack((req.pack or "").strip())
        compiler = pack_dir / "compiler" / "millforge-compile.py"
        if not compiler.is_file():
            raise HTTPException(
                status_code=400,
                detail="该包未含编译器（compiler/millforge-compile.py）——"
                "请重新导入完整包",
            )
        # 编译器依赖前置检查（同一解释器 sys.executable）
        try:
            import yaml  # noqa: F401, PLC0415
            import jsonschema  # noqa: F401, PLC0415
        except ImportError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"缺少编译器依赖 {exc.name}——qwenpaw 宿主需安装 "
                "pyyaml 与 jsonschema",
            ) from exc
        if has_tpl:
            doc = _assemble_team_doc(pack_dir, team, req.template or {}, lang)
            source = "template"
        else:
            doc = dict(req.team_json or {})
            doc["name"] = team
            doc["lang"] = lang
            source = "custom"
        build_id = (
            "mf-"
            + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            + "-"
            + uuid.uuid4().hex[:6]
        )
        bdir = _builds_dir() / build_id
        bdir.mkdir(parents=True, exist_ok=True)
        try:
            team_path = bdir / "team.json"
            team_path.write_text(
                json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            stage_dir = Path(tempfile.mkdtemp(prefix="mf-stage-"))
            staged_compiler = await asyncio.to_thread(
                _stage_pack, pack_dir, stage_dir
            )
            cmd = [
                sys.executable,
                str(staged_compiler),
                "compile",
                str(team_path),
                "--out",
                str(bdir),
            ]
            if lang == "en":
                cmd += ["--lang", "en"]
            bo = req.budget_override or {}
            for kind_key, lines in bo.items():
                kind_key = str(kind_key)
                if kind_key not in _BUDGET_KINDS:
                    raise HTTPException(
                        status_code=400,
                        detail=f"budget_override 键须为角色 kind（{_BUDGET_KINDS}）",
                    )
                try:
                    n = int(lines)
                except (TypeError, ValueError):
                    raise HTTPException(
                        status_code=400,
                        detail=f"budget_override.{kind_key} 须为整数",
                    )
                if not (60 <= n <= 500):
                    raise HTTPException(
                        status_code=400,
                        detail=f"budget_override.{kind_key} 须 60-500 行",
                    )
                cmd += ["--budget-override", f"{kind_key}={n}"]
            try:
                proc = await asyncio.to_thread(
                    subprocess.run,
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=_COMPILE_TIMEOUT,
                    cwd=str(stage_dir),
                )
            except subprocess.TimeoutExpired as exc:
                shutil.rmtree(stage_dir, ignore_errors=True)
                raise HTTPException(
                    status_code=504,
                    detail=f"编译超时（{_COMPILE_TIMEOUT:.0f}s）",
                ) from exc
            shutil.rmtree(stage_dir, ignore_errors=True)
            out = _parse_json_stdout(proc.stdout)
            if proc.returncode != 0:
                detail: Dict[str, Any] = {
                    "exit_code": proc.returncode,
                    "stage": (out or {}).get("stage") or "unknown",
                    "error": (out or {}).get("error") or "",
                    "stderr_tail": (proc.stderr or "")[-1500:],
                }
                if isinstance(out, dict):
                    for k in (
                        "over_budget",
                        "errors",
                        "hits",
                        "gaps",
                        "unresolved",
                        "over_tier",
                    ):
                        if k in out:
                            detail[k] = out[k]
                if not detail["error"]:
                    detail["error"] = (
                        (proc.stderr or proc.stdout or "").strip()[-300:]
                        or f"exit {proc.returncode}"
                    )
                raise HTTPException(status_code=422, detail=detail)
            # 成功：以落盘文件为准（行数/sha 本地重算——编译器数字只作预算源）
            compiler_outputs = {
                str(o.get("role")): o
                for o in ((out or {}).get("outputs") or [])
                if isinstance(o, dict)
            }
            roles_out: List[Dict[str, Any]] = []
            for role_doc in doc.get("roles") or []:
                if not isinstance(role_doc, dict):
                    continue
                rid = str(role_doc.get("id") or "")
                sp = bdir / f"{rid}.soul.md"
                if not rid or not sp.is_file():
                    continue
                text = sp.read_text(encoding="utf-8")
                lines = len(text.splitlines())
                o = compiler_outputs.get(rid, {})
                budget = o.get("budget")
                if not isinstance(budget, (int, float)):
                    budget = role_doc.get("budget")
                if not isinstance(budget, (int, float)):
                    budget = _BUDGET_DEFAULTS.get(
                        str(role_doc.get("kind")), 150
                    )
                budget_ok = (
                    o.get("budget_status") == "ok"
                    if o.get("budget_status") in ("ok", "EXCEEDED")
                    else lines <= budget
                )
                roles_out.append(
                    {
                        "role": rid,
                        "kind": str(role_doc.get("kind") or ""),
                        "lines": lines,
                        "budget": int(budget),
                        "budget_ok": bool(budget_ok),
                        "soul_sha256": hashlib.sha256(
                            text.encode("utf-8")
                        ).hexdigest(),
                        "soul": text,
                    }
                )
            if not roles_out:
                raise HTTPException(
                    status_code=502,
                    detail="编译器报成功但未产出 SOUL 文件",
                )
            fragments = (
                sorted(
                    p.relative_to(bdir).as_posix()
                    for p in (bdir / "fragments").rglob("*.md")
                )
                if (bdir / "fragments").is_dir()
                else []
            )
            spawn_specs = (
                sorted(
                    p.relative_to(bdir).as_posix()
                    for p in (bdir / "spawn-specs").rglob("*.md")
                )
                if (bdir / "spawn-specs").is_dir()
                else []
            )
            prov = _parse_provenance(roles_out[0]["soul"])
            meta = {
                "build_id": build_id,
                "pack": pack_dir.name,
                "pack_commit": (_tpl._load_meta(pack_dir) or {}).get("commit", ""),
                "team": team,
                "lang": lang,
                "source": source,
                "template_spec": req.template if has_tpl else None,
                "created_at": datetime.now(timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "roles": [
                    {k: r[k] for k in ("role", "kind", "lines", "budget", "budget_ok", "soul_sha256")}
                    for r in roles_out
                ],
                "fragments": fragments,
                "spawn_specs": spawn_specs,
                "provenance": prov,
            }
            (bdir / "build.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            _prune_builds(_KEEP_BUILDS)
            return {
                "ok": True,
                "build_id": build_id,
                "pack": pack_dir.name,
                "team": team,
                "lang": lang,
                "source": source,
                "roles": roles_out,
                "fragments": fragments,
                "spawn_specs": spawn_specs,
                "provenance": prov,
            }
        finally:
            _maybe_clean_build(bdir)

    # ── 注入 ──────────────────────────────────────────────────────

    @router.post("/millforge/inject")
    async def millforge_inject(req: MillforgeInjectRequest) -> Dict[str, Any]:
        """SOUL 注入（现有 Worker PUT / 新建 Worker POST）+ core skill
 （打包上传 scope=team + 追加到 worker skills）+ 读回验证。
 部分失败逐项回报（HTTP 200 + partial=true）。"""
        build = _load_build((req.build_id or "").strip())
        if not build.get("roles"):
            raise HTTPException(status_code=404, detail="build 无角色数据")
        if not all(r.get("budget_ok") for r in build["roles"]):
            raise HTTPException(
                status_code=400,
                detail="build 预算未全绿——不可注入（回模板层减片段或提预算走人审）",
            )
        bdir = _builds_dir() / build["build_id"]
        souls: Dict[str, str] = {}
        kinds: Dict[str, str] = {}
        for r in build["roles"]:
            rid = str(r.get("role") or "")
            kinds[rid] = str(r.get("kind") or "")
            sp = bdir / f"{rid}.soul.md"
            if rid and sp.is_file():
                souls[rid] = sp.read_text(encoding="utf-8")
        mapping = {
            str(k): str(v).strip()
            for k, v in (req.mapping or {}).items()
            if str(v).strip()
        }
        for rid in mapping:
            if rid not in souls:
                raise HTTPException(
                    status_code=400,
                    detail=f"mapping 角色 {rid} 不在 build 中（可选：{', '.join(sorted(souls))}）",
                )
        creates = [
            c
            for c in (req.create_workers or [])
            if (c.name or "").strip() and (c.role_id or "").strip()
        ]
        for c in creates:
            if c.role_id not in souls:
                raise HTTPException(
                    status_code=400,
                    detail=f"create_workers[{c.name}] 的 role_id {c.role_id} 不在 build 中",
                )
        if not mapping and not creates:
            raise HTTPException(
                status_code=400, detail="无注入对象——mapping 或 create_workers 至少其一"
            )
        if not req.apply_soul and not req.core_skill:
            raise HTTPException(
                status_code=400,
                detail="apply_soul 与 core_skill 至少其一须为 true（否则无操作）",
            )
        token, base = _require_token()
        result: Dict[str, Any] = {
            "build_id": build["build_id"],
            "team": (req.team or "").strip(),
            "souls": [],
            "created": [],
            "core_skill": {"status": "skipped", "detail": "未请求 core skill"},
        }
        # 1) 新建 Worker（带 SOUL）
        for c in creates:
            name = c.name.strip()
            if not _WORKER_NAME_RE.match(name):
                result["created"].append(
                    {
                        "name": name,
                        "role_id": c.role_id,
                        "status": "error",
                        "error": "worker 名非法（小写/数字/-，≤64 字符）",
                    }
                )
                continue
            body: Dict[str, Any] = {
                "name": name,
                "soul": souls[c.role_id],
                "runtime": (c.runtime or "qwenpaw").strip() or "qwenpaw",
            }
            if (c.model or "").strip():
                body["model"] = c.model.strip()
            st, data = await _ctl_call(
                "POST", f"{base}/api/v1/workers", token, json_body=body
            )
            if st in (200, 201):
                st2, d2 = await _ctl_call(
                    "GET", f"{base}/api/v1/workers/{quote(name)}", token
                )
                verified = (
                    st2 == 200 and isinstance(d2, dict) and bool(d2.get("soul"))
                )
                result["created"].append(
                    {
                        "name": name,
                        "role_id": c.role_id,
                        "status": "ok" if verified else "error",
                        "error": "" if verified else "读回验证失败（SOUL 未生效）",
                        "verified": verified,
                    }
                )
            else:
                result["created"].append(
                    {
                        "name": name,
                        "role_id": c.role_id,
                        "status": "error",
                        "error": _ctl_err(st, data),
                    }
                )
        # 2) 现有 Worker → PUT SOUL（apply_soul=false = 纯 core skill 二次注入）
        if req.apply_soul:
            for rid, wname in mapping.items():
                st, data = await _ctl_call(
                    "PUT",
                    f"{base}/api/v1/workers/{quote(wname)}",
                    token,
                    json_body={"soul": souls[rid]},
                )
                entry: Dict[str, Any] = {
                    "worker": wname,
                    "role_id": rid,
                    "status": "error" if st != 200 else "ok",
                    "error": "" if st == 200 else _ctl_err(st, data),
                    "verified": False,
                }
                if st == 200:
                    st2, d2 = await _ctl_call(
                        "GET", f"{base}/api/v1/workers/{quote(wname)}", token
                    )
                    entry["verified"] = (
                        st2 == 200
                        and isinstance(d2, dict)
                        and bool(d2.get("soul"))
                    )
                    if not entry["verified"]:
                        entry["status"] = "error"
                        entry["error"] = "读回验证失败（SOUL 未生效）"
                result["souls"].append(entry)
        # 3) core skill（打包 → 上传 scope=team → 追加到相关 worker）
        if req.core_skill:
            pack_dir = _tpl._templates_root() / str(build.get("pack") or "")
            if not pack_dir.is_dir() or not (pack_dir / "core").is_dir():
                result["core_skill"] = {
                    "status": "skipped",
                    "detail": "该包未含 core/——跳过 core 技能",
                }
            else:
                zip_bytes = _build_core_skill_zip(pack_dir)
                st, data = await _ctl_call(
                    "POST",
                    f"{base}/api/v1/skills",
                    token,
                    files={
                        "file": (
                            f"{_CORE_SKILL_NAME}.zip",
                            zip_bytes,
                            "application/zip",
                        )
                    },
                    form={"scope": "team", "team": result["team"]},
                )
                if st not in (200, 201):
                    result["core_skill"] = {
                        "status": "error",
                        "detail": _ctl_err(st, data),
                    }
                else:
                    targets: List[str] = []
                    for w in list(mapping.values()) + [
                        c["name"]
                        for c in result["created"]
                        if c.get("status") == "ok"
                    ]:
                        if w and w not in targets:
                            targets.append(w)
                    st2, d2 = await _ctl_call(
                        "GET", f"{base}/api/v1/workers", token
                    )
                    skills_by: Dict[str, List[str]] = {}
                    # The controller lists workers under "workers" (with a
                    # "total" sibling) — not "items".
                    if st2 == 200 and isinstance(d2, dict):
                        for w in d2.get("workers") or []:
                            if isinstance(w, dict) and w.get("name"):
                                skills_by[str(w["name"])] = list(
                                    w.get("skills") or []
                                )
                    assigned: List[str] = []
                    errors: List[str] = []
                    for wname in targets:
                        cur = skills_by.get(wname)
                        if cur is None:
                            errors.append(f"{wname}: 无 skills 数据")
                            continue
                        if _CORE_SKILL_NAME in cur:
                            assigned.append(wname)
                            continue
                        st3, d3 = await _ctl_call(
                            "PUT",
                            f"{base}/api/v1/workers/{quote(wname)}",
                            token,
                            json_body={"skills": cur + [_CORE_SKILL_NAME]},
                        )
                        if st3 == 200:
                            assigned.append(wname)
                        else:
                            errors.append(f"{wname}: {_ctl_err(st3, d3)}")
                    result["core_skill"] = {
                        "status": "ok" if not errors else "partial",
                        "skill": _CORE_SKILL_NAME,
                        "assigned": assigned,
                        "detail": "；".join(errors),
                    }
        partial = any(
            e.get("status") == "error" for e in result["souls"] + result["created"]
        ) or result["core_skill"].get("status") == "error"
        result["ok"] = True
        result["partial"] = partial
        _record_injection(result)
        return result

    # ── LLM 二次生成 ──────────────────────────────────────────────

    @router.post("/millforge/prompt")
    async def millforge_prompt(req: MillforgePromptRequest) -> Dict[str, Any]:
        """提示词 = PHILOSOPHY 全文 + team.schema.json + §十骨架（已填充）
 + 严格输出约束（只输出一个 JSON；拿不准标「需人确认」）。"""
        pack_dir = _pick_pack((req.pack or "").strip())
        phi_path = pack_dir / "PHILOSOPHY.md"
        if not phi_path.is_file():
            raise HTTPException(
                status_code=400,
                detail="该包未含 PHILOSOPHY.md——请重新导入完整包",
            )
        phi = phi_path.read_text(encoding="utf-8", errors="replace")
        schema_path = pack_dir / "core" / "schemas" / "team.schema.json"
        schema_text = (
            schema_path.read_text(encoding="utf-8") if schema_path.is_file() else ""
        )
        form = req.form or {}
        members = str(form.get("members") or "").strip()
        task_types = str(form.get("task_types") or "").strip()
        runtime = str(form.get("runtime") or "").strip()
        pains = str(form.get("pains") or "").strip()
        team_name = str(form.get("team_name") or "").strip()
        skeleton = _extract_ten_section(phi)
        # 行级填充：占位形态不保证（{…} 或选项枚举如 运行时行），按行整值替换。
        filled = skeleton
        filled = re.sub(
            r"成员：[^\n]*",
            f"成员：{members or '（未提供——按最小可行团队生成）'}",
            filled, count=1,
        )
        filled = re.sub(
            r"任务类型：[^\n]*",
            f"任务类型：{task_types or '（未提供）'}",
            filled, count=1,
        )
        filled = re.sub(
            r"运行时：[^\n]*",
            f"运行时：{runtime or '（未提供）'}",
            filled, count=1,
        )
        filled = re.sub(
            r"最痛的 3 个问题：[^\n]*",
            f"最痛的 3 个问题：{pains or '（未提供）'}",
            filled, count=1,
        )
        bar = "═" * 44
        prompt = (
            f"{phi}\n\n"
            f"{bar}\n# 千锻二次生成指令（已按你的团队情况填充）\n{bar}\n"
            f"{filled}\n\n"
            f"{bar}\n# team.schema.json（字段语义与硬约束）\n{bar}\n"
            f"{schema_text or '（该包未含 core/schemas/team.schema.json——按 §十 描述生成）'}\n\n"
            f"{bar}\n# 严格输出约束（覆盖上面所有「请生成」措辞）\n{bar}\n"
            f"1. 只输出一个 JSON 对象（完整 team.json）——不要 markdown 代码围栏、不要任何解释文字。\n"
            f"2. name 用 {team_name or '小写 kebab-case（3-63 字符）'}；"
            "字段/枚举/取值范围严格遵循 team.schema.json"
            "（additionalProperties=false，不得加多余字段）。\n"
            "3. 拿不准的字段：字符串字段值写「需人确认」；数字/布尔字段用 schema 默认值——不要猜。\n"
            "4. mode 用 multi_user；不要生成 coordinator 角色（工作台只有 team_leader/worker 两种运行形态）。\n"
        )
        return {"ok": True, "pack": pack_dir.name, "prompt": prompt}

    @router.post("/millforge/parse-team-json")
    async def millforge_parse_team_json(
        req: MillforgeParseRequest,
    ) -> Dict[str, Any]:
        """LLM 文本 → 去 ``` 围栏 → 提取首个 JSON → jsonschema 字段级校验。"""
        pack_dir = _pick_pack((req.pack or "").strip())
        schema_path = pack_dir / "core" / "schemas" / "team.schema.json"
        if not schema_path.is_file():
            raise HTTPException(
                status_code=400,
                detail="该包未含 core/schemas/team.schema.json——无法校验",
            )
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail=f"schema 读取失败：{exc}"
            ) from exc
        doc = _extract_json(req.text)
        if not isinstance(doc, dict):
            return {
                "ok": False,
                "errors": [
                    {
                        "path": "",
                        "message": "无法从文本中提取 JSON 对象"
                        "（已先剥 ``` 围栏再按首个大括号匹配）",
                    }
                ],
            }
        try:
            import jsonschema  # noqa: PLC0415 - 宿主依赖（惰性隔离）

            validator = jsonschema.Draft7Validator(schema)
            errors: List[Dict[str, str]] = []
            for e in validator.iter_errors(doc):
                msg = str(e.message)[:300]
                # required 错误 jsonschema 把 path 停在父节点——从 message
                # 提取缺失键名补进 path，前端才能定位到字段。
                parts = [str(p) for p in e.absolute_path]
                if e.validator == "required":
                    m = re.match(r"^'([^']+)' is a required property", msg)
                    if m:
                        parts.append(m.group(1))
                elif e.validator == "additionalProperties":
                    m = re.match(r"^Additional properties are not allowed "
                                 r"\('([^']+)' was unexpected\)", msg)
                    if m:
                        parts.append(m.group(1))
                path = ".".join(parts)
                errors.append({"path": path, "message": msg})
                if len(errors) >= 30:
                    break
        except ImportError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"缺少校验依赖 {exc.name}——qwenpaw 宿主需安装 jsonschema",
            ) from exc
        if errors:
            return {"ok": False, "errors": errors}
        return {"ok": True, "team": doc}

    # ── build / 注入历史（只读）───────────────────────────────────

    @router.get("/millforge/builds")
    async def millforge_builds() -> Dict[str, Any]:
        d = _builds_dir()
        out: List[Dict[str, Any]] = []
        if d.is_dir():
            for b in d.iterdir():
                bj = b / "build.json"
                if b.is_dir() and bj.is_file():
                    try:
                        data = json.loads(bj.read_text(encoding="utf-8"))
                        if isinstance(data, dict):
                            out.append(data)
                    except (OSError, ValueError):
                        continue
        out.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        return {"builds": out}

    @router.get("/millforge/builds/{build_id}")
    async def millforge_build_detail(build_id: str) -> Dict[str, Any]:
        return _load_build(build_id)

    @router.get("/millforge/builds/{build_id}/file")
    async def millforge_build_file(build_id: str, path: str = "") -> Dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", build_id or ""):
            raise HTTPException(status_code=404, detail="build 不存在")
        bdir = (_builds_dir() / build_id).resolve()
        if not bdir.is_dir():
            raise HTTPException(status_code=404, detail="build 不存在")
        rel = (path or "").strip()
        if not rel:
            raise HTTPException(status_code=400, detail="path 必填")
        if rel.startswith("/") or "\\" in rel or rel.startswith(".."):
            raise HTTPException(
                status_code=400, detail="path 必须是 build 根内的相对路径"
            )
        try:
            resolved = (bdir / rel).resolve()
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"非法路径：{exc}")
        if not resolved.is_relative_to(bdir):
            raise HTTPException(status_code=400, detail="path 越出 build 根（拒绝）")
        if resolved.suffix.lower() not in _BUILD_FILE_EXTS:
            raise HTTPException(
                status_code=400, detail="只允许 .md / .json 文件"
            )
        if not resolved.is_file():
            raise HTTPException(status_code=404, detail="文件不存在")
        return {
            "build_id": build_id,
            "path": rel,
            "size": resolved.stat().st_size,
            "content": resolved.read_text(encoding="utf-8", errors="replace"),
        }

    @router.get("/millforge/injections")
    async def millforge_injections() -> Dict[str, Any]:
        p = _injections_path()
        if not p.is_file():
            return {"injections": []}
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            return {"injections": data if isinstance(data, list) else []}
        except (OSError, ValueError):
            return {"injections": []}

    return router


def _json_field(path: Path, key: str) -> Optional[str]:
    """读 JSON 文件单字段（缺失/损坏 → None）。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and key in data:
            return str(data[key])
    except (OSError, ValueError):
        pass
    return None


def _maybe_clean_build(bdir: Path) -> None:
    """编译失败（raise 前未落 build.json）→ 清半 build；成功则保留。"""
    if bdir.is_dir() and not (bdir / "build.json").is_file():
        shutil.rmtree(bdir, ignore_errors=True)
