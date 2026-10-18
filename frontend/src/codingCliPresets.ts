/**
 * Coding CLI 场景 preset（1.2.5 #1360 消费；数据从 dashboard
 * src/lib/coding-cli-presets/ 逐字段移植——两侧同源不漂移）。
 *
 * preset 语义（与 dashboard 一致）：
 * - settings_patch：一键 PUT 到该 CLI 的 settings（深合并；模型名等）。
 * - toolchain / mcp / artifacts：**仅建议清单**——动 CR（env）/绑 MCP
 *   是团队级决策，preset 不自动执行（human_confirm 门）。
 */

export const CODING_CLI_IDS = ["qwen-code", "opencode", "qoder"] as const;
export type CodingCliId = (typeof CODING_CLI_IDS)[number];

export function isCodingCliId(value: string): value is CodingCliId {
  return (CODING_CLI_IDS as readonly string[]).includes(value);
}

export type Localized = string | { "zh-CN": string; "en-US"?: string };

export type Redacted = { redacted: true; has_value: boolean };

// 值层不递归（嵌套对象/数组一律 unknown 化——settings 是任意 JSON，
// 深合并由 controller 执行，前端不需要值级类型）。
export function localizedText(value: Localized | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value["zh-CN"] || value["en-US"] || "";
}

export function isRedacted(value: unknown): value is Redacted {
  return !!value && typeof value === "object" && (value as Redacted).redacted === true;
}

