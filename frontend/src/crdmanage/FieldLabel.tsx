// CrdManage 拆分（QC-196 方案 §5.2）· 字段标题组件——原为主组件内联闭包，
// 提升为独立组件：内部自调 useThemeColors 取次级文字色，渲染输出不变。

import type * as ReactNS from "react";

import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

/** ：
 * 字段标题——输入框/选择器上方人话标签（占位符输入即消失=无标题，
 * 与 11.7 团队成员「名称/角色/模型」标签同构）。 */
export default function FieldLabel({ children }: { children: ReactNS.ReactNode }) {
  const t = useThemeColors();
  return (
    <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
      {children}
    </div>
  );
}
