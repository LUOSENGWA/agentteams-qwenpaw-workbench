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
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  filterModelOptionsByProvider,
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
  // 占位（stub），不能据此把管理员挡在「未授予任何模型」后面。
  const locked = lockedAll(access) && !l1;
  const mainPairs = access ? grantedPairs(access.surfaces, "main") : [];
  const spawnPairs = access ? grantedPairs(access.surfaces, "spawn") : [];
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
  const providerOptions =
    mainPairs.length > 0
      ? Array.from(new Set(mainPairs.map((p) => p.provider))).map((name) => ({
          value: name,
          label: name,
        }))
      : union.providers.map((p) => ({ value: p.name, label: p.name }));

  const modelOptions =
    mainPairs.length > 0
      ? (provider
          ? mainPairs.filter((p) => p.provider === provider)
          : mainPairs
        )
          .map((p) => p.model)
          .filter((m, i, a) => a.indexOf(m) === i)
          .map((m) => ({ value: m, label: m }))
      : filterModelOptionsByProvider(
          union.options,
          union.gatewayOptions,
          provider,
        );

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
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 6 }}>
              {tr("Provider")}
              {/* C2：主模型区授权徽标（五态；无授权信息 → 不显示） */}
              {accessBadge(access?.capabilities?.main, tr)}
            </div>
            <antd.Select
              style={{ width: "100%" }}
              size="large"
              showSearch
              allowClear
              disabled={locked}
              placeholder={tr("自动（跟随默认）")}
              value={provider || undefined}
              onChange={(v: string) => setProvider(v ?? "")}
              options={providerOptions}
            />
          </div>
          <div style={fieldStyle}>
            <div style={labelStyle}>{tr("模型")}</div>
            <antd.AutoComplete
              style={{ width: "100%" }}
              size="large"
              allowClear
              disabled={locked}
              placeholder={tr("模型 alias（留空=跟随集群默认）")}
              value={model}
              options={modelOptions}
              onChange={(v: string) => {
                setModel(v ?? "");
                // C1a-1：configured alias → binding.providerName 仅当
                // Provider 当前为空才回填（显式 Provider 是用户意图，
                // 不覆盖）。
                const auto = providerForModel(union.gatewayOptions, v ?? "");
                if (auto && !provider) setProvider(auto);
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
              {/* C2：子代理区授权徽标（五态；无授权信息 → 不显示） */}
              {accessBadge(access?.capabilities?.spawn, tr)}
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
                  onChange={(v: string) => setSubagentProvider(v ?? "")}
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
          <CodingCliModelSection workerName={workerName} mainModel={currentModel} access={access} />
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

/** 「跟随 Worker（不指定 baseUrl）」的 Provider 哨兵值（Select option 之一）。 */
const FOLLOW_PROVIDER = "~follow~";

// ── C1a-2：CodingCLI 模型区块（仅 Worker 详情 + L1）────────────────
// 「选 Provider」= 写 model.baseUrl（qwen-code 按 name+baseUrl 成对解析；
// 多 provider 同模型名时 baseUrl 是消歧键，见 lib/codingCliModel 头注）。
// 数据：listCodingCli（探针，只列 installed）→ 逐个 getCliSettings；
// 保存 = putCliSettings(buildCliModelPatch(...)) + 重拉该 CLI 设置。
// provider 定义键（新增 modelProviders 条目）不在本单 → Coding CLI 面板维护（L1）。

function CodingCliModelSection({
  workerName,
  mainModel,
  access,
}: {
  workerName: string;
  mainModel: string;
  /** C2（#1513）：Model Access 授权信息（null = 无授权信息 → 现状行为）。 */
  access: ModelAccessPayload | null;
}) {
  const t = useThemeColors();
  const tr = useT();
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
          const status =
            !cur || !cur.name ? "none" : cur.name === mainModel ? "follow" : "indep";
          // C2（#1513）：该 CLI 的授权能力（缺 = 无授权信息 → 现状行为）。
          const cap = access?.capabilities?.codingCli?.[p.cli];
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
                title={err || `${modelText} · ${cur?.providerId ?? tr("跟随 Worker")}`}
              >
                {err ? (
                  <span style={{ color: "red" }}>{err}</span>
                ) : s ? (
                  `${modelText} · ${cur?.providerId ?? tr("跟随 Worker")}`
                ) : (
                  tr("加载中…")
                )}
              </span>
              <antd.Tag
                color={status === "follow" ? "blue" : status === "indep" ? "orange" : "default"}
                style={{ margin: 0, flexShrink: 0 }}
              >
                {status === "follow"
                  ? tr("跟随主模型")
                  : status === "indep"
                    ? tr("独立")
                    : tr("未配置")}
              </antd.Tag>
              {/* C2：该 CLI 授权徽标（五态；inherit → 「继承自 …」且编辑禁用） */}
              {accessBadge(cap, tr)}
              {err ? (
                <antd.Button size="small" onClick={() => retryCli(p.cli)}>
                  {tr("重试")}
                </antd.Button>
              ) : (
                // C2：locked / inherit / !canEdit → 编辑禁用（无授权信息 → 现状）
                <antd.Button
                  size="small"
                  disabled={!s || lockedAll(access) || (cap ? cap.inherit || !cap.canEdit : false)}
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
          pairs={
            access ? grantedPairs(access.surfaces, "codingCli", editing) : []
          }
          onClose={() => setEditing(null)}
          onSaved={() => refreshCli(editing)}
        />
      ) : null}
    </div>
  );
}

// 修改弹层（先 Provider 后模型）：Provider 选项 = cliModelEntries() 条目
// （显示 id · baseUrl）+「跟随 Worker」；模型选项 = 所选 Provider 声明的
// models + 自由输入（AutoComplete）。「跟随 Worker」= 不指定 baseUrl（候选
// 取全部 provider 声明并集——无 baseUrl 时按第一个同 id 条目解析，任何
// provider 的模型名都合法）。
function CliModelEditDialog({
  workerName,
  cli,
  settings,
  pairs,
  onClose,
  onSaved,
}: {
  workerName: string;
  cli: CodingCliId;
  settings: CliSettingsResponse;
  /** C2（#1513）：该 CLI surface 的授予 (provider, model) 对（空 = 无授予集 → 现状）。 */
  pairs: ModelAccessPair[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const isObject = objectModel(cli);
  const entries = cliModelEntries(settings.settings);
  const cur = cliCurrentModel(settings.settings);
  const [provider, setProvider] = React.useState<string>(cur.providerId ?? FOLLOW_PROVIDER);
  const [model, setModel] = React.useState(cur.name);
  const [saving, setSaving] = React.useState(false);

  // 孤儿 baseUrl：有值但反查不到任何 provider 条目（手工改过）→ 只能自由
  // 输入模型（等价“不指定 baseUrl”），行内提示 provider 条目由面板维护。
  const orphaned = cur.baseUrl !== "" && cur.providerId === null;
  const chosen =
    provider === FOLLOW_PROVIDER
      ? null
      : (entries.find((e) => e.id === provider) ?? null);
  const allModels = Array.from(new Set(entries.flatMap((e) => e.models)));

  // C2（#1513）：有授予集 → 候选只列授予的 (provider, model) 对（方向
  // provider → models）；无 → 现状。
  const granted = pairs.length > 0;
  const grantedProviders = granted
    ? Array.from(new Set(pairs.map((p) => p.provider)))
    : [];
  const grantedModels = granted
    ? Array.from(new Set(pairs.map((p) => p.model)))
    : [];

  const providerOptions = [
    { value: FOLLOW_PROVIDER, label: tr("跟随 Worker") },
    ...(granted
      ? grantedProviders.map((id) => {
          const e = entries.find((x) => x.id === id);
          return { value: id, label: e?.baseUrl ? `${id} · ${e.baseUrl}` : id };
        })
      : entries.map((e) => ({
          value: e.id,
          label: e.baseUrl ? `${e.id} · ${e.baseUrl}` : e.id,
        }))),
  ];

  const modelOptions = (
    granted
      ? provider === FOLLOW_PROVIDER
        ? grantedModels
        : pairs.filter((p) => p.provider === provider).map((p) => p.model)
      : chosen
        ? chosen.models
        : allModels
  )
    .filter((m, i, a) => a.indexOf(m) === i)
    .map((m) => ({
      value: m,
      label: m,
    }));

  // C2：要保存的值不在授予集合（例如历史值）→ 保存禁用 + 提示。
  // 对象形态：须显式 provider（跟随 Worker = 不指定 baseUrl，不成对）+
  // (provider, model) 成对存在；扁平形态：model 在授予对中是否出现。
  const saveModel = model.trim();
  const pairOk = granted
    ? isObject
      ? provider !== FOLLOW_PROVIDER && pairAllowed(pairs, provider, saveModel)
      : pairs.some((p) => p.model === saveModel)
    : true;

  const labelStyle = { fontSize: 13, color: t.textSecondary, marginBottom: 6 } as const;

  const handleSave = async () => {
    const name = model.trim();
    if (!name) return;
    setSaving(true);
    try {
      const patch = buildCliModelPatch(
        cli,
        (settings.settings as Record<string, unknown>).model,
        name,
        chosen ? chosen.baseUrl : "",
      );
      // buildCliModelPatch 返回 Record<string, unknown>（纯函数宽口）；此处
      // 补丁只含 model 键（string | 纯 JSON 对象）= 合法 SettingsObject。
      await putCliSettings(workerName, cli, patch as SettingsObject);
      antd.message.success(tr("已保存"));
      onSaved();
      onClose();
    } catch (e) {
      // 失败原样提示（不吞错）。
      antd.message.error(e instanceof Error ? e.message : String(e));
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
      okButtonProps={{ disabled: saving || model.trim() === "" || !pairOk }}
      destroyOnClose
      width={Math.min(480, window.innerWidth - 48)}
    >
      <div style={{ display: "grid", gap: 14, padding: "8px 0" }}>
        {isObject ? (
          <div>
            <div style={labelStyle}>{tr("Provider")}</div>
            <antd.Select
              style={{ width: "100%" }}
              size="large"
              showSearch
              value={provider}
              options={providerOptions}
              onChange={(v: string) => setProvider(v)}
            />
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#faad14" }}>
            {tr("该 CLI 不支持 Provider 维度（扁平模型名）")}
          </div>
        )}
        {isObject && (entries.length === 0 || orphaned) ? (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("Provider 条目由 Coding CLI 面板维护（L1）")}
          </div>
        ) : null}
        <div>
          <div style={labelStyle}>{tr("模型")}</div>
          <antd.AutoComplete
            style={{ width: "100%" }}
            size="large"
            allowClear
            placeholder={tr("模型")}
            value={model}
            options={modelOptions}
            onChange={(v: string) => setModel(v ?? "")}
          />
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
