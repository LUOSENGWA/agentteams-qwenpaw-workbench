// surface → 表单草稿纯逻辑（可 node 直测；不读 window、无 react/antd/
// 组件依赖；类型 type-only import，编译后无运行时耦合）。
//
// 键模型：surface 字段 key 为点号路径（如 "llm.model"），寻址嵌套配置
// 文档（ConfigState.values / PUT patch）。buildDraft 产出扁平草稿
//（点号 key → 值）；diffNested 折回嵌套 patch（只含变化叶子）。
// 敏感字段红线：sensitive: true 字段整体写入 —— 读回 "***" 进草稿为
// undefined 哨兵（永不回写）；diffNested 只在声明键上整体比较值，绝不
// 拆敏感对象下的子键（后端 422 拒绝）。

import type { RuntimeSurface, SurfaceField } from "../api/domains/memberConfig";

/** 点号键取嵌套文档值（段缺失 / 中途非对象 → undefined）。 */
function resolvePath(obj: Record<string, unknown>, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 深相等（原始值恒等；对象比键集 + 递归值；数组/对象类型不符 → 不等）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/** 点号键写入嵌套对象（中间段缺失或非对象时替换为空对象）。 */
function setNested(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** surface 声明 → 可编辑草稿：按声明 key 逐条从嵌套 values 取值，取不到
 * 用 default；sensitive 字段读回 "***" 掩码（或缺失且无 default）→
 * undefined 哨兵（永不回写）。 */
export function buildDraft(
  surface: RuntimeSurface,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  const v = values ?? {};
  for (const face of surface.faces) {
    for (const field of face.fields) {
      const current = resolvePath(v, field.key);
      const value = current !== undefined ? current : field.default;
      if (field.sensitive && (value === undefined || value === "***")) {
        draft[field.key] = undefined;
      } else {
        draft[field.key] = value;
      }
    }
  }
  return draft;
}

/** 草稿 → 嵌套 patch：只含变化叶子（深相等）；草稿中 undefined/缺失 =
 * 不改（敏感字段永不进 patch）；对象值（含敏感对象）整体写入，不按
 * 子键拆。 */
export function diffNested(
  draft: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const v = values ?? {};
  for (const [key, draftValue] of Object.entries(draft)) {
    if (draftValue === undefined) continue;
    if (deepEqual(draftValue, resolvePath(v, key))) continue;
    setNested(patch, key, draftValue);
  }
  return patch;
}

/** 敏感字段是否应视为「未改」（不许进 patch）：草稿值为掩码 "***"、
 * undefined 哨兵或空串。非敏感字段恒 false（"" 是它们的合法清空值）。 */
export function isSensitiveUnchanged(field: SurfaceField, draftValue: unknown): boolean {
  if (!field.sensitive) return false;
  return draftValue === "***" || draftValue === undefined || draftValue === "";
}

/** 值展示格式化：bool → 是/否；数组 → 逗号分隔；对象 → JSON；
 * null/undefined → "—"。 */
export function formatFieldValue(field: SurfaceField, value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (field.type === "bool") return value ? "是" : "否";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** rev 历史：去重后置顶、截断到 cap（默认 5）；返回新数组。
 * 空 rev 为无操作（原样返回）。 */
export function pushRev(stack: string[], rev: string, cap = 5): string[] {
  if (!rev) return stack;
  return [rev, ...stack.filter((r) => r !== rev)].slice(0, cap);
}

/** 全部 face 的声明 key（按声明顺序、去重）——供调用方校验未声明键。 */
export function flattenKeys(surface: RuntimeSurface): string[] {
  const keys: string[] = [];
  for (const face of surface.faces) {
    for (const field of face.fields) {
      if (!keys.includes(field.key)) keys.push(field.key);
    }
  }
  return keys;
}
