/**
 * TeamSection.tsx — 「管理」页团队管理域（P1：列表 + 拓扑）。
 *
 * 栏职责（方案 §4.1）：
 * - mid:   teamView==="list" → 团队列表（一个搜索框同时搜人/团队，
 *          匹配人时行内显「匹配成员」；按人排序 leader 名优先；
 *          「未分组」固定置底且同等管理）；
 *          否则 → 团队拓扑（节点 = 名字+头像+状态灯，细节进右栏；
 *          头部 = 团队名+成员数+团队设置齿轮；齿轮下 = 千锻注入卡）。
 * - right: teamView==="worker" → Worker 详情（P2）；
 *          teamView==="settings" → 团队设置内联（P3）；
 *          列表态右栏留空（用户明确要求）
 * - full:  团队域不用（集群域专属覆盖栏）
 *
 * 头像源：data.rooms（team.room_id → room.members[mxid].avatar_url，
 * mxc 经 useAvatarUrl 的 host.fetch blob 链路；取不到落首字母兜底）。
 * 待决策徽章：data.attentionPendingByRoom（room_id → 条数；
 * 旧 controller 未部署 attention = undefined → 整列不显，诚实降级）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import type {
  TeamInfo,
  TeamMember,
  WorkerSpawnGroup,
  WorkerTreeTeam,
} from "../api";
import { useAvatarUrl } from "../useAvatar";
import {
  PRIMARY,
  ROLE_BADGE,
  ROLE_COLOR,
  phaseMeta,
} from "../components/WorkerManageShared";
import { SearchIcon, SettingsIcon, TeamIcon } from "../components/icons";
import MillforgeModal from "../millforge/MillforgeModal";
import WorkerDetailPane from "./WorkerDetailPane";
import TeamSettingsPane from "./TeamSettingsPane";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 后端伪团队名（teams_api.py：无 team 的 Worker 聚合，非 Team CR）。 */
const UNGROUPED = "未分组";
/** 状态摘要口径：休眠 = Sleeping/Stopped；异常 = Failed/Error（PHASE_COLOR 红色集）。 */
const SLEEPING_PHASES = new Set(["Sleeping", "Stopped"]);
const ABNORMAL_PHASES = new Set(["Failed", "Error"]);

/** Worker/Leader 头像（mxc → host.fetch blob；加载中/失败 = 首字母兜底）。 */
function MgAvatar({
  url,
  name,
  icon,
  size = 28,
}: {
  url?: string;
  name: string;
  icon?: ReactNS.ReactNode;
  size?: number;
}) {
  const obj = useAvatarUrl(url);
  return (
    <antd.Avatar
      size={size}
      src={obj}
      icon={icon}
      style={{ flexShrink: 0, fontSize: Math.round(size * 0.4) }}
    >
      {name ? name.slice(0, 1) : "?"}
    </antd.Avatar>
  );
}

/** 团队行聚合（排序键 + 状态摘要 + 待决策数）。 */
interface TeamRow {
  key: string;
  name: string;
  team: WorkerTreeTeam;
  leader: WorkerSpawnGroup | null;
  sleeping: number;
  abnormal: number;
  pending: number;
}

function buildTeamRows(
  teams: WorkerTreeTeam[],
  attentionByRoom: Record<string, number> | undefined,
): TeamRow[] {
  const rows: TeamRow[] = teams.map((team) => {
    const name = team.team_name || UNGROUPED;
    const leader = team.workers.find((w) => w.role === "leader") ?? null;
    let sleeping = 0;
    let abnormal = 0;
    for (const w of team.workers) {
      const phase = w.phase || "";
      if (SLEEPING_PHASES.has(phase)) sleeping += 1;
      else if (ABNORMAL_PHASES.has(phase)) abnormal += 1;
    }
    return {
      key: name,
      name,
      team,
      leader,
      sleeping,
      abnormal,
      pending: team.room_id ? attentionByRoom?.[team.room_id] ?? 0 : 0,
    };
  });
  // 按人排序：leader 名优先（无 leader 取首个成员名）；「未分组」固定置底。
  rows.sort((a, b) => {
    const aU = a.name === UNGROUPED ? 1 : 0;
    const bU = b.name === UNGROUPED ? 1 : 0;
    if (aU !== bU) return aU - bU;
    const ka = (
      a.leader?.worker_name ||
      a.team.workers[0]?.worker_name ||
      a.name
    ).toLowerCase();
    const kb = (
      b.leader?.worker_name ||
      b.team.workers[0]?.worker_name ||
      b.name
    ).toLowerCase();
    return ka.localeCompare(kb, "zh");
  });
  return rows;
}

/** 中栏 A：团队列表（方案 §4.1.1）。搜索态由父组件持有（matched 同源）。 */
function TeamListPane({
  rows,
  teams,
  matched,
  roomAvatars,
  query,
  onQueryChange,
  treeLoading,
  treeSource,
  hasToken,
  onOpen,
  onGotoCrdCreate,
}: {
  rows: TeamRow[];
  teams: WorkerTreeTeam[];
  /** 搜索命中：row.key → 匹配成员（[] = 团队名命中；无搜索 = 空 Map）。 */
  matched: Map<string, WorkerSpawnGroup[]>;
  roomAvatars: Map<string, TeamMember>;
  query: string;
  onQueryChange: (q: string) => void;
  treeLoading?: boolean;
  treeSource?: string;
  hasToken?: boolean;
  onOpen: (row: TeamRow) => void;
  onGotoCrdCreate: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const visible = query.trim() ? rows.filter((row) => matched.has(row.key)) : rows;
  const noTeams = teams.length === 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 4 }}>
      <antd.Input
        allowClear
        prefix={<SearchIcon size={14} />}
        placeholder={tr("搜索团队 / 成员…")}
        value={query}
        onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
          onQueryChange(e.target.value)
        }
        style={{ borderRadius: 8 }}
        aria-label={tr("搜索团队 / 成员")}
      />
      {treeSource === "room-fallback" ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("团队数据未接通——以下为房间聚合（群聊），不是真实团队结构")}
        />
      ) : null}
      <antd.Spin spinning={!!treeLoading}>
        {visible.length ? (
          <div style={{ display: "grid", gap: 4 }}>
            {visible.map((row) => {
              const hits = matched.get(row.key);
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => onOpen(row)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minHeight: 48,
                    padding: "6px 10px",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: "transparent",
                    textAlign: "left",
                    width: "100%",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = t.hoverBg;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <MgAvatar
                    url={
                      row.leader?.mxid
                        ? roomAvatars.get(row.leader.mxid)?.avatar_url
                        : undefined
                    }
                    name={row.leader?.worker_name || row.name}
                    icon={row.leader ? undefined : <TeamIcon size={14} />}
                    size={30}
                  />
                  <span
                    style={{
                      minWidth: 0,
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 13,
                          color: t.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.name}
                      </span>
                      {row.pending > 0 ? (
                        <antd.Tag
                          color="orange"
                          style={{ margin: 0, flexShrink: 0 }}
                        >
                          {tr("待决策")} {row.pending}
                        </antd.Tag>
                      ) : null}
                    </span>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                        fontSize: 11,
                        color: t.textSecondary,
                        minWidth: 0,
                      }}
                    >
                      <span>
                        {tr("成员")} {row.team.workers.length}
                      </span>
                      {row.sleeping > 0 ? (
                        <antd.Tag color="default" style={{ margin: 0 }}>
                          {tr("休眠")} {row.sleeping}
                        </antd.Tag>
                      ) : null}
                      {row.abnormal > 0 ? (
                        <antd.Tag color="red" style={{ margin: 0 }}>
                          {tr("异常")} {row.abnormal}
                        </antd.Tag>
                      ) : null}
                      {hits && hits.length ? (
                        <span style={{ color: PRIMARY }}>
                          {tr("匹配成员")}：
                          {hits.map((w) => w.worker_name).join("、")}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : noTeams ? (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={tr("暂无团队")}
            style={{ margin: "24px 0" }}
          >
            {hasToken ? (
              <antd.Button size="small" type="primary" onClick={onGotoCrdCreate}>
                {tr("去 CRD 管理创建团队")}
              </antd.Button>
            ) : (
              <span style={{ fontSize: 12, color: t.textSecondary }}>
                {tr("加入团队房间后这里显示你的团队结构")}
              </span>
            )}
          </antd.Empty>
        ) : (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={tr("无匹配团队 / 成员")}
            style={{ margin: "24px 0" }}
          />
        )}
      </antd.Spin>
    </div>
  );
}

/** 中栏 B：团队拓扑（方案 §4.1.2——节点只显 名字+头像+状态灯）。 */
function TeamTopologyPane({
  nav,
  team,
  roomAvatars,
  data,
  onOpenMillforge,
}: {
  nav: ManageSectionProps["nav"];
  team: WorkerTreeTeam;
  roomAvatars: Map<string, TeamMember>;
  data: ManageSectionProps["data"];
  onOpenMillforge: (teamInfo: TeamInfo) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const teamName = team.team_name || UNGROUPED;
  // 千锻注入目标 = 同名 Team CR（未分组/CRD 列表缺此团队 = 无注入目标）。
  const adminTeam = React.useMemo(
    () => (data.admin?.teams ?? []).find((x) => x.name === teamName) ?? null,
    [data.admin, teamName],
  );
  const mfDisabledReason = !data.hasToken
    ? tr("千锻注入需 L1 管理 token")
    : !data.admin
      ? tr("管理数据未就绪")
      : !adminTeam
        ? tr("该团队不是 Team CR（如「未分组」），千锻注入需要团队目标")
        : "";
  // leader 置顶（其余保序）。
  const ordered = React.useMemo(() => {
    const arr = [...team.workers];
    arr.sort((a, b) => {
      const al = a.role === "leader" ? 0 : 1;
      const bl = b.role === "leader" ? 0 : 1;
      return al - bl;
    });
    return arr;
  }, [team.workers]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 4 }}>
      {/* 头部：团队名 + 成员数 + 团队设置齿轮（→ 右栏内联设置，P3） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 44,
        }}
      >
        <TeamIcon size={16} />
        <span
          style={{
            fontWeight: 700,
            fontSize: 14,
            color: t.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {teamName}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
          {tr("成员")} {team.workers.length}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => nav.openTeamSettings()}
          title={tr("团队设置")}
          aria-label={tr("团队设置")}
          style={{
            width: 44,
            height: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: t.textSecondary,
            borderRadius: 8,
            cursor: "pointer",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = t.hoverBg;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <SettingsIcon size={16} />
        </button>
      </div>
      {/* 千锻注入卡（注入入口，非常驻创建表单） */}
      <antd.Card size="small" styles={{ body: { padding: "6px 12px" } }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
          }}
        >
          <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
              {tr("千锻")}
            </span>
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("选模板 / 自定义 → 编译预览 → 注入 Worker")}
            </span>
          </span>
          <antd.Button
            size="small"
            type="primary"
            disabled={!!mfDisabledReason}
            title={mfDisabledReason || undefined}
            onClick={() => adminTeam && onOpenMillforge(adminTeam)}
          >
            {tr("打开千锻注入")}
          </antd.Button>
        </div>
      </antd.Card>
      {/* 节点列表：名字 + 头像 + 状态灯（点节点 → 右栏详情，P2） */}
      <div style={{ display: "grid", gap: 4 }}>
        {ordered.map((w) => {
          const meta = phaseMeta(w.phase || "");
          return (
            <button
              key={w.worker_name}
              type="button"
              onClick={() => nav.openWorker(w.worker_name)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                minHeight: 44,
                padding: "0 10px",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                background: "transparent",
                textAlign: "left",
                width: "100%",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = t.hoverBg;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <MgAvatar url={roomAvatars.get(w.mxid)?.avatar_url} name={w.worker_name} size={30} />
              <span
                style={{
                  fontWeight: w.role === "leader" ? 700 : 400,
                  fontSize: 13,
                  color: t.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {w.worker_name}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: ROLE_COLOR[w.role] || t.textSecondary,
                  flexShrink: 0,
                }}
              >
                {tr(ROLE_BADGE[w.role])}
              </span>
              <div style={{ flex: 1 }} />
              <span
                title={tr("Worker 状态")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: meta.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                {meta.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function TeamSection({ nav, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const tr = useT();
  // 列表搜索态（父持有——命中表 matched 与列表同源）。
  const [query, setQuery] = React.useState("");
  // 千锻注入对话框目标（null = 关闭）。
  const [mfTeam, setMfTeam] = React.useState<TeamInfo | null>(null);

  // 房间成员头像表（mxid → TeamMember）。
  const roomAvatars = React.useMemo(() => {
    const m = new Map<string, TeamMember>();
    for (const r of data.rooms ?? []) {
      for (const [mxid, mem] of Object.entries(r.members || {})) m.set(mxid, mem);
    }
    return m;
  }, [data.rooms]);

  const teamRows = React.useMemo(
    () => buildTeamRows(data.teams, data.attentionPendingByRoom),
    [data.teams, data.attentionPendingByRoom],
  );

  // 搜索命中表（row.key → 匹配成员）：团队名命中 或 成员名命中；
  // 行内「匹配成员」提示只在成员名命中时显（团队名命中整行已自明）。
  const q = query.trim().toLowerCase();
  const matched = React.useMemo(() => {
    const m = new Map<string, WorkerSpawnGroup[]>();
    if (!q) return m;
    for (const row of teamRows) {
      const teamHit = row.name.toLowerCase().includes(q);
      if (teamHit) {
        m.set(row.key, []);
        continue;
      }
      const hits = row.team.workers.filter((w) =>
        w.worker_name.toLowerCase().includes(q),
      );
      if (hits.length) m.set(row.key, hits);
    }
    return m;
  }, [teamRows, q]);

  const selectedTeam = React.useMemo(
    () =>
      nav.selectedTeam
        ? data.teams.find((tm) => (tm.team_name || UNGROUPED) === nav.selectedTeam) ??
          null
        : null,
    [nav.selectedTeam, data.teams],
  );

  // Worker 详情数据源（右栏/竖屏 L2）：按名查 admin。
  const workerInfo = React.useMemo(
    () =>
      nav.selectedWorker
        ? (data.admin?.workers ?? []).find((w) => w.name === nav.selectedWorker) ?? null
        : null,
    [nav.selectedWorker, data.admin],
  );

  const gotoCrdCreate = React.useCallback(() => {
    nav.setSection("crd");
    nav.setCrdView("team");
  }, [nav]);

  // 列表态右栏留空（用户明确要求）——hooks 之后才允许提前返回。
  if (variant === "right" && nav.teamView === "list") return null;

  const body =
    variant === "mid" ? (
      nav.teamView === "list" ? (
        <TeamListPane
          rows={teamRows}
          teams={data.teams}
          matched={matched}
          roomAvatars={roomAvatars}
          query={query}
          onQueryChange={setQuery}
          treeLoading={data.treeLoading}
          treeSource={data.treeSource}
          hasToken={data.hasToken}
          onOpen={(row) => nav.openTeam(row.key)}
          onGotoCrdCreate={gotoCrdCreate}
        />
      ) : selectedTeam ? (
        <TeamTopologyPane
          nav={nav}
          team={selectedTeam}
          roomAvatars={roomAvatars}
          data={data}
          onOpenMillforge={setMfTeam}
        />
      ) : (
        // 选中团队已从数据中消失（刷新后改名/删除）→ 回列表引导。
        <div style={{ padding: 24, textAlign: "center" }}>
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={tr("所选团队已不在最新数据中")}
          >
            <antd.Button size="small" onClick={() => nav.backTeam()}>
              {tr("回团队列表")}
            </antd.Button>
          </antd.Empty>
        </div>
      )
    ) : variant === "right" ? (
      nav.teamView === "worker" ? (
        workerInfo ? (
          <WorkerDetailPane
            worker={workerInfo}
            avatarUrl={roomAvatars.get(workerInfo.matrixUserID)?.avatar_url}
            hasToken={data.hasToken}
            onRefreshAdmin={data.onRefreshAdmin}
            onOpenSettings={data.onOpenSettings}
          />
        ) : (
          // 选中 Worker 已从数据中消失（刷新后改名/删除）→ 回拓扑。
          <div style={{ padding: 24, textAlign: "center" }}>
            <antd.Empty
              image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
              description={tr("所选 Worker 已不在最新数据中")}
            >
              <antd.Button size="small" onClick={() => nav.backTeam()}>
                {tr("回团队拓扑")}
              </antd.Button>
            </antd.Empty>
          </div>
        )
      ) : nav.teamView === "settings" ? (
        // 团队设置内联（P3）：真 Team CR → CrdCfgForm；未分组 → 引导+弹窗。
        <TeamSettingsPane
          teamName={nav.selectedTeam ?? ""}
          data={data}
          onBack={() => nav.backTeam()}
        />
      ) : (
        <div style={{ display: "grid", gap: 8, padding: 12, textAlign: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
            {tr("选择 Worker / 团队")}
          </span>
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("点中栏 Worker 节点后这里显示详情")}
          </span>
        </div>
      )
    ) : null;

  return (
    <>
      {body}
      <MillforgeModal
        team={mfTeam}
        workers={data.admin?.workers ?? []}
        onRefresh={() => void data.onRefreshAdmin?.(true)}
        onClose={() => setMfTeam(null)}
        t={t}
      />
    </>
  );
}
