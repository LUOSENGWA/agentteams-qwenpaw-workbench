import type * as ReactNS from "react";

import type { HumanInfo, WorkerTreeTeam } from "../api";
import TruncatedId from "./TruncatedId";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

/**
 * v0.4.98（M33 G5②/D4「我的团队/我的权限」员工视角只读视图）：
 * 当前登录账号能看到什么、被授权了什么——F2 产品化的员工侧半边
 * （L1 侧的「团队访问配置矩阵」是管理员半边，v0.4.97 再版 4）。
 *
 * 数据源（全部现有端点，零新后端）：
 *  - L1（配了 Controller token）：adminData.humans 中 matrixUserID == 我的
 *    MXID（config.matrix.user_id，登录后后端已存）的那条记录——
 *    level/accessibleTeams/accessibleWorkers 直读。
 *  - L2（Matrix 登录，无 token）：可见团队 = Controller 按本账号
 *    accessibleTeams 过滤后的团队列表（8/27 调研实锤：L2 读路径自动过滤）。
 * 写操作一律不在本卡（等上游 G3 PR——员工自助写路径刻意未开放）。
 */
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface MyScopeCardProps {
  /** 当前 Matrix 登录账号的 MXID（config.matrix.user_id）；空 = 未登录，卡片隐藏。 */
  myUserId: string;
  hasToken: boolean;
  humans: HumanInfo[];
  /** 团队树（L2 的可见范围数据源；L1 用 human 记录，不依赖此值）。 */
  teams: WorkerTreeTeam[];
  treeSource: string;
}

export default function MyScopeCard(props: MyScopeCardProps) {
  const tr = useT();
  const t = useThemeColors();
  const { myUserId, hasToken, humans, teams, treeSource } = props;
  if (!myUserId) return null;

  const localpart = myUserId.replace(/^@/, "").split(":")[0];
  const self = hasToken
    ? humans.find((h) => h.matrixUserID === myUserId)
    : undefined;

  const isL1 = !!self && (self.permissionLevel ?? 2) >= 1;
  const teamsArr =
    self?.accessibleTeams?.length
      ? self.accessibleTeams
      : teams.map((tm) => tm.team_name).filter(Boolean);
  const workersArr = self?.accessibleWorkers ?? [];

  return (
    <antd.Card size="small" styles={{ body: { padding: "10px 14px" } }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 16px" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          🪪 {tr("当前账号")}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 12.5 }}>
            {self?.displayName || localpart}
            {self && self.displayName ? (
              <span style={{ color: t.textSecondary, marginLeft: 6, fontSize: 11 }}>
                {localpart}
              </span>
            ) : null}
          </span>
          <antd.Tag color={isL1 ? "red" : "green"} style={{ margin: 0 }}>
            {isL1 ? tr("L1 管理员") : tr("L2 团队成员")}
          </antd.Tag>
        </span>
        <TruncatedId value={myUserId} label="MXID" />
      </div>
      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: "#999", fontSize: 12, flexShrink: 0 }}>
            {tr("可访问团队")}
          </span>
          {teamsArr.length ? (
            teamsArr.map((nm) => (
              <antd.Tag key={nm} style={{ margin: 0, fontSize: 11 }}>
                {nm}
              </antd.Tag>
            ))
          ) : (
            <span style={{ color: t.textSecondary, fontSize: 12 }}>—</span>
          )}
        </div>
        {self ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: "#999", fontSize: 12, flexShrink: 0 }}>
              {tr("可访问 Worker")}
            </span>
            {workersArr.length ? (
              workersArr.map((nm) => (
                <antd.Tag key={nm} style={{ margin: 0, fontSize: 11 }}>
                  {nm}
                </antd.Tag>
              ))
            ) : (
              <span style={{ color: t.textSecondary, fontSize: 12 }}>
                {tr("未限定（本团队全部）")}
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr(
              "上方团队 = Controller 按你的授权（accessibleTeams）过滤后的可见范围；Worker/权限明细需管理员（L1）视角。",
            )}
          </div>
        )}
        {!self && hasToken ? (
          <div style={{ fontSize: 11, color: "#faad14" }}>
            {tr("当前账号不在人员列表——尚未入职（onboard）或账号名不匹配")}
          </div>
        ) : null}
        {!self && !hasToken && treeSource === "room-fallback" ? (
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("当前为房间聚合视图（团队数据未接通）——接通后此处显示真实团队范围")}
          </div>
        ) : null}
      </div>
    </antd.Card>
  );
}
