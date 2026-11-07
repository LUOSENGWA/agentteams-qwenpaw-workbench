// RuntimeConfigPanel — 运行时配置面板（C2 + F-CFG-2/3）。
//
// 结构对齐 QwenPaw 控制台：
// - **运行配置**（bucket="config"）：按分区用 tab 展示。OpenClaw/Hermes 的
//   surface 以 face 为单位（OpenClaw 16 个、Hermes 102 个）→ tab 标题 = face；
//   QwenPaw 风格的 surface（无 face 分组）→ tab 标题 = 二级分组
//   （reactAgent / agentLoop / llmRetry / llmRateLimiter / context / memory /
//   embeddingModel / toolExecutionLevel）。
// - **能力**（bucket=mcp/tools/skills/channels/approval）：各自一张卡片，
//   只渲染映射到该能力的 face（见 lib/configSectionModel.faceBucket），
//   不再把 MCP/工具/技能/频道/审批 塞进运行配置。
//
// 纯逻辑在 lib/configSectionModel；字段渲染复用 CfgRow + SchemaField。
import type * as ReactNS from "react";

import { useThemeColors } from "../../theme";
import CfgRow from "./CfgRow";
import SchemaField from "../schema/SchemaField";
import {
  advancedFields,
  buildSections,
  diffDraft,
  filterByBucket,
  filterSection,
  type CapabilityBucket,
  type PanelField,
} from "../../lib/configSectionModel";
import type { RuntimeSurface } from "../../api/domains/memberConfig";
import { fieldLabel, labelFor } from "../../lib/runtimeLabels";
import {
  BoltIcon,
  BoxIcon,
  BrainIcon,
  BrickIcon,
  ChartIcon,
  CodeIcon,
  LinkIcon,
  MenuIcon,
  MessageIcon,
  MonitorIcon,
  PinIcon,
  PlugIcon,
  PulseIcon,
  RobotIcon,
  ShieldIcon,
  TreeIcon,
  WrenchIcon,
} from "../icons";

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

/** 二级段标题（无 face 分组的 surface）；未知段原样显示。 */
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

/** face 标题（OpenClaw/Hermes）；未知 face 原样显示。 */
const FACE_LABELS: Record<string, string> = {
  gateway: "网关",
  models: "模型",
  agents: "Agent",
  tools: "工具",
  channels: "频道",
  messaging: "消息",
  voice: "语音",
  session: "会话",
  automation: "自动化",
  "skills-plugins": "技能与插件",
  mcp: "MCP",
  browser: "浏览器",
  security: "安全",
  observability: "可观测",
  ui: "界面",
  workspace: "工作区",
  model: "模型",
  providers: "提供方",
  agent: "Agent",
  terminal: "终端",
  web: "Web",
  worktrees: "工作树",
  checkpoints: "检查点",
  database: "数据库",
  runtime: "运行时",
};

/** face → 图标（与能力卡同一套图标语义；未知 face 无图标）。 */
const FACE_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  gateway: BoltIcon,
  models: BrainIcon,
  model: BrainIcon,
  providers: LinkIcon,
  agents: RobotIcon,
  agent: RobotIcon,
  tools: WrenchIcon,
  toolsets: WrenchIcon,
  terminal: CodeIcon,
  channels: MessageIcon,
  messaging: MessageIcon,
  voice: MonitorIcon,
  session: PulseIcon,
  automation: BoltIcon,
  "skills-plugins": BrickIcon,
  skills: BrickIcon,
  mcp: PlugIcon,
  browser: MonitorIcon,
  security: ShieldIcon,
  observability: ChartIcon,
  ui: MenuIcon,
  workspace: BoxIcon,
  web: LinkIcon,
  worktrees: TreeIcon,
  checkpoints: PinIcon,
  database: BoxIcon,
  runtime: BoltIcon,
};

function FaceLabel({
  id,
  text,
}: {
  id: string;
  text: string;
}): JSX.Element {
  const Icon = FACE_ICONS[id];
  if (!Icon) return <span>{text}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Icon size={12} />
      <span>{text}</span>
    </span>
  );
}

export interface RuntimeConfigPanelProps {
  surface: RuntimeSurface;
  /** 运行时名（face→能力桶映射用）。 */
  runtime?: string;
  /** 渲染哪个能力桶（默认 config；能力卡片传 mcp/tools/…）。 */
  bucket?: CapabilityBucket;
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
  const {
    surface,
    runtime = "",
    bucket = "config",
    draft,
    initialDraft,
    onChange,
    disabled,
    errors,
    values,
  } = props;
  const translate: Tr = props.tr ?? ((text: string) => text);
  const t = useThemeColors();

  const [query, setQuery] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const changed = React.useMemo(() => diffDraft(draft, initialDraft), [draft, initialDraft]);

  // face 模式：surface 有 face，且不是 QwenPaw（QwenPaw 用二级分组）。
  const faceMode = surface.faces.length > 0 && runtime !== "qwenpaw";
  const allSections = React.useMemo(() => buildSections(surface), [surface]);
  const advKeys = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of allSections) for (const f of advancedFields(s)) set.add(f.key);
    return set;
  }, [allSections]);

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
      <CfgRow
        key={f.key}
        label={translate(fieldLabel(runtime, f.key, f.label))}
        tip={f.description}
      >
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

  // ── 分区（tab 项）──────────────────────────────────────────────
  const tabs = React.useMemo(() => {
    if (faceMode) {
      return filterByBucket(runtime, surface, bucket)
        .map((face) => {
          const q = query.trim().toLowerCase();
          const match = (f: PanelField): boolean =>
            q === "" ||
            `${f.key} ${f.label ?? ""} ${f.description ?? ""}`.toLowerCase().includes(q);
          const subs = face.subSections.length
            ? face.subSections.map((sub) => ({
                id: sub.id,
                label: translate(sub.label),
                fields: visible(sub.fields.filter(match)),
              }))
            : [];
          return {
            key: face.id,
            label: (
              <FaceLabel
                id={face.id}
                text={labelFor(runtime, face.id, translate(FACE_LABELS[face.id] ?? face.label))}
              />
            ),
            fields: subs.length ? subs.flatMap((x) => x.fields) : visible(face.fields.filter(match)),
            subs: subs.filter((x) => x.fields.length > 0),
          };
        })
        .filter((tab) => tab.fields.length > 0);
    }
    const configSec = allSections.find((s) => s.id === "config");
    if (!configSec) return [];
    const filtered = filterSection(configSec, query);
    return filtered.subSections
      .map((sub) => ({
        key: sub.id,
        label: translate(SUB_LABELS[sub.id] ?? sub.id),
        fields: visible(sub.fields),
        subs: [] as { id: string; label: string; fields: PanelField[] }[],
      }))
      .filter((tab) => tab.fields.length > 0);
  }, [faceMode, runtime, surface, bucket, allSections, query, translate, visible]);

  // 非 config 桶且 face 多于一个：每个 face 一个分组标题（卡片内分节）。
  const groups = React.useMemo(() => {
    if (!faceMode || bucket === "config") return [];
    return filterByBucket(runtime, surface, bucket)
      .map((face) => {
        const sec = allSections.find((s) => s.id === face.id);
        const filtered = sec ? filterSection(sec, query) : null;
        return {
          id: face.id,
          title: translate(FACE_LABELS[face.id] ?? face.label),
          fields: visible(filtered ? filtered.fields : face.fields),
        };
      })
      .filter((g) => g.fields.length > 0);
  }, [faceMode, bucket, runtime, surface, allSections, query, translate, visible]);

  const faceCount = faceMode ? filterByBucket(runtime, surface, bucket).length : tabs.length;
  const hitCount = faceMode
    ? groups.length > 0
      ? groups.reduce((n, g) => n + g.fields.length, 0)
      : tabs.reduce((n, tab) => n + tab.fields.length, 0)
    : tabs.reduce((n, tab) => n + tab.fields.length, 0);

  if (faceCount === 0 && !faceMode) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: t.textSecondary }}>
        {translate("暂无可配置字段")}
      </div>
    );
  }

  // 能力桶没有对应 face：诚实空态（该运行时没有这部分）。
  if (faceMode && faceCount === 0) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: t.textSecondary }}>
        {translate("该运行时没有这部分配置面")}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0, maxWidth: "100%" }}>
      {/* 工具行：搜索 + 显示高级 + 已改计数 + 重置 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <antd.Input
          size="small"
          allowClear
          style={{ flex: "1 1 160px", minWidth: 0, maxWidth: 280 }}
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

      {/* 能力桶：多 face 时按 face 分节（卡片内） */}
      {groups.length > 0 ? (
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {groups.map((g) => (
            <div key={g.id} style={{ display: "grid", gap: 8, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12 }}>{g.title}</div>
              {g.fields.map(renderField)}
            </div>
          ))}
        </div>
      ) : (
        <antd.Tabs
          size="small"
          style={{ minWidth: 0 }}
          items={tabs.map((tab) => ({
            key: tab.key,
            label: tab.label,
            children: (
              <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
                {tab.subs.length > 0
                  ? tab.subs.map((sub) => (
                      <div key={sub.id} style={{ display: "grid", gap: 6, minWidth: 0 }}>
                        {sub.id ? (
                          <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 4 }}>
                            {sub.label}
                          </div>
                        ) : null}
                        {sub.fields.map(renderField)}
                      </div>
                    ))
                  : tab.fields.map(renderField)}
              </div>
            ),
          }))}
        />
      )}
    </div>
  );
}
