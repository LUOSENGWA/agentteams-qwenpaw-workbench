/**
 * ModelEditModal.tsx — 管理页 · 模型配置编辑弹窗（Manager/Worker 详情面板共用）。
 *
 * 子代理模型（QwenPaw >= 2.1.1 专用）：
 * - 开关"与主模型相同"= ON → subagent model 同步主模型 + 选择器 disabled；
 * - OFF → 独立 Model 选择器（同源列表，可选不同后端模型）。
 */
import type * as ReactNS from "react";

import {
  getCliSettings,
  listCodingCli,
  objectModel,
  putCliSettings,
} from "../api/domains/codingcli";
import type {
  CliSettingsResponse,
  CodingCliId,
  CodingCliProbeItem,
  SettingsObject,
} from "../api/domains/codingcli";
import { fetchModelAccess } from "../api/domains/modelAccess";
import type {
  ModelAccessCapability,
  ModelAccessPair,
  ModelAccessPayload,
} from "../api/domains/modelAccess";
import {
  buildCliModelPatch,
  cliCurrentModel,
  cliModelEntries,
} from "../lib/codingCliModel";
import {
  grantedPairs,
  lockedAll,
  pairAllowed,
  surfaceBadge,
} from "../lib/modelAccess";
import { modelGrantErrorText } from "../lib/modelGrantErrors";
import ModelPicker, { type ModelPickerProvider } from "../components/ModelPicker";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  providerForModel,
  providerModelMismatch,
  useModelUnionOptions,
} from "../modelUnion";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type UnionState = ReturnType<typeof useModelUnionOptions>;

export interface ModelEditModalProps {
  open: boolean;
  title: string;
  currentModel: string;
  currentProvider: string;
  /** runtime = qwenpaw 时显示子代理模型区。 */
  runtime?: string;
  /** 当前已保存子代理模型（""=未设/与主模型相同）。 */
  currentSubagentModel?: string;
  union: UnionState;
  saving: boolean;
  /** Worker 名（仅 Worker 详情面板传）→ 渲染「CodingCLI 模型」区块；Manager 不传=不渲染。 */
  workerName?: string;
  /** L1（有 controller token）——Coding CLI 数据面仅 L1 可用。 */
  l1?: boolean;
  onCancel: () => void;
  onSave: (model: string, provider: string, subagentModel: string | null) => Promise<boolean>;
}

export default function ModelEditModal({
  open,
  title,
  currentModel,
  currentProvider,
  runtime,
  currentSubagentModel = "",
  union,
  saving,
  workerName,
  l1,
  onCancel,
  onSave,
}: ModelEditModalProps) {
  const t = useThemeColors();
  const tr = useT();
  const [model, setModel] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [subagentSame, setSubagentSame] = React.useState(true);
  const [subagentModel, setSubagentModel] = React.useState("");
  /** 子代理 Provider：只用于过滤候选/回填，提交仍是子代理 model 名。 */
  const [subagentProvider, setSubagentProvider] = React.useState("");

  const showSubagent = runtime === "qwenpaw";

  React.useEffect(() => {
    if (open) {
      setModel(currentModel);
      setProvider(currentProvider);
      if (!currentSubagentModel) {
        setSubagentSame(true);
        setSubagentModel("");
      } else {
        setSubagentSame(false);
        setSubagentModel(currentSubagentModel);
      }
    }
  }, [open, currentModel, currentProvider, currentSubagentModel]);

  // 开关 ON → 同步主模型值
  React.useEffect(() => {
    if (subagentSame) setSubagentModel(model);
  }, [subagentSame, model]);

  React.useEffect(() => {
    if (open) union.refetchSglang();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // C2（#1513）Model Access 授权信息——仅 Worker 详情（有 workerName）拉取。
  // 404（旧版 controller）/ 其它错误 → access 保持 null =「无授权信息」
  //（行为与现状完全一致，不显示授权 UI；不炸弹窗）。
  const [access, setAccess] = React.useState<ModelAccessPayload | null>(null);

  React.useEffect(() => {
    if (!open || !workerName) {
      setAccess(null);
      return;
    }
    let alive = true;
    setAccess(null);
    fetchModelAccess(workerName)
      .then((r) => {
        if (alive) setAccess(r.access);
      })
      .catch(() => {
        // 非 404 错误同按「无授权信息」降级（不抛、不阻塞现有行为）。
      });
    return () => {
      alive = false;
    };
  }, [open, workerName]);

  // C2：fail-closed（locked 整个弹窗只读）+ main/spawn surface 授予集
  //（空 = 无授予集 → 候选/校验均按现状，兼容旧控制器）。
  // 管理员（L1）不受人员授权表约束：控制器对 SA/管理员返回的是 locked
  // 占位（stub），不能据此把管理员挡在「未授予任何模型」后面——L1 一律
  // 空授予集（候选/校验无限制），与控制器写路径跳过 admin/manager grant
  // 校验对齐。
  const locked = lockedAll(access) && !l1;
  const mainPairs = !l1 && access ? grantedPairs(access.surfaces, "main") : [];
  const spawnPairs = !l1 && access ? grantedPairs(access.surfaces, "spawn") : [];
  // 子代理候选：有授予集 → 只列授予对；否则列目录。Provider 只做过滤。
  const subagentProviderOptions = React.useMemo(() => {
    if (spawnPairs.length > 0) {
      return Array.from(new Set(spawnPairs.map((p) => p.provider))).map((p) => ({
        value: p,
        label: p,
      }));
    }
    return union.providers.map((p) => ({ value: p.name, label: p.name }));
  }, [spawnPairs, union.providers]);
  const subagentModelOptions = React.useMemo(() => {
    if (spawnPairs.length > 0) {
      const pairs = subagentProvider
        ? spawnPairs.filter((p) => p.provider === subagentProvider)
        : spawnPairs;
      return Array.from(new Set(pairs.map((p) => p.model))).map((m) => ({ value: m, label: m }));
    }
    const all = union.options as { value?: string; label?: unknown; options?: unknown[] }[];
    if (!subagentProvider) return all as never;
    // 目录形态：按 provider 归属过滤（providerForModel 只对 alias 有效，
    // 归属不到时保留，避免把可自由输入的值藏掉）。
    const flat: { value: string; label: unknown }[] = [];
    const walk = (arr: unknown[]): void => {
      for (const it of arr) {
        const o = it as { value?: string; label?: unknown; options?: unknown[] };
        if (Array.isArray(o.options)) walk(o.options);
        else if (typeof o.value === "string") flat.push({ value: o.value, label: o.label ?? o.value });
      }
    };
    walk(all);
    const keep = flat.filter((o) => {
      const owner = providerForModel(union.gatewayOptions, o.value);
      return owner === "" || owner === subagentProvider;
    });
    return keep as never;
  }, [spawnPairs, subagentProvider, union.options, union.gatewayOptions]);

  // C2：main surface 有授予集 → 候选只列授予的 (provider, model) 对
  //（provider 列表 = entries 的 provider 去重；选中 provider 后模型列表 =
  // 该 provider 的 entries model；未选 provider → 全部授予 model 去重）；
  // 无 entries → 现状。
  // ModelPicker 的 provider→models：授予模式按授予对；目录模式按 alias 归属。
  const pickerProviders = React.useMemo(() => {
    const map = new Map<string, string[]>();
    const push = (p: string, m: string) => {
      if (!m) return;
      const list = map.get(p) ?? [];
      if (!list.includes(m)) list.push(m);
      map.set(p, list);
    };
    if (mainPairs.length > 0) {
      for (const p of mainPairs) push(p.provider, p.model);
    } else {
      for (const m of union.candidates ?? []) push(providerForModel(union.gatewayOptions, m), m);
    }
    return [...map].map(([name, models]) => ({ name, models }));
  }, [mainPairs, union]);

  const isNarrow = typeof window !== "undefined" && window.innerWidth < 640;
  const fieldsLayout = { display: "grid", gap: 14 } as const;
  const fieldStyle = { width: "100%" } as const;
  const labelStyle = {
    fontSize: isNarrow ? 12 : 14,
    color: t.textSecondary,
    marginBottom: 6,
  };

  const subagentEffective = subagentSame ? "" : subagentModel;
  const dirty =
    model !== currentModel ||
    provider !== currentProvider ||
    subagentEffective !== currentSubagentModel;

  // C2：若要保存的值不在授予集合（例如历史值）→ 允许显示但保存按钮禁用
  //（提示「该组合不在授权范围」）。授予集为空 = 无限制（现状）。
  // subagent 无 Provider 控件 → 按 model 在授予对中是否出现判定。
  const mainPairOk =
    mainPairs.length > 0 ? pairAllowed(mainPairs, provider, model) : true;
  const subagentPairOk =
    spawnPairs.length > 0 && subagentEffective !== ""
      ? spawnPairs.some((p) => p.model === subagentEffective)
      : true;

  const handleOk = async () => {
    // subagentSame=true → ""（显式清除覆盖=回到主模型）
    // subagentSame=false → 选中的模型名（或 null 保持）
    // 非 qwenpaw → null（不传=不影响）
    const sub = showSubagent ? (subagentSame ? "" : (subagentModel || null)) : null;
    await onSave(model, provider, sub);
  };

  return (
    <antd.Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText={tr("保存")}
      cancelText={tr("取消")}
      confirmLoading={saving}
      okButtonProps={{ disabled: !dirty || locked || !mainPairOk || !subagentPairOk }}
      width={Math.min(560, window.innerWidth - 48)}
      destroyOnClose
    >
      <div style={{ display: "grid", gap: 14, padding: "8px 0" }}>
        {/* C2（#1513）：locked → 整个弹窗只读 + 顶部提示；
         * catalogUnavailable → 顶部灰条。 */}
        {locked ? (
          <div
            style={{
              fontSize: 12,
              color: "#cf1322",
              background: "#fff2f0",
              border: "1px solid #ffccc7",
              borderRadius: 4,
              padding: "6px 10px",
            }}
          >
            {tr("当前账号未被授予任何模型，请联系管理员（Model Access）")}
          </div>
        ) : null}
        {access && access.catalogUnavailable === true ? (
          <div
            style={{
              fontSize: 12,
              color: t.textSecondary,
              background: t.cardBg,
              border: `1px solid ${t.border}`,
              borderRadius: 4,
              padding: "6px 10px",
            }}
          >
            {tr("模型目录暂不可用")}
          </div>
        ) : null}
        {/* C1a-1 provider-first：先选 Provider 再选模型——目录方向恒
         * provider → models，且实际转发由 Provider 决定（仅模型 alias
         * 不够）。模型下拉按所选 Provider 过滤（在服+在用恒保留）。 */}
        <div style={fieldsLayout}>
          <div style={fieldStyle}>
            {/* C2：main surface 授权徽标（L1 不受人员授权表约束 → 不显示） */}
            {!l1 ? (
              <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6 }}>
                {accessBadge(access?.capabilities?.main, tr)}
              </div>
            ) : null}
            <ModelPicker
              tr={(x) => tr(x)}
              providers={pickerProviders}
              provider={provider}
              model={model}
              allowEmpty
              readOnly={locked}
              providerPlaceholder={tr("自动（跟随默认）")}
              modelPlaceholder={tr("模型 alias（留空=跟随集群默认）")}
              emptyText={tr("跟随集群默认")}
              onChange={(p, m) => {
                // 目录模式：模型能反查到归属且当前未显式指定 Provider 时回填
                // （显式选择是用户意图，不覆盖）。
                const auto = !p && m ? providerForModel(union.gatewayOptions, m) : "";
                setProvider(auto || p);
                setModel(m);
              }}
            />
            {!mainPairOk ? (
              <div style={{ fontSize: 11, color: "#faad14", marginTop: 4 }}>
                {tr("该组合不在授权范围")}
              </div>
            ) : null}
            {providerModelMismatch(union.gatewayOptions, model, provider) ? (
              <div style={{ fontSize: 11, color: "#faad14", marginTop: 4 }}>
                {tr("该模型不属于所选 Provider（可直接保存，以 Provider 为准）")}
              </div>
            ) : null}
          </div>
        </div>

        {showSubagent ? (
          <div
            style={{
              display: "grid",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 8,
              border: `1px solid ${t.border}`,
              background: t.cardBg,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
                {tr("子代理模型")}
              </span>
              {/* C2：子代理区授权徽标（五态；无授权信息 / L1 → 不显示） */}
              {!l1 ? accessBadge(access?.capabilities?.spawn, tr) : null}
              <antd.Switch size="small" checked={subagentSame} disabled={locked} onChange={(v: boolean) => setSubagentSame(v)} />
              <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("与主模型相同")}</span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {/* 与主模型同一套「先 Provider 再模型」：Provider 只用于过滤
               * 候选与回填，不改变提交字段（子代理只提交 model 名）。 */}
              <div>
                <div style={labelStyle}>{tr("子代理 Provider（留空=跟随主模型 Provider）")}</div>
                <antd.Select
                  style={{ width: "100%" }}
                  size="large"
                  showSearch
                  allowClear
                  disabled={subagentSame || locked}
                  placeholder={tr("自动（跟随）")}
                  value={subagentProvider || undefined}
                  onChange={(v: string) => {
                    // 换 Provider 后旧的子代理模型可能不属于它 → 一并清掉，
                    // 避免提交一对不成立的 (provider, model)。
                    const next = v ?? "";
                    setSubagentProvider(next);
                    if (!subagentModel) return;
                    const allowed =
                      spawnPairs.length > 0
                        ? spawnPairs
                            .filter((p) => !next || p.provider === next)
                            .map((p) => p.model)
                        : null;
                    if (allowed && !allowed.includes(subagentModel)) setSubagentModel("");
                  }}
                  options={subagentProviderOptions}
                />
              </div>
              <div>
                <div style={labelStyle}>{tr("子代理模型（留空=跟随主模型）")}</div>
                <antd.Select
                  style={{ width: "100%" }}
                  size="large"
                  showSearch
                  allowClear
                  disabled={subagentSame || locked}
                  placeholder={subagentSame ? tr("（与主模型相同）") : tr("选择子代理专用模型")}
                  value={subagentSame ? undefined : subagentModel || undefined}
                  onChange={(v: string) => setSubagentModel(v ?? "")}
                  options={subagentModelOptions}
                  filterOption={(input: string, option: any) =>
                    String(option?.label ?? option?.value ?? "").toLowerCase().includes(input.toLowerCase())
                  }
                />
              </div>
              {/* C2：子代理值不在 spawn 授予集 → 提示（保存按钮同禁用） */}
              {!subagentPairOk ? (
                <div style={{ fontSize: 11, color: "#faad14", marginTop: 4 }}>
                  {tr("该组合不在授权范围")}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* C1a-2：CodingCLI 模型区块——仅 Worker（workerName）+ L1 渲染；
         * Manager 详情不传 workerName → 不渲染（自检①）。 */}
        {workerName && l1 ? (
          <CodingCliModelSection
            workerName={workerName}
            mainModel={currentModel}
            subagentModel={currentSubagentModel}
            access={access}
            l1={l1}
            // Worker 主模型 Provider 目录（仅留有候选模型的 provider）→ CLI 模型
            // 弹层追加「· Worker」候选（无 CLI modelProviders 条目时也是真实
            // Provider 选择，不只是跟随）。
            workerProviders={pickerProviders.filter((p) => p.name && p.models.length > 0)}
          />
        ) : null}

        <div
          style={{
            fontSize: 11,
            color: t.textSecondary,
            padding: "6px 10px",
            borderRadius: 4,
            background: t.cardBg,
          }}
        >
          {tr("Provider 决定实际转发目标（仅模型 alias 不够）")}
        </div>
      </div>
    </antd.Modal>
  );
}

/** C2（#1513）：Model Access 授权徽标（五态：可编辑/继承自/只读/未授权/
 * BYOK 不支持）；cap 缺（无授权信息）→ 不渲染。 */
function accessBadge(
  cap: ModelAccessCapability | null | undefined,
  tr: ReturnType<typeof useT>,
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

/** 「跟随 Worker（不指定 baseUrl）」/「跟随子代理」的 Provider 哨兵值
 * （Select option 之一；两者均 = 不写 baseUrl，只把 model 名指向跟随目标）。 */
const FOLLOW_PROVIDER = "~follow~";
const FOLLOW_SPAWN_PROVIDER = "~follow-spawn~";
/** Worker 模型目录候选的 Provider 值前缀（与 CLI modelProviders 条目 id 区分；
 * 保存 = 仅模型 hint，不写 baseUrl，路由仍按 Worker/CLI 默认解析）。 */
const WORKER_PROVIDER_PREFIX = "worker:";

// ── C1a-2：CodingCLI 模型区块（仅 Worker 详情 + L1）────────────────
// 「选 Provider」= 写 model.baseUrl（qwen-code 按 name+baseUrl 成对解析；
// 多 provider 同模型名时 baseUrl 是消歧键，见 lib/codingCliModel 头注）。
// 数据：listCodingCli（探针，只列 installed）→ 逐个 getCliSettings；
// 保存 = putCliSettings(buildCliModelPatch(...)) + 重拉该 CLI 设置。
// provider 定义键（新增 modelProviders 条目）不在本单 → Coding CLI 面板维护（L1）。

function CodingCliModelSection({
  workerName,
  mainModel,
  subagentModel,
  access,
  l1,
  workerProviders,
}: {
  workerName: string;
  mainModel: string;
  /** Worker 当前已保存的子代理模型（"" = 未设/与主模型相同 → 跟随子代理不可用）。 */
  subagentModel: string;
  /** C2（#1513）：Model Access 授权信息（null = 无授权信息 → 现状行为）。 */
  access: ModelAccessPayload | null;
  /** L1（有 controller token）：控制器写路径对 admin/manager 跳过 grant
   * 校验 → 授权徽标/限制不生效（restricted=false）；L2 保持原 grant 门控。 */
  l1: boolean;
  /** Worker 主模型 Provider 目录（可选；缺省 = 修改弹层不列「· Worker」候选）。 */
  workerProviders?: ModelPickerProvider[];
}) {
  const t = useThemeColors();
  const tr = useT();
  // L1 不受人员授权表约束（控制器对 SA/管理员返回 locked 占位/只读 cap，
  // 不能据此把管理员挡在「未授权」后面）。
  const restricted = !l1;
  const [list, setList] = React.useState<CodingCliProbeItem[] | null>(null);
  const [listErr, setListErr] = React.useState("");
  const [settings, setSettings] = React.useState<
    Record<string, CliSettingsResponse | undefined>
  >({});
  const [settingsErr, setSettingsErr] = React.useState<Record<string, string>>({});
  const [editing, setEditing] = React.useState<CodingCliId | null>(null);
  const [reload, setReload] = React.useState(0);

  // 挂载（=弹窗打开）拉取；重试/保存后重拉经 reload 触发同一逻辑。
  React.useEffect(() => {
    let alive = true;
    setList(null);
    setListErr("");
    setSettings({});
    setSettingsErr({});
    listCodingCli(workerName)
      .then((items) => {
        if (!alive) return;
        setList(items);
        for (const p of items) {
          if (!p.installed) continue;
          getCliSettings(workerName, p.cli)
            .then((r) => {
              if (alive) setSettings((prev) => ({ ...prev, [p.cli]: r }));
            })
            .catch((e) => {
              if (alive)
                setSettingsErr((prev) => ({
                  ...prev,
                  [p.cli]: e instanceof Error ? e.message : String(e),
                }));
            });
        }
      })
      .catch((e) => {
        if (alive) setListErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workerName, reload]);

  const retryCli = (cli: CodingCliId) => {
    setSettingsErr((prev) => ({ ...prev, [cli]: "" }));
    getCliSettings(workerName, cli)
      .then((r) => setSettings((prev) => ({ ...prev, [cli]: r })))
      .catch((e) =>
        setSettingsErr((prev) => ({
          ...prev,
          [cli]: e instanceof Error ? e.message : String(e),
        })),
      );
  };

  // 保存成功后重拉该 CLI 设置（putCliSettings 已失效 coding-cli 缓存 → 回源）。
  const refreshCli = (cli: CodingCliId) => {
    getCliSettings(workerName, cli)
      .then((r) => setSettings((prev) => ({ ...prev, [cli]: r })))
      .catch(() => setReload((n) => n + 1));
  };

  const installed = (list ?? []).filter((p) => p.installed);

  // 未装任何 CLI → 不渲染本区块（任务书）。
  if (list !== null && installed.length === 0) return null;

  const sectionStyle = {
    display: "grid",
    gap: 10,
    padding: "12px 14px",
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.cardBg,
  } as const;

  return (
    <div style={sectionStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
          {tr("CodingCLI 模型")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button size="small" type="text" onClick={() => setReload((n) => n + 1)}>
          {tr("刷新")}
        </antd.Button>
      </div>

      {list === null ? (
        listErr ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "red", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={listErr}>
              {listErr}
            </span>
            <antd.Button size="small" onClick={() => setReload((n) => n + 1)}>
              {tr("重试")}
            </antd.Button>
          </div>
        ) : (
          <antd.Spin size="small" />
        )
      ) : (
        installed.map((p) => {
          const err = settingsErr[p.cli] ?? "";
          const s = settings[p.cli];
          const cur = s ? cliCurrentModel(s.settings) : null;
          const modelText = err ? "" : cur && cur.name ? cur.name : tr("未配置");
          // 状态判定（行内展示 + 修改弹层默认 Provider 同源语义）：
          // 无 baseUrl + 名 = 主模型 → 跟随 Worker；无 baseUrl + 名 = 子代理模型
          // （且 ≠ 主模型）→ 跟随子代理；否则 → 独立 / 未配置。
          const status: "none" | "follow" | "follow-spawn" | "indep" =
            !cur || !cur.name
              ? "none"
              : cur.baseUrl === "" && cur.name === mainModel
                ? "follow"
                : cur.baseUrl === "" &&
                    subagentModel !== "" &&
                    cur.name === subagentModel &&
                    subagentModel !== mainModel
                  ? "follow-spawn"
                  : "indep";
          const statusText =
            status === "follow"
              ? tr("跟随 Worker")
              : status === "follow-spawn"
                ? tr("跟随子代理")
                : status === "indep"
                  ? tr("独立")
                  : tr("未配置");
          const rowText =
            status === "none" ? modelText : `${modelText} · ${cur?.providerId ?? statusText}`;
          // C2（#1513）：该 CLI 的授权能力（缺 = 无授权信息 → 现状行为）；
          // L1（restricted=false）不受人员授权表约束 → cap/locked 不消费。
          const cap = restricted ? access?.capabilities?.codingCli?.[p.cli] : undefined;
          const capLocked = restricted && lockedAll(access);
          const capBlocked = restricted && cap ? cap.inherit || !cap.canEdit : false;
          return (
            <div
              key={p.cli}
              style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text, minWidth: 84 }}>
                {p.cli}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: t.textSecondary,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={err || rowText}
              >
                {err ? (
                  <span style={{ color: "red" }}>{err}</span>
                ) : s ? (
                  rowText
                ) : (
                  tr("加载中…")
                )}
              </span>
              <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                {statusText}
              </span>
              {/* C2：该 CLI 授权徽标（五态；inherit → 「继承自 …」且编辑禁用；
               * L1 不受人员授权表约束 → 不显示） */}
              {restricted ? accessBadge(cap, tr) : null}
              {err ? (
                <antd.Button size="small" onClick={() => retryCli(p.cli)}>
                  {tr("重试")}
                </antd.Button>
              ) : (
                // C2：locked / inherit / !canEdit → 编辑禁用（无授权信息 → 现状；L1 不受限）
                <antd.Button
                  size="small"
                  disabled={!s || capLocked || capBlocked}
                  title={
                    !s
                      ? tr("未安装该 Coding CLI")
                      : capLocked
                        ? tr("未授权：无法修改 CodingCLI 模型")
                        : cap?.inherit
                          ? tr("授权要求该 CLI 跟随主模型，不能独立配置")
                          : cap && !cap.canEdit
                            ? tr("无权限修改该 CLI 模型")
                            : undefined
                  }
                  onClick={() => setEditing(p.cli)}
                >
                  {tr("修改")}
                </antd.Button>
              )}
            </div>
          );
        })
      )}

      {editing && settings[editing] ? (
        <CliModelEditDialog
          workerName={workerName}
          cli={editing}
          settings={settings[editing] as CliSettingsResponse}
          mainModel={mainModel}
          subagentModel={subagentModel}
          // L1：空授予集 → ModelPicker 无限制（候选取 CLI modelProviders
          // 条目并集 + 自由输入）；L2 保持原授予对。
          pairs={
            restricted && access
              ? grantedPairs(access.surfaces, "codingCli", editing)
              : []
          }
          workerProviders={workerProviders}
          onClose={() => setEditing(null)}
          onSaved={() => refreshCli(editing)}
        />
      ) : null}
    </div>
  );
}

// 修改弹层（先 Provider 后模型）：Provider 选项 = 「跟随 Worker」+「跟随子代理」
// + cliModelEntries() 条目（显示 id · baseUrl）+ Worker 模型目录候选
// （值 worker:<name>、label「<name> · Worker」；不写 baseUrl，只把 model 名
// 指向所选 Worker Provider 的模型）；模型选项 = 跟随模式仅跟随目标（只读/
// 选中）、独立 = 所选 Provider 声明的 models + 自由输入。
// 「跟随」= 不指定 baseUrl，把 model 名写成 Worker 主模型 / 子代理模型。
function CliModelEditDialog({
  workerName,
  cli,
  settings,
  mainModel,
  subagentModel,
  pairs,
  workerProviders,
  onClose,
  onSaved,
}: {
  workerName: string;
  cli: CodingCliId;
  settings: CliSettingsResponse;
  /** Worker 主模型（「跟随 Worker」的目标）。 */
  mainModel: string;
  /** Worker 已保存的子代理模型（「跟随子代理」的目标；空 = 选项禁用）。 */
  subagentModel: string;
  /** C2（#1513）：该 CLI surface 的授予 (provider, model) 对（空 = 无授予集 → 现状）。 */
  pairs: ModelAccessPair[];
  /** Worker 主模型 Provider 目录（可选；缺省 = 不列「· Worker」候选）。
   * 有授予集（L2）时不列——授予对是唯一候选源（语义不变）。 */
  workerProviders?: ModelPickerProvider[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const isObject = objectModel(cli);
  const entries = cliModelEntries(settings.settings);
  const cur = cliCurrentModel(settings.settings);

  // 默认 Provider：当前 baseUrl 命中独立条目 → 该 provider；
  // 否则模型 = 子代理模型（且 ≠ 主模型）→ 跟随子代理；否则 → 跟随 Worker。
  const initialProvider =
    cur.providerId ??
    (subagentModel !== "" && cur.name === subagentModel && subagentModel !== mainModel
      ? FOLLOW_SPAWN_PROVIDER
      : FOLLOW_PROVIDER);
  const [provider, setProvider] = React.useState<string>(initialProvider);
  const [model, setModel] = React.useState(
    initialProvider === FOLLOW_PROVIDER
      ? mainModel
      : initialProvider === FOLLOW_SPAWN_PROVIDER
        ? subagentModel
        : cur.name,
  );
  const [saving, setSaving] = React.useState(false);

  // 孤儿 baseUrl：有值但反查不到任何 provider 条目（手工改过）→ 行内提示
  // provider 条目由面板维护。
  const orphaned = cur.baseUrl !== "" && cur.providerId === null;
  const isFollow = provider === FOLLOW_PROVIDER || provider === FOLLOW_SPAWN_PROVIDER;
  const followTarget =
    provider === FOLLOW_PROVIDER ? mainModel : provider === FOLLOW_SPAWN_PROVIDER ? subagentModel : "";
  const chosen = isFollow ? null : (entries.find((e) => e.id === provider) ?? null);
  const allModels = Array.from(new Set(entries.flatMap((e) => e.models)));

  // C2（#1513）：有授予集 → 候选只列授予的 (provider, model) 对（方向
  // provider → models）；无 → 现状。
  const granted = pairs.length > 0;
  const grantedProviders = granted
    ? Array.from(new Set(pairs.map((p) => p.provider)))
    : [];

  // Worker 模型目录候选（值 = worker:<name>、label = <name> · Worker）：
  // 有授予集时不列（授予对是唯一候选源，L2 语义不变）；CLI modelProviders
  // 已有同 id 条目 → 不重复列（CLI 条目带 baseUrl 优先）。
  const workerOptions: ModelPickerProvider[] = granted
    ? []
    : (workerProviders ?? [])
        .filter((wp) => wp.name && (wp.models?.length ?? 0) > 0)
        .filter((wp) => !entries.some((e) => e.id === wp.name))
        .map((wp) => ({
          name: `${WORKER_PROVIDER_PREFIX}${wp.name}`,
          label: `${wp.label ?? wp.name} · Worker`,
          models: wp.models ?? [],
        }));

  // 唯一 ModelPicker 的候选：跟随哨兵 → 仅跟随目标；独立 provider → 声明
  // models；Worker 候选 → 该 Worker provider 的模型列表。有授予集时独立
  // 候选只列授予的对（C2/#1513 语义不变）。
  const modelOptionsFor = (pid: string): string[] => {
    const w = workerOptions.find((x) => x.name === pid);
    if (w) return (w.models ?? []).filter((m, i, a) => a.indexOf(m) === i);
    return (
      granted
        ? pairs.filter((p) => p.provider === pid).map((p) => p.model)
        : (entries.find((x) => x.id === pid)?.models ?? allModels)
    ).filter((m, i, a) => a.indexOf(m) === i);
  };
  const providerLabel = (id: string): string => {
    const e = entries.find((x) => x.id === id);
    return e?.baseUrl ? `${id} · ${e.baseUrl}` : id;
  };
  const pickerProviders: ModelPickerProvider[] = [
    {
      name: FOLLOW_PROVIDER,
      label: tr("跟随 Worker"),
      models: mainModel ? [mainModel] : [],
    },
    {
      name: FOLLOW_SPAWN_PROVIDER,
      label: tr("跟随子代理"),
      models: subagentModel ? [subagentModel] : [],
      disabled: subagentModel === "",
    },
    ...(granted ? grantedProviders : entries.map((e) => e.id)).map((id) => ({
      name: id,
      label: providerLabel(id),
      models: modelOptionsFor(id),
    })),
    ...workerOptions,
  ];

  // 跟随模式：模型恒为跟随目标（展示只读/选中；清空也弹回目标）；
  // 独立模式 = 用户所选/输入。
  const shownModel = isFollow ? followTarget : model;
  const saveModel = isFollow ? followTarget : model.trim();

  // C2：要保存的值不在授予集合（例如历史值）→ 保存禁用 + 提示。
  // 跟随模式无 provider 维度 → 仅目标模型在授予对中即可；独立对象形态须
  // (provider, model) 成对存在；扁平形态看 model 是否在授予对中出现。
  const pairOk = granted
    ? isFollow || !isObject
      ? pairs.some((p) => p.model === saveModel)
      : pairAllowed(pairs, provider, saveModel)
    : true;

  const labelStyle = { fontSize: 13, color: t.textSecondary, marginBottom: 6 } as const;

  const handleSave = async () => {
    // 跟随模式恒写跟随目标（不受模型框影响）；独立模式 = 所选/输入模型。
    const name = isFollow ? followTarget : model.trim();
    if (!name) return;
    setSaving(true);
    try {
      // 跟随 = 不写 baseUrl（qwen-code 按第一个同 id 条目解析）；
      // 独立 = 该 provider 的 baseUrl 消歧。
      const patch = buildCliModelPatch(
        cli,
        (settings.settings as Record<string, unknown>).model,
        name,
        isFollow ? "" : chosen ? chosen.baseUrl : "",
      );
      // buildCliModelPatch 返回 Record<string, unknown>（纯函数宽口）；此处
      // 补丁只含 model 键（string | 纯 JSON 对象）= 合法 SettingsObject。
      await putCliSettings(workerName, cli, patch as SettingsObject);
      antd.message.success(tr("已保存"));
      onSaved();
      onClose();
    } catch (e) {
      // #1514：grant 错误走统一文案；其余原样提示（不吞错）。
      antd.message.error(
        modelGrantErrorText(e, tr) ??
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <antd.Modal
      title={`${cli} · ${tr("CodingCLI 模型")}`}
      open
      onCancel={onClose}
      onOk={handleSave}
      okText={tr("保存")}
      cancelText={tr("取消")}
      confirmLoading={saving}
      okButtonProps={{ disabled: saving || saveModel === "" || !pairOk }}
      destroyOnClose
      width={Math.min(480, window.innerWidth - 48)}
    >
      <div style={{ display: "grid", gap: 14, padding: "8px 0" }}>
        {isObject ? null : (
          <div style={{ fontSize: 11, color: "#faad14" }}>
            {tr("该 CLI 不支持 Provider 维度（扁平模型名）")}
          </div>
        )}
        {isObject && entries.length === 0 ? (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {workerOptions.length > 0
              ? tr("CLI settings 暂无 modelProviders 条目；可选 Worker Provider 候选（只写模型名，不写 baseUrl），或跟随 Worker / 子代理。")
              : tr("当前没有独立 Provider 条目；可跟随 Worker / 子代理，或在 Coding CLI settings 里配置 modelProviders。")}
          </div>
        ) : isObject && orphaned ? (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("Provider 条目由 Coding CLI 面板维护（L1）")}
          </div>
        ) : null}
        {isObject && entries.length > 0 && workerOptions.length > 0 ? (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("带「· Worker」后缀 = Worker 模型目录候选（只写模型名，不写 baseUrl；路由仍按 CLI/Worker 默认）。")}
          </div>
        ) : null}
        <div>
          <div style={labelStyle}>{tr("模型")}</div>
          <ModelPicker
            tr={tr}
            allowEmpty
            providers={pickerProviders}
            provider={provider}
            model={shownModel}
            providerPlaceholder={tr("Provider")}
            modelPlaceholder={tr("模型")}
            onChange={(p: string, m: string) => {
              setProvider(p);
              // 跟随模式：模型恒为跟随目标（ModelPicker 的 keep 清空不适用）；
              // 独立模式：沿用 ModelPicker 的换 Provider 清空判定。
              if (p === FOLLOW_PROVIDER || p === FOLLOW_SPAWN_PROVIDER) {
                setModel(p === FOLLOW_PROVIDER ? mainModel : subagentModel);
              } else {
                setModel(m);
              }
            }}
          />
          {/* 跟随目标未设置 → 保存禁用 + 提示（跟随子代理空目标时选项本身已禁用） */}
          {isFollow && followTarget === "" ? (
            <div style={{ fontSize: 11, color: "#faad14", marginTop: 4 }}>
              {tr("跟随目标模型未设置，无法保存")}
            </div>
          ) : null}
          {/* C2：要保存的组合不在授予集 → 提示（保存按钮同禁用） */}
          {!pairOk ? (
            <div style={{ fontSize: 11, color: "#faad14", marginTop: 4 }}>
              {tr("该组合不在授权范围")}
            </div>
          ) : null}
        </div>
      </div>
    </antd.Modal>
  );
}
