/** Artifacts 子模块——自 Artifacts.tsx 纯搬移拆出
 * （行为零变化）。 */
import { BoxIcon, ClipIcon } from "./icons";
import { getCachedRooms } from "../api";
import { WbTooltip } from "./WbTooltip";
import {
  KIND_META,
  projectTs,
  formatTime,
  truncateFilename,
  type ProjectSummary,
  type ProjectMeta,
  type TaskDetail,
  type FileEntry,
  type ArtifactKind,
} from "./ArtifactsShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export function buildArtifactsTree({
  visibleProjects,
  tasksByProject,
  metaByProject,
  projectFiles,
  attachmentFiles,
  projectsLoading,
  narrow,
  tr,
}: {
  visibleProjects: ProjectSummary[];
  tasksByProject: Record<string, TaskDetail[]>;
  metaByProject: Record<string, ProjectMeta>;
  projectFiles: FileEntry[];
  attachmentFiles: FileEntry[];
  projectsLoading: boolean;
  narrow: boolean;
  tr: (text: string, vars?: Record<string, string | number>) => string;
}) {
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
      // 时间标签规则（）：真实来源（字段/已加入的项目房间
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
        // 两行标题——第 1 行 名称+状态 tag；第 2 行 团队·更新时间
        // （配合顶部筛选/排序控件，让排序结果在树上可感知）。
        title: (
          <div style={{ lineHeight: 1.35, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {/* antd Tooltip 显全名（原生 title 在树节点里不生效）；
 名称 ≠ project_id 时 tooltip 附带 id（id 是寻址键，排障要用）。 */}
              <WbTooltip
                title={
                  (p.title || p.name) && p.project_id !== dispName
                    ? `${dispName}（${p.project_id}）`
                    : dispName
                }
                mouseEnterDelay={0.2}
              >
                <span
                  // flex:1 + minWidth:0 让名称在行内可收缩（缺了它 flex 项
                  // 按内容宽不缩，长项目名把整行撑出容器）；左栏可拖宽，
                  // 名称任何宽度自动换行防省略号丢信息（Tooltip 附带
                  // project_id 供排障）。
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                  }}
                >
                  {dispName}
                </span>
              </WbTooltip>
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
                // 窄屏：全名 + 换行（truncate 截断在 376px 下信息丢失）；宽屏保持截断。
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {KIND_META[f.kind].icon}
                  <span style={{ fontSize: 12, wordBreak: narrow ? "break-word" : undefined }}>
                    {narrow ? f.name : truncateFilename(f.name)}
                  </span>
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
        title: <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{KIND_META[k].icon} {KIND_META[k].label}（{inKind.length}）</span>,
        children: Array.from(srcCounts.entries()).map(([src, cnt]) => ({
          key: `asrc:${k}:${src}`,
          // 两行排版 + antd Tooltip——
          // ① 原生 title 在 rc-tree 节点里不生效（用户真机验证），改 antd Tooltip
          // （portal 渲染，即时显示，不受树节点包装影响）；
          // ② 房间名单独占一行（左栏全宽给名字），计数下沉第二行灰字；
          // ③ 左栏可拖拽调宽（见下），房间名任何宽度自动换行显全名
          // （不 ellipsis 截断）。
          title: (
            <div style={{ lineHeight: 1.35, minWidth: 0 }}>
              <WbTooltip title={src} mouseEnterDelay={0.2}>
                <span
                  style={{
                    display: "block",
                    minWidth: 0,
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                  }}
                >
                  {src}
                </span>
              </WbTooltip>
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
        title: <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><BoxIcon size={13} /> {tr("项目产物")}（{projectFiles.length}）{projectsLoading ? "…" : ""}</span>,
        children: projectNodes.length
          ? projectNodes
          : [{ key: "proj:empty", title: <span style={{ color: "#bbb", fontSize: 12 }}>{projectsLoading ? tr("加载中…") : tr("暂无已登记项目——经 projectflow 登记的项目会显示在这里")}</span>, isLeaf: true }],
      },
      {
        key: "attachments",
        title: <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><ClipIcon size={13} /> {tr("房间附件")}（{attachmentFiles.length}）</span>,
        children: attachNodes,
      },
    ];
}
