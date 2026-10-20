import { BoxIcon, WarnIcon } from "./icons";
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { FilePreview, type PreviewFile } from "./FilePreview";
import {
  fetchArtifacts,
  fetchProjectSummaries,
  fetchProjectWorkflow,
  resolveFileTarget,
  resolvePluginUrl,
  httpErrorStatus,
  httpErrorDetail,
  type Artifact,
} from "../api";
import { invalidateTags } from "../requestCache";
import { WbTooltip } from "./WbTooltip";
import { useWbViewport } from "../WbViewportContext";
import {
  PRIMARY,
  KIND_META,
  artifactDownloadUrl,
  artifactKind,
  kindOf,
  projectTs,
  type ArtifactKind,
  type FileEntry,
  type ProjectMeta,
  type ProjectSummary,
  type TaskDetail,
} from "./ArtifactsShared";
import { buildArtifactsTree } from "./ArtifactsTree";
import { FileListBlock } from "./ArtifactsFileList";
import { useTreeColWidth } from "./ArtifactsTreeCol";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

interface ArtifactsProps {
  rooms?: { room_id: string; name: string }[];
  onBack?: () => void;
}

function Artifacts(props: ArtifactsProps) {
  const t = useThemeColors();
  const tr = useT();
  const { rooms = [], onBack } = props;
  // 正源：项目产物（上游端点；Controller 未升级时 projects=[] 自动 fallback）。
  const [projects, setProjects] = React.useState<ProjectSummary[] | null>(null);
  const [tasksByProject, setTasksByProject] = React.useState<
    Record<string, TaskDetail[]>
  >({});
  /** 项目时间多源元数据（roomId/updatedAt，workflow 详情来）。 */
  const [metaByProject, setMetaByProject] = React.useState<
    Record<string, ProjectMeta>
  >({});
  const [projectsLoading, setProjectsLoading] = React.useState(false);
  // 正源降级原因（横幅提示，不再静默空列表）。
  const [o19Fail, setO19Fail] = React.useState<
    "auth" | "not_deployed" | "error" | null
  >(null);
  // error 分支的真实上游错误（此前被通用文案「Controller 不可用」掩盖——
  // 如 Controller 500「mc ls ... 0 drives provided」= Controller 侧 MinIO 客户端故障）。
  const [o19FailDetail, setO19FailDetail] = React.useState("");
  // fallback：房间附件扫描。
  const [items, setItems] = React.useState<Artifact[]>([]);
  const [itemsLoading, setItemsLoading] = React.useState(false);
  // 选择态：selectedKey = tree 节点 key。
  const [selectedKey, setSelectedKey] = React.useState<string>("root");
  const [expandedKeys, setExpandedKeys] = React.useState<ReactNS.Key[]>(["projects"]);
  // 项目产物排序 + 团队筛选（纯前端，零后端改动）。
  const [projSort, setProjSort] = React.useState<
    "time_desc" | "time_asc" | "name"
  >("time_desc");
  const [teamFilter, setTeamFilter] = React.useState<string>("all");
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  // 窄屏单栏 drill-in（narrow = 容器宽 < 800，与聊天单栏同源判定）：
  // 左右两栏（树 + 文件列表）→ 窄屏「文件树（整宽）→ 点节点 →
  // 文件列表（整宽）+ ← 返回」，与聊天「房间列表 → 点进房间」同一心智；
  // 宽屏（narrow=false）路径保持原两栏不变。
  const { narrow } = useWbViewport();
  // 「已钻进文件列表」局部标记——selectedKey 初值 "root" 恒非空，
  // 不能直接当「是否钻进了列表」的判据。
  const [listOpen, setListOpen] = React.useState(false);

  // 正源加载：GET /api/v1/projects（404 → 端点未部署 → projects=[] fallback）。
  // 走 fetchProjectSummaries 统一解包——此前只认裸数组，Controller
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
      // 按真实状态码分类 + 保留 detail（此前字符串匹配 401/403/404，
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
  // 带 ?team=——同一 project_id 跨团队/全局目录重复注册时裸 id
  // 寻址 Controller 回 409 ambiguous（实测）；此前 catch 静默吞 → 重复项目的任务
  // 恒空（「项目产物（0）」的第二成因）。与 fetchWorkflowProjects 的
  // ?team= 修法对齐。
  const loadProjectTasks = React.useCallback(
    async (projectId: string, teamId?: string) => {
      if (tasksByProject[projectId]) return;
      try {
        // 统一走 api.ts 共享缓存函数（30s TTL + 标签
        // 失效）——与群内项目文件面板同源同速；手动刷新经 refresh()
        // 显式失效后穿透。
        const wf = await fetchProjectWorkflow(projectId, teamId);
        setTasksByProject((prev) => ({
          ...prev,
          [projectId]: wf.tasks_detail || [],
        }));
        // 存时间多源元数据（source_room_id → 房间最后消息；
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

  // 项目列表就绪后并行预取全部项目的 workflow（tasks_detail）——
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

  // ── 筛选（团队）+ 排序（时间/名称）——树/右列/根计数同源跟随 ──
  const visibleProjects = React.useMemo(() => {
    let list = projects || [];
    if (teamFilter !== "all") {
      list = list.filter((p) => p.team_id === teamFilter);
    }
    // 时间键见模块级 projectTs()（起多源：真实字段 →
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
  const treeData = React.useMemo(
    () =>
      buildArtifactsTree({
        visibleProjects,
        tasksByProject,
        metaByProject,
        projectFiles,
        attachmentFiles,
        projectsLoading,
        narrow,
        tr,
      }),
    [visibleProjects, tasksByProject, metaByProject, projectFiles, attachmentFiles, projectsLoading, narrow],
  );

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
      // 窄屏 drill-in：点节点 = 钻进文件列表（宽屏此标记不参与渲染）。
      setListOpen(true);
      if (key.startsWith("proj:")) {
        // 点行 = 选中 + 展开（展开箭头在旧版要等任务异步加载完
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
    // 手动刷新连任务缓存一起清——之前失败/空的项目永不重试。
    setTasksByProject({});
    // 手动刷新穿透全局 30s 读缓存——对当前已加载的
    // 项目集合显式失效（tags 为空数组时 invalidateTags 为无害空操作）。
    invalidateTags(
      Object.keys(tasksByProject).map((p) => `project:${p}`),
    );
    await Promise.all([refreshProjects(true), refreshItems(true)]);
  }, [refreshProjects, refreshItems, tasksByProject]);

  // 预览入口：把 FileEntry 归一化为 PreviewFile 交给共享 FilePreview。
  // needsFetch=true 用于正源产物（URL 带后端注入的鉴权，图片必须 fetch blob）。
  const openPreview = React.useCallback(
    (f: FileEntry) => {
      if (f.mxcUrl) {
        // resolveFileTarget——mxc→媒体代理（apiPath + getApiUrl 解析）。
        // 裸 /agentteams-proxy/... 路径落 SPA 兜底取回 index.html 壳
        //（历史缺陷「内容是网页」根因）。
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

  // 左栏（产物树）宽度可拖拽——200–480px，默认 260，localStorage 持久化
  // （话题面板同款交互）。拖拽期直接改 DOM（教训：高频交互不进
  // React 渲染循环），松手才提交 state + 持久化。
  const {
    w: treeColW,
    dragging: treeColDragging,
    ref: treeColRef,
    onDown: onTreeColDown,
  } = useTreeColWidth();

  // 窄屏 drill-in：钻进的文件列表标题（返回条右侧显示）。
  const listTitle = React.useMemo(() => {
    if (selectedKey === "root" || selectedKey === "projects")
      return tr("项目产物");
    if (selectedKey === "attachments") return tr("房间附件");
    if (selectedKey.startsWith("proj:")) {
      const pid = selectedKey.slice(5);
      const p = (projects || []).find((x) => x.project_id === pid);
      return p?.title || p?.name || pid;
    }
    if (selectedKey.startsWith("task:")) {
      const parts = selectedKey.split(":");
      return (parts[2] || "").slice(0, 16) || tr("文件");
    }
    if (selectedKey.startsWith("pf:")) {
      const f = projectFiles.find((x) => x.key === selectedKey);
      return f?.name || tr("文件");
    }
    if (selectedKey.startsWith("kind:")) {
      const k = selectedKey.slice(5) as ArtifactKind;
      return KIND_META[k] ? KIND_META[k].label : tr("文件");
    }
    if (selectedKey.startsWith("asrc:")) {
      const parts = selectedKey.split(":");
      return parts.slice(2).join(":") || tr("文件");
    }
    if (selectedKey.startsWith("af:")) {
      const f = items.find((x) => `af:${x.event_id}` === selectedKey);
      return f?.filename || f?.body || tr("文件");
    }
    return tr("文件");
  }, [selectedKey, projects, projectFiles, items, tr]);

  // 窄/宽共用：产物树。提为变量供窄屏整宽树与宽屏左栏共用——
  // 宽屏渲染同一元素，输出不变。
  const treeEl = (
    <antd.Tree
      blockNode
      treeData={treeData}
      selectedKeys={[selectedKey]}
      expandedKeys={expandedKeys}
      onExpand={(keys: ReactNS.Key[]) => setExpandedKeys(keys)}
      onSelect={onTreeSelect}
    />
  );

  const fileListBlock = (
    <FileListBlock
      visibleFiles={visibleFiles}
      selectedKey={selectedKey}
      narrow={narrow}
      onOpen={openPreview}
    />
  );

  return (
    // 高度链容器化（RoomChat 同款）：tabpane 已定高（height:100% min-0）→
    // 本根 flex 列 height:100%，内容区 flex:1 内滚——替换 calc(100vh-280px)
    // 魔法值（宿主容器高≠视口高时外溢/过矮）。
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minWidth: 0 }}>
      {/* 正源降级横幅——「新接口的产物还没扫描到」可视化：
 Controller 项目产物（产物端点）不可用时只剩房间附件扫描。 */}
      {o19Fail ? (
        <div
          style={{
            background: `color-mix(in srgb, ${PRIMARY} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${PRIMARY} 33%, transparent)`,
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            color: t.text,
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><WarnIcon size={13} /> {tr("项目产物（Controller 正源）未接通")}</span>
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
        <span style={{ fontWeight: 700, fontSize: 15, display: "inline-flex", alignItems: "center", gap: 6 }}><BoxIcon size={15} /> {tr("团队产物")}</span>
        <WbTooltip title="项目产物来自 Controller 项目端点（上游端点）；房间附件为 Matrix 消息扫描兜底。同一 project_id 若在团队目录与全局目录各有一份注册（数据侧重复），此处按 project_id 合并为一条显示（优先带团队的记录）。">
          <span style={{ color: "#999", cursor: "help", fontSize: 12 }}>ⓘ</span>
        </WbTooltip>
        <div style={{ flex: 1 }} />
        {/* 项目产物排序 + 团队筛选（纯前端，项目就绪后显示） */}
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
        <WbTooltip title="刷新">
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={projectsLoading || itemsLoading}
            onClick={() => void refresh()}
          />
        </WbTooltip>
      </div>

      {/* 窄屏单栏 drill-in（narrow = 容器宽 < 800，与聊天单栏同源判定）：
 未选节点 = 文件树（整宽，无拖拽手柄）；点节点 = 文件列表（整宽）+
 顶部返回条——与聊天「房间列表 → 点进房间」同一心智。
 宽屏（narrow=false）保持原左右两栏不变。 */}
      {narrow && !listOpen ? (
        /* 窄屏 · 未钻取：文件树整宽（独立垂直滚动）。
        容器钉屏宽（maxWidth 100% + overflowX hidden）——长项目名/房间名
        在节点内换行（treeData 窄屏分支 whiteSpace normal），不撑出屏幕。 */
        <div
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            maxWidth: "100%",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {treeEl}
        </div>
      ) : narrow && listOpen ? (
        /* 窄屏 · 已钻取：返回条 + 文件列表整宽。 */
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
              marginBottom: 8,
            }}
          >
            <antd.Button
              size="small"
              onClick={() => setListOpen(false)}
              style={{ flexShrink: 0 }}
            >
              ← {tr("返回")}
            </antd.Button>
            <span
              title={listTitle}
              style={{
                flex: 1,
                minWidth: 0,
                fontWeight: 700,
                fontSize: 14,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {listTitle}
            </span>
          </div>
          <div style={{ flex: 1, minWidth: 0, maxWidth: "100%", overflowY: "auto", overflowX: "hidden" }}>
            {fileListBlock}
          </div>
        </div>
      ) : (
        /* 宽屏：原左右分栏独立滚动（用户「产物页面左右两栏要做成分开滚动」）。
 容器定高（RoomChat 同款 calc 经验值 100vh-230 再减工具栏行 ~48）+
 两栏各自 overflow auto——此前整页滚动，树和表一起滚、排序控件滚出视野。 */
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            flex: 1,
            minHeight: 0,
            minWidth: 0,
          }}
        >
          {/* 左栏：产物树（项目 → 任务 → 文件；附件 → 类型 → 来源）。
 overflow hidden 硬裁剪——长节点标题（房间附件的来源=房间名）
 之前溢出 260px 伸进右栏区，右栏 Table 后绘覆盖其上 = 用户所见
 「房间附件宽度不一样，右边栏挡住房间产物左边栏」。
 宽度可拖拽 200–480px（默认 260，持久化）——房间名长，宽度用户自定。
 树自身垂直滚动（不再随整页滚）。 */}
          <div
            ref={treeColRef}
            style={{
              width: treeColW,
              flexShrink: 0,
              overflow: "hidden",
              overflowY: "auto",
            }}
          >
            {treeEl}
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

          {/* 右栏：文件列表（自身垂直滚动，与左栏分开） */}
          <div
            style={{ flex: 1, minWidth: 0, marginLeft: 10, overflowY: "auto" }}
          >
            {fileListBlock}
          </div>
        </div>
      )}

      <FilePreview file={preview} onClose={() => setPreview(null)} />

    </div>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(Artifacts);
