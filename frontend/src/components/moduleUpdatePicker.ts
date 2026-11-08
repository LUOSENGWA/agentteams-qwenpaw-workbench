/**
 * 模块更新·版本选择纯逻辑（不依赖 React / window，node 可直测）。
 *
 * 背景（2026-11-08 实机截图）：旧实现把索引里每个版本渲染成一个按钮——
 *「更新到 0.1.1-alpha.1」「更新到 0.1.1-alpha.2」并排，版本一多按钮就爆炸，
 * 且没有「可更新」状态提示。现改为：状态标签（未装 / 可更新 / 已是最新 /
 * 版本不一致）+ 单个版本下拉 + 单个动作按钮。
 *
 * 状态判定与可选版本集合全部收在此处，组件只负责渲染。
 */
import { compareModuleVersions } from "../api/domains/modules";
import type { IndexVersionEntry } from "../api/domains/modules";

/** 卡片状态（决定标签、下拉可见性与按钮文案）。 */
export type ModuleUpdateState =
  | "not-installed"
  | "update-available"
  | "up-to-date"
  | "inconsistent"
  | "not-installable"
  | "no-versions";

/** 下拉可选版本集合：newer = 只列比当前新的版本（已装且有更新时）。 */
export type VersionOptionMode = "all" | "newer";

/** 安装方向（与 InstallTarget.direction 同义）。 */
export type InstallDirection = "install" | "update" | "downgrade";

export interface VersionOption {
  /** 版本号（Select value / onStart({version})）。 */
  value: string;
  /** 展示文本（版本号本身；「当前 / 不可用」后缀由组件按 i18n 拼）。 */
  label: string;
  disabled: boolean;
  /** 禁用原因：current = 已装版本；unavailable = 缺 artifact 或 sha256。 */
  reason: "current" | "unavailable" | null;
}

/** 版本条目是否可安装（安装 payload 必填 artifact + sha256）。 */
function isAvailable(v: IndexVersionEntry): boolean {
  return !!v.artifact && !!v.sha256;
}

/**
 * 版本下拉选项：过滤 → 版本降序 → 标 disabled。
 * - mode="newer"（已装且有更新）：只保留比 currentVersion 新的版本；
 * - 当前已装版本与缺 artifact/sha256 的版本不可选（各自标 reason）；
 * - 无 currentVersion 时不存在「当前」。
 */
export function buildVersionOptions(
  versions: IndexVersionEntry[] | null | undefined,
  currentVersion: string | null,
  mode: VersionOptionMode = "all",
): VersionOption[] {
  const list = (versions ?? []).filter(
    (v): v is IndexVersionEntry => !!v && typeof v.version === "string" && !!v.version,
  );
  const scoped =
    mode === "newer" && currentVersion
      ? list.filter((v) => compareModuleVersions(v.version, currentVersion) > 0)
      : list;
  return scoped
    .slice()
    .sort((a, b) => compareModuleVersions(b.version, a.version))
    .map((v) => {
      const isCurrent =
        !!currentVersion && compareModuleVersions(v.version, currentVersion) === 0;
      const available = isAvailable(v);
      return {
        value: v.version,
        label: v.version,
        disabled: isCurrent || !available,
        reason: isCurrent ? "current" : available ? null : "unavailable",
      };
    });
}

/** 默认选中版本 = 最新可安装且非当前（选项已降序）→ 无则 null。 */
export function pickDefaultVersion(options: VersionOption[]): string | null {
  const first = (options ?? []).find((o) => !o.disabled);
  return first ? first.value : null;
}

/** 卡片状态判定。
 *
 * 顺序：不可安装 → 无版本 → 已装（有/无更新）→ 已装但版本不可判定
 *（团队不一致）→ 未装。
 * 注意「可更新」要求存在**可安装**的新版本（缺 artifact 的更高版本不算
 * 可更新——否则标签说可更新、下拉却无一项可选）。
 */
export function moduleUpdateState(input: {
  versions: IndexVersionEntry[] | null | undefined;
  currentVersion: string | null;
  /** 有已装迹象（plugin 命中 / 团队成员装载记录）。 */
  hasInstalled?: boolean;
  /** 团队面一致徽标；null/undefined = 无该信息（manager/worker 面）。 */
  consistent?: boolean | null;
  /** 索引条目是否可安装（runner = false）。 */
  installable?: boolean;
}): ModuleUpdateState {
  const {
    versions,
    currentVersion,
    hasInstalled = false,
    consistent = null,
    installable = true,
  } = input;
  const list = versions ?? [];
  if (!installable) return "not-installable";
  if (list.length === 0) return "no-versions";
  if (currentVersion) {
    const hasUpdatable = list.some(
      (v) =>
        compareModuleVersions(v.version, currentVersion) > 0 && isAvailable(v),
    );
    return hasUpdatable ? "update-available" : "up-to-date";
  }
  if (hasInstalled || consistent === false) return "inconsistent";
  return "not-installed";
}

/** 安装方向：未装 → install；低于当前 → downgrade；其余（含同版本）→ update。 */
export function directionFor(
  version: string,
  currentVersion: string | null,
): InstallDirection {
  if (!currentVersion) return "install";
  return compareModuleVersions(version, currentVersion) < 0 ? "downgrade" : "update";
}

/** 下拉选择 → onStart 载荷（version/entry/direction/currentVersion）。 */
export function selectionFor(
  versions: IndexVersionEntry[] | null | undefined,
  currentVersion: string | null,
  picked: string | null,
): {
  version: string;
  entry: IndexVersionEntry;
  direction: InstallDirection;
  currentVersion: string | null;
} | null {
  if (!picked) return null;
  const entry = (versions ?? []).find((v) => v.version === picked);
  if (!entry) return null;
  return {
    version: picked,
    entry,
    direction: directionFor(picked, currentVersion),
    currentVersion,
  };
}
