// SurfaceForm — surface 声明 → 表单（纯渲染：不取数、不保存、不碰 ResourceCards）。
// 每个 face 包在 WorkerCollapseCard（icon=SettingsIcon、title=face.label||face.id、
// titleExtra=字段数 Tag）；默认仅首个 face 展开（open id 集为内部状态，可多个打开）；
// 字段按 field.group 分组（无 group → 「通用」），双列网格复用 LlmTuningFields 语法；
// 不排序、不隐藏、不补字段——surface 声明什么就渲染什么。
import type * as ReactNS from "react";

import {
  type RuntimeSurface,
  type SurfaceField,
} from "../api/domains/memberConfig";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import SchemaField from "./schema/SchemaField";
import { SettingsIcon } from "./icons";
import { WorkerCollapseCard } from "./WorkerPanelsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface SurfaceFormProps {
  surface: RuntimeSurface;
  /** 扁平点号键 → 值（lib/surfaceForm buildDraft 产物）。 */
  draft: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
  /** key → 错误文案。 */
  errors?: Record<string, string>;
  /** 竖屏弹窗模式：透传给 WorkerCollapseCard。 */
  sheet?: boolean;
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

export function SurfaceForm({
  surface,
  draft,
  onChange,
  disabled,
  errors,
  sheet,
}: SurfaceFormProps) {
  const tr = useT();
  const t = useThemeColors();
  // 默认仅展开首个 face；open id 集为内部状态（可多个打开）。
  const [openIds, setOpenIds] = React.useState<string[]>(() =>
    surface.faces.length > 0 ? [surface.faces[0].id] : [],
  );

  if (surface.faces.length === 0) return null;

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
            {groupFields(face.fields).map(({ group, items }) => (
              <div key={group} style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 11, color: t.textSecondary }}>{tr(group)}</div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 8,
                  }}
                >
                  {items.map((f) => (
                    <SchemaField
                      key={f.key}
                      field={f}
                      value={draft[f.key]}
                      onChange={(v) => onChange(f.key, v)}
                      disabled={disabled}
                      error={errors?.[f.key]}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </WorkerCollapseCard>
      ))}
    </div>
  );
}

export default SurfaceForm;
