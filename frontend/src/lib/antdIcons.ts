// 宿主 antdIcons 桥接共享底座（域：宿主图标）。原先每个消费文件各复制一份
// icons/EmptyIcon/pick 五行引导（全仓 13+ 处同形），抽此收编。
// 消费方保留自己的图标名，经 pickIcon 取组件（按名回退 EmptyIcon，语义不变）。
import type * as ReactNS from "react";

export type HostIcon = ReactNS.FC<Record<string, unknown>>;

export const EmptyIcon = (() => null) as unknown as HostIcon;

export function pickIcon(name: string): HostIcon {
  const host = window.QwenPaw.host;
  const icons = (host.antdIcons || {}) as Record<string, HostIcon>;
  return (icons[name] as HostIcon) || EmptyIcon;
}
