import type * as ReactNS from "react";

import { useWorkerRuntimeConfigCore } from "./WorkerRuntimeConfigCore";
import { WorkerRuntimeConfigView } from "./WorkerRuntimeConfigView";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

function WorkerRuntimeConfig({
  name,
  l1,
  onOpenSettings,
  sheet,
}: {
  name: string;
  /** 当前账号 L1（controller token）——L1-only 字段（并发限流/上下文管理/
 * shell 组/auto_title）可编辑；L2 只读（PUT 非 L2 白名单键被服务端 403）。 */
  l1?: boolean;
  /** ：跳「设置」页
 * 配 Controller token 的入口（L1 账号密码登录只落 Higress Console
 * 会话 ≠ Controller 管理 token——两套凭证，Alert 给明确指引）。 */
  onOpenSettings?: () => void;
  /** 竖屏弹窗模式（WorkerManage NarrowSheet 底部抽屉承载）：初始即展开
 * （懒加载时点 = 弹窗打开，语义不变）+ 去卡片外框（margin/边框，弹窗
 * 即容器）+ 头部隐藏收起抓手/图标/标题（Modal 头已带标题，仅留 qwenpaw
 * 标签与 刷新/重置/保存 动作钮）。表单内容零改动。 */
  sheet?: boolean;
}) {
  const c = useWorkerRuntimeConfigCore({ name, l1, onOpenSettings, sheet });
  return (
    <WorkerRuntimeConfigView p={{ name, l1, onOpenSettings, sheet }} c={c} />
  );
}
export default WorkerRuntimeConfig;
