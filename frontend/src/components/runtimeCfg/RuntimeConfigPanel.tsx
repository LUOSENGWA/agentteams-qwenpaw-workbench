// RuntimeConfigPanel — 运行时配置分组展示面板（C2，展示组件）。
// 只负责：分组（buildSections）+ 搜索（filterSection）+ 高级过滤
//（advancedFields）+ dirty 状态（diffDraft）。不取数、不保存、不
// 回滚——接线到入口页（WorkerDetailPane / WorkerRuntimeConfig 等）是
// 下一单的事。
// 字段渲染复用 CfgRow（label + ⓘ 描述）+ SchemaField（schema 驱动
// 控件）——不重写字段渲染。通配模板字段（key 含 *）只读展示
//（collectConcreteValues 收集值；按条目编辑留在 SurfaceForm 通配
// 渲染路径）。窄屏（≤720px）：段列表折叠成下拉、字段单列。
// 所有文案走传入的 tr（缺省 identity，中文源语言直出）；不新增
// i18n 域条目。
import type * as ReactNS from "react";

import { type RuntimeSurface } from "../../api/domains/memberConfig";
import {
  advancedFields,
  buildSections,
  diffDraft,
  filterSection,
  type PanelField,
  type Section,
} from "../../lib/configSectionModel";
import { collectConcreteValues } from "../../lib/surfaceForm";
import { useThemeColors } from "../../theme";
import CfgRow from "./CfgRow";
import SchemaField from "../schema/SchemaField";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (text: string, vars?: Record<string, string | number>) => string;

/** 窄屏判定（≤720px）。shim/无 matchMedia 环境 → false（宽版布局）。
 * 同 TrashDialog.useNarrow 先例。 */
function useNarrow(max = 720): boolean {
  const [narrow, setNarrow] = React.useState<boolean>(
    () => !!window.matchMedia && window.matchMedia(`(max-width: ${max}px)`).matches,
  );
  React.useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${max}px)`);
    const fn = (e: { matches: boolean }): void => setNarrow(e.matches);
    mq.addEventListener?.("change", fn);
    return () => mq.removeEventListener?.("change", fn);
  }, [max]);
  return narrow;
}

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
  const { surface, draft, initialDraft, onChange, disabled, errors, values, tr } = props;
  const translate = tr ?? ((text: string) => text);
  const t = useThemeColors();
  const narrow = useNarrow(720);

  const sections = React.useMemo<Section[]>(() => buildSections(surface), [surface]);
  const [activeId, setActiveId] = React.useState<string>("");
  const [query, setQuery] = React.useState("");
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  const filtered = React.useMemo(
    () => (active ? filterSection(active, query) : null),
    [active, query],
  );
  const advKeys = React.useMemo(
    () => new Set(active ? advancedFields(active).map((f) => f.key) : []),
    [active],
  );
  const changed = React.useMemo(() => diffDraft(draft, initialDraft), [draft, initialDraft]);

  // 重置：逐项把变更键写回基线值（新增条目写 undefined 哨兵 → 草稿
  // 视为未改，diffDraft 不再计）。
  const handleReset = React.useCallback(() => {
    for (const key of changed) onChange(key, initialDraft[key]);
  }, [changed, initialDraft, onChange]);

  if (!active || !filtered) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: t.textSecondary }}>
        {translate("暂无可配置字段")}
      </div>
    );
  }

  // 高级过滤：隐藏高级字段（通配模板按模板键判定）；全空二级段收起。
  const visibleSubs = filtered.subSections
    .map((s) => ({ ...s, fields: s.fields.filter((f) => !advKeys.has(f.key)) }))
    .filter((s) => s.fields.length > 0);

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

  const sectionButtons = sections.map((s) => {
    const sel = s.id === active.id;
    return (
      <div
        key={s.id}
        onClick={() => setActiveId(s.id)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 12,
          background: sel ? t.accentBg : "transparent",
          border: `1px solid ${sel ? t.border : "transparent"}`,
        }}
      >
        <span style={{ flex: 1 }}>{translate(s.label)}</span>
        <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>{s.fields.length}</antd.Tag>
      </div>
    );
  });

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {/* 顶部：搜索（命中数）+ 显示高级 + 已改 N 项 + 重置 */}
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
          {translate("{n} 个命中", { n: filtered.fields.length })}
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

      {/* 主体：宽屏 = 左段列表（计数徽标）+ 右字段（纵向滚动）；
       * 窄屏（≤720px）= 段下拉 + 字段单列。 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "1fr" : "190px minmax(0, 1fr)",
          gap: 10,
          alignItems: "start",
          minWidth: 0,
        }}
      >
        {narrow ? (
          <antd.Select
            size="small"
            style={{ width: "100%" }}
            value={active.id}
            onChange={(id: string) => setActiveId(id)}
            options={sections.map((s) => ({
              value: s.id,
              label: `${translate(s.label)}（${s.fields.length}）`,
            }))}
          />
        ) : (
          <div style={{ display: "grid", gap: 4, position: "sticky", top: 8 }}>{sectionButtons}</div>
        )}
        <div
          style={{
            display: "grid",
            gap: 12,
            overflowY: "auto",
            maxHeight: 520,
            padding: 2,
            minWidth: 0,
          }}
        >
          {visibleSubs.length === 0 ? (
            <div style={{ fontSize: 12, color: t.textSecondary }}>
              {translate("无匹配字段")}
            </div>
          ) : (
            visibleSubs.map((sub) => (
              <div key={sub.id} style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: t.textSecondary, padding: "2px 0" }}>
                  {translate(sub.label)}
                </div>
                {sub.fields.map(renderField)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
