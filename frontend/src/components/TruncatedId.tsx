import type * as ReactNS from "react";

import { useT } from "../i18n";

/**
 * v0.4.97: 长标识符（MXID / 房间 ID 等）截断展示——移植 dashboard
 * TruncatedId 交互（Manager 卡片同款）：>16 字符显示「前 8 + … + 后 4」，
 * 悬停 Tooltip 显示完整值（可换行），行内复制按钮一键复制。
 * 通用组件，CrdManage 人员表 MXID 列 / 团队表房间列共用。
 */
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface TruncatedIdProps {
  value?: string;
  /** 用于提示文案的标识名称（如「MXID」「团队房间」）。 */
  label?: string;
}

export default function TruncatedId(props: TruncatedIdProps) {
  const tr = useT();
  const { value, label } = props;
  if (!value) {
    return <span style={{ color: "#999" }}>—</span>;
  }
  const displayName = label || "ID";
  const truncated =
    value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
  const copy = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(
        () => antd.message.success(tr("已复制")),
        () => antd.message.warning(tr("复制失败——请手动全选复制")),
      );
    } else {
      antd.message.warning(tr("复制失败——请手动全选复制"));
    }
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <antd.Tooltip
        title={
          <span style={{ display: "inline-block", maxWidth: 420 }}>
            <span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
              {value}
            </span>
            <div style={{ marginTop: 4, opacity: 0.75, whiteSpace: "nowrap" }}>
              {tr("点击右侧按钮复制完整 {label}", { label: displayName })}
            </div>
          </span>
        }
      >
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            cursor: "help",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 220,
            display: "inline-block",
            verticalAlign: "middle",
          }}
        >
          {truncated}
        </span>
      </antd.Tooltip>
      <antd.Button
        size="small"
        type="text"
        style={{
          color: "#888",
          fontSize: 12,
          padding: "0 4px",
          height: 18,
        }}
        onClick={copy}
        title={tr("复制 {label}", { label: displayName })}
      >
        ⧉
      </antd.Button>
    </span>
  );
}
