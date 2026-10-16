// WorkflowBoard 巨石拆分 · 左栏项目列表（ProjectRail）+ 窄屏钻取返回条
// （NarrowDetailBack）。
// 逐字自 components/WorkflowBoard.tsx 搬移；仅加 `export`。

import type { WorkflowEvent } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { statusMeta, fmtTime } from "./helpers";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

/** 左栏项目列表（卡片/拓扑视图共用选择；排序=顶部下拉，独立滚动——
 * 对齐 dashboard 任务看板「项目」区 master-detail 结构）。 */
export function ProjectRail(props: {
  events: WorkflowEvent[];
  selected: string;
  onSelect: (runId: string) => void;
  /** fill=撑满父级可用高（flex:1+minHeight:0，窄屏 drill-in 整高列表用）；
   * 默认（宽屏 master-detail）限高=容器高（百分比对栅格行解析）。
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
        ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight: "100%" }),
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
              // compact 单卡（≈40px ≤ 48px）：标题 1 行 + 元信息 1 行，
              // drill-in 列表一屏 ≥5 卡。
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
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ev.title}
            </div>
            <div
              style={{
                marginTop: 2,
                display: "flex",
                gap: 6,
                alignItems: "center",
                fontSize: 11,
                lineHeight: 1.25,
                whiteSpace: "nowrap",
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

/** 窄屏单栏 drill-in：详情顶部返回条（← 返回 + 项目标题）——
 * 与聊天房间紧凑头「← 返回」同一交互心智（列表 → 点进详情 → 返回列表）。 */
export function NarrowDetailBack(props: { title: string; onBack: () => void }) {
  const tr = useT();
  return (
    // flexShrink:0——drill-in 详情为纵向 flex 链，返回条恒占自身高（不被详情区挤压）。
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 0 }}>
      <antd.Button size="small" onClick={props.onBack} style={{ flexShrink: 0 }}>
        ← {tr("返回")}
      </antd.Button>
      <span
        title={props.title}
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
        {props.title}
      </span>
    </div>
  );
}
