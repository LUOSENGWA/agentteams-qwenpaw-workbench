# -*- coding: utf-8 -*-
"""千锻（Millforge）模板导入域：git clone templates 目录 → 本地 pack →
浏览/预览/删除。

背景：千锻仓（LUOSENGWA/millforge，GitHub/GitCode 镜像）自带模板库
``templates/``（INDEX.yaml 注册表 + {skeleton,industry,domain,fragments}/
*.md）。本域把这套模板导入工作台本地（``<config_dir>/templates/<slug>/``），
供「团队管理 → 千锻模板」卡浏览并在建队时预填（``模板来源=<pack>/<id>``，
仅表单字段记录——**本 MVP 不执行千锻编译器**，编译器是 P2 另开单）。

端点（挂在 /agentteams-proxy 前缀下，固定路径须在 catch-all 之前注册）：

- ``POST /templates/import`` ``{url, ref}``——只允许 ``https://`` + host
  白名单（github.com / gitcode.com / gitee.com）+ ref 白名单
  （``[A-Za-z0-9._/-]{1,100}``）→ 400；``git clone --depth 1``（subprocess，
  90s 超时）失败/超时 → 502 + stderr 摘要；只取 ``templates/`` 下
  ``.md`` / ``.yaml``（合计 ≤20MB → 否则 400）复制到 pack 目录（slug=仓库
  名，重复导入覆盖）+ ``meta.json`` ``{url, ref, commit, imported_at, files}``。
- ``GET /templates``——列出全部 pack + 解析后的 INDEX.yaml（四组各条
  id/file/source/applies_to/budget）+ meta；单 pack 解析失败只标该 pack
  ``parse_error``，其余照常（诚实降级，不整体 500）。
- ``GET /templates/{pack}/file?path=``——只允许 ``.md`` / ``.yaml``；路径
  resolve 后必须仍在 pack 根内（防穿越，含符号链接）；不存在 404。
- ``DELETE /templates/{pack}``——删除 pack 目录（幂等：不存在也 200，
  ``deleted=false``）。

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
_MAX_TOTAL_BYTES = 20 * 1024 * 1024  # templates/ 合计上限
_CLONE_TIMEOUT = 90.0  # git clone 超时（s）
_ALLOWED_EXTS = {".md", ".yaml"}  # 只导入/可预览的扩展名
_INDEX_SECTIONS = ("skeletons", "industry", "domain", "fragments")
_ENTRY_FIELDS = ("id", "file", "source", "applies_to", "budget")


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


def _parse_index(pack_dir: Path) -> Dict[str, List[Dict[str, str]]]:
    """解析 pack 根 INDEX.yaml → 四组条目（id/file/source/applies_to/budget）。

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
    out: Dict[str, List[Dict[str, str]]] = {}
    for sec in _INDEX_SECTIONS:
        raw = data.get(sec)
        if raw is None:
            out[sec] = []
            continue
        if not isinstance(raw, (list, dict)):
            raise ValueError(f"{sec} 段既不是列表也不是映射")
        items: List[Dict[str, str]] = []
        if isinstance(raw, dict):
            # 真实 INDEX.yaml 形态：id -> {file/budget/source/applies_to}。
            for key, it in raw.items():
                if not isinstance(it, dict):
                    raise ValueError(f"{sec} 含非映射条目")
                entry = {f: _entry_str(it.get(f)) for f in _ENTRY_FIELDS}
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
    return out


def _load_meta(pack_dir: Path) -> Dict[str, Any] | None:
    """读 pack meta.json（缺失/损坏 → None，pack 仍列出——诚实降级）。"""
    try:
        data = json.loads((pack_dir / "meta.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


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
 --depth 1 → 只取 templates/（.md/.yaml，≤20MB）→ pack 目录（覆盖）+
 meta.json。校验失败 400；clone 失败/超时 502（stderr 摘要）。"""
        url = (req.url or "").strip()
        ref = (req.ref or "").strip() or "main"
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
        if not _REF_RE.match(ref):
            raise HTTPException(
                status_code=400,
                detail="ref 只允许字母/数字/. _ / -，且 ≤100 字符",
            )
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

            src = Path(tmp) / "templates"
            if not src.is_dir():
                raise HTTPException(
                    status_code=400,
                    detail="仓库中未找到 templates/ 目录（不是千锻模板仓）",
                )
            files = sorted(
                p
                for p in src.rglob("*")
                if p.is_file() and p.suffix.lower() in _ALLOWED_EXTS
            )
            total = sum(p.stat().st_size for p in files)
            if total > _MAX_TOTAL_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"templates/ 合计 {total // 1024}KB 超过 20MB 上限——"
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
            rels: List[str] = []
            for p in files:
                rel = p.relative_to(src).as_posix()
                out = dest / rel
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, out)
                rels.append(rel)
            meta = {
                "url": url,
                "ref": ref,
                "commit": commit,
                "imported_at": datetime.now(timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "files": rels,
            }
            (dest / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            return {
                "ok": True,
                "pack": slug,
                "files": len(rels),
                "commit": commit,
            }
        finally:
            # 临时 clone 目录即弃（成功/失败都清，不留半包）。
            shutil.rmtree(tmp, ignore_errors=True)

    @router.get("/templates")
    async def templates_list() -> Dict[str, Any]:
        """列出全部 pack（meta + 解析后 INDEX 四组）。单 pack 解析失败只
 标该 pack parse_error，其余照常（HTTP 恒 200）。"""
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
                    pack["parse_error"] = (
                        f"{type(exc).__name__}: {str(exc)[:200]}"
                    )
                packs.append(pack)
        return {"packs": packs}

    @router.get("/templates/{pack}/file")
    async def templates_file(pack: str, path: str = "") -> Dict[str, Any]:
        """读 pack 内单文件（.md/.yaml 只读预览）。

 path = pack 根相对路径（如 ``INDEX.yaml`` / ``skeleton/foo.md``）。
 防穿越：resolve 后必须仍在 pack 根内（含符号链接逃逸）→ 否则 400；
 非 .md/.yaml → 400；不存在 → 404。
 """
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
            raise HTTPException(
                status_code=400, detail="path 越出模板包根（拒绝）"
            )
        if resolved.suffix.lower() not in _ALLOWED_EXTS:
            raise HTTPException(
                status_code=400, detail="只允许 .md / .yaml 文件"
            )
        if not resolved.is_file():
            raise HTTPException(status_code=404, detail="文件不存在")
        try:
            content = resolved.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise HTTPException(
                status_code=502, detail=f"文件读取失败：{exc}"
            ) from exc
        return {
            "pack": pack,
            "path": rel,
            "size": resolved.stat().st_size,
            "content": content,
        }

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
