// CrdManage 拆分（QC-196 方案 §5.2）· 配置团队弹窗（PUT 部分更新 + 批量
// 模型画笔 + 团队技能 SkillCenter onlyTeam 内嵌）——原主组件 JSX R7 逐字
// 搬移；props = 原闭包变量名（零改写）。

import type * as ReactNS from "react";

import type { AdminData, TeamInfo } from "../api";
import { modelVerdictText, validateModelValue } from "../modelUnion";
import type { LlmProviderLite, ModelSelectionOption } from "../modelCatalog";
import ModelSettingsModal from "../manage/ModelSettingsModal";
import type { ModelDraft, ProviderOption } from "../lib/modelDraft";
import {
  buildLocalProviderOptions,
  draftFromRow,
  LOCAL_PROVIDER,
  rowFromDraft,
} from "./modelPanelWiring";
import LlmTuningFields from "../components/LlmTuningFields";
import { findLlmTuningError, type LlmTuningKey } from "../lib/llm-tuning";
import type { ThemeColors } from "../theme";
import {
  BrainIcon,
  BrickIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  PlusIcon,
  TeamIcon,
  UsersIcon,
  WarnIcon,
} from "../components/icons";
import SkillCenter from "../components/SkillCenter";
import { WbTooltip } from "../components/WbTooltip";
import { useWbViewport } from "../WbViewportContext";
import FieldLabel from "./FieldLabel";
import { WorkerRowSelects } from "./WorkerRowSelects";
import type { CfgBatchModel, TeamCfgForm, TrFn, WorkerRow } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


interface CrdCfgModalProps {
  cfgTeam: TeamInfo | null;
  cfgOpen: boolean;
  cfg: TeamCfgForm;
  cfgRows: WorkerRow[];
  cfgBusy: boolean;
  setCfgOpen: ReactNS.Dispatch<ReactNS.SetStateAction<boolean>>;
  setCfgTeam: ReactNS.Dispatch<ReactNS.SetStateAction<TeamInfo | null>>;
  setCfg: ReactNS.Dispatch<ReactNS.SetStateAction<TeamCfgForm>>;
  setCfgBatchModel: ReactNS.Dispatch<ReactNS.SetStateAction<CfgBatchModel>>;
  updateCfgRow: (i: number, patch: Partial<WorkerRow>) => void;
  removeCfgRow: (i: number) => void;
  addCfgRow: () => void;
  cfgBatchModel: CfgBatchModel;
  applyCfgBatch: (
    kind: "leader" | "workers",
    model: string,
    provider: string,
  ) => void;
  cfgBatchLeaderCount: number;
  cfgBatchWorkerCount: number;
  doCfg: () => void | Promise<void>;
  /** 在服 Workers（成员行换人时取现值模型做基线）。 */
  workers: AdminData["workers"];
  workerNames: string[];
  modelOptions: { value: string }[];
  modelCandidates: string[];
  /** Higress Provider 名单（批量画笔 provider 候选——useModelCatalog
   * 既有取数透传，零新增请求）。 */
  providers: LlmProviderLite[];
  /** 网关 alias 原始选项（alias→binding.providerName；批量画笔按所选
   * Provider 过滤模型候选用）。 */
  gatewayOptions: ModelSelectionOption[];
  tr: TrFn;
  t: ThemeColors;
}

/** 团队设置分区键（顺序 = 渲染顺序）：基本信息 / LLM 调优 / 团队成员 / 团队技能。 */
export const CFG_SECTION_KEYS = ["basic", "llm", "members", "skills"] as const;

/** 默认展开的分区——技能中心（目录/矩阵/MCP）体量大且非高频，默认收起。 */
export const CFG_SECTIONS_OPEN: string[] = ["basic", "llm", "members"];

/** 分区标题（Collapse header 内容）：图标 + 标题 + 可选徽标 / 副标题说明。
 * 团队设置四段与「加入 Worker」共用一套几何，避免各段标题风格漂移。 */
export function CfgSectionLabel({
  icon,
  title,
  hint,
  badge,
  t,
}: {
  icon: ReactNS.ReactNode;
  /** 已 tr 的标题。 */
  title: string;
  /** 已 tr 的副标题（11px 次级色）。 */
  hint?: string;
  /** 可选徽标（如「3 人」）。 */
  badge?: string;
  t: ThemeColors;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {icon}
        {title}
      </span>
      {badge ? (
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            padding: "0 7px",
          }}
        >
          {badge}
        </span>
      ) : null}
      {hint ? (
        <span style={{ fontSize: 11, color: t.textSecondary }}>{hint}</span>
      ) : null}
    </span>
  );
}

/** 模型单元格只读摘要 chip（11.7 统一模型弹窗接线）：值空 → placeholder
 * 次级色；changed → 橙框（原 AutoComplete 改动态同色）；校验 error/warn
 * → 红/橙 Tag（tooltip 候选列表，与改造前行内同口径同文案）。
 * prefix（批量「provider / 模型」摘要）只参与展示、不参与校验。 */
function ModelCellChip({
  value,
  prefix,
  placeholder,
  changed,
  showVerdict = true,
  tr,
  t,
  candidates,
  narrow,
  flex,
}: {
  value?: string;
  prefix?: string;
  placeholder?: string;
  changed?: boolean;
  /** 改动前不显示校验 Tag（行内模型格旧行为）；缺省恒显。 */
  showVerdict?: boolean;
  tr: TrFn;
  t: ThemeColors;
  candidates: string[];
  /** 窄屏：摘要宽度跟随容器（不再钉死 240px）。 */
  narrow?: boolean;
  /** 摘要外框 flex 简写（成员行 1 1 180px、批量格 1 1 140px）。 */
  flex?: ReactNS.CSSProperties["flex"];
}) {
  const v = (value || "").trim();
  const pv = (prefix || "").trim();
  const verdict = v ? validateModelValue(v, candidates) : null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        minWidth: 0,
        flex: flex ?? 1,
      }}
    >
      <span
        title={v || undefined}
        style={{
          fontSize: 12,
          color: v ? t.text : t.textSecondary,
          border: changed ? "1px solid #fa8c16" : `1px dashed ${t.border}`,
          borderRadius: 6,
          padding: "3px 8px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: narrow ? "100%" : 240,
          minWidth: 0,
        }}
      >
        {v ? (pv ? `${pv} / ${v}` : v) : (placeholder || "")}
      </span>
      {verdict && verdict.level !== "ok" && showVerdict ? (
        <WbTooltip title={modelVerdictText(tr, verdict, v, candidates)}>
          <antd.Tag color={verdict.level === "error" ? "red" : "orange"} style={{ marginInlineEnd: 0 }}>
            {verdict.level === "error" ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <CloseIcon size={10} /> {tr("路径形态")}
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <WarnIcon size={10} /> {tr("未命中")}
              </span>
            )}
          </antd.Tag>
        </WbTooltip>
      ) : null}
    </div>
  );
}

/** 配置团队表单本体（10/29 管理页评审——弹窗内容抽取为具名导出：
 * CrdManage 走原 antd.Modal 壳（行为不变），管理页「团队设置」三栏
 * 走内联渲染，同一份表单零行为分叉）。props = 原闭包变量名。 */
export interface CrdCfgFormProps {
  cfgTeam: TeamInfo;
  cfg: TeamCfgForm;
  cfgRows: WorkerRow[];
  cfgBusy: boolean;
  setCfg: ReactNS.Dispatch<ReactNS.SetStateAction<TeamCfgForm>>;
  setCfgBatchModel: ReactNS.Dispatch<ReactNS.SetStateAction<CfgBatchModel>>;
  updateCfgRow: (i: number, patch: Partial<WorkerRow>) => void;
  removeCfgRow: (i: number) => void;
  addCfgRow: () => void;
  cfgBatchModel: CfgBatchModel;
  applyCfgBatch: (
    kind: "leader" | "workers",
    model: string,
    provider: string,
  ) => void;
  cfgBatchLeaderCount: number;
  cfgBatchWorkerCount: number;
  /** 在服 Workers（成员行换人时取现值模型做基线）。 */
  workers: AdminData["workers"];
  workerNames: string[];
  modelOptions: { value: string }[];
  modelCandidates: string[];
  /** Higress Provider 名单（批量画笔 provider 候选——useModelCatalog
   * 既有取数透传，零新增请求）。 */
  providers: LlmProviderLite[];
  /** 网关 alias 原始选项（alias→binding.providerName；批量画笔按所选
   * Provider 过滤模型候选用）。 */
  gatewayOptions: ModelSelectionOption[];
  tr: TrFn;
  t: ThemeColors;
}

export function CrdCfgForm({
  cfgTeam,
  cfg,
  cfgRows,
  cfgBusy,
  setCfg,
  setCfgBatchModel,
  updateCfgRow,
  removeCfgRow,
  addCfgRow,
  cfgBatchModel,
  applyCfgBatch,
  cfgBatchLeaderCount,
  cfgBatchWorkerCount,
  workers,
  workerNames,
  modelOptions,
  modelCandidates,
  providers,
  gatewayOptions,
  tr,
  t,
}: CrdCfgFormProps) {
  // ── 11.7 统一模型弹窗接线（ModelSettingsModal × 团队设置入口）────────
  // 模型单元格 = 只读摘要 + 编辑：弹窗预填当前值，保存只写回本表单本地
  // state（cfg / cfgRows / cfgBatchModel），**不发任何请求**——写链
  // （预写校验 + diff + updateTeam / 逐改动行模型对下发）仍由「保存」
  // = doCfg 统一提交（零新端点、零字段名变化）。
  type ModelPanelTarget =
    | { kind: "subagent" }
    | { kind: "row"; index: number }
    | { kind: "batch"; batch: "leader" | "workers" };
  const [modelPanel, setModelPanel] =
    React.useState<ModelPanelTarget | null>(null);

  // Provider 目录：真实 Higress provider（modelMapping 键 + 路由绑定
  // alias）+ 「在服+在用」哨兵组（原 AutoComplete 数据源，保原入口自由
  // 选择能力）。
  const panelProviders: ProviderOption[] = React.useMemo(
    () =>
      buildLocalProviderOptions(
        providers,
        gatewayOptions,
        modelOptions.map((o) => o.value),
      ),
    [providers, gatewayOptions, modelOptions],
  );

  // 按目标取当前值 → 弹窗预填草稿（provider 解析序：已刷值 > alias
  // 绑定 > 哨兵；subagent 无 provider 字段 → 绑定 / 哨兵）。
  const panelValue: ModelDraft = React.useMemo(() => {
    if (!modelPanel) return { provider: LOCAL_PROVIDER, model: "" };
    if (modelPanel.kind === "subagent") {
      return draftFromRow(cfg.subagentModel, "", gatewayOptions);
    }
    if (modelPanel.kind === "row") {
      const r = cfgRows[modelPanel.index];
      return draftFromRow(r?.model, r?.provider, gatewayOptions);
    }
    const b = modelPanel.batch;
    return draftFromRow(
      b === "leader" ? cfgBatchModel.leader : cfgBatchModel.workers,
      b === "leader" ? cfgBatchModel.leaderProvider : cfgBatchModel.workersProvider,
      gatewayOptions,
    );
  }, [modelPanel, cfg.subagentModel, cfgRows, cfgBatchModel, gatewayOptions]);

  // 写回（本地 state only；哨兵 → 所选模型 alias 绑定 / 空，见
  // modelPanelWiring.rowFromDraft）。
  const savePanel = React.useCallback(
    (patch: ModelDraft): Promise<void> => {
      const back = rowFromDraft(patch, gatewayOptions);
      if (!modelPanel) return Promise.resolve();
      if (modelPanel.kind === "subagent") {
        // subagentModel = 单模型字符串字段（"" → doCfg 发 null = 清空/继承）。
        setCfg((c) => ({ ...c, subagentModel: back.model }));
        return Promise.resolve();
      }
      if (modelPanel.kind === "row") {
        // 行 {model, provider} 成对写回（provider "" = 不下发 = 不改，
        // doCfg diff 同旧语义）。
        updateCfgRow(modelPanel.index, {
          model: back.model,
          provider: back.provider,
        });
        return Promise.resolve();
      }
      const b = modelPanel.batch;
      setCfgBatchModel((prev) =>
        b === "leader"
          ? { ...prev, leader: back.model, leaderProvider: back.provider }
          : { ...prev, workers: back.model, workersProvider: back.provider },
      );
      // 画笔语义与旧 AutoComplete 逐字段一致：成对刷到对应角色行
      // （行内仍可精修覆盖）。
      applyCfgBatch(b, back.model, back.provider);
      return Promise.resolve();
    },
    [modelPanel, setCfg, updateCfgRow, setCfgBatchModel, applyCfgBatch, gatewayOptions],
  );

  const modelPanelTitle = modelPanel
    ? modelPanel.kind === "subagent"
      ? tr("子代理默认模型")
      : modelPanel.kind === "row"
        ? `${tr("成员模型")} · ${cfgRows[modelPanel.index]?.name || tr("未选")}`
        : modelPanel.batch === "leader"
          ? `${tr("批量设置模型")} · ${tr("Leader 批")}`
          : `${tr("批量设置模型")} · ${tr("Workers 批")}`
    : "";

  // 窄屏（<800 与聊天单栏同判据）：批量画笔网格单列、摘要/输入不钉死宽度。
  const { narrow } = useWbViewport();
  // 分区头几何：minHeight 48 + 整行可点（rc-collapse header 本身就是
  // role=button 行）；段间用 1px 分隔线代替 Card 边框/阴影（ghost 风格）。
  const sectionHead = (i: number): ReactNS.CSSProperties => ({
    minHeight: 48,
    padding: narrow ? "10px 12px" : "12px 10px",
    borderTop: i === 0 ? undefined : `1px solid ${t.border}`,
  });
  const sectionBody: ReactNS.CSSProperties = {
    padding: narrow ? "0 12px 12px" : "0 10px 12px",
  };
  // 批量画笔两格（Leader 批 / Workers 批）除取数源外完全同构。
  const batchCells = [
    {
      kind: "leader" as const,
      label: tr("Leader 批（{n} 人）", { n: cfgBatchLeaderCount }),
      value: cfgBatchModel.leader,
      prefix: cfgBatchModel.leaderProvider,
    },
    {
      kind: "workers" as const,
      label: tr("Workers 批（{n} 人）", { n: cfgBatchWorkerCount }),
      value: cfgBatchModel.workers,
      prefix: cfgBatchModel.workersProvider,
    },
  ];

  return (
    <>
      <antd.Collapse
        ghost
        size="small"
        defaultActiveKey={CFG_SECTIONS_OPEN}
        items={[
          {
            key: "basic",
            label: (
              <CfgSectionLabel
                icon={<TeamIcon size={15} />}
                title={tr("基本信息")}
                t={t}
              />
            ),
            styles: { header: sectionHead(0), body: sectionBody },
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                <FieldLabel>{tr("描述（留空 = 保持不变）")}</FieldLabel>
                <antd.Input.TextArea
                  rows={2}
                  placeholder={tr("描述（留空 = 保持不变）")}
                  value={cfg.description}
                  onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                    setCfg({ ...cfg, description: e.target.value })
                  }
                />
                <FieldLabel>{tr("心跳间隔（留空 = 保持不变，如 10m）")}</FieldLabel>
                <antd.Input
                  placeholder={tr("心跳间隔（留空 = 保持不变，如 10m）")}
                  value={cfg.heartbeatEvery}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setCfg({ ...cfg, heartbeatEvery: e.target.value })
                  }
                />
                {/* subagentModel=团队级 spawn 子代理默认模型（""=继承 Worker
  主模型）。11.7 统一模型弹窗接线：只读摘要 + 编辑 →
  ModelSettingsModal 预填（候选数据源同源 modelOptions=在服∪在用∪
  网关 alias；留空可保存=继承）；保存写回 cfg.subagentModel（"" →
  doCfg 发 null 清空/继承），校验态 validateModelValue 不变。 */}
                <FieldLabel>{tr("子代理默认模型（留空 = 继承各 Worker 主模型）")}</FieldLabel>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    width: "100%",
                    maxWidth: narrow ? "100%" : 420,
                  }}
                >
                  <ModelCellChip
                    value={cfg.subagentModel}
                    placeholder={tr("留空 = 继承各 Worker 主模型")}
                    tr={tr}
                    t={t}
                    candidates={modelCandidates}
                    narrow={narrow}
                  />
                  <antd.Button
                    icon={<EditIcon size={15} />}
                    style={{ minHeight: 44, flexShrink: 0, whiteSpace: "nowrap" }}
                    onClick={() => setModelPanel({ kind: "subagent" })}
                  >
                    {tr("改模型")}
                  </antd.Button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <antd.Switch
                    size="small"
                    checked={cfg.peerMentions}
                    onChange={(v: boolean) =>
                      setCfg({ ...cfg, peerMentions: v })
                    }
                  />
                  <span style={{ fontSize: 11 }}>
                    {tr("peerMentions（团队成员可互 @）")}
                  </span>
                </div>
              </div>
            ),
          },
          {
            key: "llm",
            label: (
              <CfgSectionLabel
                icon={<BrainIcon size={15} />}
                title={tr("LLM 调优")}
                hint={tr("成员未单独设置时继承")}
                t={t}
              />
            ),
            styles: { header: sectionHead(1), body: sectionBody },
            /* 团队级 LLM 调优（1.2.5 TeamSpec llm*，Worker 未设时继承此默认）。
    字段网格复用 LlmTuningFields（与 Worker 面板同源同序）；保存=字段级
    diff（未改不发 / ""=清除 / 值=覆盖），随「保存」的 updateTeam 落盘。 */
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                <LlmTuningFields
                  values={cfg.llm}
                  onChange={(key: LlmTuningKey, value: string) =>
                    setCfg({ ...cfg, llm: { ...cfg.llm, [key]: value } })
                  }
                  disabled={cfgBusy}
                />
                {(() => {
                  const e = findLlmTuningError(cfg.llm);
                  return e ? (
                    <div style={{ fontSize: 11, color: "#e5484d" }}>
                      {tr("{label}：{message}", { label: e.label, message: e.message })}
                    </div>
                  ) : null;
                })()}
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr(
                    "留空 = 不设置（成员继承 QwenPaw registry 默认）。保存仅发送改动的字段；「重试与限流」改动需重建容器生效，「流式超时」即时生效。",
                  )}
                </div>
              </div>
            ),
          },
          {
            key: "members",
            label: (
              <CfgSectionLabel
                icon={<UsersIcon size={15} />}
                title={tr("团队成员")}
                badge={tr("{n} 人", { n: cfgRows.length })}
                hint={tr("保存 = 全量替换成员列表")}
                t={t}
              />
            ),
            styles: { header: sectionHead(2), body: sectionBody },
            children: (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr(
                    "人类成员（humanMembers）仅创建团队时可设——上游 PUT 不应用该字段，如需变更请删除重建。",
                  )}
                </div>
                {cfgTeam.workerMembers || cfgRows.length ? (
                  <>
                  {/* （·「团队配置的窗口应该增加批量改模型，
      leader/workers 两批」）：批量画笔——Leader 批 / Workers 批
      两把独立画笔。11.7 统一模型弹窗接线：每把 = 只读摘要（provider /
      模型）+ 设置 → ModelSettingsModal 预填批量当前值；保存写回
      cfgBatchModel 并按原画笔语义成对刷到对应角色行（行内仍可精修）。
      留空 = 不刷；落盘 = 下方「保存」的既有 diff 链（只发改动行），零新端点。 */}
                  <div
                    style={{
                      display: "grid",
                      gap: 6,
                      border: `1px solid ${t.border}`,
                      borderRadius: 8,
                      padding: 8,
                      background: t.bg,
                    }}
                  >
                    <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                      {tr("批量设置模型（选中值直接刷到对应角色全部成员；留空 = 不改）")}
                    </div>
                    <div
                      style={{
                        display: "grid",
                        // 宽屏两列自适应（min(220px,100%) 兜住窄容器），
                        // 窄屏直接单列——避免 375px 竖屏下摘要被挤成省略号。
                        gridTemplateColumns: narrow
                          ? "1fr"
                          : "repeat(auto-fit, minmax(min(220px, 100%), 1fr))",
                        gap: 8,
                      }}
                    >
                      {batchCells.map((b) => (
                        <div key={b.kind} style={{ display: "grid", gap: 4, minWidth: 0 }}>
                          <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                            {b.label}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              alignItems: "center",
                              flexWrap: "wrap",
                              minWidth: 0,
                            }}
                          >
                            <ModelCellChip
                              value={b.value}
                              prefix={b.prefix || undefined}
                              placeholder={tr("未设置（留空 = 不刷）")}
                              tr={tr}
                              t={t}
                              candidates={modelCandidates}
                              narrow={narrow}
                              flex="1 1 140px"
                            />
                            <antd.Button
                              icon={<EditIcon size={15} />}
                              style={{ minHeight: 44, flexShrink: 0, whiteSpace: "nowrap" }}
                              onClick={() =>
                                setModelPanel({ kind: "batch", batch: b.kind })
                              }
                            >
                              {tr("设置模型")}
                            </antd.Button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                      {tr(
                        "画笔语义：选中值立即同步到对应行的「模型」（行内仍可按人精修，覆盖刷值）；调整角色/新增行不会自动补刷——对那批重新选一次即可。",
                      )}
                      <br />
                      {tr("Provider 与模型成对刷写；留空=不改")}
                    </div>
                  </div>
                  {/* （历史缺陷：标题位置——11.7 共享头行的「模型」悬在满宽模型框上方错位，
      标题没有落在它的框上）：删共享头，改每行行内标签
      （与建队卡同构：名称/角色、模型 各管各的框）。 */}
                  {cfgRows.map((row, i) => {
                    const taken = new Set(
                      cfgRows
                        .map((r, j) => (j === i ? "" : r.name))
                        .filter(Boolean),
                    );
                    const missingRef =
                      !!row.name && !workerNames.includes(row.name);
                    // 模型内联编辑——diff 原值，改动行橙框提示
                    const modelChanged =
                      !!row.model?.trim() &&
                      row.model.trim() !== (row.modelOrig ?? "");
                    return (
                      <div
                        key={i}
                        style={{
                          display: "grid",
                          gap: 6,
                          border: `1px dashed ${t.border}`,
                          borderRadius: 8,
                          padding: 8,
                        }}
                      >
                        <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                          {tr("名称 / 角色")}
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <WorkerRowSelects
                          tr={tr}
                          row={row}
                          workers={workers}
                          workerNames={workerNames}
                          taken={taken}
                          placeholder={tr("选择 Worker")}
                          extra={
                            missingRef ? (
                              <antd.Tag color="red">{tr("不存在")}</antd.Tag>
                            ) : null
                          }
                          canRemove={cfgRows.length > 1}
                          onWorkerPick={(v: string) => {
                            // 换 Worker = 模型重新基线到新成员的现值（防串改）；
                            // 画笔刷入的 provider 一并清掉（防串改：刷值归属旧成员）。
                            const mm = workers.find((w) => w.name === v)?.model || "";
                            updateCfgRow(i, {
                              name: v,
                              model: mm,
                              modelOrig: mm,
                              provider: "",
                            });
                          }}
                          onRolePick={(v: string) => updateCfgRow(i, { role: v })}
                          onRemove={() => removeCfgRow(i)}
                        />
                        </div>
                        {/* 模型格 240 定宽摘要（chip maxWidth 240，原
      AutoComplete 同几何）+ 编辑 → 统一模型弹窗（11.7 接线）：预填行
      当前值（provider 已刷值 > alias 绑定 > 哨兵），保存写回该行
      cfgRows（model + provider 成对；""=不改，doCfg diff 语义不变）。 */}
                        <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                          {tr("模型")}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            flexWrap: "wrap",
                            minWidth: 0,
                          }}
                        >
                          <ModelCellChip
                            value={row.model}
                            placeholder={tr("留空 = 不改")}
                            changed={modelChanged}
                            showVerdict={modelChanged}
                            tr={tr}
                            t={t}
                            candidates={modelCandidates}
                            narrow={narrow}
                            flex="1 1 180px"
                          />
                          <antd.Button
                            icon={<EditIcon size={15} />}
                            style={{ minHeight: 44, flexShrink: 0, whiteSpace: "nowrap" }}
                            onClick={() => setModelPanel({ kind: "row", index: i })}
                          >
                            {tr("改模型")}
                          </antd.Button>
                          {modelChanged
                            ? (() => {
                                const cmv = validateModelValue(row.model || "", modelCandidates);
                                return cmv.level === "ok" ? (
                                  <antd.Tag color="orange">{tr("模型已改动")}</antd.Tag>
                                ) : null;
                              })()
                            : null}
                        </div>
                      </div>
                    );
                  })}
                  <antd.Button
                    type="dashed"
                    block
                    icon={<PlusIcon size={16} />}
                    style={{ minHeight: 44 }}
                    onClick={addCfgRow}
                  >
                    {tr("添加 Worker")}
                  </antd.Button>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: t.textSecondary }}>
                    {tr("该团队暂无成员（workerMembers 为空）")}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: "skills",
            label: (
              <CfgSectionLabel
                icon={<BrickIcon size={17} />}
                title={tr("团队技能")}
                hint={tr("目录 / 分配矩阵 / MCP")}
                t={t}
              />
            ),
            styles: { header: sectionHead(3), body: sectionBody },
            /* （13.20 「团队的技能等团队配置也要放在团队
  配置里面，和技能中心一样的搜索/上传/自定义等」）：团队技能节=
  SkillCenter 同款组件 onlyTeam 模式内嵌（目录搜索/上传/自定义/
  下载 + 成员分配矩阵 + MCP 卡；保存走原技能中心端点链，本弹窗
  底部「保存」只管团队 PUT，互不干扰）。L1/L2 分权：L1 可管理
  任意团队；L2 用户走「技能中心（我的团队）」（服务端按本团队
  作用域强校验，两条入口同权同级）。高度封顶 min(460px,60vh)
  （竖屏下不再顶出视口），弹窗内滚动。 */
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                <div
                  style={{
                    maxHeight: "min(460px, 60vh)",
                    overflowY: "auto",
                    border: `1px solid ${t.border}`,
                    borderRadius: 8,
                    padding: 8,
                  }}
                >
                  <SkillCenter onlyTeam={cfgTeam.name} />
                </div>
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("技能/分配/MCP 的保存独立于上方「保存」按钮（走技能中心原端点）；L2 用户经「技能中心（我的团队）」入口，同能力、服务端限本团队。")}
                </div>
              </div>
            ),
          },
      ]}
      />
      {/* 11.7 统一模型弹窗（团队设置入口）：按选中单元格预填；保存
        只写回本地表单 state（cfg / cfgRows / cfgBatchModel），落盘仍由
        「保存」= doCfg 统一提交。allowEmptyMain：子代理行 / 成员行 /
        批量均允许「留空 = 继承 / 不改」清空保存。 */}
      <ModelSettingsModal
        open={modelPanel !== null}
        title={modelPanelTitle}
        value={panelValue}
        providers={panelProviders}
        allowEmptyMain
        onClose={() => setModelPanel(null)}
        onSave={savePanel}
    />
  </>
  );
}

export default function CrdCfgModal({
  cfgTeam,
  cfgOpen,
  cfg,
  cfgRows,
  cfgBusy,
  setCfgOpen,
  setCfgTeam,
  setCfg,
  setCfgBatchModel,
  updateCfgRow,
  removeCfgRow,
  addCfgRow,
  cfgBatchModel,
  applyCfgBatch,
  cfgBatchLeaderCount,
  cfgBatchWorkerCount,
  doCfg,
  workers,
  workerNames,
  modelOptions,
  modelCandidates,
  providers,
  gatewayOptions,
  tr,
  t,
}: CrdCfgModalProps) {
  // 窄屏（竖屏/触屏）：弹窗宽度跟随视口（calc 兜住 24px 边距），顶部贴
  // 近状态栏——780 固定宽在 375px 竖屏下必然横向溢出。
  const { narrow } = useWbViewport();
  return cfgTeam ? (
    <antd.Modal
      open={cfgOpen}
      width="min(780px, calc(100vw - 24px))"
      style={{ top: narrow ? 8 : 48, maxWidth: "calc(100vw - 12px)" }}
      title={`${tr("配置团队")} · ${cfgTeam.name}`}
      // 收起动画——onCancel 只关 cfgOpen（antd
      // 播退出过渡），afterClose 才卸载（cfgTeam=null），动画期间内容
      // 保持不闪空。
      onCancel={() => setCfgOpen(false)}
      afterClose={() => setCfgTeam(null)}
      footer={
        <antd.Space size={8}>
          <antd.Button
            style={{ minHeight: 44 }}
            onClick={() => setCfgOpen(false)}
          >
            {tr("取消")}
          </antd.Button>
          <antd.Button
            type="primary"
            loading={cfgBusy}
            icon={<CheckIcon size={16} />}
            style={{ minHeight: 44 }}
            onClick={() => void doCfg()}
          >
            {tr("保存")}
          </antd.Button>
        </antd.Space>
      }
    >
      <CrdCfgForm
        cfgTeam={cfgTeam}
        cfg={cfg}
        cfgRows={cfgRows}
        cfgBusy={cfgBusy}
        setCfg={setCfg}
        setCfgBatchModel={setCfgBatchModel}
        updateCfgRow={updateCfgRow}
        removeCfgRow={removeCfgRow}
        addCfgRow={addCfgRow}
        cfgBatchModel={cfgBatchModel}
        applyCfgBatch={applyCfgBatch}
        cfgBatchLeaderCount={cfgBatchLeaderCount}
        cfgBatchWorkerCount={cfgBatchWorkerCount}
        workers={workers}
        workerNames={workerNames}
        modelOptions={modelOptions}
        modelCandidates={modelCandidates}
        providers={providers}
        gatewayOptions={gatewayOptions}
        tr={tr}
        t={t}
      />
    </antd.Modal>
  ) : null;
}
