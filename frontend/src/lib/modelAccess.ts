/**
 * modelAccess.ts — Model Access（#1513）展示纯函数（node 可直测，无 React/window 依赖）。
 *
 * 语义（#1513 照抄）：
 * - 授权轴只有 role + coding CLI（无 team / 无 per-worker 列表）；
 * - (provider, model) 是**成对**的；目录方向 = provider → models，不反向映射；
 * - inherit 是授权：spawn 空 → 继承主模型；CLI 空 → 继承 worker 的 spawn 模型
 *   （spawn 空再回落主模型）；继承中的 surface 只读；
 * - 缺 modelAccess → fail-closed（locked: true，controller 侧置位，本模块 lockedAll 消费）。
 *
 * 本模块只 `import type`（运行时零依赖）——node --experimental-strip-types
 * 可直测（与 lib/codingCliModel 同口径）。
 */

import type {
  ModelAccessCapability,
  ModelAccessPair,
  ModelAccessPayload,
  ModelAccessSurfaces,
} from "../api/domains/modelAccess";

/** 授权 surface 键。 */
export type SurfaceKey = "main" | "spawn" | "codingCli";

/** 徽标五态（文案/颜色映射在渲染层）。 */
export type SurfaceBadge =
  | { kind: "editable" }
  | { kind: "inherited"; from: string }
  | { kind: "readonly" }
  | { kind: "not_granted" }
  | { kind: "byok" };

/**
 * surface 授权 → 徽标五态。判定序：
 * ① canEdit && !inherit → editable
 * ② status = cli_not_granted / byok_unsupported → not_granted / byok
 * ③ inherit → inherited（带来源）
 * ④ 兜底 → readonly
 * ② 置于 ④ 兜底之前：cli_not_granted / byok_unsupported 是比「只读」更
 * 具体的原因——若 readonly 兜底先行，canEdit=false 的 CLI surface 会先落
 * readonly，后两态永远不可达（五态不可全覆盖）。
 */
export function surfaceBadge(
  cap: ModelAccessCapability | null | undefined,
): SurfaceBadge {
  if (!cap || typeof cap !== "object") return { kind: "readonly" };
  if (cap.canEdit && !cap.inherit) return { kind: "editable" };
  if (cap.status === "cli_not_granted") return { kind: "not_granted" };
  if (cap.status === "byok_unsupported") return { kind: "byok" };
  if (cap.inherit) return { kind: "inherited", from: cap.inheritedFrom ?? "" };
  return { kind: "readonly" };
}

/**
 * 取指定 surface 的授予 (provider, model) 对（方向 = provider → models，
 * 不反向映射；codingCli 需带 cli 名）。无 entries / 形状非法 → []。
 * 空数组语义 =「无授予集」：调用方按无限制处理（兼容旧控制器 / 未配授予）。
 */
export function grantedPairs(
  surfaces: ModelAccessSurfaces | null | undefined,
  surface: SurfaceKey,
  cli?: string,
): ModelAccessPair[] {
  if (!surfaces || typeof surfaces !== "object") return [];
  let entry: unknown;
  if (surface === "codingCli") {
    if (!cli) return [];
    entry = surfaces.codingCli?.[cli]?.entries;
  } else if (surface === "spawn") {
    entry = surfaces.spawn?.entries;
  } else {
    entry = surfaces.main?.entries;
  }
  if (!Array.isArray(entry)) return [];
  const out: ModelAccessPair[] = [];
  for (const it of entry) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.provider === "string" && typeof o.model === "string") {
      out.push({ provider: o.provider, model: o.model });
    }
  }
  return out;
}

/**
 * (provider, model) 是否被允许：
 * pairs 空 → true（无限制，兼容旧控制器 / 无授予集）；
 * 否则必须**成对**存在（provider 与 model 不能各取各的）。
 */
export function pairAllowed(
  pairs: ModelAccessPair[],
  provider: string,
  model: string,
): boolean {
  if (!pairs || pairs.length === 0) return true;
  return pairs.some((p) => p.provider === provider && p.model === model);
}

/** fail-closed：locked === true → 整个弹窗只读（缺 modelAccess → controller 置 locked true）。 */
export function lockedAll(
  access: ModelAccessPayload | null | undefined,
): boolean {
  return access?.locked === true;
}
