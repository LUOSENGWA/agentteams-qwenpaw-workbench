// 知识库域（/kb/*）：远端 workspace 档案/文件/图谱/跨 Worker 搜索。

import { requestJson } from "../shared";
import { cachedRequest } from "../../requestCache";

// W3 知识库——宿主 ReMe 记忆类型。15.29 屎山清理：memory 取数簇函数已退役
// （无 UI 承载），仅保留 MemorySection 段语义（kb/types.ts 在用）。
export type MemorySection = "daily" | "digest";

// 15.29 屎山清理：旧 memory 取数簇（fetchMemoryGraph/fetchMemoryStatus/
// reindexMemory/listMemoryFiles/loadMemoryFile）与 fetchAgentIdList 全零
// 引用（无 memory UI 承载、KB 已改走 getSelectedAgentId 正源）→ 退役。
// 类型 MemorySection 保留（kb/types.ts 在用的「daily|digest」段语义）。

// ── 远端团队知识库（用户定位）────────────────────────
// 数据通道：插件后端 → Controller Docker API 代理（docker/v1.41/
// containers/{worker}/archive?path=...，GET 只读恒放行）→ 读 Worker
// 容器内 .qwenpaw/workspaces/default（MEMORY.md + memory/ + SOUL.md）。
// 需要 Controller admin token（L1）；无 token → 401 → 组件降级本地。
// ────────────────────────────────────────────────────────────────────

export interface KbAgent {
  name: string;
  container: string;
  state: string;
  kind: "worker" | "manager";
  team?: string;
  role?: "leader" | "worker" | "critic";
  /** ：runtime 判定字段（controller 透传；
   * 旧 controller / manager 无此字段 = undefined，降级为仅按 runtime 判定）。 */
  runtime?: string;
  runtimeDeprecated?: boolean;
}

export interface KbFileItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
  /** 四分类（对齐 QwenPaw 文件管理）：
 * profile=档案 / daily=日记 / digest=知识库 / file=文件 */
  category?: string;
  /** false=非文本/符号链接文件——列出但不可点开
 * （工作区目录诚实镜像；缺省=true 兼容旧响应）。 */
  openable?: boolean;
  /** 符号链接文件（目标=文件/断链）。 */
  symlink?: boolean;
}

/** 远端 workspace 顶层目录（只列不展开）。 */
export interface KbDirItem {
  path: string;
  name: string;
  isdir: boolean;
  category?: string;
  /** 目录是符号链接（find -H 展开时跟随）。 */
  symlink?: boolean;
}

interface KbTree {
  agent: string;
  workspace: string;
  files: KbFileItem[];
  /** workspace 顶层目录（文件分类展示用）。 */
  dirs: KbDirItem[];
  count: number;
}

interface KbDirList {
  agent: string;
  dir: string;
  files: KbFileItem[];
  dirs: KbDirItem[];
}

interface KbFileContent {
  path: string;
  size: number;
  content: string;
}

interface KbGraphData {
  agent: string;
  nodes: { id: string; name: string; category: string; virtual: boolean }[];
  edges: { source: string; target: string }[];
  file_count: number;
}

/** 远端 Agent 清单（需 Controller token；401 = 未配置 → 调用方降级）。
 * cachedRequest 包裹（kb/agents，30s）。 */
export async function fetchKbAgents(): Promise<KbAgent[]> {
  return cachedRequest("kb/agents", 30000, async () => {
    const raw = (await requestJson(
      "/agentteams-proxy/kb/agents",
    )) as Record<string, unknown>;
    const agents = Array.isArray(raw.agents) ? raw.agents : [];
    return agents as KbAgent[];
  });
}

export async function fetchKbTree(agent: string): Promise<KbTree> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/tree`,
  )) as Record<string, unknown>;
  return {
    agent: String(raw.agent ?? agent),
    workspace: String(raw.workspace ?? ""),
    files: (Array.isArray(raw.files) ? raw.files : []) as KbFileItem[],
    dirs: (Array.isArray(raw.dirs) ? raw.dirs : []) as KbDirItem[],
    count: typeof raw.count === "number" ? raw.count : 0,
  };
}

/** 目录懒加载（知识库目录树展开，工作区子目录文件可见可开）。 */
export async function fetchKbDir(
  agent: string,
  dir: string,
): Promise<KbDirList> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/ls?dir=${encodeURIComponent(dir)}`,
  )) as Record<string, unknown>;
  return {
    agent: String(raw.agent ?? agent),
    dir: String(raw.dir ?? dir),
    files: (Array.isArray(raw.files) ? raw.files : []) as KbFileItem[],
    dirs: (Array.isArray(raw.dirs) ? raw.dirs : []) as KbDirItem[],
  };
}

export async function fetchKbFile(
  agent: string,
  path: string,
): Promise<KbFileContent> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/file?path=${encodeURIComponent(path)}`,
  )) as Record<string, unknown>;
  return {
    path: String(raw.path ?? path),
    size: typeof raw.size === "number" ? raw.size : 0,
    content: String(raw.content ?? ""),
  };
}

export async function fetchKbGraph(agent: string): Promise<KbGraphData> {
  const raw = (await requestJson(
    `/agentteams-proxy/kb/${encodeURIComponent(agent)}/graph`,
  )) as Record<string, unknown>;
  return {
    agent: String(raw.agent ?? agent),
    nodes: (Array.isArray(raw.nodes) ? raw.nodes : []) as KbGraphData["nodes"],
    edges: (Array.isArray(raw.edges) ? raw.edges : []) as KbGraphData["edges"],
    file_count: typeof raw.file_count === "number" ? raw.file_count : 0,
  };
}

// ── 团队知识库深化（跨 Worker 搜索 + 聚合图谱）────────────

export interface KbSearchMatch {
  agent: string;
  path: string;
  line: number;
  snippet: string;
}

export async function fetchKbSearch(
  q: string,
  agents?: string,
): Promise<{ query: string; matches: KbSearchMatch[]; count: number; agents: string[] }> {
  const params = new URLSearchParams({ q });
  if (agents) params.set("agents", agents);
  return (await requestJson(
    `/agentteams-proxy/kb/search?${params.toString()}`,
  )) as { query: string; matches: KbSearchMatch[]; count: number; agents: string[] };
}

export async function fetchKbGraphMerged(
  agents?: string,
): Promise<{ nodes: KbGraphData["nodes"]; edges: KbGraphData["edges"]; agents: string[] }> {
  const params = agents ? `?agents=${encodeURIComponent(agents)}` : "";
  const raw = (await requestJson(
    `/agentteams-proxy/kb/graph/merged${params}`,
  )) as Record<string, unknown>;
  return {
    nodes: (Array.isArray(raw.nodes) ? raw.nodes : []) as KbGraphData["nodes"],
    edges: (Array.isArray(raw.edges) ? raw.edges : []) as KbGraphData["edges"],
    agents: (Array.isArray(raw.agents) ? raw.agents : []) as string[],
  };
}
