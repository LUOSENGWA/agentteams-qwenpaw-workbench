// CrdManage 拆分（QC-196 方案 §5.2）· 人员列表 + 团队列表（两张表卡）——
// 原主组件 JSX R5b/R5c 逐字搬移；humanCols/teamCols 列定义随迁进各组件
// 函数（恒为每渲染重建，identity 语义与原来相同）；props = 原闭包变量名
// （零改写）。

import type * as ReactNS from "react";

import type { AdminData, HumanInfo, TeamInfo } from "../api";
import type { ThemeColors } from "../theme";
import WbTableFade from "../components/WbTableFade";
import { WbTooltip } from "../components/WbTooltip";
import TruncatedId from "../components/TruncatedId";
import { LEVEL_META, PHASE_COLOR, type TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface CrdHumanTableCardProps {
  humans: AdminData["humans"];
  openPerm: (r: HumanInfo) => void;
  doDeleteHuman: (name: string) => void | Promise<void>;
  tr: TrFn;
}

export function CrdHumanTableCard({
  humans,
  openPerm,
  doDeleteHuman,
  tr,
}: CrdHumanTableCardProps) {
  const humanCols = [
    {
      title: tr("账号"),
      dataIndex: "name",
      width: 100,
      ellipsis: true,
    },
    {
      title: tr("显示名"),
      dataIndex: "displayName",
      width: 100,
      ellipsis: true,
      render: (v: string) => v || "—",
    },
    {
      title: tr("级别"),
      dataIndex: "permissionLevel",
      width: 80,
      render: (v: number | undefined) => {
        const lv = v ?? 2;
        const m = LEVEL_META[lv] ?? { label: `L${lv}`, color: "#999" };
        const tag = <antd.Tag color={m.color}>{m.label}</antd.Tag>;
        return lv === 1 ? (
          <WbTooltip
            title={tr(
              "级别 1 管理员不能经 Matrix 登录获得 L2（上游设计）——团队/团队配置页需用 Controller 管理员 token",
            )}
          >
            {tag}
          </WbTooltip>
        ) : (
          tag
        );
      },
    },
    {
      title: tr("可访问团队"),
      dataIndex: "accessibleTeams",
      width: 210,
      render: (v: string[] | undefined) =>
        v && v.length ? (
          <antd.Space size={[0, 4]} wrap>
            {v.map((x) => (
              <antd.Tag key={x}>{x}</antd.Tag>
            ))}
          </antd.Space>
        ) : (
          "—"
        ),
    },
    {
      title: "MXID",
      dataIndex: "matrixUserID",
 // // 不定宽列在 fixed 布局吃掉全部剩余（170px）→ 定宽 120，余量给可访问团队。
      width: 120,
      ellipsis: true,
      // 长 MXID 截断展示（前 8+…+后 4），悬停看完整值+复制
      // （对齐 dashboard Manager 卡片 TruncatedId 交互）。
      render: (v: string) => <TruncatedId value={v} label="MXID" />,
    },
    {
      title: tr("操作"),
      key: "op",
      width: 90,
      render: (_: unknown, r: HumanInfo) => (
        <antd.Space size={4}>
          <antd.Button size="small" onClick={() => openPerm(r)}>
            {tr("权限")}
          </antd.Button>
          <antd.Popconfirm
            title={tr("确认删除该员工？（不可恢复）")}
            okText={tr("删除")}
            cancelText={tr("取消")}
            onConfirm={() => void doDeleteHuman(r.name)}
          >
            <antd.Button danger size="small">
              {tr("删除")}
            </antd.Button>
          </antd.Popconfirm>
        </antd.Space>
      ),
    },
  ];
  return (
      <antd.Card
        size="small"
        title={tr("人员列表")}
        styles={{ body: { padding: 0 } }}
      >
        <WbTableFade>
        <antd.Table
          size="small"
          rowKey="name"
          columns={humanCols}
          dataSource={humans}
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: 700 }}
          locale={{ emptyText: tr("暂无人员记录") }}
        />
        </WbTableFade>
      </antd.Card>
  );
}

interface CrdTeamTableCardProps {
  teams: AdminData["teams"];
  openCfg: (r: TeamInfo) => void;
  doDeleteTeam: (name: string) => void | Promise<void>;
  /** 「千锻注入」行操作（C）——打开千锻对话框。 */
  onMillforge?: (r: TeamInfo) => void;
  tr: TrFn;
  t: ThemeColors;
}

export function CrdTeamTableCard({
  teams,
  openCfg,
  doDeleteTeam,
  onMillforge,
  tr,
  t,
}: CrdTeamTableCardProps) {
  const teamCols = [
    {
      title: tr("团队"),
      dataIndex: "name",
      width: 140,
      ellipsis: true,
      render: (v: string, r: TeamInfo) => (
        <span>
          {v}
          {r.teamName ? (
            <span style={{ color: t.textSecondary }}>（{r.teamName}）</span>
          ) : null}
        </span>
      ),
    },
    {
      title: tr("阶段"),
      dataIndex: "phase",
      width: 88,
      render: (v: string) => (
        <antd.Tag color={PHASE_COLOR[v] ?? "#999"}>{v || "—"}</antd.Tag>
      ),
    },
    {
      title: tr("Leader"),
      dataIndex: "leaderName",
      width: 110,
      ellipsis: true,
      render: (v: string) => v || "—",
    },
    {
      title: tr("就绪"),
      key: "ready",
      width: 64,
      render: (_: unknown, r: TeamInfo) =>
        `${r.readyWorkers}/${r.totalWorkers}`,
    },
    {
      title: tr("团队房间"),
      dataIndex: "teamRoomID",
      width: 140,
      ellipsis: true,
      // 房间 ID 同为长字符串——同款截断+悬停+复制。
      // label 走 tr() 保持 EN 环境提示文案语言一致（词条已有）。
      render: (v: string) => <TruncatedId value={v} label={tr("团队房间")} />,
    },
    {
      title: tr("心跳"),
      dataIndex: "heartbeatEvery",
      width: 70,
      render: (v: string) => v || "—",
    },
    {
      title: tr("操作"),
      key: "op",
      width: 200,
      render: (_: unknown, r: TeamInfo) => (
        <antd.Space size={4}>
          <antd.Button size="small" onClick={() => openCfg(r)}>
            {tr("配置")}
          </antd.Button>
          {onMillforge ? (
            <antd.Button size="small" onClick={() => onMillforge(r)}>
              {tr("千锻注入")}
            </antd.Button>
          ) : null}
          <antd.Popconfirm
            title={tr("确认删除该团队？（不可恢复）")}
            okText={tr("删除")}
            cancelText={tr("取消")}
            onConfirm={() => void doDeleteTeam(r.name)}
          >
            <antd.Button danger size="small">
              {tr("删除")}
            </antd.Button>
          </antd.Popconfirm>
        </antd.Space>
      ),
    },
  ];
  return (
      <antd.Card
        size="small"
        title={tr("团队列表")}
        styles={{ body: { padding: 0 } }}
      >
        <WbTableFade>
        <antd.Table
          size="small"
          rowKey="name"
          columns={teamCols}
          dataSource={teams}
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: 890 }}
          locale={{ emptyText: tr("暂无团队记录") }}
        />
        </WbTableFade>
      </antd.Card>
  );
}
