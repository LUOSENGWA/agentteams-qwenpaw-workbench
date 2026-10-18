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
 * 空态结构化表单（15.30 初版；15.31 按官方 schema 全量补齐）：
 * settings 文件不存在/为空（全新 CLI 常态）时，内容驱动的树编辑器
 * 无可渲染键 → 用户见「无结构化表单」。按 CLI 提供常用字段模板，
 * 空态自动预填成起点（可编辑，保存即创建文件）。
 *
 * 模板含 `model` 的**子字段**（name 由模型专行管理，树内跳过）：
 * qwen-code 的 model 是对象 {name, reasoningEffort, ...}，opencode
 * 的 model 是扁平串（树内整体不渲染，专行管）。
 *
 * secretPaths=模板里的密钥路径（渲染为密码框，保存时若仍为空则丢弃，
 * 不写空密钥）。**15.31**：qwen-code 凭据已从 security.auth.apiKey
 * （Deprecated）迁到 modelProviders[].envKey + 顶层 env 块（官方
 * Model Providers 文档定案）→ 模板不再预填密钥字段；env 块用 JSON
 * 补丁写（{"env":{"OPENAI_API_KEY":"sk-..."}}）或容器 ~/.qwen/.env。
 *
 * 字段来源（官方 schema 实证，2026-10-18）：
 * - qwen-code：qwenlm.github.io/qwen-code-docs settings + model-providers
 *   两页全量字段表（0.25.x「New Configuration Format」）。
 * - opencode：opencode.ai/docs/config（opencode.json；全局
 *   ~/.config/opencode/ 对 run --dir 不生效——provider 需项目级）。
 * - qoder：docs.qoder.com/cli/settings（qwen-code 同源三层配置；BYOK
 *   走 /model 向导写回 settings，不手工配）。
 * 未预填的高级字段一律走 JSON 补丁（patchPlaceholder 给示例）。
 */
export interface CodingCliSeed {
  /** 空态模板。渲染为结构化表单起点。 */
  template: SettingsObject;
  /** 模板中的密钥路径（渲染为密码框 + 空值保存时丢弃）。 */
  secretPaths: string[];
  /** JSON 补丁占位示例（每 CLI 最高频的补丁需求）。 */
  patchPlaceholder: string;
}

export const CODING_CLI_SEEDS: Record<CodingCliId, CodingCliSeed> = {
  "qwen-code": {
    template: {
      // model.name 由模型专行管（树内跳过）；其余子字段预填。
      model: {
        reasoningEffort: "",
        maxToolCalls: -1,
        generationConfig: {
          timeout: 120000,
        },
      },
      fastModel: "",
      modelProviders: {
        openai: [
          {
            id: "",
            name: "",
            envKey: "OPENAI_API_KEY",
            baseUrl: "",
          },
        ],
      },
      tools: {
        approvalMode: "auto",
        shell: {
          defaultTimeoutMs: 120000,
        },
      },
      permissions: {
        allow: [] as string[],
        ask: [] as string[],
        deny: [] as string[],
      },
      context: {
        fileName: "",
        autoCompactThreshold: 0.85,
      },
      mcp: {
        allowed: [] as string[],
        excluded: [] as string[],
      },
      mcpServers: {},
      security: {
        folderTrust: {
          enabled: false,
        },
        auth: {
          selectedType: "openai",
        },
      },
      telemetry: {
        enabled: false,
      },
      general: {
        language: "",
        enableAutoUpdate: false,
      },
      ui: {
        theme: "Qwen Dark",
      },
    },
    secretPaths: [],
    patchPlaceholder:
      '{"env": {"OPENAI_API_KEY": "sk-..."}, "model": {"generationConfig": {"contextWindowSize": 131072}}}',
  },
  opencode: {
    template: {
      $schema: "https://opencode.ai/config.json",
      small_model: "",
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "allow",
      },
      tools: {},
      mcp: {},
    },
    secretPaths: [],
    patchPlaceholder:
      '{"provider": {"local": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "http://host:30000/v1", "apiKey": "not-needed"}}}}',
  },
  qoder: {
    template: {
      outputStyle: "",
      language: "",
      ui: {
        theme: "",
        autoThemeSwitching: true,
        maxTurns: 1000,
      },
      tools: {
        useRipgrep: true,
        shell: {
          inactivityTimeout: 300,
        },
      },
      security: {
        folderTrust: {
          enabled: true,
        },
        disableYoloMode: false,
      },
      mcp: {
        allowed: [] as string[],
        excluded: [] as string[],
      },
      mcpServers: {},
    },
    secretPaths: [],
    patchPlaceholder:
      '{"mcpServers": {"demo": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"]}}}',
  },
};

/**
 * 每 CLI 已知坑告警（tr 源文本=zh，组件 tr() 包裹，i18n 注册 en 键）。
 * 空态/常态都显示（选中 CLI 时）——把「配置写了但不生效」的坑前置。
 */
export const CODING_CLI_WARNINGS: Record<CodingCliId, string> = {
  "qwen-code":
    "Qwen Code 0.25.x 已知行为：settings 的 model 可能仍请求默认模型（qwen3.7-max），自定义网关无此模型时报 403——headless 建议 per-run -m <model> 指定。API Key 请写 env 块（JSON 补丁）或 ~/.qwen/.env，不要写已废弃的 security.auth.apiKey。",
  opencode:
    "OpenCode 1.19.x 只读项目级 <workspace>/.config/opencode/opencode.json；本面板写全局 ~/.config/opencode/，对 opencode run --dir 可能不生效——provider 配置需放项目级。",
  qoder:
    "Qoder 账号登录走 QODER_PERSONAL_ACCESS_TOKEN env（非 settings）；BYOK 自定义模型走 /model 向导。本表单管 model / tools / mcp / permissions。",
};

/**
 * 15.31：qwen-code 废弃字段检测——base 里出现非空的
 * security.auth.apiKey / baseUrl（旧格式残留，官方标 Deprecated）→
 * 面板告警提示迁移到 modelProviders + env。
 */
export function qwenDeprecatedAuthFields(
  settings: SettingsObject | null | undefined,
): string[] {
  if (!settings) return [];
  const auth = (settings.security as SettingsObject | undefined)?.auth as
    | SettingsObject
    | undefined;
  if (!auth || typeof auth !== "object") return [];
  const hit: string[] = [];
  for (const k of ["apiKey", "baseUrl"]) {
    const v = auth[k];
    if (typeof v === "string" && v !== "") hit.push(`security.auth.${k}`);
    else if (v && typeof v === "object" && (v as { redacted?: boolean }).redacted)
      hit.push(`security.auth.${k}`);
  }
  return hit;
}

