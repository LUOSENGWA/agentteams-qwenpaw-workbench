// CrdManage 拆分（QC-196 方案 §5.2）· 配置团队弹窗（PUT 部分更新 + 批量
// 模型画笔 + 团队技能 SkillCenter onlyTeam 内嵌）——原主组件 JSX R7 逐字
// 搬移；props = 原闭包变量名（零改写）。

import type * as ReactNS from "react";

import type { AdminData, TeamInfo } from "../api";
import { modelVerdictText, validateModelValue } from "../modelUnion";
import LlmTuningFields from "../components/LlmTuningFields";
import { findLlmTuningError, type LlmTuningKey } from "../lib/llm-tuning";
import type { ThemeColors } from "../theme";
import { CloseIcon, WarnIcon } from "../components/icons";
import SkillCenter from "../components/SkillCenter";
import { WbTooltip } from "../components/WbTooltip";
import FieldLabel from "./FieldLabel";
import { roleSelectOptions, workerOptionLabel } from "./helpers";
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
  applyCfgBatch: (kind: "leader" | "workers", value: string) => void;
  cfgBatchLeaderCount: number;
  cfgBatchWorkerCount: number;
  doCfg: () => void | Promise<void>;
  /** 在服 Workers（成员行换人时取现值模型做基线）。 */
  workers: AdminData["workers"];
  workerNames: string[];
  modelOptions: { value: string }[];
  modelCandidates: string[];
  tr: TrFn;
  t: ThemeColors;
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
tr,
t,
}: CrdCfgModalProps) {
  return cfgTeam ? (
    <antd.Modal
      open={cfgOpen}
      width={780}
      title={`${tr("配置团队")} · ${cfgTeam.name}`}
      // 收起动画——onCancel 只关 cfgOpen（antd
      // 播退出过渡），afterClose 才卸载（cfgTeam=null），动画期间内容
      // 保持不闪空。
      onCancel={() => setCfgOpen(false)}
      afterClose={() => setCfgTeam(null)}
      footer={
        <antd.Space>
          <antd.Button onClick={() => setCfgOpen(false)}>
            {tr("取消")}
          </antd.Button>
          <antd.Button
            type="primary"
            loading={cfgBusy}
            onClick={() => void doCfg()}
          >
            {tr("保存")}
          </antd.Button>
        </antd.Space>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
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
          size="small"
          placeholder={tr("心跳间隔（留空 = 保持不变，如 10m）")}
          value={cfg.heartbeatEvery}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setCfg({ ...cfg, heartbeatEvery: e.target.value })
          }
        />
        {/* ：
subagentModel=团队级 spawn 子代理默认模型（""=继承 Worker 主模型）。
：裸 Input → 与 Worker 选模型
同款 AutoComplete（同数据源 modelOptions=在服∪在用模型∪网关 alias，
同 validateModelValue 校验态）——「来源一样」。 */}
        <FieldLabel>{tr("子代理默认模型（留空 = 继承各 Worker 主模型）")}</FieldLabel>
        <antd.AutoComplete
          size="small"
          style={{ width: 320, maxWidth: "100%" }}
          placeholder={tr("子代理默认模型（如 qwen3.6:27b-fp8；留空 = 继承）")}
          options={modelOptions as { value: string }[]}
          value={cfg.subagentModel}
          onChange={(v: string) => setCfg({ ...cfg, subagentModel: v })}
          status={(() => {
            const v = cfg.subagentModel.trim();
            if (!v) return undefined;
            const lv = validateModelValue(v, modelCandidates).level;
            return lv === "error" ? "error" : lv === "warn" ? "warning" : undefined;
          })()}
        />
        {(() => {
          const v = cfg.subagentModel.trim();
          if (!v) return null;
          const sv = validateModelValue(v, modelCandidates);
          return sv.level === "ok" ? null : (
            <WbTooltip title={modelVerdictText(tr, sv, v, modelCandidates)}>
              <antd.Tag color={sv.level === "error" ? "red" : "orange"} style={{ marginBottom: 4 }}>
                {sv.level === "error" ? (
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
          );
        })()}
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
        {/* 团队级 LLM 调优（1.2.5 TeamSpec llm*，Worker 未设时继承此默认）。
  字段网格复用 LlmTuningFields（与 Worker 面板同源同序）；保存=字段级
  diff（未改不发 / ""=清除 / 值=覆盖），随下方「保存」的 updateTeam 落盘。 */}
        <antd.Divider style={{ margin: "8px 0 6px" }}>
          {tr("团队 LLM 调优（成员未单独设置时继承）")}
        </antd.Divider>
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
        <div style={{ fontSize: 10, color: t.textSecondary }}>
          {tr(
            "留空 = 不设置（成员继承 QwenPaw registry 默认）。保存仅发送改动的字段；「重试与限流」改动需重建容器生效，「流式超时」即时生效。",
          )}
        </div>
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr(
            "人类成员（humanMembers）仅创建团队时可设——上游 PUT 不应用该字段，如需变更请删除重建。",
          )}
        </div>
        {cfgTeam.workerMembers || cfgRows.length ? (
          <>
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("团队成员（workerMembers）——保存 = 全量替换成员列表")}
            </div>
            {/* （·「团队配置的窗口应该增加批量改模型，
leader/workers 两批」）：批量模型画笔——Leader 批 / Workers 批
两把独立 AutoComplete（数据源/校验态与行内模型框完全同源：
modelOptions=在服∪在用∪网关 alias，validateModelValue）。
选中值即刷到对应角色行的 model（行内仍可按人精修）；留空=不刷；
落盘=下方「保存」的既有 diff 链（只发改动行），零新端点。 */}
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
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                    {tr("Leader 批（{n} 人）", { n: cfgBatchLeaderCount })}
                  </div>
                  <antd.AutoComplete
                    size="small"
                    style={{ width: "100%" }}
                    placeholder={tr("批量模型（选中=刷到该批全部成员）")}
                    options={modelOptions as { value: string }[]}
                    value={cfgBatchModel.leader}
                    onChange={(v: string) => {
                      setCfgBatchModel((p) => ({ ...p, leader: v }));
                      applyCfgBatch("leader", v);
                    }}
                    status={(() => {
                      const v = cfgBatchModel.leader.trim();
                      if (!v) return undefined;
                      const lv = validateModelValue(v, modelCandidates).level;
                      return lv === "error"
                        ? "error"
                        : lv === "warn"
                          ? "warning"
                          : undefined;
                    })()}
                  />
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                    {tr("Workers 批（{n} 人）", { n: cfgBatchWorkerCount })}
                  </div>
                  <antd.AutoComplete
                    size="small"
                    style={{ width: "100%" }}
                    placeholder={tr("批量模型（选中=刷到该批全部成员）")}
                    options={modelOptions as { value: string }[]}
                    value={cfgBatchModel.workers}
                    onChange={(v: string) => {
                      setCfgBatchModel((p) => ({ ...p, workers: v }));
                      applyCfgBatch("workers", v);
                    }}
                    status={(() => {
                      const v = cfgBatchModel.workers.trim();
                      if (!v) return undefined;
                      const lv = validateModelValue(v, modelCandidates).level;
                      return lv === "error"
                        ? "error"
                        : lv === "warn"
                          ? "warning"
                          : undefined;
                    })()}
                  />
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                {tr(
                  "画笔语义：选中值立即同步到对应行的「模型」（行内仍可按人精修，覆盖刷值）；调整角色/新增行不会自动补刷——对那批重新选一次即可。",
                )}
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
                  <antd.Select
                    size="small"
                    showSearch
                    style={{ flex: "1 1 40%", minWidth: 0 }}
                    placeholder={tr("选择 Worker")}
                    value={row.name || undefined}
                    onChange={(v: string) => {
                      // 换 Worker = 模型重新基线到新成员的现值（防串改）
                      const mm = workers.find((w) => w.name === v)?.model || "";
                      updateCfgRow(i, { name: v, model: mm, modelOrig: mm });
                    }}
                    options={workerNames
                      .filter((n) => !taken.has(n))
                      .map((n) => ({
                        value: n,
                        label: workerOptionLabel(n, workers),
                      }))}
                  />
                  <antd.Select
                    size="small"
                    style={{ width: 132 }}
                    value={row.role}
                    onChange={(v: string) => updateCfgRow(i, { role: v })}
                    options={roleSelectOptions(tr)}
                  />
                  {missingRef ? (
                    <antd.Tag color="red">{tr("不存在")}</antd.Tag>
                  ) : null}
                  {cfgRows.length > 1 ? (
                    <antd.Button
                      size="small"
                      type="text"
                      danger
                      onClick={() => removeCfgRow(i)}
                    >
                      ×
                    </antd.Button>
                  ) : null}
                  </div>
                  {/* 模型框 240 定宽（原 1 1 100% 满宽
=「超宽」；与 Manager 表模型列 180-240 同几何）+ 行内
「模型」标签落在框正上方。 */}
                  <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                    {tr("模型")}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <antd.AutoComplete
                    size="small"
                    style={{
                      width: 240,
                      borderColor: modelChanged ? "#fa8c16" : undefined,
                    }}
                    placeholder={tr("模型（留空=不改；下拉=在服∪在用模型，provider 不变）")}
                    options={modelOptions as { value: string }[]}
                    value={row.model || ""}
                    onChange={(v: string) => updateCfgRow(i, { model: v })}
                    status={
                      modelChanged
                        ? validateModelValue(row.model || "", modelCandidates).level === "error"
                          ? "error"
                          : validateModelValue(row.model || "", modelCandidates).level === "warn"
                            ? "warning"
                            : undefined
                        : undefined
                    }
                  />
                  {modelChanged ? (
                    (() => {
                      const cmv = validateModelValue(row.model || "", modelCandidates);
                      return cmv.level === "ok" ? (
                        <antd.Tag color="orange">{tr("模型已改动")}</antd.Tag>
                      ) : (
                        <WbTooltip
                          title={modelVerdictText(tr, cmv, row.model || "", modelCandidates)}
                        >
                          <antd.Tag color={cmv.level === "error" ? "red" : "orange"}>
                            {cmv.level === "error" ? (
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
                      );
                    })()
                  ) : null}
                  </div>
                </div>
              );
            })}
            <antd.Button
              size="small"
              type="dashed"
              block
              onClick={addCfgRow}
            >
              ＋ {tr("添加 Worker")}
            </antd.Button>
          </>
        ) : null}
        {/* （13.20 「团队的技能等团队配置也要放在团队
配置里面，和技能中心一样的搜索/上传/自定义等」）：团队技能节=
SkillCenter 同款组件 onlyTeam 模式内嵌（目录搜索/上传/自定义/
下载 + 成员分配矩阵 + MCP 卡；保存走原技能中心端点链，本弹窗
底部「保存」只管团队 PUT，互不干扰）。L1/L2 分权：L1 可管理
任意团队；L2 用户走「技能中心（我的团队）」（服务端按本团队
作用域强校验，两条入口同权同级）。高度封顶 460 弹窗内滚动。 */}
        <antd.Divider style={{ margin: "10px 0 8px" }}>
          {tr("团队技能（目录 / 分配矩阵 / MCP）")}
        </antd.Divider>
        <div
          style={{
            maxHeight: 460,
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
    </antd.Modal>
  ) : null;
}
