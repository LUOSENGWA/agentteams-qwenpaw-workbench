import { RadarIcon } from "./icons";
import type * as ReactNS from "react";

import {
  fetchProjectTransitionEvents,
  type ProjectTransitionEvent,
} from "../api";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 转换引擎状态词汇（task-transitions.json 契约值）→ 颜色。
 * 未知状态回退灰（新状态上线不炸 UI）。 */
const STATUS_COLOR: Record<string, string> = {
  planned: "#999",
  prepared: "#8c8c8c",
  assigned: "#1677ff",
  in_progress: "#1677ff",
  submitted: "#722ed1",
  completed: "#52c41a",
  revision: "#fa8c16",
  blocked: "#fa541c",
  cancelled: "#ff4d4f",
};

/** ISO → HH:mm:ss（本地时区；解析失败原样截尾）。 */
function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(-8, 4);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 状态色标签（from→to 渲染用）。 */
function StatusChip({ status }: { status: string }) {
  const color = STATUS_COLOR[status] || "#999";
  return (
    <span
      style={{
        color,
        fontWeight: 600,
        fontSize: 11,
        whiteSpace: "nowrap",
      }}
    >
      {status || "?"}
    </span>
  );
}

/** 项目任务状态转换事件流（Controller GET /api/v1/projects/{id}/events，
 * #1233 transition engine 已合上游 main）。
 *
 * 数据面：游标分页（页1=最旧，next_cursor 不透明）；打开时拉全量页
 * （上限 10 页 × 200 = 2000 条，超出截断提示）；展开期间 20s 轮询尾游标
 * 增量追加；cursor_expired（50 条截断/legacy 快照漂移）→ 弃游标从头重载。
 * 展示面：新→旧时间线；行 = 时间 + action + from→to + task + actor/note。
 * 404（Controller 未升级到含该端点的版本）→ 诚实占位一行，不当错误。
 * 样式对齐同文件族 ProjectTimeline（📜 干预时间线=history 端点）：
 * 折叠、懒加载（展开才请求）、点击头切换。 */
export function WorkflowEventsTimeline(props: {
  projectId: string;
  teamId?: string;
}) {
  const { projectId, teamId } = props;
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notDeployed, setNotDeployed] = React.useState(false);
  const [events, setEvents] = React.useState<ProjectTransitionEvent[]>([]);
  const [truncated, setTruncated] = React.useState(false);
  // 尾游标（当前已加载到的位置；轮询从此增量取）。
  const tailCursorRef = React.useRef<string>("");
  const loadingRef = React.useRef(false);

  /** 从头加载全量页（最多 10 页）。返回是否 404。 */
  const loadAll = React.useCallback(async (signal?: { stopped: boolean }) => {
    let cursor = "";
    const all: ProjectTransitionEvent[] = [];
    let notDeployedNow = false;
    let truncatedNow = false;
    for (let page = 0; page < 10; page += 1) {
      if (signal?.stopped) return;
      const resp = await fetchProjectTransitionEvents(projectId, teamId, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (signal?.stopped) return;
      if (resp === null) {
        notDeployedNow = true;
        break;
      }
      all.push(...resp.events);
      if (resp.cursorExpired) {
        // 锚点失效：从头重来一次（不丢数据、不重复累加）。
        cursor = "";
        all.length = 0;
        if (page > 0) {
          // 二次仍 expired → 视为数据损坏，停止翻页避免死循环。
          truncatedNow = true;
          break;
        }
        continue;
      }
      if (!resp.nextCursor) break;
      cursor = resp.nextCursor;
    }
    if (signal?.stopped) return;
    tailCursorRef.current = cursor;
    setNotDeployed(notDeployedNow);
    setTruncated(truncatedNow);
    setEvents(all);
    setError("");
  }, [projectId, teamId]);

  const refresh = React.useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      await loadAll();
    } catch (e) {
      if (!loadingRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [loadAll]);

  // 打开时首载；关闭重置（下次展开重新拉，数据面小、不做缓存层）。
  React.useEffect(() => {
    if (!open) return;
    let stopped = false;
    setLoading(true);
    loadAll({ stopped })
      .catch((e: unknown) => {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    const timer = window.setInterval(() => {
      void refresh();
    }, 20000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, loadAll, refresh]);

  // 新→旧展示（API 页序=旧→新）。
  const shown = React.useMemo(() => [...events].reverse(), [events]);

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
        <span style={{ fontSize: 11, color: "#888" }}>{open ? "▾" : "▸"}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><RadarIcon size={13} /> {tr("事件流")}</span>
        {events.length > 0 ? (
          <span style={{ color: "#888", fontWeight: 400 }}>
            {tr("（{n} 条）", { n: events.length })}
          </span>
        ) : null}
        {loading ? (
          <span style={{ color: "#888", fontWeight: 400 }}>…</span>
        ) : null}
      </div>
      {open ? (
        <div style={{ marginTop: 6, paddingLeft: 14 }}>
          {notDeployed ? (
            <div style={{ color: "#999" }}>
              {tr("Controller 未部署事件流端点（需升级到含 #1233 的版本）")}
            </div>
          ) : error ? (
            <div style={{ color: "#ff4d4f" }}>
              {tr("事件流加载失败")}：{error}
            </div>
          ) : shown.length === 0 && !loading ? (
            // v0.5.0-beta.13.12（现场 9/23 调查报告定案）：events 端点
            // 只读（POST→405），Controller 事件摄取链路未实现——6 项目全空
            // 是平台侧系统性缺口，非本项目未执行。空态文案必须说清「数据源
            // 未接通」，不再暗示"Agent 执行后会聚合"（摄取未落地前永不出现）；
            // report_progress 当前 runtime 动作集不存在（taskflow 枚举实锤），
            // 从文案剔除。任务状态时间线仍可看拓扑/看板。
            <div style={{ color: "#999", lineHeight: 1.6 }}>
              {tr(
                "暂无转换事件——平台侧 Controller 事件摄取尚未接通（端点只读、写入链路未部署，存量项目均为空），此面板当前恒为空。任务状态请查看上方拓扑/看板。",
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 4, maxHeight: 320, overflow: "auto" }}>
              {truncated ? (
                <div style={{ color: "#fa8c16" }}>
                  {tr("（更早事件超出窗口，显示最近 2000 条）")}
                </div>
              ) : null}
              {shown.map((ev, i) => (
                <div
                  key={`${ev.seq ?? "x"}-${ev.ts}-${ev.task_id}-${i}`}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      color: "#888",
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtTime(ev.ts)}
                  </span>
                  <span
                    style={{
                      color: "#FF7F16",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {ev.action}
                  </span>
                  <span style={{ whiteSpace: "nowrap" }}>
                    <StatusChip status={ev.from} />
                    <span style={{ color: "#888", margin: "0 3px" }}>→</span>
                    <StatusChip status={ev.to} />
                  </span>
                  {ev.task_id ? (
                    <span style={{ color: "#888", fontFamily: "monospace" }}>
                      {ev.task_id}
                    </span>
                  ) : null}
                  {ev.actor ? (
                    <span style={{ color: "#888" }}>
                      {tr("by")}{ev.actor.split(":")[0].replace(/^@/, "")}
                    </span>
                  ) : null}
                  {ev.note ? (
                    <span
                      style={{ color: "#888", maxWidth: 420 }}
                      title={ev.note}
                    >
                      {ev.note.length > 120 ? `${ev.note.slice(0, 120)}…` : ev.note}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
