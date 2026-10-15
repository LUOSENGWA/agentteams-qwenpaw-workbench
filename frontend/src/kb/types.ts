// KB 域共享类型（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移，行为零变）。
// api 侧类型（KbAgent/KbDirItem/Memory* 等）由各消费方继续从 "../api" 直接
// import（与搬移前同口径），本文件只收 KB 域自身定义的共享类型。

import type { KbDirItem, KbFileItem, MemorySection } from "../api";

export interface GraphNodeLike {
  id: string;
  name: string;
  virtual?: boolean;
  category?: string;
  /** false=未解析引用（文件不存在，不可点开）。 */
  resolved?: boolean;
  /** 聚合图谱节点归属 Agent（agent::path 前缀）。 */
  agent?: string;
  section?: "daily" | "digest" | null;
  relative_path?: string | null;
  path?: string;
  description?: string;
}

export interface SelectedFile {
  section: MemorySection | "remote";
  filename: string;
  title: string;
}

export interface KbState {
  agent?: string;
  team?: string;
  graphMode?: "agent" | "merged";
}

export interface AnyFile {
  filename?: string;
  path?: string;
  size?: number;
  mtime?: number;
  /** 非文本文件灰显不可点（后端全量列目录）。 */
  openable?: boolean;
}

/** 目录懒加载缓存条目。 */
export type DirChild = { files: KbFileItem[]; dirs: KbDirItem[] };
