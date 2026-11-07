/**
 * tracingUrl.ts — Dashboard Tracing 页跳转地址（纯函数，node 可测）。
 *
 * Tracing 是 Dashboard 的能力，工作台插件只做跳转（不复制页面）；
 * Dashboard tracing 页不支持 URL 参数，因此**不拼接** worker/筛选条件。
 *
 * 规则：
 * - 空 / 纯空白 → null（未配置 Dashboard 地址 → 入口隐藏）；
 * - 无协议（`localhost:13000`）→ 补 `http://`（dashboard 默认本地/内网；
 *   显式 `https://` 原样保留——这里只是链接，不做网络探测）；
 * - 协议非 http(s) / 无法解析 → null（不生成可被脚本注入的链接）；
 * - 去尾部斜杠后补 `/#/console/governance/tracing`。
 */
const TRACING_HASH = "/#/console/governance/tracing";

export function tracingUrl(base: string): string | null {
  const raw = typeof base === "string" ? base.trim() : "";
  if (!raw) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  // query/hash 对 Tracing 页无意义（页面不支持 URL 参数）——只保留 origin+path。
  const root = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(
    /\/+$/,
    "",
  );
  return `${root}${TRACING_HASH}`;
}
