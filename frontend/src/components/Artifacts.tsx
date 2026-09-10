import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { FilePreview, type PreviewFile } from "./FilePreview";
import {
  downloadViaHost,
  resolveFileTarget,
  resolvePluginUrl,
  fetchArtifacts,
  fetchProjectSummaries,
  getCachedRooms,
  projectActivityTs,
  requestJson,
  httpErrorStatus,
  httpErrorDetail,
  type Artifact,
} from "../api";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");
const DownloadIcon = pick("DownloadOutlined");
const EyeIcon = pick("EyeOutlined");
const ImageIcon = pick("FileImageOutlined");
const TextIcon = pick("FileTextOutlined");
const FileIcon = pick("FileOutlined");
const CodeIcon = pick("CodeOutlined");
const DataIcon = pick("DatabaseOutlined");

const PRIMARY = "#FF7F16";

// ── 正源类型（#1169 端点已合并；Controller 升级后自动生效）──
// v0.4.88: 字段 1:1 对齐 Go projectSummary（v0.4.86 核对 6 字段；本次补
// name/created_at/updated_at/worker_count——排序/筛选需要时间戳与团队）。
interface ProjectSummary {
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

interface TaskDetail {
  task_id: string;
  status?: string;
  assigned_to?: string;
  result_status?: string;
  summary?: string;
  deliverables?: string[];
  result_path?: string;
}

interface WorkflowResponse {
  tasks_detail?: TaskDetail[];
  nodes?: { id: string; name: string; status: string; assignee?: string }[];
  [k: string]: unknown;
}

/** 正源产物下载 URL（O19 artifact 端点，query path 透传）。 */
function artifactDownloadUrl(
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
 * v0.4.89: 项目时间戳（排序/树标题共用）。上游 ListProjects 的
 * projectSummary 目前不含时间戳字段（v1.2.3 实测全无 created_at/
 * updated_at；meta.json 有 UpdatedAt string 未映射进列表——上游候选
 * PR 已记）。字段优先（number/string 都认，上游补字段后自动生效）→
 * 缺失用 project_id 内嵌日期近似（YYYYMMDD 段）→ 都没有 = 0。
 * v0.4.88 曾直接取不存在的字段 → 全 0 排序空转（交付前自查发现）。
 */
/** workflow 详情富化元数据（v0.4.98 再版 9：时间多源需要项目房间 id）。 */
interface ProjectMeta {
  /** 项目来源房间（workflow meta.source_room_id，项目专用群）。 */
  roomId?: string;
  /** workflow meta.updated_at（omitempty，仅生命周期写 API 写过才有）。 */
  updatedAt?: string;
}

/**
 * v0.4.89: 项目时间戳（排序/树标题共用）。上游 ListProjects 的
 * projectSummary 目前不含时间戳字段（v1.2.3 实测全无 created_at/
 * updated_at；meta.json 有 UpdatedAt string 未映射进列表——上游候选
 * PR 已记）。v0.4.98 再版 9 起走 api.ts projectActivityTs 多源：
 * 真实字段（列表/workflow 详情，上游补字段后自动生效）→ 项目房间
 * 最后消息（roomsCache 零额外请求）→ project_id 内嵌日期近似 → 0。
 */
function projectTs(
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

function formatSize(bytes?: number | null): string {
  const n = Number(bytes || 0);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
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

function truncateFilename(name: string): string {
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

function kindOf(name: string, isImage = false): ArtifactKind {
  if (isImage) return "image";
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (DOC_EXT.has(ext)) return "document";
  if (DATA_EXT.has(ext)) return "data";
  if (CODE_EXT.has(ext)) return "code";
  return "other";
}

function artifactKind(a: Artifact): ArtifactKind {
  return kindOf(a.filename || a.body, a.msgtype === "m.image");
}

const KIND_META: Record<ArtifactKind, { label: string; icon: ReactNS.ReactNode }> = {
  image: { label: "🖼️ 图片", icon: <ImageIcon style={{ color: PRIMARY }} /> },
  document: { label: "📄 文档", icon: <TextIcon style={{ color: "#1677ff" }} /> },
  data: { label: "📊 数据", icon: <DataIcon style={{ color: "#52c41a" }} /> },
  code: { label: "💻 代码", icon: <CodeIcon style={{ color: "#722ed1" }} /> },
  other: { label: "📎 其他", icon: <FileIcon style={{ color: "#999" }} /> },
};

/** 统一文件条目（正源产物 / 房间附件共用渲染）。 */
interface FileEntry {
  key: string;
  name: string;
  kind: ArtifactKind;
  size: number | null;
  source: string; // 项目名 / 房间名
  time: number;
  sender: string;
  /** MIME（v0.4.81：文件名无扩展时预览靠它识别 md——修 RAW 不渲染）。 */
  mimeType?: string;
  /** 正源：O19 artifact 下载参数。 */
  projectId?: string;
  taskId?: string;
  artifactPath?: string;
  /** fallback：mxc 直链。 */
  mxcUrl?: string;
}

export interface ArtifactsProps {
  rooms?: { room_id: string; name: string }[];
  onBack?: () => void;
}

export default function Artifacts(props: ArtifactsProps) {
  const t = useThemeColors();
  const tr = useT();
  const { rooms = [], onBack } = props;
  // 正源：项目产物（#1169 端点；Controller 未升级时 projects=[] 自动 fallback）。
  const [projects, setProjects] = React.useState<ProjectSummary[] | null>(null);
  const [tasksByProject, setTasksByProject] = React.useState<
    Record<string, TaskDetail[]>
  >({});
  /** v0.4.98 再版 9：项目时间多源元数据（roomId/updatedAt，workflow 详情来）。 */
  const [metaByProject, setMetaByProject] = React.useState<
    Record<string, ProjectMeta>
  >({});
  const [projectsLoading, setProjectsLoading] = React.useState(false);
  // v0.4.82: 正源降级原因（横幅提示，不再静默空列表）。
  const [o19Fail, setO19Fail] = React.useState<
    "auth" | "not_deployed" | "error" | null
  >(null);
  // re17: error 分支的真实上游错误（此前被通用文案「Controller 不可用」掩盖——
  // 如 Controller 500「mc ls ... 0 drives provided」= Controller 侧 MinIO 客户端故障）。
  const [o19FailDetail, setO19FailDetail] = React.useState("");
  // fallback：房间附件扫描。
  const [items, setItems] = React.useState<Artifact[]>([]);
  const [itemsLoading, setItemsLoading] = React.useState(false);
  // 选择态：selectedKey = tree 节点 key。
  const [selectedKey, setSelectedKey] = React.useState<string>("root");
  const [expandedKeys, setExpandedKeys] = React.useState<ReactNS.Key[]>(["projects"]);
  // v0.4.88: 项目产物排序 + 团队筛选（纯前端，零后端改动）。
  const [projSort, setProjSort] = React.useState<
    "time_desc" | "time_asc" | "name"
  >("time_desc");
  const [teamFilter, setTeamFilter] = React.useState<string>("all");
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);

  // 正源加载：GET /api/v1/projects（404 → 端点未部署 → projects=[] fallback）。
  // v0.4.86: 走 fetchProjectSummaries 统一解包——此前只认裸数组，Controller
  // 信封 {projects,total} 被误判空列表（200 真数据仍渲染「暂无项目」，
  // 且 o19Fail=null 无降级横幅）。
  const refreshProjects = React.useCallback(async (force = false) => {
    setProjectsLoading(true);
    try {
      const list = await fetchProjectSummaries(force);
      setProjects(list as unknown as ProjectSummary[]);
      setO19Fail(null);
      setO19FailDetail("");
    } catch (e) {
      // re17: 按真实状态码分类 + 保留 detail（此前字符串匹配 401/403/404，
      // 5xx 上游错误的真实原因丢失，横幅只显示「Controller 不可用」）。
      const status = httpErrorStatus(e);
      setProjects([]); // fallback 附件扫描
      setO19FailDetail(httpErrorDetail(e));
      setO19Fail(
        status === 401 || status === 403
          ? "auth"
          : status === 404
            ? "not_deployed"
            : "error",
      );
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const refreshItems = React.useCallback(async (force = false) => {
    setItemsLoading(true);
    try {
      setItems(await fetchArtifacts(force));
    } catch {
      antd.message.error("房间附件扫描失败");
    } finally {
      setItemsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshProjects();
    void refreshItems();
  }, [refreshProjects, refreshItems]);

  // 选中项目时懒加载其 workflow（tasks_detail）。
  // v0.4.89: 带 ?team=——同一 project_id 跨团队/全局目录重复注册时裸 id
  // 寻址 Controller 回 409 ambiguous（8/22 实测：agentteam-eval-... 裸调
  // 409、?team=<某团队> 200）；此前 catch 静默吞 → 重复项目的任务
  // 恒空（「项目产物（0）」的第二成因）。与 fetchWorkflowProjects 的
  // v0.4.83 ?team= 修法对齐。
  const loadProjectTasks = React.useCallback(
    async (projectId: string, teamId?: string) => {
      if (tasksByProject[projectId]) return;
      try {
        const teamQ = teamId
          ? `&team=${encodeURIComponent(teamId)}`
          : "";
        const wf = (await requestJson(
          `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}/workflow?includeTasks=true${teamQ}`,
        )) as WorkflowResponse;
        setTasksByProject((prev) => ({
          ...prev,
          [projectId]: wf.tasks_detail || [],
        }));
        // v0.4.98 再版 9：存时间多源元数据（source_room_id → 房间最后消息；
        // updated_at → 真实生命周期时间）。
        setMetaByProject((prev) => ({
          ...prev,
          [projectId]: {
            roomId: typeof wf.source_room_id === "string" ? wf.source_room_id : "",
            updatedAt:
              typeof wf.updated_at === "string" && wf.updated_at
                ? wf.updated_at
                : undefined,
          },
        }));
      } catch {
        setTasksByProject((prev) => ({ ...prev, [projectId]: [] }));
      }
    },
    [tasksByProject],
  );

  // v0.4.88: 项目列表就绪后并行预取全部项目的 workflow（tasks_detail）——
  // 展开/收起问题根治：旧版任务只在选择行时异步加载，项目节点在加载前
  // children:[] → antd Tree 当叶子渲染 → 无展开箭头，「展开没反应」；
  // 且展开状态与数据到达不同步。预取后树全同步，展开/收起纯状态操作。
  // 项目量增长到百级后再考虑改 antd loadData 懒加载。
  React.useEffect(() => {
    if (!projects || projects.length === 0) return;
    const missing = projects.filter(
      (p) => !(p.project_id in tasksByProject),
    );
    if (missing.length === 0) return;
    void Promise.allSettled(
      missing.map((p) => loadProjectTasks(p.project_id, p.team_id)),
    );
  }, [projects, tasksByProject, loadProjectTasks]);

  const roomNameMap = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rooms) seen.set(r.room_id, r.name);
    for (const a of items) {
      if (!seen.has(a.room_id)) seen.set(a.room_id, a.room_name);
    }
    return seen;
  }, [rooms, items]);

  // ── v0.4.88: 筛选（团队）+ 排序（时间/名称）——树/右列/根计数同源跟随 ──
  const visibleProjects = React.useMemo(() => {
    let list = projects || [];
    if (teamFilter !== "all") {
      list = list.filter((p) => p.team_id === teamFilter);
    }
    // 时间键见模块级 projectTs()（v0.4.98 再版 9 起多源：真实字段 →
    // 项目房间最后消息 → id 内嵌日期近似；此前列表端点无时间戳字段
    // 且 id 无日期时全 0，用户「显示不了时间」）。
    const tsOf = (p: ProjectSummary) =>
      projectTs(p, metaByProject[p.project_id]);
    const nameOf = (p: ProjectSummary) =>
      (p.title || p.name || p.project_id).toLowerCase();
    return [...list].sort((a, b) => {
      if (projSort === "name") return nameOf(a).localeCompare(nameOf(b));
      const d = tsOf(a) - tsOf(b);
      return projSort === "time_asc" ? d : -d;
    });
  }, [projects, teamFilter, projSort, metaByProject]);

  const teamOptions = React.useMemo(
    () =>
      Array.from(
        new Set((projects || []).map((p) => p.team_id).filter(Boolean)),
      ) as string[],
    [projects],
  );

  // ── 正源文件条目：项目 → 任务 → deliverables ──
  const projectFiles = React.useMemo(() => {
    const out: FileEntry[] = [];
    for (const p of visibleProjects) {
      const tasks = tasksByProject[p.project_id] || [];
      for (const t of tasks) {
        for (const d of t.deliverables || []) {
          const name = String(d).split("/").pop() || String(d);
          out.push({
            key: `pf:${p.project_id}:${t.task_id}:${d}`,
            name,
            kind: kindOf(name),
            size: null,
            source: p.title || p.project_id,
            time: 0,
            sender: t.assigned_to || "",
            projectId: p.project_id,
            taskId: t.task_id,
            artifactPath: String(d),
          });
        }
        if (t.result_path && !(t.deliverables || []).includes(t.result_path)) {
          const name = t.result_path.split("/").pop() || t.result_path;
          out.push({
            key: `pf:${p.project_id}:${t.task_id}:${t.result_path}`,
            name,
            kind: kindOf(name),
            size: null,
            source: p.title || p.project_id,
            time: 0,
            sender: t.assigned_to || "",
            projectId: p.project_id,
            taskId: t.task_id,
            artifactPath: t.result_path,
          });
        }
      }
    }
    return out;
  }, [visibleProjects, tasksByProject]);

  // ── fallback 文件条目：房间附件 ──
  const attachmentFiles = React.useMemo(
    () =>
      items.map((a) => ({
        key: `af:${a.event_id}`,
        name: a.filename || a.body || "附件",
        kind: artifactKind(a),
        size: a.size,
        source: roomNameMap.get(a.room_id) || a.room_name,
        time: a.ts,
        sender: a.sender,
        mimeType: a.mimetype || undefined,
        mxcUrl: a.url,
      })),
    [items, roomNameMap],
  );

  // ── 树 ──
  const treeData = React.useMemo(() => {
    const statusColor: Record<string, string> = {
      completed: "#52c41a",
      in_progress: "#1677ff",
      "in-progress": "#1677ff",
      blocked: "#f5222d",
      revision: "#fa8c16",
    };
    const projectNodes = visibleProjects.map((p) => {
      const tasks = tasksByProject[p.project_id] || [];
      const dispName = p.title || p.name || p.project_id;
      const meta = metaByProject[p.project_id];
      const ts = projectTs(p, meta);
      // 时间标签规则（v0.4.98 再版 9）：真实来源（字段/已加入的项目房间
      // last_ts）显完整时间；仅 id 近似日期时只显 MM-DD，不挂 00:00 噪音。
      const hasReal = Boolean(p.updated_at || p.created_at || meta?.updatedAt);
      const roomKnown = Boolean(
        meta?.roomId &&
          (getCachedRooms()?.rooms?.some(
            (r) => r.room_id === meta?.roomId,
          ) ||
            false),
      );
      const tsLabel =
        hasReal || roomKnown
          ? formatTime(ts)
          : ts
            ? formatTime(ts).split(" ")[0]
            : "";
      return {
        key: `proj:${p.project_id}`,
        // v0.4.88: 两行标题——第 1 行 名称+状态 tag；第 2 行 团队·更新时间
        // （配合顶部筛选/排序控件，让排序结果在树上可感知）。
        title: (
          <div style={{ lineHeight: 1.35, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {/* v0.4.91: antd Tooltip 显全名（原生 title 在树节点里不生效）；
                  名称 ≠ project_id 时 tooltip 附带 id（id 是寻址键，排障要用）。 */}
              <antd.Tooltip
                title={
                  (p.title || p.name) && p.project_id !== dispName
                    ? `${dispName}（${p.project_id}）`
                    : dispName
                }
                mouseEnterDelay={0.2}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dispName}
                </span>
              </antd.Tooltip>
              <antd.Tag
                color={statusColor[p.status] || "default"}
                style={{ margin: 0, fontSize: 11, flexShrink: 0 }}
              >
                {p.status || "?"}
              </antd.Tag>
            </div>
            {(p.team_id || ts) ? (
              <div style={{ fontSize: 11, color: "#999" }}>
                {p.team_id || ""}
                {p.team_id && ts ? " · " : ""}
                {tsLabel}
              </div>
            ) : null}
          </div>
        ),
        children: tasks.map((t) => {
          const files = projectFiles.filter(
            (f) => f.projectId === p.project_id && f.taskId === t.task_id,
          );
          return {
            key: `task:${p.project_id}:${t.task_id}`,
            title: (
              <span>
                {t.task_id.slice(0, 12)}…
                <span style={{ color: "#999", fontSize: 12 }}>（{files.length}）</span>
              </span>
            ),
            children: files.map((f) => ({
              key: f.key,
              title: (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {KIND_META[f.kind].icon}
                  <span style={{ fontSize: 12 }}>{truncateFilename(f.name)}</span>
                </span>
              ),
              isLeaf: true,
            })),
          };
        }),
      };
    });
    // 附件分支：类型 → 房间
    const kinds: ArtifactKind[] = ["image", "document", "data", "code", "other"];
    const attachNodes = kinds.map((k) => {
      const inKind = attachmentFiles.filter((f) => f.kind === k);
      const srcCounts = new Map<string, number>();
      for (const f of inKind) srcCounts.set(f.source, (srcCounts.get(f.source) || 0) + 1);
      return {
        key: `kind:${k}`,
        title: `${KIND_META[k].label}（${inKind.length}）`,
        children: Array.from(srcCounts.entries()).map(([src, cnt]) => ({
          key: `asrc:${k}:${src}`,
          // v0.4.91: 两行排版 + antd Tooltip——
          // ① 原生 title 在 rc-tree 节点里不生效（用户真机验证），改 antd Tooltip
          //    （portal 渲染，即时显示，不受树节点包装影响）；
          // ② 房间名单独占一行（260px 全宽给名字），计数下沉第二行灰字；
          // ③ 左栏可拖拽调宽（见下），长房间名可放宽到 480px 基本不用截断。
          title: (
            <div style={{ lineHeight: 1.35, minWidth: 0 }}>
              <antd.Tooltip title={src} mouseEnterDelay={0.2}>
                <span
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {src}
                </span>
              </antd.Tooltip>
              <div style={{ fontSize: 11, color: "#999" }}>
                {cnt} {tr("个文件")}
              </div>
            </div>
          ),
          isLeaf: true,
        })),
      };
    });
    return [
      {
        key: "projects",
        title: `📦 ${tr("项目产物")}（${projectFiles.length}）${projectsLoading ? "…" : ""}`,
        children: projectNodes.length
          ? projectNodes
          : [{ key: "proj:empty", title: <span style={{ color: "#bbb", fontSize: 12 }}>{projectsLoading ? tr("加载中…") : tr("暂无已登记项目——经 projectflow 登记的项目会显示在这里")}</span>, isLeaf: true }],
      },
      {
        key: "attachments",
        title: `📎 ${tr("房间附件")}（${attachmentFiles.length}）`,
        children: attachNodes,
      },
    ];
  }, [visibleProjects, tasksByProject, metaByProject, projectFiles, attachmentFiles, projectsLoading]);

  // ── 右列表（按选中节点推导）──
  const visibleFiles = React.useMemo(() => {
    if (selectedKey === "root" || selectedKey === "projects") return projectFiles;
    if (selectedKey === "attachments") return attachmentFiles;
    if (selectedKey.startsWith("proj:")) {
      const pid = selectedKey.slice(5);
      return projectFiles.filter((f) => f.projectId === pid);
    }
    if (selectedKey.startsWith("task:")) {
      const [, pid, tid] = selectedKey.split(":");
      return projectFiles.filter((f) => f.projectId === pid && f.taskId === tid);
    }
    if (selectedKey.startsWith("pf:")) {
      return projectFiles.filter((f) => f.key === selectedKey);
    }
    if (selectedKey.startsWith("kind:")) {
      const k = selectedKey.slice(5) as ArtifactKind;
      return attachmentFiles.filter((f) => f.kind === k);
    }
    if (selectedKey.startsWith("asrc:")) {
      const [, k, src] = selectedKey.split(":");
      return attachmentFiles.filter(
        (f) => f.kind === (k as ArtifactKind) && f.source === src,
      );
    }
    if (selectedKey.startsWith("af:")) {
      return attachmentFiles.filter((f) => f.key === selectedKey);
    }
    return [];
  }, [selectedKey, projectFiles, attachmentFiles]);

  const onTreeSelect = React.useCallback(
    (keys: ReactNS.Key[]) => {
      const key = String(keys[0] || "root");
      setSelectedKey(key);
      if (key.startsWith("proj:")) {
        // v0.4.88: 点行 = 选中 + 展开（展开箭头在旧版要等任务异步加载完
        // 才出现，用户点行无展开反馈，视为「展开有问题」）。
        setExpandedKeys((prev) =>
          prev.includes(key) ? prev : [...prev, key],
        );
        const pid = key.slice(5);
        const proj = (visibleProjects || []).find(
          (p) => p.project_id === pid,
        );
        void loadProjectTasks(pid, proj?.team_id);
      }
    },
    [loadProjectTasks, visibleProjects],
  );

  const refresh = React.useCallback(async () => {
    // v0.4.88: 手动刷新连任务缓存一起清——之前失败/空的项目永不重试。
    setTasksByProject({});
    await Promise.all([refreshProjects(true), refreshItems(true)]);
  }, [refreshProjects, refreshItems]);

  // 预览入口：把 FileEntry 归一化为 PreviewFile 交给共享 FilePreview。
  // needsFetch=true 用于正源产物（URL 带后端注入的鉴权，图片必须 fetch blob）。
  const openPreview = React.useCallback(
    (f: FileEntry) => {
      if (f.mxcUrl) {
        // v0.4.85: resolveFileTarget——mxc→媒体代理（apiPath + getApiUrl 解析）。
        // 裸 /agentteams-proxy/... 路径落 SPA 兜底取回 index.html 壳
        //（8/22 星闪SLE报告「内容是网页」真根因）。
        const t = resolveFileTarget(f.mxcUrl);
        if (!t.url) {
          antd.message.error(
            `附件地址无效（非 mxc/http 链接）：${String(f.mxcUrl).slice(0, 60)}`,
          );
          return;
        }
        setPreview({
          name: f.name,
          url: t.url,
          apiPath: t.apiPath,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
        });
        return;
      }
      if (f.projectId && f.taskId && f.artifactPath) {
        const p = artifactDownloadUrl(f.projectId, f.taskId, f.artifactPath);
        setPreview({
          name: f.name,
          url: resolvePluginUrl(p),
          apiPath: p,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f.size ? { size: f.size } : {}),
          needsFetch: true,
        });
      }
    },
    [],
  );

  // v0.4.91: 左栏（产物树）宽度可拖拽——200–480px，默认 260，localStorage 持久化
  // （话题面板同款交互）。拖拽期直接改 DOM（v0.4.82 教训：高频交互不进
  // React 渲染循环），松手才提交 state + 持久化。
  const [treeColW, setTreeColW] = React.useState(() => {
    const v = Number(localStorage.getItem("agentteams-qwenpaw-workbench:artifacts-tree-w"));
    return Number.isFinite(v) && v >= 200 && v <= 480 ? Math.round(v) : 260;
  });
  const [treeColDragging, setTreeColDragging] = React.useState(false);
  const treeColRef = React.useRef<HTMLDivElement | null>(null);
  const onTreeColDown = React.useCallback(
    (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = treeColRef.current?.clientWidth || treeColW;
      setTreeColDragging(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          480,
          Math.max(200, Math.round(startW + (ev.clientX - startX))),
        );
        if (treeColRef.current) treeColRef.current.style.width = `${next}px`;
      };
      const onUp = (ev: MouseEvent) => {
        const next = Math.min(
          480,
          Math.max(200, Math.round(startW + (ev.clientX - startX))),
        );
        setTreeColW(next);
        localStorage.setItem(
          "agentteams-qwenpaw-workbench:artifacts-tree-w",
          String(next),
        );
        setTreeColDragging(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [treeColW],
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* v0.4.82: 正源降级横幅——「新接口的产物还没扫描到」可视化：
          Controller 项目产物（O19）不可用时只剩房间附件扫描。 */}
      {o19Fail ? (
        <div
          style={{
            background: `${PRIMARY}14`,
            border: `1px solid ${PRIMARY}55`,
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            color: t.text,
          }}
        >
          ⚠️ {tr("项目产物（Controller 正源）未接通")}
          {o19Fail === "auth"
            ? tr("——token 未配置或无效。配置页填入 controller_token（L1）后可见全部项目产物（含 Leader 创建、你不在其房间内的）")
            : o19Fail === "not_deployed"
              ? tr("——Controller 未升级到含项目产物的版本（404），当前只显示房间附件")
              : (
                <>
                  {tr("——Controller 请求失败，当前只显示房间附件")}
                  {o19FailDetail ? (
                    <div
                      style={{
                        marginTop: 4,
                        color: t.textSecondary,
                        wordBreak: "break-all",
                      }}
                    >
                      {o19FailDetail.slice(0, 220)}
                      {/mc |minio|drive provided/i.test(o19FailDetail)
                        ? tr("（Controller 的 MinIO 客户端 mc 别名异常——需在 Controller 宿主机重新注册 mc 别名，自检 L2 有指引）")
                        : null}
                    </div>
                  ) : null}
                </>
              )}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {onBack ? (
          <antd.Button size="small" onClick={onBack}>
            ← {tr("返回")}
          </antd.Button>
        ) : null}
        <span style={{ fontWeight: 700, fontSize: 15 }}>📦 {tr("团队产物")}</span>
        <antd.Tooltip title="项目产物来自 Controller 项目端点（#1169）；房间附件为 Matrix 消息扫描兜底。同一 project_id 若在团队目录与全局目录各有一份注册（数据侧重复），此处按 project_id 合并为一条显示（优先带团队的记录）。">
          <span style={{ color: "#999", cursor: "help", fontSize: 12 }}>ⓘ</span>
        </antd.Tooltip>
        <div style={{ flex: 1 }} />
        {/* v0.4.88: 项目产物排序 + 团队筛选（纯前端，项目就绪后显示） */}
        {projects && projects.length > 0 ? (
          <>
            <antd.Select
              size="small"
              value={projSort}
              onChange={(v: string) => setProjSort(v as typeof projSort)}
              style={{ width: 128 }}
              options={[
                { value: "time_desc", label: tr("时间 新→旧") },
                { value: "time_asc", label: tr("时间 旧→新") },
                { value: "name", label: tr("名称 A→Z") },
              ]}
            />
            <antd.Select
              size="small"
              value={teamFilter}
              onChange={(v: string) => setTeamFilter(v)}
              style={{ width: 132 }}
              options={[
                { value: "all", label: tr("全部团队") },
                ...teamOptions.map((tm) => ({ value: tm, label: tm })),
              ]}
            />
          </>
        ) : null}
        <antd.Tooltip title="刷新">
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={projectsLoading || itemsLoading}
            onClick={() => void refresh()}
          />
        </antd.Tooltip>
      </div>

      {/* v0.4.98 再版 9：左右分栏独立滚动（用户「产物页面左右两栏要做成分开滚动」）。
          容器定高（RoomChat 同款 calc 经验值 100vh-230 再减工具栏行 ~48）+
          两栏各自 overflow auto——此前整页滚动，树和表一起滚、排序控件滚出视野。 */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          height: "calc(100vh - 280px)",
          minHeight: 320,
        }}
      >
        {/* 左栏：产物树（项目 → 任务 → 文件；附件 → 类型 → 来源）。
            v0.4.90: overflow hidden 硬裁剪——长节点标题（房间附件的来源=房间名）
            之前溢出 260px 伸进右栏区，右栏 Table 后绘覆盖其上 = 用户所见
            「房间附件宽度不一样，右边栏挡住房间产物左边栏」。
            v0.4.91: 宽度可拖拽 200–480px（默认 260，持久化）——房间名长，宽度用户自定。
            v0.4.98 再版 9: 树自身垂直滚动（不再随整页滚）。 */}
        <div
          ref={treeColRef}
          style={{
            width: treeColW,
            flexShrink: 0,
            overflow: "hidden",
            overflowY: "auto",
          }}
        >
          <antd.Tree
            blockNode
            treeData={treeData}
            selectedKeys={[selectedKey]}
            expandedKeys={expandedKeys}
            onExpand={(keys: ReactNS.Key[]) => setExpandedKeys(keys)}
            onSelect={onTreeSelect}
          />
        </div>

        {/* 拖拽手柄（话题面板同款：细条，拖动时高亮 PRIMARY） */}
        <div
          onMouseDown={onTreeColDown}
          title={tr("拖动调整产物树宽度")}
          style={{
            width: 10,
            flexShrink: 0,
            cursor: "col-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 2px 0 10px",
          }}
        >
          <div
            style={{
              width: 3,
              height: 28,
              borderRadius: 2,
              background: treeColDragging ? PRIMARY : "rgba(128,128,128,0.35)",
            }}
          />
        </div>

        {/* 右栏：文件列表（v0.4.98 再版 9: 自身垂直滚动，与左栏分开） */}
        <div
          style={{ flex: 1, minWidth: 0, marginLeft: 10, overflowY: "auto" }}
        >
          {visibleFiles.length === 0 ? (
            <antd.Empty
              description={
                selectedKey === "projects"
                  ? tr("暂无项目产物——已登记项目的任务交付物会显示在这里（未登记项目只走下方房间附件扫描）")
                  : tr("该分类下还没有文件")
              }
            />
          ) : (
            <antd.Table
              rowKey="key"
              size="small"
              pagination={false}
              // v0.4.90: 固定列合计 ~700px，窄窗口下表格在右栏内部横滚，
              // 不再撑破 flex 容器溢出页面（与左栏互挡的另一半根因）。
              scroll={{ x: "max-content" }}
              dataSource={visibleFiles}
              columns={[
                {
                  title: tr("文件"),
                  dataIndex: "name",
                  render: (_: unknown, f: FileEntry) => (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {KIND_META[f.kind].icon}
                      <antd.Tooltip title={f.name}>
                        <a
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}
                          onClick={(e) => {
                            e.preventDefault();
                            void openPreview(f);
                          }}
                        >
                          {truncateFilename(f.name)}
                        </a>
                      </antd.Tooltip>
                    </div>
                  ),
                },
                {
                  title: tr("类型"),
                  dataIndex: "kind",
                  width: 80,
                  render: (k: ArtifactKind) => (
                    <antd.Tag style={{ margin: 0 }} color={k === "image" ? "orange" : k === "document" ? "blue" : k === "data" ? "green" : k === "code" ? "purple" : undefined}>
                      {KIND_META[k].label.replace(/^\S+\s/, "")}
                    </antd.Tag>
                  ),
                },
                {
                  title: tr("来源"),
                  dataIndex: "source",
                  width: 170,
                  ellipsis: true,
                },
                {
                  title: tr("大小"),
                  dataIndex: "size",
                  width: 90,
                  render: (v: number | null) => formatSize(v) || "—",
                },
                {
                  title: tr("发送者"),
                  dataIndex: "sender",
                  width: 110,
                  render: (v: string) =>
                    (v.split(":")[0] || v || "").replace(/^@/, ""),
                },
                {
                  title: tr("时间"),
                  dataIndex: "time",
                  width: 120,
                  render: (v: number) => (v ? formatTime(v) : "—"),
                },
                {
                  title: tr("操作"),
                  key: "actions",
                  width: 130,
                  render: (_: unknown, f: FileEntry) => {
                    // v0.4.85: mxc/正源 → apiPath（host.fetch blob 下载，带鉴权）；
                    // http 直链 → 原样导航。裸插件路径落 SPA 兜底（index.html 壳），
                    // 解析后 /api 路径裸导航带不了鉴权头会 401——两条都不通。
                    const target = f.mxcUrl
                      ? resolveFileTarget(f.mxcUrl)
                      : f.projectId && f.taskId && f.artifactPath
                        ? (() => {
                            const p = artifactDownloadUrl(
                              f.projectId,
                              f.taskId,
                              f.artifactPath,
                            );
                            return { url: resolvePluginUrl(p), apiPath: p };
                          })()
                        : { url: "" };
                    const previewable =
                      !!target.url &&
                      (f.kind === "image" ||
                        f.kind === "document" ||
                        f.kind === "data" ||
                        f.kind === "code");
                    return (
                      <div style={{ display: "flex", gap: 4 }}>
                        {previewable ? (
                          <antd.Button
                            type="text"
                            size="small"
                            icon={<EyeIcon />}
                            title={tr("预览")}
                            onClick={() => void openPreview(f)}
                          />
                        ) : null}
                        <antd.Button
                          type="text"
                          size="small"
                          icon={<DownloadIcon />}
                          title={tr("下载")}
                          href={target.apiPath ? undefined : target.url || undefined}
                          download={f.name}
                          disabled={!target.url}
                          onClick={
                            target.apiPath
                              ? (e: { preventDefault: () => void }) => {
                                  e.preventDefault();
                                  void (async () => {
                                    const ok = await downloadViaHost(
                                      target.apiPath as string,
                                      f.name,
                                    );
                                    if (!ok)
                                      antd.message.error("下载失败，请稍后重试");
                                  })();
                                }
                              : undefined
                          }
                        />
                      </div>
                    );
                  },
                },
              ]}
            />
          )}
        </div>
      </div>

      <FilePreview file={preview} onClose={() => setPreview(null)} />

    </div>
  );
}
