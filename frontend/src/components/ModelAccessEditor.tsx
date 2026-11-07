// ModelAccessEditor.tsx — C2b（#1513 管理员面）：Human CR spec.modelAccess
// 受控编辑器（人员详情「模型授权」卡；CrdHumanForm 复用同一组件，不许复制实现）。
//
// 纯受控（value/onChange）：自身不拨号——候选（catalog）/共享表名（tables）/
// 生效值授权（capabilities）全由父组件传入；唯一异步侧通道是
// getTablePreview（表内容只读预览，父接 getModelAccessTable）。
//
// 数据模型（契约 main 9322b04f9，见 api/domains/modelAccess.ts 头注）：
// - modelAccess = { scopes: [...] }；授权轴只有 role + coding CLI；
// - (provider, model) 必须成对（不完整行红字提示，保存门在父组件）；
// - role 可空 = 默认作用域；table 与内联 entries 二选一，内联优先；
// - 无值 = fail-closed（全锁）——空态提示在此，升级提示（升级警告）在父；
// - writeVia/reason 是只读回显（小标签/11px 提示），绝不写回。
//
// React/antd 走 window.QwenPaw.host（blob-URL 单文件构建约束，见 vite.config 守卫）。
import type * as ReactNS from "react";
import {
  type HumanModelAccess,
  type HumanModelAccessCapabilities,
  type HumanModelAccessCapability,
  type HumanModelAccessScope,
  type ModelAccessPair,
} from "../api/domains/modelAccess";
import { surfaceBadge } from "../lib/modelAccess";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import { CloseIcon } from "./icons";

const host = window.QwenPaw.host;
/** 固定三种 Coding CLI（与 api/domains/codingcli.ts 的 CodingCliId 同源）。 */
export const CLI_IDS = ["qwen-code", "opencode", "qoder"] as const;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 模型候选（父组件组装：providers = 网关 provider 名；
 * models = SGLang ∪ 在服 ∪ 网关 alias；空 = 自由输入）。 */
export interface ModelCatalogLite {
  providers: string[];
  models: string[];
  /** 模型 → 所属 provider（父组件按网关 alias 归属构造；缺省 = 不按
   * provider 过滤模型候选）。 */
  modelsByProvider?: Record<string, string[]>;
}

export interface ModelAccessEditorProps {
  value?: HumanModelAccess | null;
  /** ?resolve=1 生效值授权（null = 无信息 → 不做分区只读）。 */
  capabilities?: HumanModelAccessCapabilities | null;
  /** 共享表名（null = 端点不支持 → 隐藏表选择器，只留内联 entries）。 */
  tables?: string[] | null;
  catalog?: ModelCatalogLite | null;
  onChange: (next: HumanModelAccess) => void;
  tr: TrFn;
  t: ThemeColors;
  /** 整体只读（非 admin / 全 surface 锁定）。 */
  readOnly?: boolean;
  /** 表内容预览（只读；不传 = 不显示预览）。 */
  getTablePreview?: (name: string) => Promise<ModelAccessPair[]>;
}

type CliSurface = { entries?: ModelAccessPair[]; inherit?: boolean };

/** 分区可编辑：整体只读 或 该 surface 显式 canEdit=false → 不可编辑。 */
function capEditable(
  cap: HumanModelAccessCapability | null | undefined,
  readOnly: boolean,
): boolean {
  if (readOnly) return false;
  return !cap || cap.canEdit !== false;
}

/** 授权徽标（五态，与 ModelEditModal accessBadge 同映射；i18n 键复用 chat.ts）。 */
function capBadge(
  cap: HumanModelAccessCapability | null | undefined,
  tr: TrFn,
): ReactNS.ReactElement | null {
  if (!cap) return null;
  const b = surfaceBadge(cap);
  const label =
    b.kind === "editable"
      ? tr("可编辑")
      : b.kind === "inherited"
        ? tr("继承自 {x}", { x: b.from || "—" })
        : b.kind === "not_granted"
          ? tr("未授权")
          : b.kind === "byok"
            ? tr("BYOK 不支持")
            : tr("只读");
  const color =
    b.kind === "editable"
      ? "green"
      : b.kind === "inherited"
        ? "blue"
        : b.kind === "not_granted"
          ? "red"
          : b.kind === "byok"
            ? "orange"
            : "default";
  return (
    <antd.Tag color={color} style={{ margin: 0, flexShrink: 0 }}>
      {label}
    </antd.Tag>
  );
}

/** writeVia 小标签 + reason 提示（只读回显）。 */
function capMeta(
  cap: HumanModelAccessCapability | null | undefined,
  tr: TrFn,
  t: ThemeColors,
): ReactNS.ReactElement | null {
  if (!cap) return null;
  const via = Array.isArray(cap.writeVia)
    ? cap.writeVia.filter(Boolean).join(" / ")
    : "";
  if (!via && !cap.reason) return null;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
      {via ? (
        <antd.Tag style={{ margin: 0, flexShrink: 0 }}>
          {tr("写入路径：{via}", { via })}
        </antd.Tag>
      ) : null}
      {cap.reason ? (
        <span style={{ fontSize: 11, color: t.textSecondary, minWidth: 0 }}>
          {cap.reason}
        </span>
      ) : null}
    </span>
  );
}

/** (provider, model) 成对字段——目录候选非空 → AutoComplete（可自由输入）；
 * 候选空 → Input 自由输入（目录为空退化路径）。 */
/** 选中态：provider 多选 + model 多选（各自去重保序）。 */
export interface PairSelection {
  providers: string[];
  models: string[];
}

/** 已授权对 → 两个多选的值（回显）。 */
export function pairsToSelection(rows: ModelAccessPair[]): PairSelection {
  const providers: string[] = [];
  const models: string[] = [];
  for (const r of rows) {
    const p = (r.provider ?? "").trim();
    const m = (r.model ?? "").trim();
    if (p && !providers.includes(p)) providers.push(p);
    if (m && !models.includes(m)) models.push(m);
  }
  return { providers, models };
}

/** 多选（先 provider 后 model）可选模型：选中 provider 的并集；
 * 无映射信息 → 全部候选（不误伤自由输入场景）。 */
export function modelOptionsFor(
  sel: PairSelection,
  allModels: string[],
  modelsByProvider?: Record<string, string[]>,
): string[] {
  if (!modelsByProvider || Object.keys(modelsByProvider).length === 0) return allModels;
  if (sel.providers.length === 0) return allModels;
  const out: string[] = [];
  for (const p of sel.providers) {
    for (const m of modelsByProvider[p] ?? []) {
      if (!out.includes(m)) out.push(m);
    }
  }
  return out;
}

/** 多选 → (provider, model) 对。provider 归属优先沿用原对，其次按
 * modelsByProvider 反查（命中多个选中 provider 时取第一个），最后落第一个
 * 选中 provider（无映射时的兜底：单 provider 场景语义正确）。 */
export function selectionToPairs(
  sel: PairSelection,
  prev: ModelAccessPair[],
  modelsByProvider?: Record<string, string[]>,
): ModelAccessPair[] {
  const picked = new Set(sel.providers);
  const out: ModelAccessPair[] = [];
  for (const m of sel.models) {
    const before = prev.find((r) => r.model === m && r.provider);
    let provider = before && picked.has(before.provider) ? before.provider : "";
    if (!provider && modelsByProvider) {
      provider = sel.providers.find((p) => (modelsByProvider[p] ?? []).includes(m)) ?? "";
    }
    if (!provider) provider = sel.providers[0] ?? before?.provider ?? "";
    out.push({ provider, model: m });
  }
  return out;
}

/** entries 编辑器（provider 多选 → model 多选；不再逐行增删）。 */
function EntriesEditor({
  rows,
  canEdit,
  catalog,
  tr,
  t,
  onChange,
}: {
  rows: ModelAccessPair[];
  canEdit: boolean;
  catalog?: ModelCatalogLite | null;
  tr: TrFn;
  t: ThemeColors;
  onChange: (next: ModelAccessPair[]) => void;
}) {
  const modelsByProvider = catalog?.modelsByProvider;
  const allModels = catalog?.models ?? [];
  const providers = catalog?.providers ?? [];

  // 选择态自持：provider 可以「只选不配对」（还没选模型时也要留住选择），
  // 因此不能从 rows 反推——rows 是提交形态，选择是编辑中间态。
  // 选择态自持。外部值变化时按「内容」同步（父组件每次 render 都可能给
  // 新数组引用，按引用比较会把刚选中的 provider 清空）。
  const [sel, setSel] = React.useState<PairSelection>(() => pairsToSelection(rows));
  const emittedRef = React.useRef<string>(JSON.stringify(pairsToSelection(rows)));
  React.useEffect(() => {
    const incoming = JSON.stringify(pairsToSelection(rows));
    if (incoming === emittedRef.current) return; // 自己刚提交的，不回灌
    emittedRef.current = incoming;
    setSel(JSON.parse(incoming) as PairSelection);
  }, [rows]);

  const apply = (next: PairSelection) => {
    setSel(next);
    const pairs = selectionToPairs(next, rows, modelsByProvider);
    emittedRef.current = JSON.stringify(pairsToSelection(pairs));
    onChange(pairs);
  };

  const modelOptions = modelOptionsFor(sel, allModels, modelsByProvider);
  const hasProviders = sel.providers.length > 0;

  if (!canEdit) {
    if (rows.length === 0) {
      return (
        <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("无 entries（空 = 不授权）")}</span>
      );
    }
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {rows.map((r, i) => (
          <antd.Tag key={i} style={{ marginInlineEnd: 0, fontSize: 11 }}>
            {r.provider ? `${r.provider} / ${r.model}` : r.model}
          </antd.Tag>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <antd.Select
        mode="multiple"
        allowClear
        showSearch
        optionFilterProp="label"
        size="small"
        style={{ width: "100%" }}
        placeholder={tr("选择 Provider（可多选，输入可搜索）")}
        options={providers.map((p) => ({ value: p, label: p }))}
        value={sel.providers}
        onChange={(v: string[]) => apply({ providers: v, models: sel.models })}
      />
      <antd.Select
        mode="multiple"
        allowClear
        showSearch
        optionFilterProp="label"
        size="small"
        style={{ width: "100%" }}
        disabled={!hasProviders}
        placeholder={
          hasProviders ? tr("选择模型（可多选，输入可搜索）") : tr("先选 Provider，再选模型")
        }
        options={modelOptions.map((m) => ({ value: m, label: m }))}
        value={sel.models}
        onChange={(v: string[]) => apply({ providers: sel.providers, models: v })}
      />
      {rows.length === 0 ? (
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("未选择 = 不授权（fail-closed）")}
        </span>
      ) : null}
      {rows.some((r) => !r.provider.trim() || !r.model.trim()) ? (
        <span style={{ fontSize: 11, color: "#ff4d4f" }}>
          {tr("Provider 与 model 必须成对填写")}
        </span>
      ) : null}
    </div>
  );
}

/** 共享表内容预览（只读；按 name 缓存 + 回调走 ref，防父渲染重触发拉取）。 */
function TablePreview({
  name,
  tr,
  t,
  getTablePreview,
}: {
  name: string;
  tr: TrFn;
  t: ThemeColors;
  getTablePreview: (n: string) => Promise<ModelAccessPair[]>;
}) {
  const [st, setSt] = React.useState<{ entries: ModelAccessPair[]; err: string } | null>(null);
  const cacheRef = React.useRef(new Map<string, { entries: ModelAccessPair[]; err: string }>());
  const cbRef = React.useRef(getTablePreview);
  cbRef.current = getTablePreview;
  React.useEffect(() => {
    const cached = cacheRef.current.get(name);
    if (cached) {
      setSt(cached);
      return;
    }
    let alive = true;
    setSt(null);
    cbRef.current(name)
      .then((entries) => {
        if (!alive) return;
        const v = { entries, err: "" };
        cacheRef.current.set(name, v);
        setSt(v);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const v = { entries: [], err: e instanceof Error ? e.message : String(e) };
        cacheRef.current.set(name, v);
        setSt(v);
      });
    return () => {
      alive = false;
    };
  }, [name]);
  return (
    <div style={{ fontSize: 11, color: t.textSecondary, display: "grid", gap: 2 }}>
      <span>{tr("共享表内容（只读）")}</span>
      {st === null ? (
        <span>{tr("加载中…")}</span>
      ) : st.err ? (
        <span style={{ color: "#ff4d4f" }}>{st.err}</span>
      ) : st.entries.length ? (
        st.entries.map((p, i) => (
          <span key={i}>
            {p.provider} / {p.model}
          </span>
        ))
      ) : (
        <span>{tr("表为空")}</span>
      )}
    </div>
  );
}

/** 一个 surface 块（标题 + 授权徽标 + 可选右侧控件 + writeVia/reason 回显 + 内容）。 */
function SurfaceBlock({
  title,
  cap,
  tr,
  t,
  right,
  children,
}: {
  title: string;
  cap: HumanModelAccessCapability | null | undefined;
  tr: TrFn;
  t: ThemeColors;
  right?: ReactNS.ReactElement | null;
  children: ReactNS.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.text, flexShrink: 0 }}>
          {title}
        </span>
        {capBadge(cap, tr)}
        {right}
      </div>
      {capMeta(cap, tr, t)}
      {children}
    </div>
  );
}

export default function ModelAccessEditor(props: ModelAccessEditorProps) {
  const { value, capabilities, tables, catalog, onChange, tr, t } = props;
  const readOnly = props.readOnly ?? false;
  const getTablePreview = props.getTablePreview;
  const rawScopes = value?.scopes;
  const scopes: HumanModelAccessScope[] = Array.isArray(rawScopes) ? rawScopes : [];

  const setScopes = (next: HumanModelAccessScope[]) => onChange({ scopes: next });
  const patchScope = (i: number, patch: Partial<HumanModelAccessScope>) =>
    setScopes(scopes.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const removeScope = (i: number) => setScopes(scopes.filter((_, j) => j !== i));
  const addScope = () => setScopes([...scopes, {}]);

  // 分区可编辑（capabilities 不按 scope 细分——同一 surface 所有 scope 同权）。
  const mainEd = capEditable(capabilities?.main, readOnly);
  const spawnEd = capEditable(capabilities?.spawn, readOnly);

  const setCodingCli = (i: number, rec: Record<string, CliSurface | undefined>) =>
    patchScope(i, { codingCli: Object.keys(rec).length ? rec : undefined });
  const setCli = (i: number, cli: string, patch: Partial<CliSurface>) => {
    const rec: Record<string, CliSurface | undefined> = { ...(scopes[i].codingCli ?? {}) };
    const cur = rec[cli] && typeof rec[cli] === "object" ? rec[cli] : {};
    const next: CliSurface = { ...cur, ...patch };
    // 空键即删（entries 无 + inherit 无 = 该 CLI 块不存在）。
    if (!next.inherit && (!next.entries || !next.entries.length)) delete rec[cli];
    else rec[cli] = next;
    setCodingCli(i, rec);
  };
  const renameCli = (i: number, oldKey: string, raw: string) => {
    const rec: Record<string, CliSurface | undefined> = { ...(scopes[i].codingCli ?? {}) };
    const cur = rec[oldKey];
    delete rec[oldKey];
    const nk = raw.trim();
    if (nk && cur) rec[nk] = cur;
    setCodingCli(i, rec);
  };
  const dropCli = (i: number, cli: string) => {
    const rec: Record<string, CliSurface | undefined> = { ...(scopes[i].codingCli ?? {}) };
    delete rec[cli];
    setCodingCli(i, rec);
  };
  // 固定三种 CLI：加的时候直接取「第一个还没选的」，不造 qwen-code-2 这种名字。
  const addCli = (i: number) => {
    const used = Object.keys(scopes[i].codingCli ?? {});
    const next = CLI_IDS.find((id) => !used.includes(id));
    if (!next) return;
    patchScope(i, { codingCli: { ...(scopes[i].codingCli ?? {}), [next]: {} } });
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {scopes.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            border: `1px dashed ${t.border}`,
            borderRadius: 8,
            padding: 10,
          }}
        >
          {tr("未配置作用域（无值 = fail-closed，全部模型锁定）")}
        </div>
      ) : null}
      {scopes.map((scope, i) => {
        const sp = scope.spawn && typeof scope.spawn === "object" ? scope.spawn : undefined;
        const cliEntries = Object.entries(scope.codingCli ?? {}).filter(
          ([, v]) => v && typeof v === "object",
        );
        const scopeTable = (scope.table ?? "").trim();
        return (
          <div
            key={i}
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              padding: 10,
              display: "grid",
              gap: 8,
              background: t.cardBg,
            }}
          >
            {/* 头：序号 + role + 共享表选择 + 删除 */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.text, flexShrink: 0 }}>
                {tr("作用域 {n}", { n: i + 1 })}
              </span>
              <antd.Input
                value={scope.role ?? ""}
                disabled={readOnly}
                placeholder={tr("role（空 = 默认作用域）")}
                style={{ width: 170 }}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  patchScope(i, { role: e.target.value })
                }
                aria-label={tr("role（空 = 默认作用域）")}
              />
              {tables && tables.length ? (
                <antd.Select
                  value={scope.table || undefined}
                  disabled={readOnly}
                  allowClear
                  placeholder={tr("共享表（可选）")}
                  options={tables.map((n: string) => ({ value: n, label: n }))}
                  style={{ width: 170 }}
                  onChange={(v: string | undefined) => patchScope(i, { table: v ?? "" })}
                  aria-label={tr("共享表（可选）")}
                />
              ) : null}
              <span style={{ flex: 1 }} />
              {!readOnly ? (
                <span
                  role="button"
                  aria-label={tr("删除作用域")}
                  onClick={() => removeScope(i)}
                  style={{ cursor: "pointer", color: t.textSecondary, display: "inline-flex" }}
                >
                  <CloseIcon size={14} />
                </span>
              ) : null}
            </div>
            {tables && tables.length ? (
              <span style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("共享表与内联 entries 二选一，内联 entries 优先")}
              </span>
            ) : null}
            {tables && tables.length && scopeTable ? (
              getTablePreview ? (
                <TablePreview name={scopeTable} tr={tr} t={t} getTablePreview={getTablePreview} />
              ) : (
                <span style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("已选共享表：{name}（内联 entries 优先）", { name: scopeTable })}
                </span>
              )
            ) : null}

            {/* main（主模型：无 inherit） */}
            <SurfaceBlock title={tr("主模型")} cap={capabilities?.main} tr={tr} t={t}>
              <EntriesEditor
                rows={scope.main?.entries ?? []}
                canEdit={mainEd}
                catalog={catalog}
                tr={tr}
                t={t}
                onChange={(rows) =>
                  patchScope(i, { main: rows.length ? { entries: rows } : undefined })
                }
              />
            </SurfaceBlock>

            {/* spawn（inherit 开关 + entries） */}
            <SurfaceBlock
              title={tr("spawn / 子代理")}
              cap={capabilities?.spawn}
              tr={tr}
              t={t}
              right={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  <antd.Switch
                    size="small"
                    checked={!!sp?.inherit}
                    disabled={!spawnEd}
                    onChange={(c: boolean) =>
                      patchScope(i, { spawn: { ...(sp ?? {}), inherit: c ? true : undefined } })
                    }
                  />
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {tr("继承主模型（spawn 空值）")}
                  </span>
                </span>
              }
            >
              <EntriesEditor
                rows={sp?.entries ?? []}
                canEdit={spawnEd}
                catalog={catalog}
                tr={tr}
                t={t}
                onChange={(rows) =>
                  patchScope(i, {
                    spawn: { ...(sp ?? {}), entries: rows.length ? rows : undefined },
                  })
                }
              />
            </SurfaceBlock>

            {/* codingCli（per-CLI 块） */}
            <SurfaceBlock
              title="Coding CLI"
              cap={null}
              tr={tr}
              t={t}
              right={
                !readOnly ? (
                  <antd.Button
                    size="small"
                    type="dashed"
                    disabled={Object.keys(scopes[i].codingCli ?? {}).length >= CLI_IDS.length}
                    onClick={() => addCli(i)}
                  >
                    {tr("添加 CLI")}
                  </antd.Button>
                ) : null
              }
            >
              {cliEntries.length === 0 ? (
                <span style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("未配置 Coding CLI 授权")}
                </span>
              ) : (
                cliEntries.map(([cli, v]) => {
                  const vv = v as CliSurface;
                  const cliEd = capEditable(capabilities?.codingCli?.[cli], readOnly);
                  return (
                    <div
                      key={cli}
                      style={{
                        border: `1px dashed ${t.border}`,
                        borderRadius: 6,
                        padding: 8,
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <antd.Select
                          value={cli}
                          disabled={!cliEd}
                          size="small"
                          style={{ width: 180 }}
                          options={[
                            { value: "qwen-code", label: "Qwen Code" },
                            { value: "opencode", label: "OpenCode" },
                            { value: "qoder", label: "Qoder" },
                          ].filter(
                            (o) =>
                              o.value === cli ||
                              !Object.keys(scopes[i].codingCli ?? {}).includes(o.value),
                          )}
                          onChange={(v: string) => renameCli(i, cli, v)}
                          aria-label={tr("Coding CLI")}
                        />
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                          <antd.Switch
                            size="small"
                            checked={!!vv.inherit}
                            disabled={!cliEd}
                            onChange={(c: boolean) => setCli(i, cli, { inherit: c ? true : undefined })}
                          />
                          <span style={{ fontSize: 11, color: t.textSecondary }}>
                            {tr("继承 spawn 模型（CLI 空值）")}
                          </span>
                        </span>
                        {capBadge(capabilities?.codingCli?.[cli], tr)}
                        <span style={{ flex: 1 }} />
                        {!readOnly ? (
                          <span
                            role="button"
                            aria-label={tr("删除 CLI")}
                            onClick={() => dropCli(i, cli)}
                            style={{ cursor: "pointer", color: t.textSecondary, display: "inline-flex" }}
                          >
                            <CloseIcon size={14} />
                          </span>
                        ) : null}
                      </div>
                      {capMeta(capabilities?.codingCli?.[cli], tr, t)}
                      <EntriesEditor
                        rows={vv.entries ?? []}
                        canEdit={cliEd}
                        catalog={catalog}
                        tr={tr}
                        t={t}
                        onChange={(rows) => setCli(i, cli, { entries: rows.length ? rows : undefined })}
                      />
                    </div>
                  );
                })
              )}
            </SurfaceBlock>
          </div>
        );
      })}
      {!readOnly ? (
        <antd.Button type="dashed" size="small" onClick={addScope}>
          {tr("添加作用域")}
        </antd.Button>
      ) : null}
    </div>
  );
}
