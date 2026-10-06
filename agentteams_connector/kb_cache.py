# -*- coding: utf-8 -*-
"""v0.5.0-beta.14.10：KB 端点 SWR 磁盘缓存。

背景（实测）：冷读容器 tree 最慢 13.8s、graph 同级、/kb/agents 3.3s 且
无缓存（每次全量）；命中缓存 = 4-5ms。冷开知识库长时间空转 → 体感「记忆
没生效」。修法 = stale-while-revalidate + 磁盘持久缓存：重启/换页后旧值
秒回（cached/age 标记），后台单飞静默刷新（见 router._spawn_kb_refresh）。

目录 = 配置同级的 kb-cache/（config.py 的 _CONFIG_PATH 父目录下）；
文件 {safe_key}.json = {"ts": epoch, "payload": ...}；原子写
（tmp+rename）。写失败静默、读失败 → None（缓存不佳不影响主流程）。

用法：load(key) → (ts, payload) | None；save(key, payload)。
测试可 monkeypatch _CACHE_DIR 到 tmp_path（conftest autouse fixture 已
整测重定向，不碰真实 secret 目录）。
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional, Tuple

from .config import _CONFIG_DIR

# 模块级缓存目录（测试 monkeypatch 本变量到 tmp_path 即完成隔离）。
_CACHE_DIR: Path = _CONFIG_DIR / "kb-cache"

# key 安全过滤：agent 名/端点种类只放行字母数字与 _ . -（防路径穿越、
# 防特殊字符进文件名）。
_KEY_RE = re.compile(r"[^A-Za-z0-9_.-]")


def cache_dir() -> str:
    """惰性建缓存目录（mkdir -p），返回路径字符串。"""
    d = Path(_CACHE_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def _file_for(key: str) -> Path:
    """key → 缓存文件路径（先过滤特殊字符）。"""
    return Path(_CACHE_DIR) / f"{_KEY_RE.sub('_', str(key))}.json"


def load(key: str) -> Optional[Tuple[float, Any]]:
    """读缓存 → (ts, payload)；文件缺失/损坏/形状异常 → None。"""
    try:
        raw = json.loads(_file_for(key).read_text(encoding="utf-8"))
        ts = float(raw["ts"])
        payload = raw.get("payload")
        # 形状异常（payload 非 dict）= 视同损坏——KB 三类 payload
        # （agents/tree/graph）与 last-agent 记录均为 dict。
        if not isinstance(payload, dict):
            return None
        return (ts, payload)
    except Exception:  # noqa: BLE001 - 缓存不佳不影响主流程
        return None


def save(key: str, payload: Any) -> None:
    """写缓存（原子 tmp+rename）；写失败静默（缓存不佳不影响主流程）。"""
    try:
        p = _file_for(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(
            json.dumps({"ts": time.time(), "payload": payload},
                       ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001 - 缓存不佳不影响主流程
        pass


# ── v0.5.0-beta.14.11：轻探针（变更检测）扩展 ─────────────────
# probe 存 {safe_key}.probe（纯文本，独立于 payload json）：探针刷新不碰
# payload、深扫落盘不碰 probe，两侧互不重写。


def _probe_file_for(key: str) -> Path:
    """key → 探针签名文件路径（特殊字符过滤同缓存文件）。"""
    return Path(_CACHE_DIR) / f"{_KEY_RE.sub('_', str(key))}.probe"


def save_probe(key: str, probe: str) -> None:
    """写探针签名（原子 tmp+rename）；写失败静默（同 save 风格）。"""
    try:
        p = _probe_file_for(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(str(probe), encoding="utf-8")
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001 - 探针不佳不影响主流程
        pass


def load_probe(key: str) -> Optional[str]:
    """读探针签名；缺失/读失败 → None（调用方退回深扫，安全）。"""
    try:
        return _probe_file_for(key).read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001 - 探针不佳不影响主流程
        return None


def touch(key: str) -> None:
    """把缓存的 ts 更新为现在（刷新检查通过后重置 60s 时钟）。

 v0.5.0-beta.14.11：读-改-写只更新 ts，payload/probe
 原样不动；键缺失/损坏时静默（同 save 风格，不影响主流程）。"""
    try:
        p = _file_for(key)
        raw = json.loads(p.read_text(encoding="utf-8"))
        raw["ts"] = time.time()
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(raw, ensure_ascii=False),
                       encoding="utf-8")
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001 - 探针不佳不影响主流程
        pass
