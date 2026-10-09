// 统一动作按钮（图标 + 文字 + 可见规格）。
//
// 背景：此前「下载 / 查看 / 上传 / 复制」等行内动作按钮是
// `type="text" size="small" icon-only + title`——纯图标、几乎不可见、
// 各组件各写各的（字号 11 / padding 0 4px 不一），观感「糊弄上去的」。
// 本组件收敛为单一规格：
//   - 图标 + 文字标签（label 必填，不再纯图标）——可读、可发现；
//   - size="small" + 默认可见边框（type="default"），行内不突兀；
//   - 支持 href/download（直链）或 onClick（鉴权 blob 下载）；
// 各组件行内动作按钮一律经本组件，杜绝再次漂移（技术债防线）。
// host（React/antd）经 window.QwenPaw.host 注入（与其余组件同款）。
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface ActionBtnProps {
  /** 图标（antdIcon 节点，可空但 label 必填）。 */
  icon?: ReactNS.ReactNode;
  /** 按钮文字（必填——统一不再做纯图标动作按钮）。 */
  label: string;
  /** antd type：default=可见边框（默认）/ primary / dashed / text / link。 */
  type?: "default" | "primary" | "text" | "dashed" | "link";
  /** 尺寸：默认 small（行内动作统一）。 */
  size?: "small" | "middle" | "large";
  /** 直链地址（提供则渲染 <a>）。 */
  href?: string;
  /** 下载文件名（配合 href，<a> 生效）。 */
  download?: string;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  loading?: boolean;
  block?: boolean;
  onClick?: ReactNS.MouseEventHandler<HTMLButtonElement | HTMLAnchorElement>;
  style?: ReactNS.CSSProperties;
  className?: string;
}

/**
 * 统一动作按钮。label 必现（图标仅作辅助）；默认 small + 可见边框，
 * 保证在任何行内/工具条语境都清晰可点、视觉一致。
 */
export function ActionBtn({
  icon,
  label,
  type = "default",
  size = "small",
  href,
  download,
  disabled,
  title,
  danger,
  loading,
  block,
  onClick,
  style,
  className,
}: ActionBtnProps) {
  return (
    <antd.Button
      type={type}
      size={size}
      icon={icon}
      danger={danger}
      href={href}
      download={download}
      disabled={disabled}
      title={title}
      loading={loading}
      block={block}
      onClick={onClick}
      style={style}
      className={className}
    >
      {label}
    </antd.Button>
  );
}

export default ActionBtn;
