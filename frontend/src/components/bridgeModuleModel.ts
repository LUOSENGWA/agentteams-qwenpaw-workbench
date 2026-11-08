/**
 * bridgeModuleModel.ts — 「QwenPaw × QwenCode 桥」安装/更新的纯逻辑模型
 * （无 React、不访问 window/宿主，node/vitest 可直测）。
 *
 * 交互口径（2026-11-08 模块更新卡设计，本栏沿用同一交互）：
 * 不要每个版本一个按钮 —— 状态标签（未装 / 可更新 / 已是最新 / 该频道
 * 无更新 / 该频道暂无版本）+ 版本下拉（当前版本、缺制品版本 disabled）+
 * 单个安装/更新按钮。
 *
 * 数据源：
 * - 索引：千锻发布索引 modules["qwenpaw-qwencode-bridge"]（频道由 UI
 *   选择 stable/beta/alpha，默认 stable）；
 * - 已装态：Worker 插件列表里 pluginId "qwen-code-bridge" 的版本。
 * 注意：模块键 ≠ pluginId（安装 body 用模块键，已装对账用 pluginId）。
 */
import {
  DEFAULT_MODULE_REPO,
  compareModuleVersions,
  moduleEntryVersions,
} from "../api/domains/modules";
import type {
  IndexModuleEntry,
  IndexVersionEntry,
  ModuleIndexResponse,
  ModulePluginEntry,
  ModuleSource,
  ModuleChannel,
  PluginInstallBody,
} from "../api/domains/modules";

/** 索引模块键（安装 body 的 module 字段）。 */
export const BRIDGE_MODULE_KEY = "qwenpaw-qwencode-bridge";
/** 安装后的 QwenPaw 插件 id（已装列表对账用）。 */
export const BRIDGE_PLUGIN_ID = "qwen-code-bridge";

/** 频道集（桥栏内可切换；默认 stable）。 */
export const BRIDGE_CHANNELS: ModuleChannel[] = ["stable", "beta", "alpha"];
export const BRIDGE_DEFAULT_CHANNEL: ModuleChannel = "stable";

/** 本栏固定查询参数（源/ref 固定；频道由用户选择）。 */
export const BRIDGE_SOURCE: ModuleSource = "github";
export const BRIDGE_REF = "main";

/** 桥栏安装状态（ahead = 已装版本高于索引最新，如预装/降级索引）。 */
export type BridgeState =
  | "not-installed"
  | "update-available"
  | "up-to-date"
  | "ahead"
  | "no-versions";

/** 版本下拉选项（禁用原因直接给标记，UI 侧拼文案）。 */
export interface BridgeOption {
  version: string;
  /** 已装版本（标「当前」并 disabled）。 */
  current: boolean;
  /** 缺 artifact/sha256 等不可安装项（标「不可用」并 disabled）。 */
  disabled: boolean;
  /** 默认选中项（最新可安装且非当前）。 */
  defaultSelected: boolean;
}

/** 版本方向：首装 / 升级 / 降级 / 与已装相同。 */
export type BridgeDirection = "install" | "update" | "downgrade" | "current";

/** 索引里找桥模块（模块键优先；兼容按 pluginId 匹配的条目）。 */
export function pickBridgeModule(
  index: ModuleIndexResponse | null | undefined,
): IndexModuleEntry | null {
  const modules = index?.modules ?? [];
  return (
    modules.find((m) => m.module === BRIDGE_MODULE_KEY) ??
    modules.find(
      (m) =>
        m.pluginId === BRIDGE_PLUGIN_ID || m.name === BRIDGE_MODULE_KEY,
    ) ??
    null
  );
}

/** 可安装 = 制品与校验字段齐全（缺一即 400/索引不完整）。 */
export function bridgeInstallable(v: IndexVersionEntry): boolean {
  return !!v.artifact && !!v.sha256;
}

/** 版本列表：宽容解析 → 去弃用 → 新版本在前。 */
export function bridgeVersions(
  entry: IndexModuleEntry | null | undefined,
): IndexVersionEntry[] {
  return moduleEntryVersions(entry)
    .filter((v) => v.deprecated !== true)
    .sort((a, b) => compareModuleVersions(b.version, a.version));
}

/** 最新可安装版本号（无 = null）。 */
export function bridgeLatest(versions: IndexVersionEntry[]): string | null {
  return versions.find(bridgeInstallable)?.version ?? null;
}

/**
 * 状态判定（新模块更新卡口径）：
 * - 无任何可安装版本 / 索引 latest === null → no-versions；
 * - 未装 → not-installed；latest > 已装 → update-available；
 * - latest == 已装 → up-to-date；latest < 已装 → ahead。
 */
export function bridgeState({
  installedVersion,
  versions,
  latest,
}: {
  installedVersion?: string | null;
  versions: IndexVersionEntry[];
  /** 索引条目的 latest 字段（null = 该通道暂无版本）。 */
  latest?: string | null;
}): BridgeState {
  if (latest === null || bridgeLatest(versions) === null) return "no-versions";
  const installed = (installedVersion || "").trim();
  if (!installed) return "not-installed";
  const top = bridgeLatest(versions) as string;
  const cmp = compareModuleVersions(top, installed);
  if (cmp > 0) return "update-available";
  if (cmp === 0) return "up-to-date";
  return "ahead";
}

/**
 * 版本下拉选项：新版本在前；已装版本标「当前」并 disabled（只列 ≥ 已装，
 * 避免把降级按钮堆到本栏）；缺制品/sha256 标「不可用」并 disabled；
 * 首项可安装且非当前者 = 默认选中。
 */
export function bridgeOptions(
  versions: IndexVersionEntry[],
  installedVersion?: string | null,
): BridgeOption[] {
  const installed = (installedVersion || "").trim();
  const out: BridgeOption[] = [];
  for (const v of versions) {
    const cmp = installed
      ? compareModuleVersions(v.version, installed)
      : 1;
    if (installed && cmp < 0) continue;
    if (installed && cmp === 0) {
      out.push({
        version: v.version,
        current: true,
        disabled: true,
        defaultSelected: false,
      });
      continue;
    }
    out.push({
      version: v.version,
      current: false,
      disabled: !bridgeInstallable(v),
      defaultSelected: false,
    });
  }
  const first = out.find((o) => !o.disabled && !o.current);
  if (first) first.defaultSelected = true;
  return out;
}

/** 选中版本相对已装版本的方向（决定按钮文案）。 */
export function bridgeDirection(
  version: string,
  installedVersion?: string | null,
): BridgeDirection {
  const installed = (installedVersion || "").trim();
  if (!installed) return "install";
  const cmp = compareModuleVersions(version, installed);
  if (cmp > 0) return "update";
  if (cmp < 0) return "downgrade";
  return "current";
}

/** 该状态是否需要安装/更新动作（up-to-date / ahead / no-versions 不出按钮）。 */
export function bridgeHasAction(state: BridgeState): boolean {
  return state === "not-installed" || state === "update-available";
}

/** 已装插件匹配（pluginId 为准；模块键/显示名兜底，容忍老列表形态）。 */
export function matchBridgePlugin(
  plugins: ModulePluginEntry[] | null | undefined,
): ModulePluginEntry | null {
  return (
    (plugins ?? []).find(
      (p) =>
        p?.id === BRIDGE_PLUGIN_ID ||
        p?.name === BRIDGE_PLUGIN_ID ||
        p?.id === BRIDGE_MODULE_KEY ||
        p?.name === BRIDGE_MODULE_KEY,
    ) ?? null
  );
}

/** 已装桥插件版本（无 = null）。 */
export function bridgeInstalledVersion(
  plugins: ModulePluginEntry[] | null | undefined,
): string | null {
  return matchBridgePlugin(plugins)?.version ?? null;
}

/** 频道显示名（Select label；三频道同名直出，集中一处防文案漂移）。 */
export function bridgeChannelLabel(channel: ModuleChannel): string {
  return channel === "beta" ? "beta" : channel === "alpha" ? "alpha" : "stable";
}

/** 安装 body（module 用模块键——契约要求；已装对账才用 pluginId；
 * channel = 当前选择频道）。 */
export function bridgeInstallBody(
  version: IndexVersionEntry,
  repo: string = DEFAULT_MODULE_REPO,
  channel: ModuleChannel = BRIDGE_DEFAULT_CHANNEL,
): PluginInstallBody {
  return {
    module: BRIDGE_MODULE_KEY,
    source: BRIDGE_SOURCE,
    repo: repo.trim() || DEFAULT_MODULE_REPO,
    ref: BRIDGE_REF,
    channel,
    version: version.version,
    artifact: version.artifact ?? "",
    sha256: version.sha256 ?? "",
  };
}
