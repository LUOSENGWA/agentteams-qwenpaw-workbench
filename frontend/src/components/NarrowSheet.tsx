/**
 * NarrowSheet.tsx — 竖屏友好弹窗（共享呈现容器）。
 *
 * 自 WorkerManageTree 本地函数抽出（行为零改动）：narrow 下各面板的
 * 「内联 → 弹窗」容器——antd.Modal 居中（非底部抽屉）+ 手机近全宽
 *（上限 520 居中）+ body ≤66dvh 纵向可滚；afterClose 才卸载内容
 *（面板内 30s 轮询/取数随之下线，关窗后零后台负载，动画期间不闪空）。
 *
 * 消费方：WorkerManageTree（运行配置/环境变量/MCP/插件/Coding CLI/
 * LLM 调优/资源管理 narrow 入口）+ 管理页新卡（ResourceCardHost
 * narrow 模式）。wbc-narrow 标记走全局 CSS（portal 在 body，规则
 * 不带 .wb-main 前缀）。
 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export default function NarrowSheet({
  open,
  title,
  onClose,
  children,
  flushTop = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNS.ReactNode;
  /** 顶部贴合（默认 false）：body 顶部 padding 0——面板首元素为 tab 条/
   * 面板标题行时紧贴弹窗标题栏下沿（8px 空隙在滚动时会透出内容）。 */
  flushTop?: boolean;
}) {
  const [render, setRender] = React.useState(open);
  React.useEffect(() => {
    if (open) setRender(true);
  }, [open]);
  return (
    <antd.Modal
      open={open}
      afterClose={() => setRender(false)}
      onCancel={onClose}
      footer={null}
      title={title}
      width="min(calc(100vw - 32px), 520px)"
      // 居中弹窗（非底部抽屉）——竖屏友好：不贴底(不靠下)、不超屏底(居中 + body 内滚)。
      // 此前 styles.wrapper 强改 bottom:0 成底部抽屉→"太靠下 + 贴手势条/超底部"。
      centered
      styles={{
        // 内容纵向可滚：body 封顶 66dvh(≈屏高 2/3)，居中后上下留白，不超屏底。
        body: {
          maxHeight: "min(66dvh, 560px)",
          overflowY: "auto",
          // 内容贴弹窗宽（左右内边距收紧 16→10，内层 Card/面板铺满弹窗宽）。
          // flushTop：顶部 0——tab 条/面板标题行紧贴标题栏下沿（16.29
          // 缝隙透出内容修复；左右/底部不变）。
          padding: flushTop ? "0 10px 8px" : "8px 10px",
        },
        content: { borderRadius: 12, overflow: "hidden" },
      }}
    >
      {/* wbc-narrow：窄屏弹窗内容标记（全局 CSS 消费——表单行转纵向 + antd 控件
      限宽到容器，治「弹窗内容横向拖」；portal 在 body，规则不带 .wb-main 前缀）。 */}
      {render ? (
        <div className="wbc-narrow wb-sheet-in" style={{ minWidth: 0 }}>
          {children}
        </div>
      ) : null}
    </antd.Modal>
  );
}
