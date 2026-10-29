// CrdManage 拆分（QC-196 方案 §5.2）· 团队访问配置矩阵（员工 × 团队）——
// 勾选 = 本地目标态；「生成命令」汇成批量 merge-patch 脚本（上游无 PUT
// humans——P-HUMANS-PUT 合并后升级一键 PUT）。原主组件 JSX R5a 逐字搬移；
// props = 原闭包变量名（零改写）。

import type * as ReactNS from "react";

import type { AdminData, HumanInfo } from "../api";
import type { ThemeColors } from "../theme";
import WbTableFade from "../components/WbTableFade";
import type { TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


interface CrdAccessMatrixProps {
  humans: AdminData["humans"];
  teams: AdminData["teams"];
  accessOf: (h: HumanInfo) => string[];
  accessChanged: Record<string, string[]>;
  toggleAccess: (name: string, team: string, on: boolean) => void;
  generateAccessCmd: () => void;
  copyAccessCmd: () => void;
  accessCmd: string;
  saving: boolean;
  saveMsg: { kind: "ok" | "err"; text: string } | null;
  saveAccess: () => void;
  /** 矩阵内搜索（账号/显示名）——空 = 全量。管理页访问配置弹窗用；
   * CrdManage 原入口不传，行为不变。 */
  filter?: string;
  tr: TrFn;
  t: ThemeColors;
}

export default function CrdAccessMatrix({
humans,
teams,
accessOf,
accessChanged,
toggleAccess,
generateAccessCmd,
copyAccessCmd,
accessCmd,
saving,
saveMsg,
saveAccess,
filter,
tr,
t,
}: CrdAccessMatrixProps) {
  // 矩阵内搜索（账号/显示名）——filter 空 = 全量行。
  const q = (filter ?? "").trim().toLowerCase();
  const rows = q
    ? humans.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          (h.displayName || "").toLowerCase().includes(q),
      )
    : humans;
  return (
      <antd.Card
        size="small"
        title={tr("团队访问配置（员工 × 团队）")}
        styles={{ body: { padding: 0 } }}
        extra={
          <antd.Space size={6}>
            <antd.Button
              size="small"
              type="primary"
              loading={saving}
              disabled={!Object.keys(accessChanged).length}
              onClick={saveAccess}
            >
              {tr("保存到 Controller")}
            </antd.Button>
            <antd.Button
              size="small"
              disabled={!Object.keys(accessChanged).length}
              onClick={generateAccessCmd}
            >
              {tr("生成命令")}
            </antd.Button>
          </antd.Space>
        }
      >
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            color: t.textSecondary,
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          {tr(
            "勾选要授予/取消的团队，点「保存到 Controller」直接生效（reconcile 约 5 分钟把员工拉入/移出团队房间）。旧版 Controller 无 PUT /humans 时自动回落「生成命令」（复制到 Controller 宿主机执行）。",
          )}
          {saveMsg ? (
            <div
              style={{
                marginTop: 4,
                color: saveMsg.kind === "ok" ? "#389e0d" : "#ff4d4f",
              }}
            >
              {saveMsg.text}
            </div>
          ) : null}
        </div>
        <WbTableFade>
        <antd.Table
          size="small"
          rowKey="name"
          pagination={false}
          scroll={{ x: 160 + teams.length * 96 }}
          dataSource={rows}
          locale={{ emptyText: tr("暂无人员记录") }}
          columns={[
            {
              title: tr("账号"),
              dataIndex: "name",
              width: 160,
              render: (v: string, r: HumanInfo) => (
                <div>
                  {v}
                  {r.displayName ? (
                    <div style={{ fontSize: 10, color: t.textSecondary }}>
                      {r.displayName}
                    </div>
                  ) : null}
                </div>
              ),
            },
            ...teams.map((tm) => ({
              title: tm.name,
              key: `team_${tm.name}`,
              width: 96,
              align: "center" as const,
              render: (_: unknown, r: HumanInfo) => (
                <antd.Checkbox
                  checked={accessOf(r).includes(tm.name)}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    toggleAccess(r.name, tm.name, e.target.checked)
                  }
                />
              ),
            })),
            {
              title: tr("状态"),
              key: "access_status",
              width: 80,
              render: (_: unknown, r: HumanInfo) =>
                accessChanged[r.name] ? (
                  <antd.Tag color="orange">{tr("已改动")}</antd.Tag>
                ) : (
                  <span style={{ color: t.textSecondary }}>—</span>
                ),
            },
          ]}
        />
        </WbTableFade>
        {accessCmd ? (
          <div style={{ padding: "0 12px 12px" }}>
            <antd.Input.TextArea
              rows={8}
              readOnly
              value={accessCmd}
              style={{ fontFamily: "monospace", fontSize: 11 }}
            />
            <antd.Button
              size="small"
              style={{ marginTop: 6 }}
              onClick={copyAccessCmd}
            >
              {tr("复制命令")}
            </antd.Button>
          </div>
        ) : null}
      </antd.Card>
  );
}
