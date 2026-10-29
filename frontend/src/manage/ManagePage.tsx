/**
 * ManagePage.tsx — 「管理」页（顶层 tab key=team，替代旧 WorkerManage 页面壳）。
 *
 * 布局（10/29 评审确认，15.36 加 xwide 四栏，按容器宽度 1/2/3/4 栏）：
 * - xwide（w ≥ 1440）→ 4 栏：域导航 160（恒内联）+ L1 列表 280（railOpen 门控）
 *   + 中栏 340 + 右栏 flex(min 400)——VS Code 活动栏/侧栏/编辑器/辅助栏模型：
 *   域导航恒显，toggle 改管 L1 列表列显隐（L1 列内容 = 各域第一层：
 *   团队列表 / CRD 入口 / 人员列表 / 集群概览+入口卡）。
 * - wide（1280–1439）→ 3 栏：左栏 200（内联）+ 中栏 360 + 右栏 flex(min 420)
 * - medium（1024–1279）→ 2 栏：中栏 360 + 右栏 flex；左栏 = 抽屉覆盖（默认收起）
 * - narrow（< 1024）→ 1 栏：中栏全宽；左栏 = 抽屉；右栏内容推为二级页（左上「←」返回）
 * 左栏展开/收起持久化 localStorage `manage.railOpen`（默认 wide 及以上开、其余关）；
 * 页头 toggle 用 MenuIcon（仓库 icons 无 PanelLeft 图标——等价替代，见报告假设）。
 * 横屏详情态页头显可点面包屑（L1 层名 → … → 当前层；当前层不可点），
 * 竖屏「←」返回不变。
 *
 * 集群域 logs/audit 为覆盖「中+右」两栏的二级页（横屏亦然，左栏保留）。
 * 各栏独立滚动（overflow:auto + height:100% 链，页面本身不滚）；
 * minmax(0,1fr) 防撑宽；颜色全走 useThemeColors token（无硬编码色）。
 *
 * 数据/刷新：承接旧 WorkerManage 的 30s 静默刷新（usePoller + activeRef
 * 门控 + refreshRef 稳定引用——rc-tabs 保活，切走不卸载，不门控则后台不零负载）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { usePoller } from "../usePoller";
import { MenuIcon } from "../components/icons";
import { ReloadIcon } from "../components/WorkerManageShared";
import ManageRail from "./ManageRail";
import { useManageNav, type ManageSection } from "./useManageNav";
import type { ManageData, ManageVariant } from "./types";
import TeamSection from "./TeamSection";
import CrdSection from "./CrdSection";
import PeopleSection from "./PeopleSection";
import ClusterSection from "./ClusterSection";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface ManagePageProps extends ManageData {
  /** 当前 tab 是否激活（rc-tabs 保活：30s 轮询门控；稳定 ref 模式，
   * 传 ref 不传 boolean——prop 翻转不击穿 React.memo）。 */
  activeRef?: { current: boolean };
  /** section 深链（一次性请求：首页 SGLang 卡 → 集群管理）。 */
  sectionRequest?: ManageSection | null;
  onSectionRequestConsumed?: () => void;
}

/** 左栏展开态持久化 key（任务书指定 manage.railOpen）。 */
const RAIL_KEY = "manage.railOpen";
/** 栏数断点（10/29 评审 + 15.36 xwide：xwide ≥1440 四栏 / wide ≥1280 三栏 /
 * medium 1024–1279 两栏 / narrow <1024 单栏）。 */
const XWIDE_W = 1440;
const WIDE_W = 1280;
const MEDIUM_W = 1024;

/** 初始默认：wide 开、其余关；localStorage 有值则从值。 */
function readRailDefault(initialWide: boolean): boolean {
  try {
    const v = window.localStorage.getItem(RAIL_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* storage 不可用 → 走默认 */
  }
  return initialWide;
}

const SECTION_TITLE: Record<ManageSection, string> = {
  team: "团队管理",
  crd: "CRD 管理",
  people: "人员管理",
  cluster: "集群管理",
};

function ManagePage(props: ManagePageProps) {
  const t = useThemeColors();
  const tr = useT();
  const nav = useManageNav();
  const {
    teams,
    admin,
    treeLoading,
    adminLoading,
    adminFailCount = 0,
    onRefreshTree,
    onRefreshAdmin,
    onDm,
    hasToken,
    activeRef,
    treeSource = "",
    myUserId = "",
    l1TokenMode,
    workerSessionByName,
    onOpenSettings,
    rooms,
    attentionPendingByRoom,
    sectionRequest,
    onSectionRequestConsumed,
  } = props;

  const data: ManageData = {
    teams,
    admin,
    treeLoading,
    adminLoading,
    adminFailCount,
    onRefreshTree,
    onRefreshAdmin,
    onDm,
    hasToken,
    treeSource,
    myUserId,
    l1TokenMode,
    workerSessionByName,
    onOpenSettings,
    rooms,
    attentionPendingByRoom,
  };

  // ── 30s 静默刷新（旧 WorkerManage 同款：activeRef 门控 + refreshRef）──
  const refreshRef = React.useRef({ tree: onRefreshTree, admin: onRefreshAdmin });
  refreshRef.current = { tree: onRefreshTree, admin: onRefreshAdmin };
  usePoller({
    fn: () => {
      if (activeRef && !activeRef.current) return;
      void refreshRef.current.tree?.(true);
      void refreshRef.current.admin?.(true);
    },
    intervalMs: 30000,
  });

  // ── 容器宽度 → 栏数（ResizeObserver；8px 滞回防断点抖动重渲）──
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [cw, setCw] = React.useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 0,
  );
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setCw((prev) => (w > 0 && Math.abs(w - prev) >= 8 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols: 1 | 2 | 3 | 4 =
    cw >= XWIDE_W ? 4 : cw >= WIDE_W ? 3 : cw >= MEDIUM_W ? 2 : 1;

  // ── 左栏展开/收起（持久化；默认 wide 开、其余关）──
  const [railOpen, setRailOpen] = React.useState<boolean>(() =>
    readRailDefault((typeof window !== "undefined" ? window.innerWidth : 0) >= WIDE_W),
  );
  const setRailPersist = React.useCallback((open: boolean) => {
    setRailOpen(open);
    try {
      window.localStorage.setItem(RAIL_KEY, open ? "1" : "0");
    } catch {
      /* storage 不可用则仅会话内生效 */
    }
  }, []);

  // ── section 深链消费（首页 SGLang 卡 → 集群管理；一次性）──
  const { setSection } = nav;
  React.useEffect(() => {
    if (sectionRequest) {
      setSection(sectionRequest);
      onSectionRequestConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionRequest]);

  const {
    section,
    teamView,
    selectedTeam,
    selectedWorker,
    crdView,
    selectedHuman,
    clusterView,
    inDetail,
    backTeam,
    setCrdView,
    setPeopleView,
    setClusterView,
  } = nav;

  // ── 栏内容：variant 驱动各 section（mid / right / full）──
  const renderSection = (v: ManageVariant) =>
    section === "team" ? (
      <TeamSection nav={nav} cols={cols} data={data} variant={v} />
    ) : section === "crd" ? (
      <CrdSection nav={nav} cols={cols} data={data} variant={v} />
    ) : section === "people" ? (
      <PeopleSection nav={nav} cols={cols} data={data} variant={v} />
    ) : (
      <ClusterSection nav={nav} cols={cols} data={data} variant={v} />
    );

  // 15.36 C：集群详情横屏也走 right 栏（不再覆盖中+右）；仅 narrow（1 栏）
  // 推 L2 二级页（full variant）。
  const isClusterDetail = section === "cluster" && clusterView !== "overview";
  const l2Active = cols === 1 && inDetail;
  // narrow L2 二级页 variant：team 在拓扑态（选中团队、未进 worker/设置）时拓扑活在
  // mid 分支（TeamTopologyPane），须用 "mid" 才能渲染；worker/设置走 right 分支。
  // crd/people 详情表单本就在 right 分支，集群用 full。
  const l2Variant: ManageVariant = isClusterDetail
    ? "full"
    : section === "team" && teamView === "topology"
      ? "mid"
      : "right";

  const onL2Back = React.useCallback(() => {
    if (section === "team") backTeam();
    else if (section === "crd") setCrdView("list");
    else if (section === "people") setPeopleView("list");
    else setClusterView("overview");
  }, [section, backTeam, setCrdView, setPeopleView, setClusterView]);

  // 二级页标题（竖屏 L2 顶栏）。
  const l2Title =
    section === "team"
      ? teamView === "worker"
        ? selectedWorker || ""
        : teamView === "settings"
          ? tr("团队设置")
          : selectedTeam || ""
      : section === "crd"
        ? crdView === "human"
          ? tr("员工入职")
          : crdView === "team"
            ? tr("创建团队")
            : tr("新建 Worker")
        : section === "people"
          ? selectedHuman || tr("人员管理")
          : clusterView === "audit"
            ? tr("审计")
            : clusterView === "upgrade"
              ? tr("运行时批量升级")
              : tr("日志");

  // 页头可点面包屑（横屏详情态在标题右侧；竖屏由 L2 顶栏承载）。
  // 段 = [L1 层] → [层 2] → … → [当前层（不可点）]；点击前缀段逐级回退。
  // cluster（15.36 C）：概览 → 日志/审计/运行时批量升级（详情在 right/mid 栏）。
  const crumbSegs: { label: string; onClick?: () => void }[] = [];
  if (!l2Active) {
    if (section === "team" && selectedTeam) {
      crumbSegs.push({ label: tr("团队列表"), onClick: () => nav.goTeamList() });
      crumbSegs.push({ label: selectedTeam, onClick: () => nav.goTeamTopology() });
      if (teamView === "worker" && selectedWorker) {
        crumbSegs.push({ label: selectedWorker });
      } else if (teamView === "settings") {
        crumbSegs.push({ label: tr("团队设置") });
      }
    } else if (section === "crd" && crdView !== "list") {
      crumbSegs.push({ label: tr("入口列表"), onClick: () => setCrdView("list") });
      crumbSegs.push({
        label:
          crdView === "human" ? tr("员工入职") : crdView === "team" ? tr("创建团队") : tr("新建 Worker"),
      });
    } else if (section === "people" && selectedHuman) {
      crumbSegs.push({ label: tr("人员列表"), onClick: () => nav.clearPeople() });
      crumbSegs.push({ label: selectedHuman });
    } else if (section === "cluster" && clusterView !== "overview") {
      crumbSegs.push({ label: tr("概览"), onClick: () => setClusterView("overview") });
      crumbSegs.push({
        label:
          clusterView === "logs"
            ? tr("组件日志")
            : clusterView === "audit"
              ? tr("审计")
              : tr("运行时批量升级"),
      });
    }
  }

  const paneStyle: ReactNS.CSSProperties = {
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    overflowX: "hidden",
  };

  const gridTemplate =
    cols === 4
      ? railOpen
        ? "160px 280px 340px minmax(400px, 1fr)"
        : "160px 340px minmax(400px, 1fr)"
      : cols === 3 && railOpen
        ? "200px 360px minmax(420px, 1fr)"
        : "360px minmax(420px, 1fr)";

  return (
    <div
      ref={rootRef}
      style={{
        height: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* 页头：左栏 toggle（MenuIcon）+ 域标题/面包屑 + 自动刷新 + 手动刷新 */}
      <header
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setRailPersist(!railOpen)}
          // 四栏：域导航恒显，toggle 管 L1 列表列；其余栏数管左栏（内联/抽屉）。
          title={
            cols === 4
              ? railOpen
                ? tr("收起 L1 列表")
                : tr("展开 L1 列表")
              : railOpen
                ? tr("收起左栏")
                : tr("展开左栏")
          }
          aria-label={
            cols === 4
              ? railOpen
                ? tr("收起 L1 列表")
                : tr("展开 L1 列表")
              : railOpen
                ? tr("收起左栏")
                : tr("展开左栏")
          }
          style={{
            width: 44,
            height: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: `1px solid ${t.border}`,
            background: railOpen ? t.hoverBg : "transparent",
            color: t.textSecondary,
            borderRadius: 8,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <MenuIcon size={16} />
        </button>
        <span
          style={{
            fontWeight: 700,
            fontSize: 15,
            color: t.text,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          {tr(SECTION_TITLE[section])}
          {crumbSegs.length ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 2,
                fontWeight: 400,
                fontSize: 12,
                color: t.textSecondary,
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              <span style={{ flexShrink: 0 }}>/</span>
              {crumbSegs.map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <span style={{ flexShrink: 0 }}>→</span> : null}
                  {s.onClick ? (
                    <button
                      type="button"
                      onClick={s.onClick}
                      style={{
                        height: 44,
                        padding: "0 6px",
                        border: "none",
                        background: "transparent",
                        color: t.textSecondary,
                        fontSize: 12,
                        cursor: "pointer",
                        borderRadius: 6,
                        maxWidth: 140,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flexShrink: 1,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = t.hoverBg;
                        e.currentTarget.style.color = t.text;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = t.textSecondary;
                      }}
                    >
                      {s.label}
                    </button>
                  ) : (
                    <span
                      style={{
                        color: t.text,
                        fontWeight: 600,
                        maxWidth: 140,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flexShrink: 1,
                      }}
                    >
                      {s.label}
                    </span>
                  )}
                </React.Fragment>
              ))}
            </span>
          ) : null}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ color: t.textSecondary, fontSize: 11, flexShrink: 0 }}>
          {tr("自动刷新 30 秒")}
        </span>
        {onRefreshTree || onRefreshAdmin ? (
          <antd.Button
            type="text"
            size="small"
            icon={<ReloadIcon />}
            loading={Boolean(treeLoading) || Boolean(adminLoading)}
            onClick={() => {
              void onRefreshTree?.();
              void onRefreshAdmin?.();
            }}
          >
            {tr("刷新")}
          </antd.Button>
        ) : null}
      </header>

      {l2Active ? (
        // ── L2 二级页：竖屏 1 栏详情 / 集群日志·审计覆盖中+右 ──
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 4,
              paddingBottom: 6,
            }}
          >
            {/* 「←」44px 命中区（方案 §3.3 竖屏返回）。 */}
            <button
              type="button"
              onClick={onL2Back}
              aria-label={tr("返回")}
              title={tr("返回")}
              style={{
                width: 44,
                height: 44,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                background: "transparent",
                color: t.text,
                fontSize: 18,
                cursor: "pointer",
                borderRadius: 8,
                flexShrink: 0,
              }}
            >
              ←
            </button>
            <span
              style={{
                fontWeight: 600,
                fontSize: 14,
                color: t.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {l2Title}
            </span>
          </div>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
            {renderSection(l2Variant)}
          </div>
        </div>
      ) : cols >= 2 ? (
        // ── 2/3/4 栏：中栏 + 右栏（3 栏 wide 且展开时左栏内联成第三列；
        // 4 栏域导航恒内联成第一列，railOpen 时再插 L1 列表列）──
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "grid",
            gap: 12,
            gridTemplateColumns: gridTemplate,
          }}
        >
          {cols === 4 || cols === 3 && railOpen ? (
            <div style={paneStyle}>
              <ManageRail section={section} onSelect={setSection} />
            </div>
          ) : null}
          {cols === 4 && railOpen ? <div style={paneStyle}>{renderSection("l1")}</div> : null}
          <div style={paneStyle}>{renderSection("mid")}</div>
          <div style={paneStyle}>{renderSection("right")}</div>
        </div>
      ) : (
        // ── 1 栏 L1：中栏全宽 ──
        <div style={{ flex: "1 1 auto", minHeight: 0, ...paneStyle }}>{renderSection("mid")}</div>
      )}

      {/* 左栏抽屉（medium/narrow：展开态 = 覆盖层；域切换后自动收起） */}
      {cols < 3 ? (
        <antd.Drawer
          placement="left"
          width={264}
          open={railOpen}
          onClose={() => setRailPersist(false)}
          title={tr("管理")}
          styles={{ body: { padding: "12px 8px", background: t.bg } }}
        >
          <ManageRail
            section={section}
            onSelect={(s) => {
              setSection(s);
              setRailPersist(false);
            }}
          />
        </antd.Drawer>
      ) : null}
    </div>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染且 props 无变化时跳过
//（沿用旧 WorkerManage 的 memo 模式；activeRef 为稳定 ref 不击穿）。
export default React.memo(ManagePage);
