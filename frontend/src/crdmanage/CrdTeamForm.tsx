// CrdManage 拆分（QC-196 方案 §5.2）· 创建团队卡（Team CRD 表单 + 成员行
// 内联编辑 + SOUL 编辑器）——原主组件 JSX R4b 逐字搬移；props = 原闭包
// 变量名（零改写）。

import type * as ReactNS from "react";

import {
  fetchGatewayAiProviders,
  fetchGatewayAiRoutes,
  type AdminData,
} from "../api";
import {
  buildModelSelectionOptions,
  type LlmProviderLite,
  type ModelSelectionOption,
} from "../modelCatalog";
import {
  extractGatewayLists,
  modelVerdictText,
  providerModelMismatch,
  validateModelValue,
} from "../modelUnion";
import ModelPicker, { type ModelPickerProvider } from "../components/ModelPicker";
import type { ThemeColors } from "../theme";
import { CheckIcon, ClipIcon, CloseIcon, DocIcon, WarnIcon } from "../components/icons";
import { WbTooltip } from "../components/WbTooltip";
import FieldLabel from "./FieldLabel";
import { roleSelectOptions } from "./helpers";
import { WorkerRowSelects } from "./WorkerRowSelects";
import MillforgeCreateSection from "../millforge/MillforgeCreateSection";
import type { MfCreate } from "../millforge/useMillforgeCreate";
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
  /** 千锻段（B）——折叠区状态 + pre/post 钩子由父组件持有。 */
  millforge?: MfCreate | null;
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
  modelCandidates,
  modelOf,
  loadSoulFile,
  millforge,
  tr,
  t,
}: CrdTeamFormProps) {
  // C1a-2 provider-first：成员行 Provider 名单 + 网关 alias→provider 映射
  // （与 CrdCfgModal 同源数据）。父组件（建队卡接线）不在本单白名单、
  // 传不进 props → 叶子直调请求缓存包裹的取数：cachedRequest（30s TTL +
  // in-flight 去重）+ LRU，同屏 catalog 实例挂载即已拉取 → 命中缓存/
  // 复用同 key 在途 Promise，零新增网络请求。
  const [providers, setProviders] = React.useState<LlmProviderLite[]>([]);

  const [gatewayOpts, setGatewayOpts] = React.useState<
    ModelSelectionOption[] | null
  >(null);

  // ModelPicker 的 Provider→Model 候选：网关 alias 按 binding.providerName
  // 归到各自 Provider（无 binding 的 alias 不进列表，避免出现空 Provider）。
  const pickerProviders: ModelPickerProvider[] = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const p of providers) map.set(p.name, new Set());
    for (const o of gatewayOpts ?? []) {
      const pn = o.binding?.providerName;
      if (!pn) continue;
      if (!map.has(pn)) map.set(pn, new Set());
      map.get(pn)?.add(o.alias);
    }
    return [...map.entries()].map(([name, set]) => ({
      name,
      models: [...set].sort(),
    }));
  }, [providers, gatewayOpts]);
  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [routes, provs] = await Promise.all([
          fetchGatewayAiRoutes(),
          fetchGatewayAiProviders(),
        ]);
        if (!live) return;
        if (!routes.available || !provs.available) {
          setGatewayOpts(null); // 无 Console 会话=正常降级（非错误）
          setProviders([]);
          return;
        }
        // 共享解包 + 共享构建（与 useModelCatalog 同源零分叉）。
        const { routesList, providersList } = extractGatewayLists(
          routes.data,
          provs.data,
        );
        setGatewayOpts(buildModelSelectionOptions(routesList, providersList));
        setProviders(providersList);
      } catch {
        if (live) {
          setGatewayOpts(null);
          setProviders([]);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
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
                .map((r, j) => (j === i ? "" : (r.name || "").trim()))
                .filter(Boolean),
            );
            const rowMv = validateModelValue(
              row.model || "",
              modelCandidates,
            );
            // 新建行（mode=new）名字冲突：已存在（在服或本表单其他行）→
            // 行内红字提示，不自动复用；提交时 useTeamCrd 兜底再拦一次。
            const newName = (row.name || "").trim();
            const newRowConflict =
              row.mode === "new" &&
              newName !== "" &&
              (workerNames.includes(newName) || taken.has(newName));
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
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {/* 行模式：选已有（原 WorkerRowSelects）/ 新建（名字+运行时+模型）；
切换模式清空行内容，避免两模式间残留半值。 */}
                  <antd.Select
                    size="small"
                    style={{ width: 118 }}
                    value={row.mode ?? "existing"}
                    onChange={(v: "existing" | "new") =>
                      updateRow(i, {
                        mode: v,
                        name: "",
                        model: "",
                        modelOrig: "",
                        provider: "",
                        soul: "",
                        soulOpen: false,
                        ...(v === "new" ? { runtime: "qwenpaw" } : { runtime: undefined }),
                      })
                    }
                    options={[
                      { value: "existing", label: tr("选已有") },
                      { value: "new", label: tr("新建") },
                    ]}
                  />
                  {row.mode === "new" ? (
                    <>
                      <antd.Input
                        size="small"
                        style={{ flex: "1 1 40%", minWidth: 120 }}
                        placeholder={tr("Worker 名（新建，唯一）")}
                        value={row.name}
                        status={newRowConflict ? "error" : undefined}
                        onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                          updateRow(i, { name: e.target.value })
                        }
                      />
                      <antd.Select
                        size="small"
                        style={{ width: 132 }}
                        value={row.runtime || "qwenpaw"}
                        onChange={(v: string) => updateRow(i, { runtime: v })}
                        options={[
                          { value: "openclaw", label: "OpenClaw" },
                          { value: "hermes", label: "Hermes" },
                          { value: "qwenpaw", label: "QwenPaw" },
                          { value: "deepseek-harness", label: "DeepSeek Harness" },
                        ]}
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
                          icon={<CloseIcon size={11} />}
                        />
                      ) : null}
                      {newRowConflict ? (
                        <div style={{ flexBasis: "100%", fontSize: 11, color: "#f5222d" }}>
                          {tr("同名 Worker 已存在——请改名，或切回「选已有」（新建不自动复用）")}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <WorkerRowSelects
                      tr={tr}
                      row={row}
                      workers={workers}
                      workerNames={workerNames}
                      taken={taken}
                      placeholder={tr("选择 Worker（已有 CR）")}
                      canRemove={workerRows.length > 1}
                      onWorkerPick={(v: string) => {
                        // 选中即预填该 Worker CR 现值（diff 基线）
                        const mm = modelOf(v);
                        const pp =
                          workers.find((x) => x.name === v)?.modelProvider || "";
                        updateRow(i, {
                          name: v,
                          model: mm,
                          modelOrig: mm,
                          provider: pp,
                          soul: "",
                          soulOpen: false,
                        });
                      }}
                      onRolePick={(v: string) => updateRow(i, { role: v })}
                      onRemove={() => removeRow(i)}
                    />
                  )}
                </div>
                {/* C1a-2 provider-first：行级 Provider 在模型前（与配置团队
行同几何）；候选按 Provider 过滤，失配黄字提示不阻塞。 */}
                <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                  {tr("模型")}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
{/* ：240 定宽，与配置团队/Manager 表同几何。 */}
                  <ModelPicker
                    inline
                    size="small"
                    allowEmpty
                    tr={tr}
                    providers={pickerProviders}
                    provider={row.provider || ""}
                    model={row.model || ""}
                    providerPlaceholder={tr("Provider")}
                    modelPlaceholder={tr("模型（留空=不改）")}
                    onChange={(p: string, m: string) =>
                      updateRow(i, { provider: p, model: m })
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
                  {providerModelMismatch(
                    gatewayOpts ?? [],
                    row.model || "",
                    row.provider || "",
                  ) ? (
                    <div
                      style={{
                        flexBasis: "100%",
                        fontSize: 10.5,
                        color: "#faad14",
                      }}
                    >
                      {tr("该模型不属于所选 Provider（可直接保存，以 Provider 为准）")}
                    </div>
                  ) : null}
                </div>
                {/* ：行级 SOUL（折叠；多行+上传）。新建行不含 SOUL
（提交走 POST /workers 仅 name/runtime/model）——不渲染。 */}
                {row.mode !== "new" ? (
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
                ) : null}
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
          {/* 千锻模板（可选）——B：折叠区，启用后提交建队时自动 编译→注入 */}
          {millforge ? (
            <MillforgeCreateSection
              mf={millforge}
              workers={workers}
              teamName={tForm.name}
              tr={tr}
              t={t}
            />
          ) : null}
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
