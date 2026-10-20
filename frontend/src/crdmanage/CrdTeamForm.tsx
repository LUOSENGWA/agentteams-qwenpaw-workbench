// CrdManage 拆分（QC-196 方案 §5.2）· 创建团队卡（Team CRD 表单 + 成员行
// 内联编辑 + SOUL 编辑器）——原主组件 JSX R4b 逐字搬移；props = 原闭包
// 变量名（零改写）。

import type * as ReactNS from "react";

import type { AdminData } from "../api";
import { modelVerdictText, validateModelValue } from "../modelUnion";
import type { ThemeColors } from "../theme";
import { CheckIcon, ClipIcon, CloseIcon, DocIcon, WarnIcon } from "../components/icons";
import { WbTooltip } from "../components/WbTooltip";
import FieldLabel from "./FieldLabel";
import { roleSelectOptions, workerOptionLabel } from "./helpers";
import type { TeamForm, TrFn, WorkerRow } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface CrdTeamFormProps {
  tForm: TeamForm;
  setTForm: ReactNS.Dispatch<ReactNS.SetStateAction<TeamForm>>;
  workerRows: WorkerRow[];
  updateRow: (i: number, patch: Partial<WorkerRow>) => void;
  removeRow: (i: number) => void;
  addRow: () => void;
  doCreateTeam: () => void | Promise<void>;
  tBusy: boolean;
  /** 在服 Workers（成员行初始化 + 选项「在用」标注）。 */
  workers: AdminData["workers"];
  humanNames: string[];
  workerNames: string[];
  modelOptions: { value: string }[];
  modelCandidates: string[];
  modelOf: (name: string) => string;
  loadSoulFile: (
    file: File | null | undefined,
    role: string,
    onLoaded: (text: string) => void,
  ) => void;
  tr: TrFn;
  t: ThemeColors;
}

export default function CrdTeamForm({
  tForm,
  setTForm,
  workerRows,
  updateRow,
  removeRow,
  addRow,
  doCreateTeam,
  tBusy,
  workers,
  humanNames,
  workerNames,
  modelOptions,
  modelCandidates,
  modelOf,
  loadSoulFile,
  tr,
  t,
}: CrdTeamFormProps) {
  return (
      <antd.Card
        size="small"
        title={tr("创建团队（Team CRD）")}
        styles={{ body: { padding: 10 } }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <FieldLabel>{tr("团队 ID（唯一，小写字母/数字/-）")}</FieldLabel>
          <antd.Input
            size="small"
            placeholder={tr("团队 ID（唯一，小写字母/数字/-）")}
            value={tForm.name}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setTForm({ ...tForm, name: e.target.value })
            }
          />
          <FieldLabel>{tr("团队显示名（可选）")}</FieldLabel>
          <antd.Input
            size="small"
            placeholder={tr("团队显示名（可选）")}
            value={tForm.teamName}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setTForm({ ...tForm, teamName: e.target.value })
            }
          />
          <FieldLabel>{tr("描述（可选）")}</FieldLabel>
          <antd.Input
            size="small"
            placeholder={tr("描述（可选）")}
            value={tForm.description}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setTForm({ ...tForm, description: e.target.value })
            }
          />
          <FieldLabel>{tr("人类成员（可选，仅创建时可设）")}</FieldLabel>
          <antd.Select
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("人类成员（可选，仅创建时可设）")}
            value={tForm.humanMembers}
            onChange={(v: string[]) =>
              setTForm({ ...tForm, humanMembers: v })
            }
            options={humanNames.map((n) => ({ value: n, label: n }))}
          />
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("Worker 成员（必填，至少 1 个 team_leader）")}
          </div>
          {workerRows.map((row, i) => {
            const taken = new Set(
              workerRows
                .map((r, j) => (j === i ? "" : r.name))
                .filter(Boolean),
            );
            const rowMv = validateModelValue(
              row.model || "",
              modelCandidates,
            );
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
                {/* （选项标签——配置团队弹窗
同名需求，建队卡片同构补齐，不留半截）。 */}
                <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                  {tr("名称 / 角色")}
                </div>
                {/* （竖屏创建团队卡溢出——
行内 Select flex 项 min-width:auto 撑宽，与 cfgRows
同几何：40% 基线 + wrap 断撑链）。 */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <antd.Select
                    size="small"
                    showSearch
                    style={{ flex: "1 1 40%", minWidth: 0 }}
                    placeholder={tr("选择 Worker（已有 CR）")}
                    value={row.name || undefined}
                    onChange={(v: string) => {
                      // 选中即预填该 Worker CR 现值（diff 基线）
                      const mm = modelOf(v);
                      updateRow(i, {
                        name: v,
                        model: mm,
                        modelOrig: mm,
                        soul: "",
                        soulOpen: false,
                      });
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
                    onChange={(v: string) => updateRow(i, { role: v })}
                    options={roleSelectOptions(tr)}
                  />
                  {workerRows.length > 1 ? (
                    <antd.Button
                      size="small"
                      type="text"
                      danger
                      onClick={() => removeRow(i)}
                    >
                      ×
                    </antd.Button>
                  ) : null}
                </div>
                {/* /：行级模型（AutoComplete + 写前校验实时提示） */}
                <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                  {tr("模型")}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
{/* ：240 定宽，与配置团队/Manager 表同几何。 */}
                  <antd.AutoComplete
                    size="small"
                    style={{ width: 240 }}
                    placeholder={tr("模型（留空=不改；新建跟随集群默认；下拉=在服∪在用∪Higress alias）")}
                    options={modelOptions as { value: string }[]}
                    value={row.model || ""}
                    onChange={(v: string) => updateRow(i, { model: v })}
                    status={
                      rowMv.level === "error"
                        ? "error"
                        : rowMv.level === "warn"
                          ? "warning"
                          : undefined
                    }
                  />
                  {(row.model || "").trim() && rowMv.level !== "ok" ? (
                    <WbTooltip title={modelVerdictText(tr, rowMv, row.model || "", modelCandidates)}>
                      <span
                        style={{
                          fontSize: 11,
                          cursor: "help",
                          color: rowMv.level === "error" ? "#f5222d" : "#fa8c16",
                        }}
                      >
                        {rowMv.level === "error" ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <CloseIcon size={10} /> {tr("路径形态")}
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <WarnIcon size={10} /> {tr("未命中")}
                          </span>
                        )}
                      </span>
                    </WbTooltip>
                  ) : null}
                </div>
                {/* ：行级 SOUL（折叠；多行+上传） */}
                <div>
                  <antd.Button
                    size="small"
                    type="link"
                    style={{ padding: 0, fontSize: 11 }}
                    onClick={() =>
                      updateRow(i, { soulOpen: !row.soulOpen })
                    }
                  >
                    <DocIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {tr("SOUL（可选，多行/上传）")}
                    {(row.soul || "").trim() ? <CheckIcon size={10} style={{ color: "#52c41a", verticalAlign: "-1px", marginLeft: 2 }} /> : null}
                    {row.soulOpen ? " ▾" : " ▸"}
                  </antd.Button>
                  {row.soulOpen ? (
                    <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
                      <antd.Input.TextArea
                        size="small"
                        autoSize={{ minRows: 3, maxRows: 10 }}
                        placeholder={tr("SOUL 全文（写入 spec.soul；预算 team_leader≤250 / worker≤150 行）")}
                        value={row.soul || ""}
                        onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                          updateRow(i, { soul: e.target.value })
                        }
                      />
                      <antd.Upload
                        showUploadList={false}
                        beforeUpload={(f: File) => {
                          loadSoulFile(f, row.role, (t) =>
                            updateRow(i, { soul: t }),
                          );
                          return false;
                        }}
                      >
                        <antd.Button size="small" type="text" style={{ padding: 0, height: "auto" }}>
                          <ClipIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {tr("上传 SOUL 文件")}
                        </antd.Button>
                      </antd.Upload>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
          <antd.Button
            size="small"
            type="dashed"
            block
            onClick={addRow}
          >
            ＋ {tr("添加 Worker")}
          </antd.Button>
          <FieldLabel>{tr("心跳间隔（可选，如 10m）")}</FieldLabel>
          <antd.Input
            size="small"
            placeholder={tr("心跳间隔（可选，如 10m）")}
            value={tForm.heartbeatEvery}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setTForm({ ...tForm, heartbeatEvery: e.target.value })
            }
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <antd.Switch
              size="small"
              checked={tForm.peerMentions}
              onChange={(v: boolean) =>
                setTForm({ ...tForm, peerMentions: v })
              }
            />
            <span style={{ fontSize: 11 }}>
              {tr("peerMentions（团队成员可互 @）")}
            </span>
          </div>
          <antd.Button
            size="small"
            type="primary"
            loading={tBusy}
            onClick={() => void doCreateTeam()}
          >
            {tr("确认创建")}
          </antd.Button>
        </div>
      </antd.Card>
  );
}
