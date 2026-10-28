# -*- coding: utf-8 -*-
"""千锻（Millforge）模板导入域：git clone 千锻仓 → 本地 pack →
浏览/预览/删除。

背景：千锻仓（LUOSENGWA/millforge，GitHub/GitCode 镜像）自带模板库
``templates/``（INDEX.yaml 注册表 + {skeleton,industry,domain,fragments}/
*.md）、编译器 ``compiler/millforge-compile.py``、核心层 ``core/``
（protocol/scripts/schemas）与 ``PHILOSOPHY.md``（LLM 二次生成基线）。
本域把整套包导入工作台本地（``<config_dir>/templates/<slug>/``），
是「千锻注入」功能（millforge_api：源配置/编译/注入）的共享导入底座——
导入文件集 = ``templates/``（.md/.yaml）+ ``compiler/`` + ``core/``
（全量，排除 ``__pycache__``）+ 根 ``PHILOSOPHY.md`` / ``PHILOSOPHY.en.md``
/ ``requirements.txt``（合计 ≤60MB）。

端点（挂在 /agentteams-proxy 前缀下，固定路径须在 catch-all 之前注册）：

- ``POST /templates/import`` ``{url, ref}``——只允许 ``https://`` + host
  白名单（github.com / gitcode.com / gitee.com）+ ref 白名单
  （``[A-Za-z0-9._/-]{1,100}``）→ 400；``git clone --depth 1``（subprocess
  list 参数不走 shell，90s 超时）失败/超时 → 502 + stderr 摘要；文件集
  复制到 pack 目录（slug=仓库名，重复导入整包覆盖）+ ``meta.json``
  ``{source, url, ref, commit, imported_at, files, has_compiler, has_core}``。
- ``GET /templates``——列出全部 pack + 解析后的 INDEX.yaml（skeletons/
  industry/domain/fragments/teams 五组）+ meta；单 pack 解析失败只标该
  pack ``parse_error``，其余照常（诚实降级，不整体 500）。
- ``GET /templates/{pack}/file?path=``——只允许 ``.md`` / ``.yaml``；路径
  resolve 后必须仍在 pack 根内（防穿越，含符号链接）；不存在 404。
- ``DELETE /templates/{pack}``——删除 pack 目录（幂等：不存在也 200，
  ``deleted=false``）。

共享底座（millforge_api 复用）：``validate_repo_url`` / ``clean_ref`` /
``run_pack_import`` / ``list_packs_payload`` / ``read_pack_file``。

状态目录 = ``<config_dir>/templates/``（与 config.json 同源——单测的
conftest 已把 ``config_mod._CONFIG_DIR`` 重定向到 per-test tmp，天然隔离）。
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# 仓库 host 白名单（防 SSRF / 内网探测：只认三家公开代码托管的 https）。
_ALLOWED_HOSTS = {"github.com", "gitcode.com", "gitee.com"}
# ref 白名单（分支/tag 形态；禁空白与 shell 元字符——参数经 list 传
# subprocess 不走 shell，白名单是纵深不是唯一防线）。
_REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
# pack 名 = slug（导入时由 URL 派生并收敛到该字符集）——文件/删除端点按
# 同规则校验，非法包名直接按不存在处理。
_SLUG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_MAX_TOTAL_BYTES = 60 * 1024 * 1024  # 整包合计上限（含 compiler/ core/）
_CLONE_TIMEOUT = 90.0  # git clone 超时（s）
_ALLOWED_EXTS = {".md", ".yaml"}  # templates/ 只导入的扩展名
#: 根级单文件（千锻 LLM 二次生成基线 + 依赖清单）。
_ROOT_FILES = ("PHILOSOPHY.md", "PHILOSOPHY.en.md", "requirements.txt")
#: API 段名 → 真实 INDEX.yaml 段名别名（千锻用 domains/protocol；
#: 早期草稿用 domain/fragments，两者都接受，API 对外键保持稳定）。
_INDEX_SECTIONS = (
    ("skeletons", ("skeletons",)),
    ("industry", ("industry",)),
    ("domain", ("domains", "domain")),
    ("fragments", ("protocol", "fragments")),
)
_ENTRY_FIELDS = (
    "id",
    "file",
    "source",
    "applies_to",
    "industry",  # domain 条目 → 所属行业（前端行业→领域级联；旧包无此字段 = 空串）
    "budget",
    "resident",
    "trigger",
)


def _templates_root() -> Path:
    """pack 存储根 = <config_dir>/templates/（惰性导入：conftest 按测重定向）。"""
    from . import config as config_mod  # noqa: PLC0415

    return config_mod._CONFIG_DIR / "templates"


def _run_git(args: List[str], timeout: float) -> subprocess.CompletedProcess:
    """git 子进程唯一注入点（单测 monkeypatch 本函数，零真实网络/仓库）。

 参数经 list 传递（不走 shell）；capture_output + timeout；不 check——
 调用方按 returncode 定语义（clone 失败 = 502 + stderr 摘要）。
 """
    return subprocess.run(
        ["git"] + list(args),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _slug_from_url(url: str) -> str:
    """URL 路径末段 → slug（去 .git 后缀 + 收敛字符集）。空 = 无法派生。"""
    segs = [s for s in urlparse(url).path.split("/") if s]
    name = segs[-1] if segs else ""
    if name.endswith(".git"):
        name = name[: -len(".git")]
    return re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._-")


def _entry_str(v: Any) -> str:
    """INDEX 条目字段归一化为 str（None→""；list→逗号连；标量→str）。"""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v)
    return str(v)


def validate_repo_url(url: str) -> None:
    """仓库 URL 校验（https + host 白名单）——失败 400。/templates/import
 与 /millforge/import（源配置派生 URL 落回此校验，纵深）共用。"""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(
            status_code=400, detail="只允许 https:// 仓库地址"
        )
    host = (parsed.hostname or "").lower()
    if host not in _ALLOWED_HOSTS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"仓库 host 不在白名单：{host or '（空）'}"
                "（允许 github.com / gitcode.com / gitee.com）"
            ),
        )


def clean_ref(ref: str) -> str:
    """ref 白名单校验（空 → 默认 main；违规 → 400）。"""
    ref = (ref or "").strip() or "main"
    if not _REF_RE.match(ref):
        raise HTTPException(
            status_code=400,
            detail="ref 只允许字母/数字/. _ / -，且 ≤100 字符",
        )
    return ref


def _iter_pack_files(clone_root: Path) -> List[Path]:
    """导入文件集 = templates/（.md/.yaml）+ compiler/ core/（全量，
 排除 __pycache__）+ 根 PHILOSOPHY.md / PHILOSOPHY.en.md / requirements.txt。

 落盘布局契约（_parse_index 与旧导入测试均依赖）：``templates/`` 的**内容**
 落 pack 根（INDEX.yaml / skeleton/… 直接在 pack 下，剥掉 templates/ 前缀）；
 ``compiler/`` ``core/`` 与根三文件保持原相对路径。"""
    files: List[Path] = []
    tdir = clone_root / "templates"
    if tdir.is_dir():
        files.extend(
            p
            for p in tdir.rglob("*")
            if p.is_file() and p.suffix.lower() in _ALLOWED_EXTS
        )
    for sub in ("compiler", "core"):
        d = clone_root / sub
        if not d.is_dir():
            continue
        files.extend(
            p
            for p in d.rglob("*")
            if p.is_file()
            and "__pycache__" not in p.relative_to(clone_root).parts
        )
    for name in _ROOT_FILES:
        p = clone_root / name
        if p.is_file():
            files.append(p)
    return sorted(
        set(files), key=lambda p: p.relative_to(clone_root).as_posix()
    )


async def run_pack_import(url: str, ref: str, source: str) -> Dict[str, Any]:
    """共享导入管线（/templates/import 与 /millforge/import 同一条）。

 前提：``validate_repo_url`` / ``clean_ref`` 已校验（调用方负责）。
 成功返回 meta dict（已落盘 pack 目录）；失败 400/502（不留半包）。
 ``source`` ∈ github/gitcode/custom（源配置 kind 或自定义 URL 标记）。
 """
    slug = _slug_from_url(url)
    if not slug:
        raise HTTPException(
            status_code=400, detail="无法从 URL 派生仓库名（slug 为空）"
        )

    tmp = tempfile.mkdtemp(prefix="millforge-import-")
    try:
        try:
            cp = await asyncio.to_thread(
                _run_git,
                ["clone", "--depth", "1", "--branch", ref, url, tmp],
                _CLONE_TIMEOUT,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(
                status_code=502,
                detail=f"git clone 超时（{_CLONE_TIMEOUT:.0f}s）——"
                "仓库过大或网络不通",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - git 缺失/参数异常族
            raise HTTPException(
                status_code=502, detail=f"git clone 失败：{exc}"
            ) from exc
        if cp.returncode != 0:
            err = (cp.stderr or cp.stdout or "").strip()
            last = err.splitlines()[-1] if err else f"exit {cp.returncode}"
            raise HTTPException(
                status_code=502,
                detail=f"git clone 失败：{last[:300]}",
            )

        src = Path(tmp)
        if not (src / "templates").is_dir():
            raise HTTPException(
                status_code=400,
                detail="仓库中未找到 templates/ 目录（不是千锻模板仓）",
            )
        files = _iter_pack_files(src)
        total = sum(p.stat().st_size for p in files)
        if total > _MAX_TOTAL_BYTES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"整包合计 {total // (1024 * 1024)}MB 超过 60MB 上限——"
                    "请精简模板仓后重试"
                ),
            )
        try:
            cp2 = await asyncio.to_thread(
                _run_git, ["-C", tmp, "rev-parse", "HEAD"], 10.0
            )
            commit = (
                (cp2.stdout or "").strip() if cp2.returncode == 0 else ""
            )
        except Exception:  # noqa: BLE001 - commit 缺失不致命（meta 空串）
            commit = ""

        dest = _templates_root() / slug
        if dest.exists():
            # 重复导入 = 整包覆盖（先清旧包再落新文件，不留残留）。
            shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True, exist_ok=True)
        tdir = src / "templates"
        rels: List[str] = []
        for p in files:
            # 布局契约：templates/ 内容落 pack 根（剥前缀）；其余保持原路径。
            base = tdir if p.is_relative_to(tdir) else src
            rel = p.relative_to(base).as_posix()
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, out)
            rels.append(rel)
        meta = {
            "source": source,
            "url": url,
            "ref": ref,
            "commit": commit,
            "imported_at": datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            "files": rels,
            "has_compiler": (dest / "compiler" / "millforge-compile.py").is_file(),
            "has_core": (dest / "core").is_dir(),
        }
        (dest / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        return meta
    finally:
        # 临时 clone 目录即弃（成功/失败都清，不留半包）。
        shutil.rmtree(tmp, ignore_errors=True)


def _parse_index(pack_dir: Path) -> Dict[str, List[Dict[str, Any]]]:
    """解析 pack 根 INDEX.yaml → 五组条目（四组 id/file/source/… + teams）。

 任何形态异常（无文件 / 非 mapping 顶层 / 组非 list / 条目非 mapping）
 都抛 ValueError——调用方把该 pack 标 ``parse_error``（其余 pack 照常）。
 PyYAML 是 qwenpaw 宿主既有依赖（pyyaml>=6.0），非本插件新增。
 """
    import yaml  # noqa: PLC0415 - 惰性（宿主依赖；隔离导入便于降级）

    p = pack_dir / "INDEX.yaml"
    if not p.is_file():
        raise ValueError("INDEX.yaml 不存在")
    data = yaml.safe_load(p.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("INDEX.yaml 顶层不是映射")
    out: Dict[str, List[Dict[str, Any]]] = {}
    for sec, aliases in _INDEX_SECTIONS:
        raw = None
        for key in aliases:
            if data.get(key) is not None:
                raw = data.get(key)
                break
        if raw is None:
            out[sec] = []
            continue
        if not isinstance(raw, (list, dict)):
            raise ValueError(f"{sec} 段既不是列表也不是映射")
        items: List[Dict[str, Any]] = []
        if isinstance(raw, dict):
            # 真实 INDEX.yaml 形态：id -> {file/budget/source/applies_to}。
            for key, it in raw.items():
                if not isinstance(it, dict):
                    raise ValueError(f"{sec} 含非映射条目")
                entry: Dict[str, Any] = {
                    f: _entry_str(it.get(f)) for f in _ENTRY_FIELDS
                }
                entry["id"] = str(key)
                file_ref = entry.get("file", "")
                if file_ref.startswith("templates/"):
                    entry["file"] = file_ref[len("templates/"):]
                items.append(entry)
        else:
            for it in raw:
                if not isinstance(it, dict):
                    raise ValueError(f"{sec} 含非映射条目")
                items.append({f: _entry_str(it.get(f)) for f in _ENTRY_FIELDS})
        out[sec] = items
    # teams 段（整队组合；条目形态不同于四组：
    # {name, industry, members: {leader, workers, critic}, domains[], source}）。
    teams_raw = data.get("teams")
    teams: List[Dict[str, Any]] = []
    if teams_raw is not None:
        if not isinstance(teams_raw, dict):
            raise ValueError("teams 段必须是 id -> 组合 的映射")
        for key, it in teams_raw.items():
            if not isinstance(it, dict):
                raise ValueError("teams 含非映射条目")
            members = it.get("members") or {}
            if not isinstance(members, dict):
                members = {}
            teams.append(
                {
                    "id": str(key),
                    "name": _entry_str(it.get("name")),
                    "industry": _entry_str(it.get("industry")),
                    "members": {
                        "leader": _entry_str(members.get("leader")),
                        "workers": _entry_str(members.get("workers")),
                        "critic": _entry_str(members.get("critic")),
                    },
                    "domains": _entry_str(it.get("domains")),
                    "source": _entry_str(it.get("source")),
                    "experimental": _entry_str(it.get("experimental")),
                }
            )
    out["teams"] = teams
    return out


def _load_meta(pack_dir: Path) -> Dict[str, Any] | None:
    """读 pack meta.json（缺失/损坏 → None，pack 仍列出——诚实降级）。"""
    try:
        data = json.loads((pack_dir / "meta.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


async def list_packs_payload() -> Dict[str, Any]:
    """共享 pack 列表（GET /templates 与 GET /millforge/packs 同款载荷：
 packs[{pack, meta, index|parse_error}]；HTTP 恒 200）。"""
    root = _templates_root()
    packs: List[Dict[str, Any]] = []
    if root.is_dir():
        for d in sorted(root.iterdir(), key=lambda p: p.name):
            if not d.is_dir():
                continue
            pack: Dict[str, Any] = {
                "pack": d.name,
                "meta": _load_meta(d),
                "index": None,
                "parse_error": None,
            }
            try:
                pack["index"] = await asyncio.to_thread(_parse_index, d)
            except Exception as exc:  # noqa: BLE001 - 单包隔离
                pack["parse_error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
            packs.append(pack)
    return {"packs": packs}


def read_pack_file(pack: str, path: str, exts: set) -> Dict[str, Any]:
    """共享 pack 文件读（防穿越：resolve 后必须仍在 pack 根内，含符号
 链接逃逸 → 400；扩展名白名单外 → 400；不存在 → 404）。"""
    if not _SLUG_RE.match(pack):
        raise HTTPException(status_code=404, detail="模板包不存在")
    root = _templates_root()
    pack_dir = (root / pack).resolve()
    if not pack_dir.is_dir():
        raise HTTPException(status_code=404, detail="模板包不存在")
    rel = (path or "").strip()
    if not rel:
        raise HTTPException(status_code=400, detail="path 必填")
    if rel.startswith("/") or "\\" in rel or rel.startswith(".."):
        raise HTTPException(
            status_code=400, detail="path 必须是 pack 根内的相对路径"
        )
    try:
        resolved = (pack_dir / rel).resolve()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"非法路径：{exc}")
    if not resolved.is_relative_to(pack_dir):
        raise HTTPException(status_code=400, detail="path 越出模板包根（拒绝）")
    if resolved.suffix.lower() not in exts:
        raise HTTPException(
            status_code=400,
            detail="只允许 " + " / ".join(sorted(exts)) + " 文件",
        )
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        content = resolved.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"文件读取失败：{exc}") from exc
    return {
        "pack": pack,
        "path": rel,
        "size": resolved.stat().st_size,
        "content": content,
    }


class TemplatesImportRequest(BaseModel):
    """模板导入请求（url 必填 + ref 默认 main）。"""

    url: str = ""
    ref: str = "main"


def build_templates_router() -> APIRouter:
    """千锻模板域 router（挂在 /agentteams-proxy 前缀下）。

 固定路径（/templates*）——必须注册在 catch-all（approval_api，
 ``/{target}/{path:path}``）之前，否则会被吞。
 """
    router = APIRouter(tags=["templates"])

    @router.post("/templates/import")
    async def templates_import(req: TemplatesImportRequest) -> Dict[str, Any]:
        """导入千锻模板包：https + host 白名单 + ref 白名单 → git clone
 --depth 1 → 文件集（templates/.md/.yaml + compiler/ + core/ + 根
 PHILOSOPHY*.md/requirements.txt，≤60MB）→ pack 目录（覆盖）+ meta.json。
 校验失败 400；clone 失败/超时 502（stderr 摘要）。"""
        url = (req.url or "").strip()
        ref = clean_ref(req.ref)
        validate_repo_url(url)
        meta = await run_pack_import(url, ref, source=_source_of_url(url))
        return {
            "ok": True,
            "pack": _slug_from_url(url),
            "files": len(meta["files"]),
            "commit": meta["commit"],
        }

    @router.get("/templates")
    async def templates_list() -> Dict[str, Any]:
        """列出全部 pack（meta + 解析后 INDEX 五组）。单 pack 解析失败只
 标该 pack parse_error，其余照常（HTTP 恒 200）。"""
        return await list_packs_payload()

    @router.get("/templates/{pack}/file")
    async def templates_file(pack: str, path: str = "") -> Dict[str, Any]:
        """读 pack 内单文件（.md/.yaml 只读预览）。

 path = pack 根相对路径（如 ``INDEX.yaml`` / ``skeleton/foo.md``）。
 防穿越：resolve 后必须仍在 pack 根内（含符号链接逃逸）→ 否则 400；
 非 .md/.yaml → 400；不存在 → 404。
 """
        return read_pack_file(pack, path, _ALLOWED_EXTS)

    @router.delete("/templates/{pack}")
    async def templates_delete(pack: str) -> Dict[str, Any]:
        """删除 pack 目录（幂等：不存在也 200 + deleted=false）。"""
        if not _SLUG_RE.match(pack):
            return {"ok": True, "deleted": False}
        pack_dir = _templates_root() / pack
        if not pack_dir.is_dir():
            return {"ok": True, "deleted": False}
        shutil.rmtree(pack_dir, ignore_errors=True)
        return {"ok": True, "deleted": True}

    return router


def _source_of_url(url: str) -> str:
    """URL host → 源标记（meta.source：github/gitcode/gitee）。"""
    host = (urlparse(url).hostname or "").lower()
    if host == "github.com":
        return "github"
    if host == "gitcode.com":
        return "gitcode"
    if host == "gitee.com":
        return "gitee"
    return "custom"
