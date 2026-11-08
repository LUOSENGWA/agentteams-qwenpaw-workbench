// surface → 表单草稿纯逻辑（可 node 直测；不读 window、无 react/antd/
// 组件依赖；类型 type-only import，编译后无运行时耦合）。
//
// 键模型：surface 字段 key 为点号路径（如 "llm.model"），寻址嵌套配置
// 文档（ConfigState.values / PUT patch）。buildDraft 产出扁平草稿
//（点号 key → 值）；diffNested 折回嵌套 patch（只含变化叶子）。
// 通配键（#1493）：`*` 段恰好匹配一个非空段。单星模板按条目展开
//（expandEntries / concreteKey，草稿键是 concrete 键）；双星模板
//（如 models.providers.*.models.*.id）v1 只读（isReadOnlyField）——
// 不进草稿、不可编辑。normalizeSurface 归一旧 type 别名（re-export
// 自 api/domains/memberConfig）。
// 敏感字段红线：sensitive: true 字段整体写入 —— 读回 "***" 进草稿为
// undefined 哨兵（永不回写）；diffNested 只在声明键上整体比较值，绝不
// 拆敏感对象下的子键（后端 422 拒绝）。

import type { RuntimeSurface, SurfaceField, SurfaceFieldType } from "../api/domains/memberConfig";

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

/** 键中恰好等于 `*` 的段数（`a*b` 这类非纯通配段不计）。 */
function countStarSegments(key: string): number {
  let n = 0;
  for (const p of key.split(".")) if (p === "*") n += 1;
  return n;
}

/** v1 只读判定：双星（key 含 ≥2 个 `*` 段，如
 * models.providers.*.models.*.id）→ true。导出供 UI 用。 */
export function isReadOnlyField(field: SurfaceField): boolean {
  return countStarSegments(field.key) >= 2;
}

/** 单星模板 → values 中该通配段的对象键名列表（裁定：该段值是对象才计，
 * 标量/数组/null 不计）；去重、保持键序；父路径缺失/中途非对象 → []。
 * 双星与非通配模板 → []（仅单星可展开）。 */
export function expandEntries(template: string, values: Record<string, unknown>): string[] {
  const parts = template.split(".");
  const starIdx = parts.indexOf("*");
  if (starIdx === -1 || countStarSegments(template) !== 1) return [];
  let cur: unknown = values ?? {};
  for (let i = 0; i < starIdx; i += 1) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return [];
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) return [];
  const entries: string[] = [];
  for (const k of Object.keys(cur as Record<string, unknown>)) {
    const v = (cur as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && !entries.includes(k)) entries.push(k);
  }
  return entries;
}

/** 单星模板 + 条目名 → concrete 点号键（替换 `*` 段）。 */
export function concreteKey(template: string, entry: string): string {
  const parts = template.split(".");
  const starIdx = parts.indexOf("*");
  if (starIdx === -1) return template;
  parts[starIdx] = entry;
  return parts.join(".");
}

/** surface 声明 → 可编辑草稿：按声明 key 逐条从嵌套 values 取值，取不到
 * 用 default；sensitive 字段读回 "***" 掩码（或缺失且无 default）→
 * undefined 哨兵（永不回写）。单星通配字段按条目展开为 concrete 键
 *（每个 entry 一条，掩码规则同上）；双星字段 v1 只读，不进草稿。 */
export function buildDraft(
  surface: RuntimeSurface,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  const v = values ?? {};
  for (const face of surface.faces) {
    for (const field of face.fields) {
      if (isReadOnlyField(field)) continue;
      const starIdx = field.key.split(".").indexOf("*");
      const keys =
        starIdx === -1
          ? [field.key]
          : expandEntries(field.key, v).map((e) => concreteKey(field.key, e));
      for (const key of keys) {
        const current = resolvePath(v, key);
        const value = current !== undefined ? current : field.default;
        if (field.sensitive && (value === undefined || value === "***")) {
          draft[key] = undefined;
        } else {
          draft[key] = value;
        }
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
    // 防御：草稿键不应含 `*` 段（通配模板不进草稿）；出现则跳过。
    if (countStarSegments(key) > 0) continue;
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

/** 值展示格式化：boolean/bool → 是/否；secret → 非空值掩码 "••••"
 *（不显明文）；数组 → 逗号分隔；对象 → JSON；null/undefined → "—"。 */
export function formatFieldValue(field: SurfaceField, value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (field.type === "boolean" || field.type === "bool") return value ? "是" : "否";
  if (field.type === "secret") return value === "" ? "" : "••••";
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

/** #1493 合并后契约归一：旧 type 别名 → 真实契约成员
 *（int|float→number、bool→boolean、string-list→array、
 * type "enum"→"string" 且保留 enum 属性）。纯函数：不 mutate 入参，
 * 幂等。定义在此（node 直测；api/domains/memberConfig re-export）。 */
export function normalizeSurface(surface: RuntimeSurface): RuntimeSurface {
  const norm = (t: SurfaceFieldType): SurfaceFieldType => {
    switch (t) {
      case "int":
      case "float":
        return "number";
      case "bool":
        return "boolean";
      case "string-list":
        return "array";
      case "enum":
        return "string";
      default:
        return t;
    }
  };
  return {
    ...surface,
    faces: surface.faces.map((face) => ({
      ...face,
      fields: face.fields.map((f) => ({ ...f, type: norm(f.type) })),
    })),
  };
}

// ── O2：面板过滤 + 通配条目展示（纯函数，node 直测）────────────────

/** 模板段匹配：concrete 键与模板段数相同且所有非 `*` 段相等
 *（非通配模板退化为精确相等）。 */
export function keyMatchesTemplate(concrete: string, template: string): boolean {
  const segs = concrete.split(".");
  const parts = template.split(".");
  if (segs.length !== parts.length) return false;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === "*") continue;
    if (segs[i] !== parts[i]) return false;
  }
  return true;
}

/** 字段过滤（面板「搜索 + 仅看已修改」）：query 对 key/label 做
 * 不区分大小写子串匹配（空串 = 全过）；changedKeys 空集 = 不做修改过滤，
 * 否则字段自身 key（非通配）或其模板（单星）匹配到的任一 concrete 键
 * 命中 changedKeys 才保留。 */
export function filterFields(
  fields: SurfaceField[],
  query: string,
  changedKeys: ReadonlySet<string>,
): SurfaceField[] {
  const q = query.trim().toLowerCase();
  const out: SurfaceField[] = [];
  for (const f of fields) {
    if (q && !`${f.key} ${f.label ?? ""}`.toLowerCase().includes(q)) continue;
    if (changedKeys.size > 0) {
      let hit = false;
      for (const ck of changedKeys) {
        if (keyMatchesTemplate(ck, f.key)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
    }
    out.push(f);
  }
  return out;
}

/** 草稿修改键集合：草稿键值非 undefined 且与 values 同键解析值深不相等
 * → 已修改（通配草稿键本就是 concrete 键；敏感字段 undefined 哨兵
 * 恒不算修改）。 */
export function changedKeys(
  draft: Record<string, unknown>,
  values: Record<string, unknown>,
): Set<string> {
  const v = values ?? {};
  const out = new Set<string>();
  for (const [key, dv] of Object.entries(draft)) {
    if (dv === undefined) continue;
    if (!deepEqual(dv, resolvePath(v, key))) out.add(key);
  }
  return out;
}

/** 模板在 values 下的全部 concrete 值（单星/双星通用；非星段中途
 * 缺失 → 空；模板以 `*` 段结尾时标量值也收）。只读字段（双星 v1
 * 只读）展示用。 */
export function collectConcreteValues(
  template: string,
  values: Record<string, unknown>,
): unknown[] {
  const parts = template.split(".");
  const out: unknown[] = [];
  const walk = (obj: unknown, i: number): void => {
    if (i === parts.length) {
      out.push(obj);
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    if (parts[i] === "*") {
      for (const v of Object.values(obj as Record<string, unknown>)) walk(v, i + 1);
    } else {
      walk((obj as Record<string, unknown>)[parts[i]], i + 1);
    }
  };
  walk(values ?? {}, 0);
  return out;
}

/** 单星模板在草稿中的条目名（键形同且非星段相等的键；去重、按草稿
 * 键序）——「添加条目」新加的条目（values 中还没有）也参与渲染与
 * 重名校验。非通配模板 → []。 */
export function templateDraftEntries(
  template: string,
  draft: Record<string, unknown>,
): string[] {
  const parts = template.split(".");
  const starIdx = parts.indexOf("*");
  if (starIdx === -1) return [];
  const out: string[] = [];
  for (const key of Object.keys(draft)) {
    const segs = key.split(".");
    if (segs.length !== parts.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      if (i === starIdx) continue;
      if (segs[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok && !out.includes(segs[starIdx])) out.push(segs[starIdx]);
  }
  return out;
}
