import { NotesIcon, WarnIcon } from "./icons";
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import type { CrdManageProps } from "../crdmanage/types";
import { useModelCatalog } from "../crdmanage/useModelCatalog";
import { useHumanCrd } from "../crdmanage/useHumanCrd";
import { useAccessMatrix } from "../crdmanage/useAccessMatrix";
import { useTeamCrd } from "../crdmanage/useTeamCrd";
import CrdHumanForm from "../crdmanage/CrdHumanForm";
import CrdTeamForm from "../crdmanage/CrdTeamForm";
import CrdWorkerForm from "../crdmanage/CrdWorkerForm";
import CrdCheckPanel from "../crdmanage/CrdCheckPanel";
import CrdAccessMatrix from "../crdmanage/CrdAccessMatrix";
import { CrdHumanTableCard, CrdTeamTableCard } from "../crdmanage/CrdListTables";
import CrdCfgModal from "../crdmanage/CrdCfgModal";
import CrdPermModal from "../crdmanage/CrdPermModal";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/**
 * CRD 管理面板（L1 门控——仅配置了 Controller 管理员 token 时由
 * WorkerManage 渲染）。真人"员工"入职（Human CRD）+ 团队创建/配置（Team CRD）。
 * 走现有通用 Controller 代理（agentteams-proxy/controller），零新后端端点。
 *
 * 权限管理（人员可访问团队）：上游 Controller REST 无 UpdateHuman API
 * （dashboard 的 updateHuman 是死代码——只写了客户端没写路由；agt update
 * 也无 human 子命令）→ 本面板生成「embedded apiserver merge-patch」命令
 * （标准姿势：token.csv 第一列 + 127.0.0.1:6443），在 Controller
 * 宿主机执行。上游 Human PUT 端点合并后此处可零改动升级为一键 PUT
 * （通用代理已支持 PUT）。
 */
export type { CrdManageHandle } from "../crdmanage/types";

// ── ──────────────────────────
// 建团缺陷（历史回归）：建团表单只有 name+role，
// Worker 出生即无模型；model 自由文本零校验，SGLang 在服列表被污染时
// 「/models」被当作候选下拉项写进 CRD → 全团 LLM 死亡。修复：
// ① 候选 = SGLang ∪ 在服 Worker 已用模型，且剔除路径形态值（防列表自身被毒）；
// ② 写前校验三入口共用（建 Worker 弹窗/建队行/团队配置内联）；
// ③ SOUL 多行+上传入口（预算告警不阻断）；
// ④ 创建自检（CRD 回读+阶段轮询；LLM 冒烟/SOUL 检查=无通道，如实标注）。

// 模型校验/合并/分组的纯函数在 ../modelUnion（抽出，
// 与 WorkerManage ManagerTable 共用——同一套候选与校验，行为零分叉）。


export default function CrdManage(props: CrdManageProps) {
  const t = useThemeColors();
  const tr = useT();
  const { admin, onRefresh, l1TokenMode } = props;
 // 三卡同排 + 可折叠。
  const [crdCardsOpen, setCrdCardsOpen] = React.useState(true);
  const { humans, teams, workers } = admin;
  const catalog = useModelCatalog({ workers, tr });
  const {
    hForm,
    setHForm,
    hBusy,
    created,
    setCreated,
    doCreateHuman,
    copyPassword,
    doDeleteHuman,
    permHuman,
    setPermHuman,
    permForm,
    setPermForm,
    permCmd,
    openPerm,
    generatePermCmd,
    copyPermCmd,
  } = useHumanCrd({ onRefresh, tr });
  const {
    accessOf,
    accessChanged,
    toggleAccess,
    generateAccessCmd,
    copyAccessCmd,
    accessCmd,
    saving: accessSaving,
    saveMsg: accessSaveMsg,
    saveAccess,
  } = useAccessMatrix({ humans, tr, onSaved: onRefresh });
  const {
    gatewayOpts,
    gatewayLoaded,
    modelCandidates,
    modelOptions,
    modelOf,
    loadSoulFile,
  } = catalog;
  const team = useTeamCrd({
    teams,
    workers,
    onRefresh,
    tr,
    catalog,
    registerHandle: props.registerHandle,
    // 「用此模板建队」预填时展开快捷操作卡（建队表单所在折叠区）。
    expandShortcutCards: () => setCrdCardsOpen(true),
  });
  const {
    tForm,
    setTForm,
    workerRows,
    updateRow,
    removeRow,
    addRow,
    tBusy,
    exporting,
    nw,
    setNw,
    tCheck,
    startTeamCheck,
    doExportCrd,
    doCreateWorker,
    doCreateTeam,
    cfgTeam,
    setCfgTeam,
    cfgOpen,
    cfg,
    cfgRows,
    cfgBusy,
    openCfg,
    setCfgOpen,
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
    doDeleteTeam,
  } = team;

  const teamNames = teams.map((x) => x.name);
  const workerNames = workers.map((x) => x.name);
  const humanNames = humans.map((x) => x.name);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <antd.Card
        size="small"
        title={
          <span style={{ fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <NotesIcon size={14} /> {tr("CRD 管理（L1 管理员）")}
          </span>
        }
        extra={
          // 导出 JSON（参考 dashboard 团队页同款；按钮不用
 // emoji 图标——，icon SVG 化在 backlog）。
          <antd.Button size="small" loading={exporting} onClick={() => void doExportCrd()}>
            {tr("导出 JSON")}
          </antd.Button>
        }
        styles={{ body: { padding: 8 } }}
      >
        {/* token 模式无 Higress Console 会话 → 网关 alias 层不可见（显式提示，
 不再静默降级——token 模式要提示）。 */}
        {l1TokenMode && gatewayLoaded && gatewayOpts === null ? (
          <div
            style={{
              fontSize: 12,
              // 深色档亮黄底+深琥珀字在暗页=亮斑+不可读
              // → 半透明琥珀底+亮琥珀字（antd warning 亮向）。
              color: t.mode === "dark" ? "#faad14" : "#ad6800",
              background: t.mode === "dark" ? "rgba(250,173,20,0.10)" : "#fffbe6",
              border: `1px solid ${t.mode === "dark" ? "rgba(250,173,20,0.35)" : "#ffe58f"}`,
              borderRadius: 4,
              padding: "4px 8px",
              marginBottom: 8,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 5 }}><WarnIcon size={12} style={{ marginTop: 2, flexShrink: 0 }} /> {tr("token 模式无 Higress Console 会话——Higress alias 层当前不可见。配置 admin 账号密码后，「Higress alias（路由可解析）」与「Higress 内置 alias」分组将出现在模型下拉中；或等待上游支持 controller_token 直连 Higress Console 的 PR 合入。")}</span>
          </div>
        ) : null}
 {/* 三张快捷操作卡同排（lg=8×3）+
 可折叠——此前 员工入职/创建团队 各占半行、新建 Worker 单占半行。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: crdCardsOpen ? 6 : 0 }}>
          <antd.Button
            size="small"
            type="text"
            style={{ padding: 0, fontSize: 12, height: "auto" }}
            onClick={() => setCrdCardsOpen((v) => !v)}
          >
            {crdCardsOpen
              ? `▾ ${tr("收起快捷操作（员工入职 / 创建团队 / 新建 Worker）")}`
              : `▸ ${tr("展开快捷操作（员工入职 / 创建团队 / 新建 Worker）")}`}
          </antd.Button>
        </div>
        {crdCardsOpen ? (
        <antd.Row gutter={[10, 10]}>
          <antd.Col xs={24} lg={8}>
            <CrdHumanForm
              hForm={hForm}
              setHForm={setHForm}
              hBusy={hBusy}
              doCreateHuman={doCreateHuman}
              teamNames={teamNames}
              workerNames={workerNames}
              tr={tr}
            />
          </antd.Col>
          <antd.Col xs={24} lg={8}>
            <CrdTeamForm
              tForm={tForm}
              setTForm={setTForm}
              workerRows={workerRows}
              updateRow={updateRow}
              removeRow={removeRow}
              addRow={addRow}
              doCreateTeam={doCreateTeam}
              tBusy={tBusy}
              workers={workers}
              humanNames={humanNames}
              workerNames={workerNames}
              modelOptions={modelOptions}
              modelCandidates={modelCandidates}
              modelOf={modelOf}
              loadSoulFile={loadSoulFile}
              tr={tr}
              t={t}
            />
            <CrdCheckPanel
              tCheck={tCheck}
              startTeamCheck={startTeamCheck}
              tr={tr}
              t={t}
            />
          </antd.Col>
          {/* ：
 新建 Worker 从建队卡内折叠区独立成卡（建队卡聚焦团队字段）。
 行为不变：创建成功后仍自动加入建队表单的 Worker 成员行。
 模型/alias 拉取由组件 mount 时统一触发（原展开时拉取的逻辑移除）。 */}
          <antd.Col xs={24} lg={8}>
            <CrdWorkerForm
              nw={nw}
              setNw={setNw}
              doCreateWorker={doCreateWorker}
              modelOptions={modelOptions}
              modelCandidates={modelCandidates}
              loadSoulFile={loadSoulFile}
              tr={tr}
              t={t}
            />
          </antd.Col>
        </antd.Row>
        ) : null}
        <antd.Space
          direction="vertical"
          size={12}
          style={{ display: "flex", marginTop: 12 }}
        >
          <CrdAccessMatrix
            humans={humans}
            teams={teams}
            accessOf={accessOf}
            accessChanged={accessChanged}
            toggleAccess={toggleAccess}
            generateAccessCmd={generateAccessCmd}
            accessCmd={accessCmd}
            copyAccessCmd={copyAccessCmd}
            saving={accessSaving}
            saveMsg={accessSaveMsg}
            saveAccess={saveAccess}
            tr={tr}
            t={t}
          />
          <CrdHumanTableCard
            humans={humans}
            openPerm={openPerm}
            doDeleteHuman={doDeleteHuman}
            tr={tr}
          />
          <CrdTeamTableCard
            teams={teams}
            openCfg={openCfg}
            doDeleteTeam={doDeleteTeam}
            tr={tr}
            t={t}
          />
        </antd.Space>
      </antd.Card>

      {/* 入职成功——initialPassword 只显示一次 */}
      {created ? (
        <antd.Modal
          open
          title={tr("入职成功——初始密码")}
          onCancel={() => setCreated(null)}
          footer={
            <antd.Space>
              <antd.Button onClick={copyPassword}>{tr("复制")}</antd.Button>
              <antd.Button type="primary" onClick={() => setCreated(null)}>
                {tr("我已保存")}
              </antd.Button>
            </antd.Space>
          }
        >
          <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 10 }}>
            {tr(
              "此密码只显示一次，关闭后无法找回。请让用户首次 Matrix 登录后立即修改。",
            )}
          </div>
          <antd.Input
            readOnly
            value={`${created.name} / ${created.password}`}
            style={{ fontFamily: "monospace" }}
          />
        </antd.Modal>
      ) : null}

      <CrdCfgModal
        cfgTeam={cfgTeam}
        cfgOpen={cfgOpen}
        cfg={cfg}
        cfgRows={cfgRows}
        cfgBusy={cfgBusy}
        setCfgOpen={setCfgOpen}
        setCfgTeam={setCfgTeam}
        setCfg={setCfg}
        setCfgBatchModel={setCfgBatchModel}
        updateCfgRow={updateCfgRow}
        removeCfgRow={removeCfgRow}
        addCfgRow={addCfgRow}
        cfgBatchModel={cfgBatchModel}
        applyCfgBatch={applyCfgBatch}
        cfgBatchLeaderCount={cfgBatchLeaderCount}
        cfgBatchWorkerCount={cfgBatchWorkerCount}
        doCfg={doCfg}
        workers={workers}
        workerNames={workerNames}
        modelOptions={modelOptions}
        modelCandidates={modelCandidates}
        tr={tr}
        t={t}
      />

      <CrdPermModal
        permHuman={permHuman}
        permForm={permForm}
        permCmd={permCmd}
        setPermHuman={setPermHuman}
        setPermForm={setPermForm}
        generatePermCmd={generatePermCmd}
        copyPermCmd={copyPermCmd}
        teamNames={teamNames}
        workerNames={workerNames}
        tr={tr}
        t={t}
      />
    </div>
  );
}
