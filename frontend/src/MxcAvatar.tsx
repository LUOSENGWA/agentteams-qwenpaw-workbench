import type * as ReactNS from "react";

import { useAvatarUrl } from "./useAvatar";

// v0.4.87: React/antd 必须取宿主的（全代码库唯一模式）。
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** antd.Avatar 封装：mxc 走 host.fetch blob objectURL，加载中/失败落
 * children 首字母兜底。替代散落的 `<antd.Avatar src={mxc_url}>`
 *（8 处，再版 11 统一裂图修）。
 * 5.0.0-beta.5：透传全部宿主注入的 props（...rest → antd.Avatar）。
 * 根因修复：antd Popover/Dropdown 通过 cloneElement 向 child 注入
 * onClick/onContextMenu，MxcAvatar 旧版只认 url/size/style/children
 * 四个具名 prop → 注入的事件处理器被静默丢弃 → 头像左键弹层/右键
 * 菜单全都不触发（emoji 弹层 child 是 antd.Button 透传 props 所以
 * 一直正常）。透传后两类菜单同时修复。 */
export function MxcAvatar({
  url,
  size,
  style,
  children,
  ...rest
}: {
  url?: string | null;
  size?: number | "small" | "default" | "large";
  style?: ReactNS.CSSProperties;
  children?: ReactNS.ReactNode;
} & Omit<ReactNS.HTMLAttributes<HTMLElement>, "children">) {
  const src = useAvatarUrl(url);
  return (
    <host.antd.Avatar
      size={size}
      src={src || undefined}
      style={style}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </host.antd.Avatar>
  );
}
