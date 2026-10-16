// WorkflowBoard 巨石拆分 · 项目干预时间线（ProjectTimeline，懒加载）+ 干预前
// 快照详情（SnapshotDetail）。
// 逐字自 components/WorkflowBoard.tsx 搬移；仅加 `export`。

import {
  fetchProjectHistory,
  fetchProjectHistorySnapshot,
} from "../api";
import { useT } from "../i18n";
import { HistoryIcon } from "../components/icons";
import { fmtTime } from "./helpers";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 项目干预时间线（history 端点；懒加载：展开时才请求）。
 * teamId 透传 ?team=——跨团队重名项目裸 id 409（同 /workflow 契约）。 */
export function ProjectTimeline({ projectId, teamId }: { projectId: string; teamId?: string }) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; snapshots: { timestamp: string }[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(
    null,
  );

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({ kind: "loading" });
    fetchProjectHistory(projectId, teamId)
      .then((resp) => {
        if (alive) setState({ kind: "ok", snapshots: resp.snapshots });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({ kind: "error", message: msg });
      });
    return () => {
      alive = false;
    };
  }, [open, projectId]);

  const openDetail = (ts: string) => {
    fetchProjectHistorySnapshot(projectId, ts, teamId)
      .then((raw) => setDetail(raw))
      .catch(() => setDetail(null));
  };

  return (
    <div style={{ marginTop: 8, fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          fontWeight: 600,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontSize: 11, color: "#888" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><HistoryIcon size={12} /> {tr("时间线")}</span>
        {state.kind === "ok" && state.snapshots.length > 0 ? (
          <antd.Badge
            count={state.snapshots.length}
            size="small"
            style={{ backgroundColor: "#8c8c8c", marginLeft: 4 }}
          />
        ) : null}
      </div>
      {open ? (
        <div style={{ marginTop: 6, paddingLeft: 16, display: "grid", gap: 4 }}>
          {state.kind === "loading" ? (
            <span style={{ color: "#999" }}>{tr("加载中…")}</span>
          ) : null}
          {state.kind === "error" ? (
            <span style={{ color: "#999" }}>
              {state.message.includes("not found") ||
              /HTTP 404/.test(state.message)
                ? tr("Controller 升级后自动生效")
                : `${tr("时间线加载失败")}：${state.message}`}
            </span>
          ) : null}
          {state.kind === "ok" && state.snapshots.length === 0 ? (
            <span style={{ color: "#999" }}>{tr("暂无干预记录")}</span>
          ) : null}
          {state.kind === "ok"
            ? state.snapshots.map((s) => (
                <div
                  key={s.timestamp}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                    color: "#666",
                  }}
                  onClick={() => openDetail(s.timestamp)}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#bbb",
                      flexShrink: 0,
                    }}
                  />
                  <span>
                    {fmtTime(Number(s.timestamp) / 1e6)}
                    <span style={{ color: "#aaa", marginLeft: 6 }}>
                      {s.timestamp.slice(0, 10)}…
                    </span>
                  </span>
                </div>
              ))
            : null}
        </div>
      ) : null}
      <antd.Drawer
        title={tr("干预前快照")}
        open={detail !== null}
        onClose={() => setDetail(null)}
        width={420}
      >
        {detail ? (
          <SnapshotDetail raw={detail} />
        ) : (
          <span style={{ color: "#999" }}>{tr("快照加载失败")}</span>
        )}
      </antd.Drawer>
    </div>
  );
}

/** 单份快照关键字段展示（raw meta JSON）。 */
export function SnapshotDetail({ raw }: { raw: Record<string, unknown> }) {
  const tr = useT();
  const rows: [string, unknown][] = [
    [tr("状态"), raw.status],
    [tr("标题"), raw.title],
    [tr("操作人"), raw.updated_by],
    [tr("操作时间"), raw.updated_at],
    [tr("暂停原因"), raw.pause_reason],
  ];
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return (
    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
      {rows.map(([label, value]) =>
        value === undefined || value === null || value === "" ? null : (
          <div key={label}>
            <div style={{ color: "#999", fontSize: 12 }}>{label}</div>
            <div>{String(value)}</div>
          </div>
        ),
      )}
      <div>
        <div style={{ color: "#999", fontSize: 12 }}>
          {tr("任务数")}
        </div>
        <div>{tasks.length}</div>
      </div>
    </div>
  );
}
