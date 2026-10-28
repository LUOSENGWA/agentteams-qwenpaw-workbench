// 千锻注入历史（任务书 C 末段）——GET /millforge/injections（留 50，
// 最新在前）：时间/团队/build/逐项成败/core 技能状态。

import type * as ReactNS from "react";

import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import { fmtRfc3339 } from "../components/WorkerManageShared";
import type { MfCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  core: MfCore;
  tr: TrFn;
  t: ThemeColors;
}

export default function MillforgeHistory({ core, tr, t }: Props) {
  const { injections, injLoading, loadInjections } = core;

  const countOk = (entries: { status: string }[]) =>
    `${entries.filter((e) => e.status === "ok").length}/${entries.length}`;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
          {tr("注入历史（最近 50 条）")}
        </span>
        <antd.Button size="small" loading={injLoading} onClick={() => void loadInjections()}>
          {tr("刷新")}
        </antd.Button>
      </div>
      <antd.Table
        size="small"
        pagination={false}
        rowKey={(r: { id?: string; at: string; build_id: string }) => r.id || `${r.at}:${r.build_id}`}
        dataSource={injections}
        scroll={{ y: 220 }}
        columns={[
          {
            title: tr("时间"),
            dataIndex: "at",
            width: 145,
            render: (v: string) => (
              <span style={{ fontSize: 11, color: t.textSecondary }}>{v ? fmtRfc3339(v) : "—"}</span>
            ),
          },
          { title: tr("团队"), dataIndex: "team", width: 110, ellipsis: true },
          {
            title: "build",
            dataIndex: "build_id",
            width: 90,
            render: (v: string) => (
              <span style={{ fontFamily: "monospace", fontSize: 11 }}>{String(v || "").slice(0, 10)}…</span>
            ),
          },
          {
            title: tr("整体"),
            dataIndex: "partial",
            width: 70,
            render: (v: boolean) =>
              v ? (
                <antd.Tag color="orange" style={{ marginInlineEnd: 0 }}>{tr("部分失败")}</antd.Tag>
              ) : (
                <antd.Tag color="green" style={{ marginInlineEnd: 0 }}>{tr("全部成功")}</antd.Tag>
              ),
          },
          {
            title: "SOUL",
            width: 70,
            render: (_: unknown, r: { souls: { status: string }[] }) => countOk(r.souls || []),
          },
          {
            title: tr("新建"),
            width: 60,
            render: (_: unknown, r: { created: { status: string }[] }) =>
              r.created?.length ? countOk(r.created) : "—",
          },
          {
            title: "core 技能",
            dataIndex: ["core_skill", "status"],
            width: 80,
            render: (v: string) =>
              v === "ok"
                ? tr("成功")
                : v === "skipped"
                  ? tr("跳过")
                  : v === "partial"
                    ? tr("部分失败")
                    : v,
          },
        ]}
        locale={{ emptyText: tr("（暂无注入记录）") }}
      />
    </div>
  );
}
