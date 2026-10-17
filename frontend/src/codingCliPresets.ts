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
export type PresetSettingsValue =
  | string
  | number
  | boolean
  | null
  | Redacted
  | Record<string, unknown>
  | unknown[];

export interface PresetSettingsObject {
  [key: string]: PresetSettingsValue;
}

export interface CodingCliPreset {
  id: string;
  name: Localized;
  description?: Localized;
  team_mapping?: {
    team: string;
    workers: string[];
    note?: Localized;
  };
  settings_patch: PresetSettingsObject;
  toolchain: {
    shared_volume?: string | null;
    install?: Localized;
    env?: Record<string, string>;
    human_confirm: boolean;
    note?: Localized | null;
  };
  mcp: {
    suggested: string[];
    human_confirm: boolean;
    note?: Localized | null;
  };
  artifacts?: { minio_path?: string; note?: string };
  arch_note?: Localized;
  discipline?: Localized;
}

export function localizedText(value: Localized | null | undefined): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value["zh-CN"] || value["en-US"] || "";
}

export function isRedacted(value: unknown): value is Redacted {
  return !!value && typeof value === "object" && (value as Redacted).redacted === true;
}

export const CODING_CLI_PRESETS: CodingCliPreset[] = [
  {
    id: "p-harmony",
    name: { "zh-CN": "鸿蒙 AI 开发", "en-US": "HarmonyOS AI Development" },
    description: {
      "zh-CN": "鸿蒙（ArkTS）原生开发 preset。",
      "en-US": "HarmonyOS (ArkTS) native development preset.",
    },
    team_mapping: {
      team: "sysdev",
      workers: ["harmony-dev"],
      note: {
        "zh-CN": "sysdev-team 下 harmony-dev worker；embedded+sysdev MCU 属第①层（工具链共享卷）",
        "en-US": "Under the sysdev-team harmony-dev worker; embedded+sysdev MCU is layer ① (shared-volume toolchain)",
      },
    },
    settings_patch: { model: { name: "qwen3.6-27b-fp8" } },
    toolchain: {
      shared_volume: "/mnt/agentteam/toolchains/harmony/",
      install: {
        "zh-CN": "CLT 26.0.0（内嵌 NEXT SDK+hdc）+ JDK 21 + Node 22.20+（engines 硬要求 + TLS 指纹代际）",
        "en-US": "CLT 26.0.0 (embedded NEXT SDK + hdc) + JDK 21 + Node 22.20+ (engines hard requirement + TLS fingerprint generation)",
      },
      env: {
        DEVECO_CLI_CLT_PATH: "<shared_volume>/clt",
        DEVECO_CLI_DATA_DIR: "<shared_volume>/data",
        JAVA_HOME: "<shared_volume>/jdk21",
        DEVECO_CLI_DISABLE_TELEMETRY: "1",
      },
      human_confirm: true,
      note: {
        "zh-CN": "工具链动 CR（env）= 团队级决策，preset 只生成建议清单，不自动执行",
        "en-US": "Toolchain changes touch the CR (env) = team-level decision; preset only generates the suggestion list, never auto-applies",
      },
    },
    mcp: {
      suggested: [
        "devecocli serve（官方 stdio MCP 主锚：ArkTS LSP check/hover/definition + clangd + 文档）",
        "devecocli-mcp（可选，capability_search）",
      ],
      human_confirm: true,
      note: "走现有 McpSelector 链手动绑定，零新接口",
    },
    discipline: {
      "zh-CN": "docs-first + check 零错 + 构建通过 = 硬验收门（注入 worker SOUL/skill）",
      "en-US": "docs-first + zero check errors + build pass = hard acceptance gate (injected into worker SOUL/skill)",
    },
    artifacts: {
      minio_path: "teams/<team>/artifacts/harmony/",
      note: "HAP 包 → MinIO → 工作台审批",
    },
  },
  {
    id: "p-web",
    name: { "zh-CN": "网站开发", "en-US": "Web Development" },
    description: {
      "zh-CN": "Web 前端/全栈开发 preset。Node 24.5+ 指纹代际 + 浏览器 MCP 验证闭环。",
      "en-US": "Web front-end/full-stack preset. Node 24.5+ (fingerprint generation) + browser MCP verification loop.",
    },
    team_mapping: {
      team: "sysdev",
      workers: ["web front-end / full-stack worker"],
      note: { "zh-CN": "sysdev web 前端/全栈 worker", "en-US": "sysdev web front-end / full-stack worker" },
    },
    settings_patch: { model: { name: "qwen3.6-27b-fp8" } },
    toolchain: {
      shared_volume: "/mnt/agentteam/toolchains/web/",
      install: {
        "zh-CN": "Node 24.5+（指纹代际；容器不 apt 系统包，走共享卷或 nvm-in-container）；pnpm/corepack 随场景",
        "en-US": "Node 24.5+ (fingerprint generation; no apt system packages in container — shared volume or nvm-in-container); pnpm/corepack per scenario",
      },
      env: {},
      human_confirm: true,
      note: {
        "zh-CN": "工具链动 CR（env）= 团队级决策，preset 只生成建议清单",
        "en-US": "Toolchain changes touch the CR (env) = team-level decision; preset only generates the suggestion list",
      },
    },
    mcp: {
      suggested: ["浏览器 MCP（playwright 类，UI 验证闭环）", "部署目标 MCP（视场景）"],
      human_confirm: true,
      note: "走现有 McpSelector 链手动绑定",
    },
    artifacts: {
      minio_path: "teams/<team>/artifacts/web/",
      note: "dist 包/静态站",
    },
  },
  {
    id: "p-android",
    name: { "zh-CN": "Android 开发", "en-US": "Android Development" },
    description: {
      "zh-CN": "Android 原生开发 preset。SDK cmdline-tools 共享卷 + 可选 adb 设备 MCP。",
      "en-US": "Android native development preset. SDK cmdline-tools on shared volume + optional adb device MCP.",
    },
    team_mapping: {
      team: "sysdev",
      workers: ["android-dev"],
      note: { "zh-CN": "sysdev 扩展", "en-US": "sysdev extension" },
    },
    settings_patch: { model: { name: "qwen3.6-27b-fp8" } },
    toolchain: {
      shared_volume: "/mnt/agentteam/toolchains/android/",
      install: {
        "zh-CN": "Android SDK cmdline-tools + JDK 17 → 共享卷（大件）",
        "en-US": "Android SDK cmdline-tools + JDK 17 → shared volume (large)",
      },
      env: { ANDROID_HOME: "<shared_volume>/android-sdk" },
      human_confirm: true,
      note: {
        "zh-CN": "工具链动 CR（env）= 团队级决策，preset 只生成建议清单",
        "en-US": "Toolchain changes touch the CR (env) = team-level decision; preset only generates the suggestion list",
      },
    },
    mcp: {
      suggested: ["SDK 文档库 MCP（API 文档检索）", "adb 设备 MCP（可选，真机/模拟器）"],
      human_confirm: true,
      note: "走现有 McpSelector 链手动绑定",
    },
    artifacts: {
      minio_path: "teams/<team>/artifacts/android/",
      note: "APK/AAB",
    },
  },
  {
    id: "p-ios",
    name: { "zh-CN": "iOS 开发", "en-US": "iOS Development" },
    description: {
      "zh-CN": "iOS 开发 preset（受限：签名/模拟器 macOS only）。Linux worker 侧只做代码+文档级验证，构建签名回 macOS 侧——与鸿蒙模拟器降级同构。",
      "en-US": "iOS preset (limited: signing/simulator macOS only). Linux workers do code+doc-level verification; build/signing returns to the macOS side — isomorphic to the HarmonyOS simulator downgrade.",
    },
    team_mapping: {
      team: "sysdev",
      workers: ["ios worker"],
      note: {
        "zh-CN": "sysdev 扩展（受限）",
        "en-US": "sysdev extension (limited)",
      },
    },
    settings_patch: { model: { name: "qwen3.6-27b-fp8" } },
    toolchain: {
      shared_volume: "/mnt/agentteam/toolchains/ios/",
      install: {
        "zh-CN": "Swift 文档库（离线）→ 共享卷；Linux 容器内无 Xcode，明确边界",
        "en-US": "Swift docs (offline) → shared volume; no Xcode inside Linux containers — boundary is explicit",
      },
      env: {},
      human_confirm: true,
      note: {
        "zh-CN": "边界写死不藏着：.ipa 构建/签名必须回 macOS 侧",
        "en-US": "Boundary is documented, not hidden: .ipa build/signing must return to the macOS side",
      },
    },
    mcp: {
      suggested: ["Apple 文档检索 MCP"],
      human_confirm: true,
      note: "走现有 McpSelector 链手动绑定",
    },
    artifacts: {
      minio_path: "teams/<team>/artifacts/ios/",
      note: "工程快照（.ipa 走 macOS 构建侧）",
    },
  },
  {
    id: "p-embedded",
    name: { "zh-CN": "MCU / Embedded", "en-US": "MCU / Embedded" },
    description: {
      "zh-CN": "MCU/embedded 开发 preset（embedded team 现成）。arm64 容器注意 ripgrep 自动降级（见 arch_note）。",
      "en-US": "MCU/embedded preset (embedded team, existing). arm64 containers: note the automatic ripgrep downgrade (see arch_note).",
    },
    team_mapping: {
      team: "embedded",
      workers: ["mcu worker"],
      note: {
        "zh-CN": "embedded team（现成）；MCU 场景 = 第①层（工具链共享卷）；Pi 弱端验证环境",
        "en-US": "embedded team (existing); MCU scenario = layer ① (shared-volume toolchain); Pi as weak-end verification env",
      },
    },
    settings_patch: { model: { name: "qwen3.6-27b-fp8" } },
    arch_note: {
      "zh-CN": "arm64 16K 页系统（如 Pi）：qwen-code 0.25.0 的 bundled ripgrep 崩溃后自动优雅降级 built-in grep，无需配置字段（10/8 Pi 实测；上游 issue 稿已备）。若未来需手动钉死内置搜索，正确字段是 tools.useRipgrep:false（= built-in grep）——不是 tools.useBuiltinRipgrep（那只切 bundled rg → 系统级 rg，且仅 useRipgrep=true 时生效）。",
      "en-US": "arm64 16K-page systems (e.g. Pi): qwen-code 0.25.0's bundled ripgrep crash auto-downgrades gracefully to built-in grep — no config field required (verified on Pi 10/08; upstream issue draft ready). If a manual pin to built-in search is ever needed, the correct field is tools.useRipgrep:false (= built-in grep) — NOT tools.useBuiltinRipgrep (which only switches bundled rg → system-level rg, and only when useRipgrep=true).",
    },
    toolchain: {
      shared_volume: "/mnt/agentteam/toolchains/embedded/",
      install: {
        "zh-CN": "arm-none-eabi-gcc / ESP-IDF / Zephyr 按 MCU 平台 → 共享卷",
        "en-US": "arm-none-eabi-gcc / ESP-IDF / Zephyr per MCU platform → shared volume",
      },
      env: {},
      human_confirm: true,
      note: {
        "zh-CN": "工具链动 CR（env）= 团队级决策，preset 只生成建议清单",
        "en-US": "Toolchain changes touch the CR (env) = team-level decision; preset only generates the suggestion list",
      },
    },
    mcp: {
      suggested: ["平台文档库 MCP", "串口/烧录 MCP（可选）"],
      human_confirm: true,
      note: "走现有 McpSelector 链手动绑定",
    },
    artifacts: {
      minio_path: "teams/<team>/artifacts/embedded/",
      note: ".bin/.elf",
    },
  },
  {
    id: "p-gencode",
    name: { "zh-CN": "通用 Coding（最小形态）", "en-US": "General Coding (minimal)" },
    description: {
      "zh-CN": "最小 preset：仅 auth+model（= 安装后默认态，preset 不额外写 settings）。用作状态卡「当前 preset = None」的显式回退。",
      "en-US": "Minimal preset: auth+model only (= post-install default; preset writes no extra settings). Serves as the explicit fallback shown as 'current preset = None'.",
    },
    team_mapping: {
      team: "any",
      workers: ["any worker"],
      note: { "zh-CN": "任意 team 任意 worker", "en-US": "any team, any worker" },
    },
    settings_patch: {},
    toolchain: {
      shared_volume: null,
      install: { "zh-CN": "无", "en-US": "none" },
      env: {},
      human_confirm: false,
      note: null,
    },
    mcp: {
      suggested: [],
      human_confirm: false,
      note: null,
    },
    artifacts: {
      minio_path: "teams/<team>/artifacts/gencode/",
      note: "任意代码产物",
    },
  },
];
