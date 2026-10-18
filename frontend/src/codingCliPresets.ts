/**
 * Coding CLI 场景 preset（1.2.5 #1360 消费；数据从 dashboard
 * src/lib/coding-cli-presets/ 逐字段移植——两侧同源不漂移）。
 *
 * preset 语义（与 dashboard 一致）：
 * - settings_patch：一键 PUT 到该 CLI 的 settings（深合并；模型名等）。
 * - toolchain / mcp / artifacts：**仅建议清单**——动 CR（env）/绑 MCP
 *   是团队级决策，preset 不自动执行（human_confirm 门）。
 */

import type { SettingsObject } from "./api";

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

/**
 * 空态结构化表单（15.30）：settings 文件不存在/为空（全新 CLI 常态）时，
 * 内容驱动的树编辑器无可渲染键 → 用户见「无结构化表单」。按 CLI 提供
 * 常用字段模板，空态自动预填成起点（可编辑，保存即创建文件）。
 *
 * 模板不含 `model`（模型专行独立管理，qwen-code=对象{name}，
 * opencode/qoder=扁平串）。secretPaths=模板里的密钥路径（渲染为密码框，
 * 保存时若仍为空则丢弃，不写空密钥）。
 *
 * 字段来源（coding-cli-management SKILL.md 实证，2026-10-11 Pi
 * node24 E2E）：qwen-code `~/.qwen/settings.json` 的 security.auth
 * （selectedType/apiKey/baseUrl）；opencode 全局 `~/.config/opencode/`
 * 对 `run --dir` 不生效（provider 需项目级）→ 模板留空靠 JSON 补丁；
 * qoder 鉴权走 QODER_PERSONAL_ACCESS_TOKEN env（非 settings）→ 模板留空。
 */
export interface CodingCliSeed {
  /** 空态模板（不含 model）。渲染为结构化表单起点。 */
  template: SettingsObject;
  /** 模板中的密钥路径（渲染为密码框 + 空值保存时丢弃）。 */
  secretPaths: string[];
}

export const CODING_CLI_SEEDS: Record<CodingCliId, CodingCliSeed> = {
  "qwen-code": {
    template: {
      security: {
        auth: { selectedType: "openai", apiKey: "", baseUrl: "" },
      },
    },
    secretPaths: ["security.auth.apiKey"],
  },
  opencode: { template: {}, secretPaths: [] },
  qoder: { template: {}, secretPaths: [] },
};

/**
 * 每 CLI 已知坑告警（tr 源文本=zh，组件 tr() 包裹，i18n 注册 en 键）。
 * 空态/常态都显示（选中 CLI 时）——把「配置写了但不生效」的坑前置。
 */
export const CODING_CLI_WARNINGS: Record<CodingCliId, string> = {
  "qwen-code":
    "Qwen Code 0.25.1 已知行为：settings 的 model 可能仍请求默认模型（qwen3.7-max），自定义网关无此模型时报 403——headless 建议 per-run -m <model> 指定。",
  opencode:
    "OpenCode 1.19.0 只读项目级 <workspace>/.config/opencode/opencode.json；本面板写全局 ~/.config/opencode/，对 opencode run --dir 可能不生效——headless 的 provider 配置需放项目级。",
  qoder:
    "Qoder 鉴权走环境变量 QODER_PERSONAL_ACCESS_TOKEN（非 settings）；本表单管 model / tools / mcp。",
};

