import type * as ReactNS from "react";

/**
 * WbTooltip — 触屏可达的 Tooltip 包装（P0 触屏适配 T2）。
 *
 * 背景：antd Tooltip 默认 trigger=hover——纯触屏设备（手机/平板/触控
 * 笔电）无 hover 概念，109 处 Tooltip 的信息对触屏用户全部不可达
 * （WCAG 1.4.13 Content on Hover or Focus：核心信息不得只依赖 hover）。
 *
 * 本包装默认 trigger = ["hover", "focus", "click"]：
 * - 桌面：行为不变（hover 为主；click 也能开=键盘/鼠标点按同样可达，
 *   属增强不属行为变更）
 * - 触屏：tap 弹出，再 tap 一次 / tap 别处收起（antd 内置 toggle）
 * - 调用方显式传 trigger 时以调用方为准（行操作显现型不走本包装，
 *   改 .wb-hover-only-action + @media (hover:none) 常显）
 *
 * 用法：import { WbTooltip } from "./WbTooltip"（或 ../components/WbTooltip），
 * 替换 `antd.Tooltip` 即可，props 全透传。
 */
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type TooltipProps = ReactNS.ComponentProps<typeof antd.Tooltip>;

/**
 * tap（默认 true）——点击触发是否加入 trigger：
 * - 包**纯文本/图标/状态点**（无自身 onClick）：tap=true，触屏 tap 弹信息
 * - 包**可点按钮/链接**（有 onClick/是 a）：tap=false → trigger 只留
 *   hover+focus（键盘可达满足 WCAG 1.4.13）。原因：click 触发与
 *   按钮自身 onClick 同刻双发——触屏 tap 会「执行动作 + 弹提示」，
 *   提示变成误触噪音
 */
export function WbTooltip(
  props: TooltipProps & { tap?: boolean },
) {
  const { trigger, tap = true, ...rest } = props;
  const t =
    trigger ??
    (tap ? ["hover", "focus", "click"] : ["hover", "focus"]);
  return React.createElement(antd.Tooltip, { trigger: t, ...rest } as TooltipProps);
}

export default WbTooltip;
