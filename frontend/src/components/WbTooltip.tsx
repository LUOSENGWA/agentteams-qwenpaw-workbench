import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

type TooltipProps = ReactNS.ComponentProps<typeof antd.Tooltip>;

/** 给 trigger DOM 打标记——供「按下即关」判断「按在 trigger 上→不关」。 */
const TRIGGER_MARK = "data-wbtt-trigger";

/**
 * 统一 Tooltip 交互模型（P0-2 触屏批引入 tap；15.4 加触屏「按下即关」）。
 *
 * - 桌面鼠标 / 触控笔：hover / focus 触发（零改动）。
 * - 触屏：tap={true}（默认）tap 开；**tap={false}**（按钮等会二次触发的元素）
 *   只保留 hover/focus——触屏无 hover，故触屏永不弹出，避免「点击触发元素 +
 *   弹 tooltip」双动作抢手势。
 * - 触屏「按下即关」：提示应在手指**按下**其它地方那一刻就关，不必等**松开**
 *   才关。antd 的 click 触发在 pointerup（松手）才关；本组件改挂 document 级
 *   `pointerdown`（仅 touch 指针）落在 trigger 外 → 立即关，不必等松手。桌面
 *   hover 路径零改动（open/onOpenChange 镜像 antd 意图，等价原非受控行为）。
 */
export function WbTooltip(props: TooltipProps & { tap?: boolean }) {
  const {
    trigger,
    tap = true,
    open: openProp,
    onOpenChange,
    children,
    ...rest
  } = props;
  const controlled = openProp !== undefined;
  const [open, setOpen] = React.useState(false);

  // 触屏：指针「按下」(pointerdown，非 pointerup/click) 落在 trigger 外 → 立即关。
  // 仅 open 且非外部受控时挂监听；mouse/pen 指针跳过（桌面 hover 路径零改动）。
  // 用 capture 阶段，抢先于 antd 的 pointerup/click 处理。
  React.useEffect(() => {
    if (controlled || !open) return;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "touch") return;
      const tgt = e.target as HTMLElement | null;
      // 按在 trigger 上 → 交给 antd 的 click 触发（toggle），此处不关
      if (tgt && (tgt as HTMLElement).closest && (tgt as HTMLElement).closest(`[${TRIGGER_MARK}]`))
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [controlled, open]);

  const t = trigger ?? (tap ? ["hover", "focus", "click"] : ["hover", "focus"]);
  // 给 trigger 打标记（仅加 data-* 属性，不动 ref，antd 二次 clone 不受影响）。
  const childEl = React.isValidElement(children)
    ? React.cloneElement(children, { [TRIGGER_MARK]: "" } as unknown as ReactNS.Attributes)
    : children;
  return React.createElement(
    antd.Tooltip,
    {
      trigger: t,
      open: controlled ? (openProp as boolean) : open,
      onOpenChange: (o: boolean) => {
        if (!controlled) setOpen(o);
        if (onOpenChange) onOpenChange(o);
      },
      ...rest,
    },
    childEl
  );
}

export default WbTooltip;
