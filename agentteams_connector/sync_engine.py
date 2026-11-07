# -*- coding: utf-8 -*-
"""兼容再导出壳：本单实现主体在 ``file_sync_engine``（避免与
``sync_watcher`` 混淆，见任务书命名约定）；本模块保留 ``sync_engine``
导入路径可用，两个名字指向同一实现。SYNC-STORE 落盘存储
（``sync_store``：根迁移 + http/chat/lru 缓存）一并再导出。"""
from .file_sync_engine import (  # noqa: F401
    DEFAULT_HUMAN,
    HttpResult,
    SyncEngine,
    build_ctl_call,
    ensure_engine,
    get_engine,
    reset_for_tests,
    safe_rel_path,
    resolve_workspace_root,
    set_current_agent,
    start,
    stop,
)
from .sync_store import (  # noqa: F401
    MAX_CHAT_MESSAGES,
    MAX_HTTP_BODY_BYTES,
    MAX_LRU_ENTRIES,
    SyncStore,
    http_key,
    legacy_root_for,
    migrate_root,
)
