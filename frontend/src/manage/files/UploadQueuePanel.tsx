// UploadQueuePanel — 文件页工具条下方的上传队列面板（多选并发 ≤2）。
//
// 数据来源 = 容器 useUploadQueue（queue 状态机在 files/uploadQueue.ts）；
// 本组件只渲染：总进度 + 「完成 a/b · 失败 n」+ 逐项状态（等待 / 上传中 /
// 成功 / 失败 + 失败原因 + 重试单项）。空队列不占版面。
// 移动端可折叠（compact = <768 sheet 断点）：默认收起，只留标题 + 总进度；
// 展开由标题右侧三角切换。
import type * as ReactNS from "react";

import type { ThemeColors } from "../../theme";
import {
  uploadProgress,
  type UploadItem,
  type UploadItemStatus,
} from "./uploadQueue";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

export interface UploadQueuePanelProps {
  t: ThemeColors;
  tr: Tr;
  items: readonly UploadItem[];
  /** 窄屏（移动端）默认收起。 */
  compact: boolean;
  onRetry: (id: string) => void;
  /** 移除已完成（success）项；失败项保留供重试。 */
  onClearFinished: () => void;
}

function statusText(tr: Tr, s: UploadItemStatus): string {
  if (s === "waiting") return tr("等待");
  if (s === "uploading") return tr("上传中");
  if (s === "success") return tr("成功");
  return tr("失败");
}

export default function UploadQueuePanel({
  t,
  tr,
  items,
  compact,
  onRetry,
  onClearFinished,
}: UploadQueuePanelProps) {
  const [open, setOpen] = React.useState(!compact);
  // 进入窄屏（如旋转 / 窗口缩窄）→ 自动收起，避免挤占列表。
  React.useEffect(() => {
    if (compact) setOpen(false);
  }, [compact]);
  if (items.length === 0) return null;
  const p = uploadProgress(items);
  const statusColor = (s: UploadItemStatus): string =>
    s === "failed" ? "#d4380d" : s === "uploading" ? t.text : t.textSecondary;
  return (
    <div
      data-upload-queue="1"
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "8px 10px",
        background: t.cardBg,
        display: "grid",
        gap: 6,
        fontSize: 12,
        color: t.text,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{tr("上传队列")}</span>
        <span style={{ color: t.textSecondary }}>
          {tr("完成 {a}/{b}", { a: p.finished, b: p.total })}
          {p.failed > 0 ? ` · ${tr("失败 {n}", { n: p.failed })}` : ""}
        </span>
        <span style={{ flex: "1 1 auto" }} />
        {p.success > 0 ? (
          <antd.Button size="small" type="link" onClick={onClearFinished}>
            {tr("清除已完成")}
          </antd.Button>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? tr("收起") : tr("展开")}
          title={open ? tr("收起") : tr("展开")}
          onClick={() => setOpen((v) => !v)}
          style={{
            minWidth: "var(--hf-btn-min, 40px)",
            minHeight: "var(--hf-btn-min, 40px)",
            border: "none",
            background: "transparent",
            color: t.textSecondary,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      <antd.Progress
        percent={p.percent}
        size="small"
        showInfo={false}
        style={{ margin: 0 }}
      />
      {open ? (
        <div style={{ display: "grid", gap: 4 }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: "grid", gap: 2 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  title={it.path}
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.name}
                </span>
                <span style={{ color: statusColor(it.status), whiteSpace: "nowrap" }}>
                  {statusText(tr, it.status)}
                </span>
                {it.status === "failed" ? (
                  <antd.Button
                    size="small"
                    onClick={() => onRetry(it.id)}
                    aria-label={tr("重试 {name}", { name: it.name })}
                  >
                    {tr("重试")}
                  </antd.Button>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
              {it.status === "failed" && it.error ? (
                <span
                  style={{
                    color: "#d4380d",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.error}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
