// RuntimeConfigPanel — 运行时配置面板（C2 + F-CFG-2）。
//
// 结构与 QwenPaw 控制台一致：**运行配置**用 tab 分区（reactAgent /
// agentLoop / llmRetry / llmRateLimiter / context / memory /
// embeddingModel / toolExecutionLevel），其余能力（MCP / 工具 / 技能 /
// ACP / 检查点 / 其他）各自一张卡片，不再混在同一张长表里。
//
// 纯逻辑在 lib/configSectionModel（分组、过滤、diff）；本文件只负责布局与
// 文案。字段渲染复用 CfgRow + SchemaField，不重写控件。
import type * as ReactNS from "react";

import { useThemeColors } from "../../theme";
import CfgRow from "./CfgRow";
import SchemaField from "../schema/SchemaField";
import {
  advancedFields,
  diffDraft,
  filterSection,
  type PanelField,
  type Section,
  type SectionId,
} from "../../lib/configSectionModel";
import { buildSections } from "../../lib/configSectionModel";
import type { RuntimeSurface } from "../../api/domains/memberConfig";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (text: string, params?: Record<string, string | number>) => string;

/** 通配模板键的展示值收集（单星按条目；双星只读）。 */
function collectConcreteValues(
  key: string,
  values: Record<string, unknown>,
): unknown[] {
  if (!key.includes("*")) return [];
  const prefix = key.slice(0, key.indexOf("*"));
  const suffix = key.slice(key.indexOf("*") + 1);
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!k.startsWith(prefix)) continue;
    if (suffix !== "" && !k.endsWith(suffix)) continue;
    if (suffix === "" || k.length > prefix.length + suffix.length) out.push(v);
  }
  return out;
}

/** 二级段标题（QwenPaw 同款口径）；未知段原样显示。 */
const SUB_LABELS: Record<string, string> = {
  reactAgent: "React Agent",
  agentLoop: "Agent Loop",
  llmRetry: "LLM 重试",
  llmRateLimiter: "LLM 限流",
  context: "上下文",
  memory: "记忆",
  embeddingModel: "嵌入模型",
  toolExecutionLevel: "工具执行级别",
};

const SECTION_ORDER: SectionId[] = [
  "config",
  "mcp",
  "tools",
  "skills",
  "acp",
  "checkpoints",
  "other",
];

export interface RuntimeConfigPanelProps {
  surface: RuntimeSurface;
  /** 扁平点号键草稿（buildDraft 产物；通配为 concrete 键）。 */
  draft: Record<string, unknown>;
  /** 基线草稿（载入时 buildDraft）——「已改 N 项」与重置依据。 */
  initialDraft: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  /** key → 错误文案。 */
  errors?: Record<string, string>;
  /** 原始嵌套 values（通配字段收集展示值）。 */
  values?: Record<string, unknown>;
  /** 全部文案经此 tr（缺省 identity）。 */
  tr?: Tr;
}

export default function RuntimeConfigPanel(props: RuntimeConfigPanelProps): JSX.Element {
  const { surface, draft, initialDraft, onChange, disabled, errors, values } = props;
  const translate: Tr = props.tr ?? ((text: string) => text);
  const t = useThemeColors();

  const [query, setQuery] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const sections = React.useMemo<Section[]>(() => buildSections(surface), [surface]);
  const changed = React.useMemo(() => diffDraft(draft, initialDraft), [draft, initialDraft]);

  const byId = React.useMemo(() => {
    const m = new Map<SectionId, Section>();
    for (const s of sections) m.set(s.id, s);
    return m;
  }, [sections]);

  const advKeys = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of sections) for (const f of advancedFields(s)) set.add(f.key);
    return set;
  }, [sections]);

  const visible = React.useCallback(
    (fields: PanelField[]): PanelField[] =>
      fields.filter((f) => (showAdvanced ? true : !advKeys.has(f.key))),
    [advKeys, showAdvanced],
  );

  const handleReset = React.useCallback(() => {
    for (const key of changed) onChange(key, initialDraft[key]);
  }, [changed, initialDraft, onChange]);

  const v = values ?? {};
  const renderField = (f: PanelField) => {
    const star = f.key.includes("*");
    return (
      <CfgRow key={f.key} label={translate(f.label || f.key)} tip={f.description}>
        <SchemaField
          field={f}
          value={star ? collectConcreteValues(f.key, v) : draft[f.key]}
          onChange={(val) => onChange(f.key, val)}
          disabled={disabled}
          readOnly={star}
          error={errors?.[f.key]}
        />
      </CfgRow>
    );
  };

  // ── 运行配置：tab 分区 ──────────────────────────────────────────
  const configSection = byId.get("config");
  const configTabs = React.useMemo(() => {
    if (!configSection) return [];
    const filtered = filterSection(configSection, query);
    return filtered.subSections
      .map((sub) => ({
        key: sub.id,
        label: translate(SUB_LABELS[sub.id] ?? sub.id),
        fields: visible(sub.fields),
      }))
      .filter((sub) => sub.fields.length > 0);
  }, [configSection, query, translate, visible]);

  // ── 其余能力：各自卡片 ─────────────────────────────────────────
  const cards = React.useMemo(() => {
    const out: { id: SectionId; title: string; fields: PanelField[] }[] = [];
    for (const id of SECTION_ORDER) {
      if (id === "config") continue;
      const sec = byId.get(id);
      if (!sec) continue;
      const filtered = filterSection(sec, query);
      const fields = visible(filtered.fields);
      if (fields.length === 0) continue;
      out.push({ id, title: translate(sec.label), fields });
    }
    return out;
  }, [byId, query, translate, visible]);

  const hitCount =
    configTabs.reduce((n, tab) => n + tab.fields.length, 0) +
    cards.reduce((n, c) => n + c.fields.length, 0);

  if (sections.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: t.textSecondary }}>
        {translate("暂无可配置字段")}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {/* 工具行：搜索 + 显示高级 + 已改计数 + 重置 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <antd.Input
          size="small"
          allowClear
          style={{ flex: 1, minWidth: 120, maxWidth: 260 }}
          placeholder={translate("搜索字段…")}
          value={query}
          onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) => setQuery(ev.target.value)}
        />
        <span style={{ fontSize: 11, color: t.textSecondary, whiteSpace: "nowrap" }}>
          {translate("{n} 个命中", { n: hitCount })}
        </span>
        <antd.Switch
          size="small"
          checked={showAdvanced}
          onChange={(c: boolean) => setShowAdvanced(c)}
        />
        <span style={{ fontSize: 11, color: t.textSecondary }}>{translate("显示高级")}</span>
        <div style={{ flex: 1 }} />
        {changed.length > 0 ? (
          <antd.Tag color="orange" style={{ fontSize: 11 }}>
            {translate("已改 {n} 项", { n: changed.length })}
          </antd.Tag>
        ) : null}
        <antd.Button size="small" disabled={disabled || changed.length === 0} onClick={handleReset}>
          {translate("重置")}
        </antd.Button>
      </div>

      {/* 运行配置（tab 分区） */}
      {configTabs.length > 0 ? (
        <antd.Card
          size="small"
          title={translate("运行配置")}
          styles={{ body: { paddingTop: 4 } }}
        >
          <antd.Tabs
            size="small"
            items={configTabs.map((tab) => ({
              key: tab.key,
              label: tab.label,
              children: <div style={{ display: "grid", gap: 8 }}>{tab.fields.map(renderField)}</div>,
            }))}
          />
        </antd.Card>
      ) : null}

      {/* 其余能力卡片 */}
      {cards.map((card) => (
        <antd.Card key={card.id} size="small" title={card.title}>
          <div style={{ display: "grid", gap: 8 }}>{card.fields.map(renderField)}</div>
        </antd.Card>
      ))}
    </div>
  );
}
