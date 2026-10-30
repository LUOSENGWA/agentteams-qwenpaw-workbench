// CrdSection.tsx — 「管理」页 CRD 管理域（方案 §4.2，P4）。
//
// CRD 域 = 纯创建面（16.28）：旧记录列表/行操作已移至团队管理域
// （TeamSection→TeamSettingsPane→CrdCfgForm 团队配置/删除）与人员管理域
// （PeopleSection→HumanAccessModal 访问与权限）；本域只保留创建表单。
//
// 栏职责（方案 §4.2）：
// - mid:   三个入口卡（员工入职 Human CRD / 创建团队 Team CRD / 新建 Worker）
//          + 各自记录数
// - right: 入口选中 → 原 CRD 表单（crdmanage/* 组件零行为改动直用）：
//          human  → CrdHumanForm（+ 入职成功初始密码弹窗）
//          team   → 导出 JSON + CrdTeamForm + CrdCheckPanel
//          worker → CrdWorkerForm
// - full:  本域不用（横屏无覆盖二级页；竖屏 L2 走 right）
//
// L1 门控：hasToken && admin（与旧 WorkerManage→CrdManage 同门）；L2 → 引导。
// 四个重 hook（catalog/human/millforge/team）放 CrdDomain 内层组件——
// 仅 L1 且有管理数据时挂载（useModelCatalog 挂载即拉网关 alias，L2 不拨号）。
//
// 跨域复用（不复制逻辑）：
// - 建队表单千锻折叠区 = useMillforgeCreate 实例（pre/post 经 ref 断环，
//   与 CrdManage 同款接线）。
//
// 四栏（cols=4）本组件只收 l1/mid（16.28：无右栏，与集群域同款）。

import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useModelCatalog } from "../crdmanage/useModelCatalog";
import { useHumanCrd } from "../crdmanage/useHumanCrd";
import { useTeamCrd } from "../crdmanage/useTeamCrd";
import CrdHumanForm from "../crdmanage/CrdHumanForm";
import CrdTeamForm from "../crdmanage/CrdTeamForm";
import CrdCheckPanel from "../crdmanage/CrdCheckPanel";
import CrdWorkerForm from "../crdmanage/CrdWorkerForm";
import { useMillforgeCreate } from "../millforge/useMillforgeCreate";
import { UserIcon, TeamIcon, RobotIcon } from "../components/icons";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export default function CrdSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const tr = useT();
  // L1 门控（与旧 CrdManage 渲染条件一致）。
  if (!(data.hasToken && data.admin)) {
    return (
      <div style={{ display: "grid", gap: 8, padding: 12 }}>
        <antd.Alert
          type="info"
          showIcon
          message={tr("CRD 管理需要 Controller 管理员 token（L1）")}
          description={tr("到设置页填 Controller 地址 + 管理员 token 后可创建/配置 Human / Team / Worker CRD。")}
        />
      </div>
    );
  }
  return (
    <CrdDomain nav={nav} cols={cols} data={data} variant={variant} t={t} tr={tr} />
  );
}

/** L1 内层：四个重 hook + 三入口/三表单（仅 L1+admin 挂载）。 */
function CrdDomain({
  nav,
  cols,
  data,
  variant,
  t,
  tr,
}: ManageSectionProps & {
  t: ReturnType<typeof useThemeColors>;
  tr: (s: string, v?: Record<string, string | number>) => string;
}) {
  const humans = data.admin?.humans ?? [];
  const teams = data.admin?.teams ?? [];
  const workers = data.admin?.workers ?? [];
  const onRefresh = data.onRefreshAdmin ?? (() => undefined);

  const catalog = useModelCatalog({ workers, tr });
  const human = useHumanCrd({ onRefresh, tr });
  // 千锻段：core 实例供建队表单折叠区持有；pre/post 钩子经 ref 断环
  // （preCreate 依赖 tForm.name，tForm 归 useTeamCrd 管——与 CrdManage 同款）。
  const mf = useMillforgeCreate(tr, workers);
  const mfPreRef = React.useRef(mf.preCreate);
  mfPreRef.current = mf.preCreate;
  const mfPostRef = React.useRef(mf.postCreate);
  mfPostRef.current = mf.postCreate;
  const mfPre = React.useCallback((name: string) => mfPreRef.current(name), []);
  const mfPost = React.useCallback((): string | null => {
    return mfPostRef.current();
  }, []);
  const team = useTeamCrd({
    teams,
    workers,
    onRefresh,
    tr,
    catalog,
    millforgePreCreate: mfPre,
    millforgePostCreate: mfPost,
  });

  const teamNames = teams.map((x) => x.name);
  const workerNames = workers.map((x) => x.name);
  const humanNames = humans.map((x) => x.name);

  // ── 数据未就绪瞬态（admin 刷新中清空）──
  if (!data.admin) {
    return (
      <div style={{ padding: 12 }}>
        <antd.Spin spinning>
          <div style={{ color: t.textSecondary, fontSize: 12, minWidth: 200 }}>
            {tr("管理数据加载中…")}
          </div>
        </antd.Spin>
      </div>
    );
  }

  // ── 入口卡（2/3 栏 mid；四栏 L1 列；选中入口高亮）──
  const renderEntries = () => {
    const entries = [
      {
        id: "human" as const,
        icon: UserIcon,
        title: tr("员工入职"),
        desc: tr("Human CRD 入职（名字 / 团队 / 权限档位）；初始密码只显示一次"),
        count: humans.length,
      },
      {
        id: "team" as const,
        icon: TeamIcon,
        title: tr("创建团队"),
        desc: tr("Team CRD（Leader + Worker 行 + 模型）+ 创建自检"),
        count: teams.length,
      },
      {
        id: "worker" as const,
        icon: RobotIcon,
        title: tr("新建 Worker"),
        desc: tr("Worker CRD（名字 + 模型 + SOUL）"),
        count: workers.length,
      },
    ];
    return (
      <div style={{ display: "grid", gap: 8, padding: 4 }}>
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => nav.setCrdView(e.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              minHeight: 44,
              padding: "10px 12px",
              textAlign: "left",
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              background: nav.crdView === e.id ? t.hoverBg : t.cardBg,
              color: "inherit",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <e.icon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: t.text,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {e.title}
                <antd.Tag style={{ margin: 0, fontSize: 10.5 }}>
                  {tr("{n} 条记录", { n: e.count })}
                </antd.Tag>
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: t.textSecondary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.desc}
              </span>
            </span>
            <span style={{ color: t.textSecondary, fontSize: 15, flexShrink: 0 }}>›</span>
          </button>
        ))}
      </div>
    );
  };

  // l1（四栏）与 2/3 栏 mid：入口卡。
  if (variant === "l1") return renderEntries();
  if (variant === "mid" && cols !== 4) return renderEntries();

  // ── full：本域不用 ──
  if (variant === "full") return null;

  const view = nav.crdView;

  // ── 四栏：mid = 入口对应表单（列表态 → 引导）；无右栏（16.28，与集群域同款）──
  if (cols === 4 && variant === "mid" && view === "list") {
    return (
      <div style={{ display: "grid", gap: 8, padding: 12, textAlign: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
          {tr("选择 CRD 入口")}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("点左侧列表入口显示对应表单")}
        </span>
      </div>
    );
  }

  // ── 2/3 栏 right：入口列表态 → 引导；否则入口对应表单 ──
  if (view === "list") {
    return (
      <div style={{ display: "grid", gap: 8, padding: 12, textAlign: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
          {tr("选择 CRD 入口")}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("点中栏入口卡后这里显示对应表单")}
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10, padding: 4 }}>
      {view === "human" ? (
        <CrdHumanForm
          hForm={human.hForm}
          setHForm={human.setHForm}
          hBusy={human.hBusy}
          doCreateHuman={human.doCreateHuman}
          teamNames={teamNames}
          workerNames={workerNames}
          tr={tr}
        />
      ) : null}
      {view === "team" ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{tr("创建团队")}</span>
            <div style={{ flex: 1 }} />
            {/* 导出 JSON（保留自旧 CrdManage 卡头）。 */}
            <antd.Button
              size="small"
              loading={team.exporting}
              onClick={() => void team.doExportCrd()}
            >
              {tr("导出 JSON")}
            </antd.Button>
          </div>
          <CrdTeamForm
            tForm={team.tForm}
            setTForm={team.setTForm}
            workerRows={team.workerRows}
            updateRow={team.updateRow}
            removeRow={team.removeRow}
            addRow={team.addRow}
            doCreateTeam={team.doCreateTeam}
            tBusy={team.tBusy}
            workers={workers}
            humanNames={humanNames}
            workerNames={workerNames}
            modelOptions={catalog.modelOptions}
            modelCandidates={catalog.modelCandidates}
            modelOf={catalog.modelOf}
            loadSoulFile={catalog.loadSoulFile}
            millforge={mf}
            tr={tr}
            t={t}
          />
          <CrdCheckPanel tCheck={team.tCheck} startTeamCheck={team.startTeamCheck} tr={tr} t={t} />
        </>
      ) : null}
      {view === "worker" ? (
        <CrdWorkerForm
          nw={team.nw}
          setNw={team.setNw}
          doCreateWorker={team.doCreateWorker}
          modelOptions={catalog.modelOptions}
          modelCandidates={catalog.modelCandidates}
          loadSoulFile={catalog.loadSoulFile}
          tr={tr}
          t={t}
        />
      ) : null}

      {/* 入职成功——initialPassword 只显示一次（自旧 CrdManage 原样搬移）。 */}
      {human.created ? (
        <antd.Modal
          open
          title={tr("入职成功——初始密码")}
          onCancel={() => human.setCreated(null)}
          footer={
            <antd.Space>
              <antd.Button onClick={human.copyPassword}>{tr("复制")}</antd.Button>
              <antd.Button type="primary" onClick={() => human.setCreated(null)}>
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
            value={`${human.created.name} / ${human.created.password}`}
            style={{ fontFamily: "monospace" }}
          />
        </antd.Modal>
      ) : null}
    </div>
  );
}
