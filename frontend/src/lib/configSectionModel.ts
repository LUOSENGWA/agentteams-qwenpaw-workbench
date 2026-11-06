// configSectionModel — 运行时配置面板分组模型（C2，纯逻辑，node 直测）。
// 不读 window、无 react/antd/组件依赖；类型 type-only import（编译后无
// 运行时耦合，与 lib/surfaceForm 同规格）。生产代码不读盘、不依赖
// tests/fixtures（夹具仅供测试构造输入）。
//
// 分组规则（三级回退）：
//  1. 字段自带分组：field.group / field.tab / field.section（取第一个非空）；
//  2. 无分组 → 按 key 首段前缀归类（prefixBucket：llm*/model*→llm、
//     memory*→memory、embedding*→embedding、tool*/exec*→tools、mcp*→mcp、
//     context*/window*→context、retry*/timeout*→reliability、其余→other）；
//  3. 分组名首段命中顶级别名（mcp/tool(s)/toolsets/skill(s)/acp/
//     checkpoint(s)/other，不区分大小写）→ 对应顶级段；否则 → config 段，
//     分组名成为段内二级段（如 model、agent.agent_cache、llm）。
//
// 顶级段顺序固定：config, mcp, tools, skills, acp, checkpoints, other
//（缺段不出现）；config 段内二级段按 QwenPaw 基准顺序
// reactAgent, agentLoop, llmRetry, llmRateLimiter, context, memory,
// embeddingModel, toolExecutionLevel，未知二级段按首现顺序追加在后。
import type { RuntimeSurface, SurfaceField } from "../api/domains/memberConfig";

/** 字段扩展形：surface 可能在 #1493 基线契约之外携带分组/描述/高级
 * 标记（field.tab / field.section / description / advanced）——防御性
 * 读取，缺失 = 无该信息。SurfaceField 结构可赋值到本类型（新增皆
 * 可选）。 */
export interface PanelField extends SurfaceField {
  tab?: string;
  section?: string;
  description?: string;
  advanced?: boolean;
}

export type SectionId = "config" | "mcp" | "tools" | "skills" | "acp" | "checkpoints" | "other";

/** 段内二级分组（config 段按 QwenPaw 二级基准排序；其余段按首现序）。 */
export interface SubSection {
  id: string;
  label: string;
  fields: PanelField[];
}

export interface Section {
  id: SectionId;
  label: string;
  /** 本段全部字段（surface 声明顺序）。 */
  fields: PanelField[];
  subSections: SubSection[];
}

/** 顶级段固定顺序（缺段不出现）。 */
export const SECTION_ORDER: readonly SectionId[] = [
  "config",
  "mcp",
  "tools",
  "skills",
  "acp",
  "checkpoints",
  "other",
];

/** 顶级段显示名（组件侧 tr 透传；此处保留源语言）。 */
const SECTION_LABELS: Record<SectionId, string> = {
  // 中文作为 i18n 源键（与全库字典一致）；MCP / ACP 为专有名词不译。
  config: "运行配置",
  mcp: "MCP",
  tools: "工具",
  skills: "技能",
  acp: "ACP",
  checkpoints: "检查点",
  other: "其他",
};

/** 分组名首段 → 顶级段别名（小写、不区分大小写）；未命中 → config。 */
const TOP_GROUP_ALIASES: Record<string, SectionId> = {
  mcp: "mcp",
  tool: "tools",
  tools: "tools",
  toolsets: "tools",
  skill: "skills",
  skills: "skills",
  acp: "acp",
  checkpoint: "checkpoints",
  checkpoints: "checkpoints",
  other: "other",
};

/** config 段二级顺序（QwenPaw 基准）；未列名的二级段按首现序追加。 */
export const CONFIG_SUB_ORDER: readonly string[] = [
  "reactAgent",
  "agentLoop",
  "llmRetry",
  "llmRateLimiter",
  "context",
  "memory",
  "embeddingModel",
  "toolExecutionLevel",
];

/** 字段自带分组（group / tab / section 取第一个非空——空串视无；
 * 无 → ""）。 */
export function fieldGroup(f: PanelField): string {
  for (const g of [f.group, f.tab, f.section]) {
    if (typeof g === "string" && g.trim() !== "") return g.trim();
  }
  return "";
}

/** 无分组时按 key 首段前缀归桶（不区分大小写）。 */
export function prefixBucket(key: string): string {
  const seg = (key.split(".")[0] ?? "").toLowerCase();
  if (seg.startsWith("llm") || seg.startsWith("model")) return "llm";
  if (seg.startsWith("memory")) return "memory";
  if (seg.startsWith("embedding")) return "embedding";
  if (seg.startsWith("tool") || seg.startsWith("exec")) return "tools";
  if (seg.startsWith("mcp")) return "mcp";
  if (seg.startsWith("context") || seg.startsWith("window")) return "context";
  if (seg.startsWith("retry") || seg.startsWith("timeout")) return "reliability";
  return "other";
}

/** 分组名 → 顶级段：首段命中别名 → 对应段；否则 config。 */
function topLevelForGroup(rawGroup: string): SectionId {
  const g = rawGroup.toLowerCase();
  const first = g.split(".")[0] ?? g;
  return TOP_GROUP_ALIASES[first] ?? "config";
}

/** surface 声明 → 顶级段列表（固定顺序、缺段不出现；字段不丢不重）。 */
export function buildSections(surface: RuntimeSurface): Section[] {
  const sections: Partial<Record<SectionId, Section>> = {};
  const subKeys = new Map<SectionId, string[]>();
  const subs = new Map<SectionId, Map<string, SubSection>>();

  for (const face of surface.faces ?? []) {
    for (const raw of face.fields ?? []) {
      const f = raw as PanelField;
      const rawGroup = fieldGroup(f) || prefixBucket(f.key);
      const secId = topLevelForGroup(rawGroup);
      let sec = sections[secId];
      if (!sec) {
        sec = { id: secId, label: SECTION_LABELS[secId], fields: [], subSections: [] };
        sections[secId] = sec;
        subKeys.set(secId, []);
        subs.set(secId, new Map());
      }
      sec.fields.push(f);
      const subKey = rawGroup.toLowerCase();
      let sub = subs.get(secId)?.get(subKey);
      if (!sub) {
        sub = { id: rawGroup, label: rawGroup, fields: [] };
        subs.get(secId)?.set(subKey, sub);
        subKeys.get(secId)?.push(subKey);
      }
      sub.fields.push(f);
    }
  }

  const out: Section[] = [];
  for (const id of SECTION_ORDER) {
    const sec = sections[id];
    if (!sec || sec.fields.length === 0) continue;
    let keys = subKeys.get(id) ?? [];
    if (id === "config") {
      // 已知二级名按 QwenPaw 基准序前置（小写比对）；未知二级段按首现序
      // 追加在后。
      const known = CONFIG_SUB_ORDER.map((c) => c.toLowerCase());
      keys = [
        ...known.filter((k) => keys.includes(k)),
        ...keys.filter((k) => !known.includes(k)),
      ];
    }
    const map = subs.get(id);
    sec.subSections = keys.map((k) => map?.get(k) as SubSection);
    out.push(sec);
  }
  return out;
}

/** 段内过滤：label/key/描述 不区分大小写子串匹配；空查询返回全部。
 * subSections 同步过滤（查询非空时空二级段移除）；返回浅拷贝，不改入参。 */
export function filterSection(section: Section, query: string): Section {
  const q = query.trim().toLowerCase();
  const hit = (f: PanelField): boolean => {
    if (q === "") return true;
    return `${f.key} ${f.label ?? ""} ${f.description ?? ""}`.toLowerCase().includes(q);
  };
  const fields = section.fields.filter(hit);
  const subSections = section.subSections
    .map((s) => ({ ...s, fields: s.fields.filter(hit) }))
    .filter((s) => q === "" || s.fields.length > 0);
  return { ...section, fields, subSections };
}

/** 高级判定 token：字段名（key）含其一即视为高级字段。 */
const ADVANCED_TOKENS: readonly string[] = ["retry", "timeout", "limit"];

/** 高级字段：advanced: true 标记，或字段名含 retry/timeout/limit
 *（不区分大小写）。 */
export function advancedFields(section: Section): PanelField[] {
  return section.fields.filter((f) => {
    if (f.advanced === true) return true;
    const key = (f.key ?? "").toLowerCase();
    return ADVANCED_TOKENS.some((tok) => key.includes(tok));
  });
}

/** 深相等（原始值恒等；对象比键集 + 递归值；数组/对象类型不符 → 不等）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** 草稿 vs 基线草稿 → 变更 key 列表（两者均为扁平点号键 → 值；草稿
 * undefined 哨兵恒不算变更；顺序按草稿键序）。用于「已改 N 项」提示
 * 与重置/保存按钮禁用。 */
export function diffDraft(
  draft: Record<string, unknown>,
  initial: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const init = initial ?? {};
  for (const key of Object.keys(draft ?? {})) {
    const dv = draft[key];
    if (dv === undefined) continue;
    if (deepEqual(dv, init[key])) continue;
    out.push(key);
  }
  return out;
}
