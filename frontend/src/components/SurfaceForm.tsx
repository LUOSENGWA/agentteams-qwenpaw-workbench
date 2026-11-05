// SurfaceForm — surface 声明 → 表单（纯渲染：不取数、不保存、不碰 ResourceCards）。
// 每个 face 包在 WorkerCollapseCard（icon=SettingsIcon、title=face.label||face.id、
// titleExtra=字段数 Tag）；默认仅首个 face 展开（open id 集为内部状态，可多个打开）；
// 字段按 field.group 分组（无 group → 「通用」），双列网格复用 LlmTuningFields 语法；
// 不排序、不隐藏、不补字段——surface 声明什么就渲染什么。
// O2 通配渲染（纯逻辑用 O1 lib/surfaceForm）：
//  - 含双星字段的 group → 整组只读块（字段显示值 + 只读 Tag，无控件）；
//  - 含单星通配字段的 group → 按条目渲染：entries = expandEntries(values) ∪
//    templateDraftEntries(draft)，antd.Collapse 子卡（默认折叠、首个展开），
//    子卡内该组单星字段按 concreteKey 拼键渲染；组头「添加条目」
//    （内联 Input + 确认；条目名空/重复/含 `.` 或 `*` → 禁用）；
//  - 非通配 group → 现状不变。
// query/changedKeys 经 filterFields 纯函数过滤（只滤字段，group/条目
// 骨架保留）。
import type * as ReactNS from "react";

import {
  type RuntimeSurface,
  type SurfaceField,
} from "../api/domains/memberConfig";
import {
  collectConcreteValues,
  concreteKey,
  expandEntries,
  filterFields,
  isReadOnlyField,
  templateDraftEntries,
} from "../lib/surfaceForm";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import SchemaField from "./schema/SchemaField";
import { SettingsIcon } from "./icons";
import { WorkerCollapseCard } from "./WorkerPanelsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const NO_CHANGED: ReadonlySet<string> = new Set();

export interface SurfaceFormProps {
  surface: RuntimeSurface;
  /** 扁平点号键 → 值（lib/surfaceForm buildDraft 产物；通配为 concrete 键）。 */
  draft: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  /** key → 错误文案。 */
  errors?: Record<string, string>;
  /** 竖屏弹窗模式：透传给 WorkerCollapseCard。 */
  sheet?: boolean;
  /** 原始嵌套 values（通配条目展开 + 只读字段取值用）。 */
  values?: Record<string, unknown>;
  /** 搜索子串（key/label，不区分大小写；空 = 全部）。 */
  query?: string;
  /** 已修改键集合（空集 = 「仅看已修改」关）。 */
  changedKeys?: ReadonlySet<string>;
}

/** 按 field.group 分组（保持声明顺序，不排序）；无 group → 「通用」。 */
function groupFields(fields: SurfaceField[]): Array<{ group: string; items: SurfaceField[] }> {
  const order: string[] = [];
  const map = new Map<string, SurfaceField[]>();
  for (const f of fields) {
    const g = f.group || "通用";
    const arr = map.get(g);
    if (arr) arr.push(f);
    else {
      map.set(g, [f]);
      order.push(g);
    }
  }
  return order.map((g) => ({ group: g, items: map.get(g) as SurfaceField[] }));
}

/** 键中纯 `*` 段数（`a*b` 这类非纯通配段不计，同 O1 countStarSegments）。 */
function starCount(key: string): number {
  let n = 0;
  for (const p of key.split(".")) if (p === "*") n += 1;
  return n;
}

export function SurfaceForm({
  surface,
  draft,
  onChange,
  disabled,
  errors,
  sheet,
  values,
  query,
  changedKeys,
}: SurfaceFormProps) {
  const tr = useT();
  const t = useThemeColors();
  // 默认仅展开首个 face；open id 集为内部状态（可多个打开）。
  const [openIds, setOpenIds] = React.useState<string[]>(() =>
    surface.faces.length > 0 ? [surface.faces[0].id] : [],
  );
  // 「添加条目」内联态（同一时刻一个 group；gid = face.id:group）。
  const [addingGid, setAddingGid] = React.useState<string | null>(null);
  const [newEntry, setNewEntry] = React.useState("");

  if (surface.faces.length === 0) return null;

  const v = values ?? {};
  const q = query ?? "";
  const ck = changedKeys ?? NO_CHANGED;

  const renderGroup = (faceId: string, group: string, items: SurfaceField[]) => {
    const gid = `${faceId}:${group}`;
    const visible = filterFields(items, q, ck);
    const hasDouble = items.some(isReadOnlyField);
    const starFields = items.filter((f) => starCount(f.key) === 1);

    // 双星 group → 整组只读块（字段显示值 + 只读 Tag，无控件）。
    if (hasDouble) {
      return (
        <div key={group} style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: t.textSecondary }}>{tr(group)}</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 8,
            }}
          >
            {visible.map((f) => (
              <SchemaField
                key={f.key}
                field={f}
                value={starCount(f.key) > 0 ? collectConcreteValues(f.key, v) : draft[f.key]}
                onChange={(val) => onChange(f.key, val)}
                disabled={disabled}
                readOnly
              />
            ))}
          </div>
        </div>
      );
    }

    // 单星通配 group → 按条目渲染 + 组头「添加条目」。
    if (starFields.length > 0) {
      const template = starFields[0].key;
      const entries = Array.from(
        new Set([...expandEntries(template, v), ...templateDraftEntries(template, draft)]),
      );
      const visibleStar = visible.filter((f) => starCount(f.key) === 1);
      const visiblePlain = visible.filter((f) => starCount(f.key) === 0);
      const name = newEntry.trim();
      const nameOk =
        name !== "" &&
        !name.includes(".") &&
        !name.includes("*") &&
        !entries.includes(name);
      const confirmEntry = () => {
        if (!nameOk) return;
        for (const f of starFields) {
          const key = concreteKey(f.key, name);
          if (!(key in draft)) onChange(key, f.default);
        }
        setNewEntry("");
        setAddingGid(null);
      };
      return (
        <div key={group} style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: t.textSecondary }}>{tr(group)}</span>
            {disabled ? null : addingGid === gid ? (
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <antd.Input
                  size="small"
                  style={{ width: 140 }}
                  placeholder={tr("条目名")}
                  value={newEntry}
                  autoFocus
                  onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setNewEntry(ev.target.value)
                  }
                  onPressEnter={confirmEntry}
                />
                <antd.Button size="small" type="primary" disabled={!nameOk} onClick={confirmEntry}>
                  {tr("添加")}
                </antd.Button>
              </span>
            ) : (
              <antd.Button
                size="small"
                type="dashed"
                onClick={() => {
                  setNewEntry("");
                  setAddingGid(gid);
                }}
              >
                {tr("添加条目")}
              </antd.Button>
            ))}
          </div>
          {visiblePlain.length > 0 ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {visiblePlain.map((f) => (
                <SchemaField
                  key={f.key}
                  field={f}
                  value={draft[f.key]}
                  onChange={(val) => onChange(f.key, val)}
                  disabled={disabled}
                  error={errors?.[f.key]}
                />
              ))}
            </div>
          ) : null}
          {entries.length > 0 ? (
            <antd.Collapse
              size="small"
              ghost
              defaultActiveKey={entries[0] ? [entries[0]] : []}
              items={entries.map((e) => ({
                key: e,
                label: (
                  <span style={{ fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                    {e}
                  </span>
                ),
                children: (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 8,
                    }}
                  >
                    {visibleStar.map((f) => {
                      const key = concreteKey(f.key, e);
                      return (
                        <SchemaField
                          key={key}
                          field={f}
                          value={draft[key]}
                          onChange={(val) => onChange(key, val)}
                          disabled={disabled}
                          error={errors?.[key]}
                        />
                      );
                    })}
                  </div>
                ),
              }))}
            />
          ) : null}
        </div>
      );
    }

    // 非通配 group → 现状不变。
    return (
      <div key={group} style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: 11, color: t.textSecondary }}>{tr(group)}</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 8,
          }}
        >
          {visible.map((f) => (
            <SchemaField
              key={f.key}
              field={f}
              value={draft[f.key]}
              onChange={(val) => onChange(f.key, val)}
              disabled={disabled}
              error={errors?.[f.key]}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {surface.faces.map((face) => (
        <WorkerCollapseCard
          key={face.id}
          open={openIds.includes(face.id)}
          sheet={sheet}
          icon={<SettingsIcon size={13} />}
          title={tr(face.label || face.id)}
          titleExtra={
            <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {tr("{n} 个配置项", { n: face.fields.length })}
            </antd.Tag>
          }
          onExpand={() =>
            setOpenIds((p) => (p.includes(face.id) ? p : [...p, face.id]))
          }
          onCollapse={() => setOpenIds((p) => p.filter((x) => x !== face.id))}
        >
          <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
            {groupFields(face.fields).map(({ group, items }) =>
              renderGroup(face.id, group, items),
            )}
          </div>
        </WorkerCollapseCard>
      ))}
    </div>
  );
}

export default SurfaceForm;
