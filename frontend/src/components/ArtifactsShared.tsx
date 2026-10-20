/** Artifacts 子模块——自 Artifacts.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import {
  projectActivityTs,
  type Artifact,
  type WorkflowTaskDetail,
} from "../api";

const host = window.QwenPaw.host;
const React = host.React;

const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ImageIcon = pick("FileImageOutlined");
const TextIcon = pick("FileTextOutlined");
const FileIcon = pick("FileOutlined");
const CodeIcon = pick("CodeOutlined");
const DataIcon = pick("DatabaseOutlined");

export const PRIMARY = "var(--app-accent, #FF7F16)";

// ── 正源类型（端点已合并；Controller 升级后自动生效）──
// 字段 1:1 对齐 Go projectSummary（核对 6 字段；本次补
// name/created_at/updated_at/worker_count——排序/筛选需要时间戳与团队）。
export interface ProjectSummary {
  project_id: string;
  title: string;
  status: string;
  plan_type?: string;
  team_id?: string;
  mode?: string;
  name?: string;
  created_at?: number;
  updated_at?: number;
  worker_count?: number;
}

// 局部类型提升为 api.ts 共享类型（群内项目文件面板与
// 产物 tab 同源同型）；组件内渲染代码经别名零改动。旧局部
// WorkflowResponse 的 nodes 字段本文件无读取点（grep 核实），随提升移除。
export type TaskDetail = WorkflowTaskDetail; // 组件内渲染代码零改动别名

/** 正源产物下载 URL（项目产物端点，query path 透传）。 */
export function artifactDownloadUrl(
  projectId: string,
  taskId: string,
  path: string,
): string {
  return (
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/tasks/${encodeURIComponent(taskId)}/artifact?path=${encodeURIComponent(path)}`
  );
}

// ── 工具函数 ──────────────────────────────────────────────
/**
 * 项目时间戳（排序/树标题共用）。上游 ListProjects 的
 * projectSummary 目前不含时间戳字段（v1.2.3 实测全无 created_at/
 * updated_at；meta.json 有 UpdatedAt string 未映射进列表——上游候选
 * PR 已记）。字段优先（number/string 都认，上游补字段后自动生效）→
 * 缺失用 project_id 内嵌日期近似（YYYYMMDD 段）→ 都没有 = 0。
 * 曾直接取不存在的字段 → 全 0 排序空转（交付前自查发现）。
 */
/** workflow 详情富化元数据（时间多源需要项目房间 id）。 */
export interface ProjectMeta {
  /** 项目来源房间（workflow meta.source_room_id，项目专用群）。 */
  roomId?: string;
  /** workflow meta.updated_at（omitempty，仅生命周期写 API 写过才有）。 */
  updatedAt?: string;
}

/**
 * 项目时间戳（排序/树标题共用）。上游 ListProjects 的
 * projectSummary 目前不含时间戳字段（v1.2.3 实测全无 created_at/
 * updated_at；meta.json 有 UpdatedAt string 未映射进列表——上游候选
 * PR 已记）。起走 api.ts projectActivityTs 多源：
 * 真实字段（列表/workflow 详情，上游补字段后自动生效）→ 项目房间
 * 最后消息（roomsCache 零额外请求）→ project_id 内嵌日期近似 → 0。
 */
export function projectTs(
  p: {
    project_id?: string;
    updated_at?: unknown;
    created_at?: unknown;
  },
  meta?: ProjectMeta,
): number {
  const raw: unknown = p.updated_at ?? p.created_at ?? meta?.updatedAt;
  let realTs = 0;
  if (raw) {
    const t = typeof raw === "string" ? Date.parse(raw) : Number(raw);
    if (t && !Number.isNaN(t)) realTs = t;
  }
  return projectActivityTs(realTs, meta?.roomId || "", p.project_id || "");
}

export function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

export function truncateFilename(name: string): string {
  if (name.length <= 19) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot >= name.length - 8) {
    return `${name.slice(0, 15)}…${name.slice(dot)}`;
  }
  return `${name.slice(0, 15)}…${name.slice(-4)}`;
}


function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type ArtifactKind = "image" | "document" | "data" | "code" | "other";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);
const DOC_EXT = new Set([
  "md", "markdown", "txt", "log", "pdf", "doc", "docx", "xlsx", "xls",
  "pptx", "ppt", "rtf", "html", "htm",
]);
const DATA_EXT = new Set(["json", "csv", "tsv", "yaml", "yml", "xml", "sql"]);
const CODE_EXT = new Set([
  "py", "ts", "tsx", "js", "jsx", "go", "rs", "sh", "bash", "java", "c",
  "cpp", "h", "hpp", "css", "scss", "toml", "ini", "conf",
]);

export function kindOf(name: string, isImage = false): ArtifactKind {
  if (isImage) return "image";
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (DOC_EXT.has(ext)) return "document";
  if (DATA_EXT.has(ext)) return "data";
  if (CODE_EXT.has(ext)) return "code";
  return "other";
}

export function artifactKind(a: Artifact): ArtifactKind {
  return kindOf(a.filename || a.body, a.msgtype === "m.image");
}

export const KIND_META: Record<ArtifactKind, { label: string; icon: ReactNS.ReactNode }> = {
  image: { label: "图片", icon: <ImageIcon style={{ color: PRIMARY }} /> },
  document: { label: "文档", icon: <TextIcon style={{ color: "#1677ff" }} /> },
  data: { label: "数据", icon: <DataIcon style={{ color: "#52c41a" }} /> },
  code: { label: "代码", icon: <CodeIcon style={{ color: "#722ed1" }} /> },
  other: { label: "其他", icon: <FileIcon style={{ color: "#999" }} /> },
};

/** 统一文件条目（正源产物 / 房间附件共用渲染）。 */
export interface FileEntry {
  key: string;
  name: string;
  kind: ArtifactKind;
  size: number | null;
  source: string; // 项目名 / 房间名
  time: number;
  sender: string;
  /** MIME（文件名无扩展时预览靠它识别 md——修 RAW 不渲染）。 */
  mimeType?: string;
  /** 正源：项目产物下载参数。 */
  projectId?: string;
  taskId?: string;
  artifactPath?: string;
  /** fallback：mxc 直链。 */
  mxcUrl?: string;
}
