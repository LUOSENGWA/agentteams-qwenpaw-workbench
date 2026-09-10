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

/** 任务文件条目（O19 artifact 声明：result_path/spec_path/deliverables）。 */
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

/** 正源产物下载 URL（O19 artifact 端点，query path 透传——
 *  与 Artifacts.tsx artifactDownloadUrl 同契约，交叉验证基准）。 */
function artifactDownloadUrl(projectId: string, taskId: string, path: string): string {
  return (
    `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/tasks/${encodeURIComponent(taskId)}/artifact?path=${encodeURIComponent(path)}`
  );
}

function basenameOf(path: string): string {
  const seg = path.split("/").filter(Boolean);
  return seg.length ? seg[seg.length - 1] : path;
}

/** 团队共享空间 / 项目文件面板（8/18 批次 2，O19 版）。
 *
 * 数据源决策（memory/2026-08-18 决策树）：dashboard 5fa2c91 共享空间是
 * MinIO 直读（dashboard 与 Controller 同机有凭据）；插件在用户侧外网，部署侧
 * 反代只暴露 Controller API——Controller 路由全表无房间/团队文件代理端点
 *（唯一文件端点 = O19 任务级 artifact）。故第一版 = O19 任务文件
 *（workflow tasks_detail 声明的 result/spec/deliverables），房间级共享
 * 空间待上游文件 API PR。
 *
 * 链路：当前房间 → workflow events room_id 匹配项目 → 逐项目
 * GET /projects/{id}/workflow?includeTasks=true → tasks_detail → 文件条目
 * → 下载（O19 URL 新窗口，后端 admin token 鉴权）/ 预览（共享 FilePreview，
 * 与 Artifacts 页同一组件）。 */
export default function ProjectFiles(props: {
  room: TeamRoom | null;
  workflowEvents: WorkflowEvent[];
  onClose?: () => void;
}) {
  const { room, workflowEvents, onClose } = props;
  const t = useThemeColors();
  const tr = useT();
  const [files, setFiles] = React.useState<TaskFile[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);

  // 当前房间关联的项目（workflow events room_id 匹配）。
  const projects = React.useMemo(
    () => workflowEvents.filter((ev) => ev.room_id && ev.room_id === room?.room_id),
    [workflowEvents, room],
  );

  const refresh = React.useCallback(async () => {
    if (projects.length === 0) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const collected: TaskFile[] = [];
      for (const ev of projects) {
        let tasks: Array<Record<string, unknown>> = [];
        try {
          const wf = (await requestJson(
            `/agentteams-proxy/controller/api/v1/projects/${encodeURIComponent(ev.runId)}` +
              `/workflow?includeTasks=true`,
          )) as { tasks_detail?: Array<Record<string, unknown>> };
          tasks = Array.isArray(wf.tasks_detail) ? wf.tasks_detail : [];
        } catch {
          // 单项目 workflow 拉取失败不拖垮整个面板（best-effort）。
          continue;
        }
        for (const task of tasks) {
          const taskId = String(task.task_id || "");
          if (!taskId) continue;
          const taskName = String(task.task_id || "");
          const status = String(task.status || "");
          const assignee = String(task.assigned_to || "");
          const push = (path: unknown, kind: TaskFile["kind"]) => {
            if (typeof path !== "string" || !path.trim()) return;
            collected.push({
              projectId: ev.runId,
              projectTitle: ev.title || ev.runId,
              taskId,
              taskName,
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
      }
      setFiles(collected);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "");
      setFiles(null);
    } finally {
      setLoading(false);
    }
  }, [projects]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // 项目 → 任务 分组渲染数据。
  const groups = React.useMemo(() => {
    const byProject = new Map<string, Map<string, TaskFile[]>>();
    for (const f of files || []) {
      if (!byProject.has(f.projectTitle)) byProject.set(f.projectTitle, new Map());
      const byTask = byProject.get(f.projectTitle)!;
      if (!byTask.has(f.taskId)) byTask.set(f.taskId, []);
      byTask.get(f.taskId)!.push(f);
    }
    return byProject;
  }, [files]);

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

  const openFile = (f: TaskFile) => {
    const p = artifactDownloadUrl(f.projectId, f.taskId, f.path);
    setPreview({
      name: basenameOf(f.path) || f.path,
      url: resolvePluginUrl(p),
      apiPath: p,
      // v0.4.85: 正源走 host.fetch（带鉴权）；裸插件路径落 SPA 兜底
      needsFetch: true,
    });
  };

  return (
    <div style={{ display: "grid", gap: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: t.text }}>
          📁 {tr("项目文件")}
        </span>
        <antd.Tag style={{ fontSize: 10.5 }}>{room?.name || ""}</antd.Tag>
        <div style={{ flex: 1 }} />
        <antd.Button size="small" loading={loading} onClick={() => void refresh()}>
          {tr("刷新")}
        </antd.Button>
        {onClose ? (
          <antd.Button size="small" type="text" onClick={() => onClose()}>
            ✕
          </antd.Button>
        ) : null}
      </div>

      {loadError ? (
        <antd.Alert type="warning" showIcon message={tr("部分项目文件加载失败")} description={loadError} />
      ) : null}

      {loading && files === null ? (
        <antd.Spin />
      ) : projects.length === 0 ? (
        <antd.Empty
          description={tr("该房间暂无关联项目——项目群里出现任务后，这里会显示任务文件（结果/任务书/交付物）")}
        />
      ) : (files || []).length === 0 ? (
        <antd.Empty description={tr("项目暂无已声明的文件（任务完成并产出结果后会显示）")} />
      ) : (
        [...groups.entries()].map(([projectTitle, byTask]) => (
          <div
            key={projectTitle}
            style={{ border: `1px solid ${t.border}`, borderRadius: 10, background: t.cardBg, padding: 10 }}
          >
            <div style={{ fontWeight: 600, fontSize: 12.5, color: t.text, marginBottom: 8 }}>
              {projectTitle}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {[...byTask.entries()].map(([taskId, taskFiles]) => (
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
                            // v0.4.85: 解析后 /api URL 裸导航带不了鉴权头（401）
                            // → 一律 host.fetch blob 下载。
                            e.preventDefault();
                            void (async () => {
                              const ok = await downloadViaHost(
                                artifactDownloadUrl(f.projectId, f.taskId, f.path),
                                basenameOf(f.path) || f.path,
                              );
                              if (!ok) antd.message.error("下载失败，请稍后重试");
                            })();
                          }}
                        >
                          📄 {basenameOf(f.path) || f.path}
                        </a>
                        <antd.Button
                          size="small"
                          type="text"
                          style={{ fontSize: 11, padding: "0 4px" }}
                          onClick={() => openFile(f)}
                          title={tr("预览")}
                        >
                          👁
                        </antd.Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
