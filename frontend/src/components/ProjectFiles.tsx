import { PageIcon, EyeIcon, FolderIcon, CloseIcon } from "./icons";
import {
  downloadViaHost,
  requestJson,
  resolvePluginUrl,
  type TeamRoom,
  type WorkflowEvent,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { FilePreview, type PreviewFile } from "./FilePreview";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 任务文件条目（产物端点 artifact 声明：result_path/spec_path/deliverables）。 */
interface TaskFile {
  projectId: string;
  projectTitle: string;
  taskId: string;
  taskName: string;
  taskStatus: string;
  assignee: string;
  path: string;
  kind: "result" | "spec" | "deliverable";
}

/** 正源产物下载 URL（项目产物端点，query path 透传——
 * 与 Artifacts.tsx artifactDownloadUrl 同契约，交叉验证基准）。
 * export：#1230 任务巡检 Drawer（WorkflowBoard）复用同一下载通道。 */
export function artifactDownloadUrl(projectId: string, taskId: string, path: string): string {
  return (
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/tasks/${encodeURIComponent(taskId)}/artifact?path=${encodeURIComponent(path)}`
  );
}

function basenameOf(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg.length ? seg[seg.length - 1] : path;
}

/** 项目状态 → antd Tag color（与 WorkflowCard 徽章同一判定集合）。 */
function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (["completed", "complete", "success", "done"].includes(s)) return "green";
  if (["failed", "error", "cancelled", "canceled"].includes(s)) return "red";
  if (s === "paused") return "orange";
  if (s === "active" || s === "in_progress" || s === "planning") return "blue";
  return "default";
}

/** 单项目文件拉取（includeTasks → tasks_detail 声明的 result/spec/deliverables）。
 *  v0.5.0-beta.13.13：带 &team= 限定——同一 project_id 跨团队重名时
 *  Controller 回 409（fetchWorkflowProjects 同款处理），此前本面板不传
 *  team → 重名项目 409 被静默吞掉 → 「读取不到」的另一条根因。 */
async function fetchProjectFiles(ev: WorkflowEvent): Promise<TaskFile[]> {
  const teamQ =
    typeof ev.team_id === "string" && ev.team_id
      ? `&team=${encodeURIComponent(ev.team_id)}`
      : "";
  const wf = (await requestJson(
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(ev.runId)}` +
      `/workflow?includeTasks=true${teamQ}`,
  )) as { tasks_detail?: Array<Record<string, unknown>> };
  const tasks = Array.isArray(wf.tasks_detail) ? wf.tasks_detail : [];
  const collected: TaskFile[] = [];
  for (const task of tasks) {
    const taskId = String(task.task_id || "");
    if (!taskId) continue;
    const status = String(task.status || "");
    const assignee = String(task.assigned_to || "");
    const push = (path: unknown, kind: TaskFile["kind"]) => {
      if (typeof path !== "string" || !path.trim()) return;
      collected.push({
        projectId: ev.runId,
        projectTitle: ev.title || ev.runId,
        taskId,
        taskName: taskId,
        taskStatus: status,
        assignee,
        path,
        kind,
      });
    };
    push(task.result_path, "result");
    push(task.spec_path, "spec");
    const deliv = task.deliverables;
    if (Array.isArray(deliv)) deliv.forEach((d) => push(d, "deliverable"));
  }
  return collected;
}

/** 团队共享空间 / 项目文件面板（v0.5.0-beta.12）。
 *
 * 数据源决策：dashboard 共享空间是 MinIO 直读（dashboard 与 Controller 同机
 * 有凭据）；插件在用户侧外网，部署侧反代只暴露 Controller API——Controller
 * 路由全表无房间/团队文件代理端点（唯一文件端点 = 产物端点 任务级
 * artifact）。故第一版 = 产物端点 任务文件（workflow tasks_detail 声明的
 * result/spec/deliverables），房间级共享空间待上游文件 API PR。
 *
 * v0.5.0-beta.13.13（13.12 装验「聊天群的项目文件读取不到」）匹配模型重构：
 * 旧版只认 `ev.room_id === 当前房间 room_id` 严格相等——项目从 QQ/其他通道
 * 发起时 source_room_id 为 `qq:...` 等非 Matrix 房间 ID（实盘 jev 项目
 * 2026-09-23 实证），任何 Matrix 房间里开 📁 都空面板。新版：
 *   ① 当前房间项目（严格匹配）→ 自动加载文件；
 *   ② 其他项目（不匹配但已注册）→ 折叠列表懒加载（点开才拉）；
 *   ③ 每项目拉取失败显形（旧版静默 continue = 黑盒）+ 刷新按钮全量重拉
 *  已加载项目。 */
export default function ProjectFiles(props: {
  room: TeamRoom | null;
  workflowEvents: WorkflowEvent[];
  onClose?: () => void;
}) {
  const { room, workflowEvents, onClose } = props;
  const t = useThemeColors();
  const tr = useT();

  const roomProjects = React.useMemo(
    () =>
      workflowEvents.filter(
        (ev) => ev.room_id && ev.room_id === room?.room_id,
      ),
    [workflowEvents, room],
  );
  const otherProjects = React.useMemo(
    () =>
      workflowEvents.filter(
        (ev) => !(ev.room_id && ev.room_id === room?.room_id),
      ),
    [workflowEvents, room],
  );

  const [filesByProject, setFilesByProject] = React.useState<
    Record<string, TaskFile[]>
  >({});
  const [errByProject, setErrByProject] = React.useState<Record<string, string>>({});
  const [loadingSet, setLoadingSet] = React.useState<Record<string, boolean>>({});
  const [loadedSet, setLoadedSet] = React.useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = React.useState<string[]>([]);

  const loading = Object.values(loadingSet).some(Boolean);

  const loadOne = React.useCallback(
    async (ev: WorkflowEvent, force = false) => {
      if (!force && loadedSet[ev.runId]) return;
      if (loadingSet[ev.runId]) return;
      setLoadingSet((s) => ({ ...s, [ev.runId]: true }));
      setErrByProject((s) => ({ ...s, [ev.runId]: "" }));
      try {
        const files = await fetchProjectFiles(ev);
        setFilesByProject((s) => ({ ...s, [ev.runId]: files }));
        setLoadedSet((s) => ({ ...s, [ev.runId]: true }));
      } catch (e) {
        setErrByProject((s) => ({
          ...s,
          [ev.runId]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setLoadingSet((s) => ({ ...s, [ev.runId]: false }));
      }
    },
    [loadedSet, loadingSet],
  );

  const refresh = React.useCallback(async () => {
    // 全量重拉：当前房间项目 + 已展开的其他项目。
    const targets = [...roomProjects, ...otherProjects.filter((ev) => expanded.includes(ev.runId))];
    setLoadedSet({});
    await Promise.all(targets.map((ev) => loadOne(ev, true)));
  }, [roomProjects, otherProjects, expanded, loadOne]);

  // 当前房间项目：挂载/项目集变化自动加载。
  React.useEffect(() => {
    roomProjects.forEach((ev) => void loadOne(ev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomProjects]);

  const groupsOf = (files: TaskFile[]) => {
    const byTask = new Map<string, TaskFile[]>();
    for (const f of files) {
      const list = byTask.get(f.taskId) || [];
      list.push(f);
      byTask.set(f.taskId, list);
    }
    return byTask;
  };

  const kindTag = (k: TaskFile["kind"]) => {
    switch (k) {
      case "result":
        return <antd.Tag color="green" style={{ margin: 0, fontSize: 10 }}>{tr("结果")}</antd.Tag>;
      case "spec":
        return <antd.Tag color="blue" style={{ margin: 0, fontSize: 10 }}>{tr("任务书")}</antd.Tag>;
      default:
        return <antd.Tag color="purple" style={{ margin: 0, fontSize: 10 }}>{tr("交付物")}</antd.Tag>;
    }
  };

  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  const openFile = (f: TaskFile) => {
    const p = artifactDownloadUrl(f.projectId, f.taskId, f.path);
    setPreview({
      name: basenameOf(f.path) || f.path,
      url: resolvePluginUrl(p),
      apiPath: p,
      // v0.5.0-beta.12: 正源走 host.fetch（带鉴权）；裸插件路径落 SPA 兜底
      needsFetch: true,
    });
  };

  /** 项目文件块（任务分组渲染）——当前房间项目与其他项目共用。 */
  const renderProjectBlock = (ev: WorkflowEvent) => {
    const files = filesByProject[ev.runId];
    const err = errByProject[ev.runId];
    const isLoaded = loadedSet[ev.runId];
    const isLoading = loadingSet[ev.runId];
    return (
      <div
        key={ev.runId}
        style={{ border: `1px solid ${t.border}`, borderRadius: 10, background: t.cardBg, padding: 10 }}
      >
        <div style={{ fontWeight: 600, fontSize: 12.5, color: t.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {ev.title || ev.runId}
          <antd.Tag color={statusColor(ev.status)} style={{ margin: 0, fontSize: 10 }}>{ev.status || "?"}</antd.Tag>
          <div style={{ flex: 1 }} />
          <antd.Button
            size="small"
            type="text"
            loading={isLoading}
            onClick={() => void loadOne(ev, true)}
            style={{ fontSize: 11, padding: "0 4px" }}
          >
            {tr("刷新")}
          </antd.Button>
        </div>
        {err ? (
          <antd.Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8, fontSize: 11 }}
            message={tr("该项目工作流拉取失败")}
            description={<span style={{ fontSize: 11 }}>{err}</span>}
          />
        ) : null}
        {isLoading && !isLoaded ? (
          <antd.Spin size="small" />
        ) : (files || []).length === 0 && isLoaded ? (
          <div style={{ fontSize: 11.5, color: t.textSecondary, padding: "4px 0" }}>
            {tr("该项目暂无已声明的文件（任务完成并产出结果后会显示）")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {[...groupsOf(files || []).entries()].map(([taskId, taskFiles]) => (
              <div key={taskId}>
                <div
                  style={{
                    fontSize: 11,
                    color: t.textSecondary,
                    marginBottom: 4,
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontFamily: "monospace" }}>{taskId}</span>
                  {taskFiles[0].assignee ? <span>· {taskFiles[0].assignee}</span> : null}
                  {taskFiles[0].taskStatus ? <span>· {taskFiles[0].taskStatus}</span> : null}
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {taskFiles.map((f, i) => (
                    <div
                      key={`${f.path}-${i}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11.5,
                        padding: "3px 6px",
                        borderRadius: 6,
                        background: t.hoverBg,
                      }}
                    >
                      {kindTag(f.kind)}
                      <a
                        href={resolvePluginUrl(artifactDownloadUrl(f.projectId, f.taskId, f.path))}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "#1677ff",
                        }}
                        title={`${f.path}（${tr("下载")}）`}
                        onClick={(e) => {
                          // v0.5.0-beta.12: 解析后 /api URL 裸导航带不了鉴权头（401）
                          // → 一律 host.fetch blob 下载。
                          e.preventDefault();
                          void (async () => {
                            const ok = await downloadViaHost(
                              artifactDownloadUrl(f.projectId, f.taskId, f.path),
                              basenameOf(f.path) || f.path,
                            );
                            if (!ok) antd.message.error(tr("下载失败，请稍后重试"));
                          })();
                        }}
                      >
                        <PageIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {basenameOf(f.path) || f.path}
                      </a>
                      <antd.Button
                        size="small"
                        type="text"
                        style={{ fontSize: 11, padding: "0 4px" }}
                        onClick={() => openFile(f)}
                        title={tr("预览")}
                      >
                        <EyeIcon size={12} />
                      </antd.Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: t.text, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <FolderIcon size={14} /> {tr("项目文件")}
        </span>
        <antd.Tag style={{ fontSize: 10.5 }}>{room?.name || ""}</antd.Tag>
        <div style={{ flex: 1 }} />
        <antd.Button size="small" loading={loading} onClick={() => void refresh()}>
          {tr("刷新")}
        </antd.Button>
        {onClose ? (
          <antd.Button size="small" type="text" onClick={() => onClose()}>
            <CloseIcon size={12} />
          </antd.Button>
        ) : null}
      </div>

      {workflowEvents.length === 0 ? (
        <antd.Empty
          description={tr("未获取到任何项目工作流（Controller 未连通或无注册项目）——点刷新重试")}
        />
      ) : (
        <>
          {roomProjects.length > 0 ? (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary }}>
                {tr("当前房间项目")}
              </div>
              {roomProjects.map((ev) => renderProjectBlock(ev))}
            </>
          ) : (
            <antd.Alert
              type="info"
              showIcon
              style={{ fontSize: 11.5 }}
              message={tr("当前房间无直接关联项目（项目可能从 QQ 等其他通道发起，或尚未在 Controller 注册）——可查下方其他项目")}
            />
          )}
          {otherProjects.length > 0 ? (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, color: t.textSecondary }}>
                {tr("其他项目（{n}）", { n: otherProjects.length })}
              </div>
              <antd.Collapse
                size="small"
                activeKey={expanded}
                onChange={(keys: string | string[]) => {
                  const list = Array.isArray(keys) ? keys.map(String) : [String(keys)];
                  setExpanded(list);
                  list.forEach((k) => {
                    const ev = otherProjects.find((e) => e.runId === k);
                    if (ev) void loadOne(ev);
                  });
                }}
                items={otherProjects.map((ev) => ({
                  key: ev.runId,
                  label: (
                    <span style={{ fontSize: 12 }}>
                      {ev.title || ev.runId}
                      {"  "}
                      <antd.Tag color={statusColor(ev.status)} style={{ margin: 0, fontSize: 10 }}>
                        {ev.status || "?"}
                      </antd.Tag>
                      {filesByProject[ev.runId] ? (
                        <span style={{ color: t.textSecondary, fontSize: 10.5 }}>
                          {"（"}
                          {filesByProject[ev.runId].length}
                          {tr("个文件")}
                          {"）"}
                        </span>
                      ) : null}
                    </span>
                  ),
                  children: renderProjectBlock(ev),
                }))}
              />
            </>
          ) : null}
        </>
      )}

      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
