/**
 * harness/entry-1323.tsx — v0.5.0-beta.13.23 UI 实证入口（不进 dist，
 * esbuild 独立打包成 harness/bundle-1323.js，playwright 驱动断言）。
 *
 * 覆盖 13.23 审批数据面统一 #1216（ApprovalControl 六实例分态）：
 *  A1  #1216 GET 200 → 四档卡 + OFF capability 提示行 + 当前模式 Tag
 *  A2  #1216 404 + 旧端点 200 → 回退读成功（docker 直读）
 *  A3  #1216 404 + 旧端点 401 → 新权限文案（橙色，删过期前提）
 *  A4  apply #1216 PUT 200 → 成功 toast + 级别更新
 *  A5  apply #1216 404 + 旧端点 200 → 回退写成功
 *  A6  apply OFF #1216 403（approval_policy capability #1273）→ 错误透传 detail
 */
import type * as ReactNS from "react";
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

import ApprovalControl from "../src/components/ApprovalControl";

function Section({
  id,
  title,
  name,
}: {
  id: string;
  title: string;
  name: string;
}) {
  return (
    <section
      id={id}
      style={{ border: "1px solid #ccc", padding: 8, marginBottom: 12 }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
        {title}
      </div>
      <ApprovalControl workerName={name} />
    </section>
  );
}

function HarnessApp() {
  return (
    <div style={{ padding: 12, maxWidth: 720 }}>
      <Section id="a1" title="A1 #1216 主路径读（AUTO）" name="w-a1" />
      <Section id="a2" title="A2 #1216 404 → 旧端点回退读（STRICT）" name="w-a2" />
      <Section id="a3" title="A3 #1216 404 + 旧端点 401 → 权限文案" name="w-a3" />
      <Section id="a4" title="A4 apply 主路径（#1216 PUT 200）" name="w-a4" />
      <Section id="a5" title="A5 apply #1216 404 → 旧端点回退写" name="w-a5" />
      <Section id="a6" title="A6 apply OFF 403（approval_policy）" name="w-a6" />
    </div>
  );
}

const ReactDOM = (
  window as unknown as {
    ReactDOM: {
      createRoot: (el: Element) => { render: (n: ReactNS.ReactNode) => void };
    };
  }
).ReactDOM;
ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
).render(<HarnessApp />);
