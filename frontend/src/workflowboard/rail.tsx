// WorkflowBoard 巨石拆分 · 左栏项目列表（ProjectRail，拓扑视图 master-detail
// 左栏；窄屏 drill-in 整高列表同款）。
// 逐字自 components/WorkflowBoard.tsx 搬移；仅加 `export`。
// 10/26：NarrowDetailBack（窄屏 card 钻取返回条）随 card 视图退役删除。

import type { WorkflowEvent } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { statusMeta, fmtTime } from "./helpers";

const host = window.QwenPaw.host;
const React = host.React;

/** 左栏项目列表（拓扑视图选择；排序=顶部下拉，独立滚动——
 * 对齐 dashboard 任务看板「项目」区 master-detail 结构）。 */
export function ProjectRail(props: {
  events: WorkflowEvent[];
  selected: string;
  onSelect: (runId: string) => void;
  /** fill=撑满父级可用高（flex:1+minHeight:0，窄屏 drill-in 整高列表用）；
   * 默认（宽屏 master-detail）高=栅格区高（height:100% 对隐式单行解析），
   * 列内独立滚动、互不带动（10/26 双栏独立滚动）。
   * 高度一律容器相对，禁 100vh（宿主为可拖拽容器，100vh≠容器高）。 */
  fill?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { events, selected, onSelect, fill } = props;
  if (events.length === 0) return null;
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        boxSizing: "border-box",
        ...(fill ? { flex: 1, minHeight: 0 } : { height: "100%", minHeight: 0 }),
        overflowY: "auto",
      }}
    >
      {events.map((ev) => {
        const active = ev.runId === selected;
        const meta = statusMeta(ev.status);
        const n = (ev.nodes ?? []).length;
        return (
          <div
            key={ev.runId}
            onClick={() => onSelect(ev.runId)}
            style={{
              cursor: "pointer",
              // 卡片高度动态=内容高（无固定高）：项目名自动换行，行随拖宽
              // 变化——与项目卡视图项目名同款换行（不 ellipsis 丢信息）。
              padding: "4px 12px",
              borderBottom: `1px solid ${t.border}`,
              borderLeft: active ? `3px solid ${meta.color}` : "3px solid transparent",
              background: active ? `${meta.color}14` : undefined,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.25,
                color: t.text,
                // 自动换行防省略号（长名/长 URL 断词）；列拖窄不溢出。
                whiteSpace: "normal",
                wordBreak: "break-word",
              }}
            >
              {ev.title}
            </div>
            <div
              style={{
                marginTop: 2,
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
                fontSize: 11,
                lineHeight: 1.25,
                color: t.textSecondary,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: meta.color,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span>{tr(meta.label)}</span>
              <span>·</span>
              <span>
                {n} {tr("任务")}
              </span>
              {ev.ts ? (
                <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                  {fmtTime(ev.ts)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
