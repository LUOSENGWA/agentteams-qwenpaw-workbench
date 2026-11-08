// TeamSettingsPane.tsx — 「管理」页团队域 · 团队设置（方案 §4.1.4，P3）。
//
// - 真 Team CR → CrdCfgForm 内联（CrdCfgModal 内容抽取的具名导出，
//   CrdManage 弹窗壳行为不变）+ 44px 底部操作条（返回 / 保存）。
//   状态 = useTeamCrd + useModelCatalog（与 CRD 管理页同源同实现，
//   零逻辑复制）。openCfg 以 team.name 为键只触发一次——catalog
//   （modelOptions/gatewayLoaded）identity 变化不得重跑 openCfg，
//   否则用户正在改的草稿被重置。
// - 「未分组」/ 非 Team CR（伪团队）→ 引导 + StandaloneWorkerModels
//   弹窗入口（组件本质是 modal，原样复用不内联）。

import type * as ReactNS from "react";

import type { AdminData, TeamInfo } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useModelCatalog } from "../crdmanage/useModelCatalog";
import { useTeamCrd } from "../crdmanage/useTeamCrd";
import { CfgSectionLabel, CrdCfgForm } from "../crdmanage/CrdCfgModal";
import { computeStandaloneWorkers } from "../crdmanage/standalone";
import { StandaloneWorkerModels } from "../components/StandaloneWorkerModels";
import {
  CheckIcon,
  PlusIcon,
  SettingsIcon,
  TeamIcon,
  TrashIcon,
} from "../components/icons";
import { useWbViewport } from "../WbViewportContext";
import { WbTooltip } from "../components/WbTooltip";
import { useCallerLevel } from "../hooks/useCallerLevel";
import { canControlResources, resourceControlDeniedHint } from "../lib/resourceControl";
import type { ManageData } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export default function TeamSettingsPane({
  teamName,
  data,
  onBack,
}: {
  teamName: string;
  data: ManageData;
  onBack: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  // #1536：删除团队 = 资源控制，只对 L1 调用者（permissionLevel === 1）开放。
  // useCallerLevel 为纯派生（无内部 hook），可在早退分支前调用。
  const canControl = canControlResources(
    useCallerLevel({ admin: data.admin, myUserId: data.myUserId, hasToken: data.hasToken }),
  );

  if (!data.admin) {
    return (
      <div style={{ display: "grid", gap: 10, padding: 4 }}>
        <PaneHeader tr={tr} t={t} onBack={onBack} title={teamName || tr("团队设置")} />
        <antd.Alert type="warning" showIcon message={tr("管理数据未就绪")} />
      </div>
    );
  }

  const teams = data.admin.teams;
  const workers = data.admin.workers;
  const team = teamName ? teams.find((x) => x.name === teamName) ?? null : null;

  return team ? (
    <TeamCfgInline
      team={team}
      teams={teams}
      workers={workers}
      canControl={canControl}
      onRefresh={data.onRefreshAdmin ?? (() => undefined)}
      onBack={onBack}
    />
  ) : (
    <StandaloneEntry
      tr={tr}
      t={t}
      teamName={teamName}
      workers={workers}
      onRefreshAdmin={data.onRefreshAdmin}
      onBack={onBack}
    />
  );
}

/** 栏头：44px 返回 + 标题（与 L2 二级页头同几何）。 */
function PaneHeader({
  tr,
  t,
  onBack,
  title,
  extra,
}: {
  tr: (s: string, v?: Record<string, string | number>) => string;
  t: ReturnType<typeof useThemeColors>;
  onBack: () => void;
  title: string;
  /** 右侧操作（保存等）——与返回同一行，滚动时固定在顶部。 */
  extra?: ReactNS.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        position: "sticky",
        top: 0,
        zIndex: 3,
        background: t.bg,
        paddingBottom: 4,
      }}
    >
      <antd.Button onClick={onBack} style={{ minHeight: 44 }}>
        {tr("返回")}
      </antd.Button>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 700,
          fontSize: 15,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <TeamIcon size={15} /> {title}
      </span>
      <div style={{ flex: 1 }} />
      {extra}
    </div>
  );
}

/** 真 Team CR → CrdCfgForm 内联 + 44px 底部操作条。 */
function TeamCfgInline({
  team,
  teams,
  workers,
  canControl,
  onRefresh,
  onBack,
}: {
  team: TeamInfo;
  teams: TeamInfo[];
  workers: AdminData["workers"];
  /** #1536：调用者是否 L1（资源控制 = 允许删除团队）。 */
  canControl: boolean;
  onRefresh: (silent?: boolean) => void;
  onBack: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const { narrow } = useWbViewport();
  const deniedHint = resourceControlDeniedHint(tr);
  const catalog = useModelCatalog({ workers, tr });
  const crd = useTeamCrd({ teams, workers, onRefresh, tr, catalog });

  // 删除团队（危险区）：确认后走 useTeamCrd.doDeleteTeam——内部按快照
  // 6s「撤销」toast（createTeam 重建）+ 失效刷新；成功后返回团队列表。
  const confirmDelete = React.useCallback(() => {
    antd.Modal.confirm({
      title: tr("删除团队 {name}", { name: team.name }),
      okText: tr("删除"),
      cancelText: tr("取消"),
      okButtonProps: { danger: true },
      content: (
        <div style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
          <span>
            {tr("团队房间与团队配置将删除；成员 Worker 保留（变为未分组）。")}
          </span>
          <span style={{ fontSize: 11 }}>
            {tr("删除后 6 秒内可从提示条撤销（按快照重建；房间历史与容器状态不随之恢复）。")}
          </span>
        </div>
      ),
      onOk: async () => {
        await crd.doDeleteTeam(team.name);
        onBack();
      },
    });
  }, [crd, team.name, onBack, tr]);

  // openCfg 按 team.name 只触发一次：openCfg 的 identity 随 catalog
  // 更新变化，若无键守卫，catalog 每次更新都会重跑 openCfg → 重置
  // 用户草稿（cfg/cfgRows 全部回到 team 基线）。
  const openedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (openedRef.current !== team.name) {
      openedRef.current = team.name;
      crd.openCfg(team);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.name, crd.openCfg]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      {/* 标题栏固定：返回 + 标题 + 保存（滚动内容只在下方区域滚动）。 */}
      <div style={{ flex: "0 0 auto", padding: narrow ? "4px 2px 0" : "4px 4px 0" }}>
        <PaneHeader
          tr={tr}
          t={t}
          onBack={onBack}
          title={`${tr("团队设置")} · ${team.name}`}
          extra={
            <antd.Button
              type="primary"
              loading={crd.cfgBusy}
              icon={<CheckIcon size={16} />}
              style={{ minHeight: 48, minWidth: 104, fontSize: 14, flexShrink: 0 }}
              onClick={() => void crd.doCfg()}
            >
              {tr("保存")}
            </antd.Button>
          }
        />
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
        <div
          style={{
            display: "grid",
            gap: 10,
            // 窄屏收边：375 竖屏下把 4px 侧边距压到 2px，内容多出 4px 宽。
            padding: narrow ? "4px 2px 12px" : "4px 4px 12px",
          }}
        >
          {crd.cfgTeam ? (
            <CrdCfgForm
              cfgTeam={crd.cfgTeam}
              cfg={crd.cfg}
              cfgRows={crd.cfgRows}
              cfgBusy={crd.cfgBusy}
              setCfg={crd.setCfg}
              setCfgBatchModel={crd.setCfgBatchModel}
              updateCfgRow={crd.updateCfgRow}
              removeCfgRow={crd.removeCfgRow}
              addCfgRow={crd.addCfgRow}
              cfgBatchModel={crd.cfgBatchModel}
              applyCfgBatch={crd.applyCfgBatch}
              cfgBatchLeaderCount={crd.cfgBatchLeaderCount}
              cfgBatchWorkerCount={crd.cfgBatchWorkerCount}
              workers={workers}
              workerNames={crd.workerNames}
              modelOptions={catalog.modelOptions}
              modelCandidates={catalog.modelCandidates}
              providers={catalog.providers}
              gatewayOptions={catalog.gatewayOpts || []}
              tr={tr}
              t={t}
            />
          ) : (
            <antd.Spin spinning style={{ padding: 24 }}>
              <div style={{ color: t.textSecondary, fontSize: 12, minWidth: 200 }}>
                {tr("团队设置加载中…")}
              </div>
            </antd.Spin>
          )}
          {crd.cfgTeam ? (
            <AddStandaloneWorkers
              teams={teams}
              workers={workers}
              busy={crd.cfgBusy}
              onAdd={(n: string) => void crd.doAddWorker(team.name, n)}
              tr={tr}
              t={t}
            />
          ) : null}
          {/* 危险区：删除团队（L1；Controller 仅 admin 放行）。
              #1536：非 L1 调用者 disabled + 统一提示（不隐藏）。 */}
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "red" }}>
              {tr("危险区")}
            </span>
            {canControl ? (
              <antd.Button
                danger
                disabled={crd.cfgBusy}
                icon={<TrashIcon size={16} />}
                style={{
                  minHeight: 48,
                  justifyContent: "flex-start",
                  fontSize: 13.5,
                }}
                onClick={confirmDelete}
              >
                {tr("删除团队")}
              </antd.Button>
            ) : (
              <WbTooltip title={deniedHint} tap={false}>
                <span style={{ display: "inline-block", width: "100%" }}>
                  <antd.Button
                    danger
                    disabled
                    icon={<TrashIcon size={16} />}
                    style={{
                      minHeight: 48,
                      justifyContent: "flex-start",
                      fontSize: 13.5,
                    }}
                  >
                    {tr("删除团队")}
                  </antd.Button>
                </span>
              </WbTooltip>
            )}
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("成员 Worker 保留（变未分组）；6 秒内可从提示条撤销（按快照重建，房间历史不恢复）。")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 团队设置「加入 Worker」：列未归属任何团队的 Worker（computeStandaloneWorkers
同源——admin.workers 中不在任何 teams[].workerNames/workerMembers 的），
一键 PUT 合并进当前团队（保留原有成员，角色 = worker）。独立 Worker 的回头路。 */
function AddStandaloneWorkers({
  teams,
  workers,
  busy,
  onAdd,
  tr,
  t,
}: {
  teams: TeamInfo[];
  workers: AdminData["workers"];
  busy: boolean;
  onAdd: (workerName: string) => void;
  tr: (s: string, v?: Record<string, string | number>) => string;
  t: ReturnType<typeof useThemeColors>;
}) {
  const { narrow } = useWbViewport();
  const standalone = React.useMemo(
    () => computeStandaloneWorkers(teams, workers),
    [teams, workers],
  );
  return (
    <antd.Collapse
      ghost
      size="small"
      defaultActiveKey={[]}
      items={[
        {
          key: "join",
          label: (
            <CfgSectionLabel
              icon={<PlusIcon size={15} />}
              title={tr("加入 Worker")}
              badge={tr("{n} 个未归属", { n: standalone.length })}
              hint={tr("未归属任何团队的 Worker 一键并入")}
              t={t}
            />
          ),
          styles: {
            header: {
              minHeight: 48,
              padding: narrow ? "10px 12px" : "12px 10px",
            },
            body: { padding: narrow ? "0 12px 12px" : "0 10px 12px" },
          },
          children: (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("一键加入 = PUT 合并进当前团队成员（保留原有成员，角色 = worker）。")}
              </div>
              {standalone.length ? (
                standalone.map((n) => (
                  <div
                    key={n}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 12, minWidth: 0 }}>{n}</span>
                    <div style={{ flex: "1 1 0" }} />
                    <antd.Button
                      loading={busy}
                      icon={<PlusIcon size={15} />}
                      style={{ minHeight: 44, whiteSpace: "nowrap" }}
                      onClick={() => onAdd(n)}
                    >
                      {tr("加入本团队")}
                    </antd.Button>
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("无未归属 Worker（未被任何 Team CR 引用的 Worker）——可到 CRD 管理 → 新建 Worker 创建。")}
                </div>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}

/** 未分组 / 非 Team CR → 引导 + StandaloneWorkerModels 弹窗入口。 */
function StandaloneEntry({
  tr,
  t,
  teamName,
  workers,
  onRefreshAdmin,
  onBack,
}: {
  tr: (s: string, v?: Record<string, string | number>) => string;
  t: ReturnType<typeof useThemeColors>;
  teamName: string;
  workers: AdminData["workers"];
  onRefreshAdmin?: (silent?: boolean, strong?: boolean) => void;
  onBack: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const count = React.useMemo(
    () => workers.filter((w) => !(w.team || "").trim()).length,
    [workers],
  );

  return (
    <div style={{ display: "grid", gap: 10, padding: 4 }}>
      <PaneHeader tr={tr} t={t} onBack={onBack} title={teamName || tr("未分组")} />
      <antd.Card size="small">
        <div style={{ display: "grid", gap: 8, fontSize: 12.5, color: t.textSecondary }}>
          <span>
            {tr(
              "未分组是后端为无 team 的 Worker 造的伪团队（不是 Team CR）——没有团队级设置（描述 / 心跳 / LLM 调优 / 团队技能等）。",
            )}
          </span>
          <span>{tr("Worker 级模型可单独改：当前 {n} 个 Worker 未分组。", { n: count })}</span>
          <antd.Button
            type="primary"
            icon={<SettingsIcon size={16} />}
            style={{ minHeight: 44, justifyContent: "flex-start" }}
            onClick={() => setOpen(true)}
          >
            {tr("打开 Worker 模型设置")}
          </antd.Button>
        </div>
      </antd.Card>
      <StandaloneWorkerModels
        workers={workers}
        open={open}
        onClose={() => setOpen(false)}
        onRefreshAdmin={onRefreshAdmin}
      />
    </div>
  );
}
