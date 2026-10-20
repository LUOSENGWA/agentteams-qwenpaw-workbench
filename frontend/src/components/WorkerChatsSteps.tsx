/** WorkerChats 子模块——自 WorkerChats.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { CloseIcon, WrenchIcon, PictureIcon, ThoughtIcon, MessageIcon } from "./icons";
import { useThemeColors } from "../theme";
import type { Extracted } from "./WorkerChatsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** 步骤行：工具（名+参数/输出单行预览，失败 ❌）/ 思考 💭 / 中间文本 💬 / 媒体。 */
export function StepLine({
  e,
}: {
  e: Extracted;
}) {
  const t = useThemeColors(); 
  return (
    <div
      style={{
        fontSize: 11.5,
        color: t.textSecondary,
        background: t.toolBg,
        borderRadius: 6,
        padding: "3px 8px",
      }}
    >
      {e.parts.length === 0 ? (
        <span style={{ color: t.textSecondary }}>{e.type || e.role || "…"}</span>
      ) : (
        e.parts.map((p, j) => {
          if (p.kind === "tool") {
            return (
              <div
                key={j}
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "baseline",
                  overflow: "hidden",
                }}
              >
                <span style={{ flexShrink: 0 }}>{p.failed ? <CloseIcon size={12} style={{ color: "#ff4d4f", verticalAlign: "-1px" }} /> : <WrenchIcon size={12} style={{ verticalAlign: "-1px" }} />}</span>
                <span
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {p.label}
                </span>
                {p.detail ? (
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: t.textSecondary,
                    }}
                  >
                    {p.detail}
                  </span>
                ) : null}
              </div>
            );
          }
          if (p.kind === "media") {
            return (
              <div key={j}>
                {p.image ? (
                  <img
                    src={p.image}
                    alt={p.label}
                    style={{ maxWidth: 160, maxHeight: 120, borderRadius: 6, display: "block" }}
                  />
                ) : null}
                <PictureIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {p.label}
              </div>
            );
          }
          const txt =
            p.label.length > 150 ? `${p.label.slice(0, 150)}…` : p.label;
          return (
            <div
              key={j}
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: t.textSecondary,
              }}
            >
              {p.kind === "thinking" ? <ThoughtIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} /> : <MessageIcon size={12} style={{ verticalAlign: "-1px", marginRight: 2 }} />} {txt}
            </div>
          );
        })
      )}
    </div>
  );
}

/** 步骤折叠（QwenPaw LazyAccordion 同款语义：收起 = 子内容完全不渲染，
 * 懒加载；完成态默认收起——getCollapsedGroupStatus 的 stepsCompleted 形态）。 */
export function StepsCollapse({
  items,
  tr,
}: {
  items: { i: number; e: Extracted }[];
  tr: (k: string, v?: Record<string, string | number>) => string;
}) {
  const t = useThemeColors(); 
  const [open, setOpen] = React.useState(false);
  // inline pill
  // 改 QwenPaw LazyAccordion 同款**整行头**——图标 + 文案 + 计数 + 右对齐
  // 旋转 chevron，整行可点，浅底圆角行（@agentscope-ai/chat Accordion
  // group header 同构；收起=子内容不渲染的懒语义保持）。
  return (
    <div style={{ margin: "0 0 8px 12px" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 10px",
          borderRadius: 8,
          background: t.toolBg,
          border: `1px solid ${t.border}`,
          fontSize: 11.5,
          color: t.textSecondary,
          userSelect: "none",
        }}
        title={open ? tr("收起") : tr("点击展开步骤详情")}
      >
        <span style={{ display: "inline-flex" }}><WrenchIcon size={12} /></span>
        <span>{tr("{n} 步", { n: items.length })}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 9,
            transition: "transform 0.15s",
            transform: open ? "rotate(180deg)" : "none",
            display: "inline-block",
          }}
        >
          ▼
        </span>
      </div>
      {open ? (
        <div
          style={{
            marginTop: 5,
            display: "grid",
            gap: 4,
            paddingLeft: 6,
            borderLeft: "2px solid rgba(127,127,127,0.18)",
          }}
        >
          {items.map(({ i, e }) => (
            <StepLine key={i} e={e} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
