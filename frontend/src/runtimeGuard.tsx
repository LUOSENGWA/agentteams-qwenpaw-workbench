// v0.5.0-beta.14.22：运行时提醒配套（D4）——非 qwenpaw 运行时对
// QwenPaw 独有功能的「提前禁用/隐藏 + 说清楚」，杜绝拨号失败 400/502
// 的糊涂态。规格=运行时UI提醒配套-执行规格 v2（8 面板矩阵）。
//
// 判据（与后端 400 语义同源，空值放行不误伤老 worker）：
// - worker.runtime 空/qwenpaw → false（功能可用）
// - 其余（openclaw/hermes/deepseek-harness/legacy copaw）→ true
// - runtimeDeprecated=true（controller ≥#1327；copaw 存量）→ 角标
//   「Legacy · 建议升级 QwenPaw」（#8）
//
// 行为三选一（按面板性质定）：隐藏入口 / 禁用+说明 / 降级空态+说明。
// 只拦写路径与 qwenpaw 独有面；只读展示照读（分配层 CRD 等）。
import type * as ReactNS from "react";
import { useT } from "./i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 判定：非 qwenpaw 且 runtime 非空 → 该 worker 的 qwenpaw 独有功能禁用。 */
export function isQwenpawOnlyDisabled(runtime?: string): boolean {
  const r = (runtime || "").trim().toLowerCase();
  return r !== "" && r !== "qwenpaw";
}

/** 统一说明条（禁用/降级面板顶部）；legacy=角标形态（#8 所有 worker 卡）。 */
export function RuntimeNotice({
  runtime,
  kind = "feature",
  compact = false,
}: {
  runtime?: string;
  kind?: "feature" | "legacy";
  compact?: boolean;
}) {
  const tr = useT();
  if (kind === "legacy") {
    return (
      <antd.Tag color="orange" style={{ margin: 0, fontSize: 10.5 }}>
        {tr("Legacy · 建议升级 QwenPaw")}
      </antd.Tag>
    );
  }
  if (!isQwenpawOnlyDisabled(runtime)) return null;
  return (
    <antd.Alert
      type="info"
      showIcon
      style={{ fontSize: compact ? 11 : 12, marginBottom: compact ? 4 : 8 }}
      message={
        <span style={{ fontSize: compact ? 11 : 12 }}>
          {tr("此功能仅支持 QwenPaw 运行时的 Worker")}
          {runtime ? `（当前：${runtime}）` : ""}
        </span>
      }
    />
  );
}

export default RuntimeNotice;
