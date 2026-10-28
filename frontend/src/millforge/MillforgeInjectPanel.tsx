// 千锻注入面板（任务书 B5）——注入模式（更新已选 Worker / 新建 Worker
// 并注入）+ mapping 逐角色选现有 worker / create_workers 行（name/role/
// model）+ core skill/apply soul 开关 + 注入按钮；结果表逐 worker 状态
// （souls/created 逐项 + core_skill + partial）。建队表单（B）与「千锻
// 注入」对话框（C）共用。

import type * as ReactNS from "react";

import type { WorkerInfo } from "../api";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import { CheckIcon, CloseIcon, WarnIcon } from "../components/icons";
import { WbTooltip } from "../components/WbTooltip";
import type { MfCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  core: MfCore;
  /** 在服 Workers（mapping 选项 / 已属本团标注）。 */
  workers: WorkerInfo[];
  /** 目标团队 CR 名（inject team 字段；core skill scope=team）。 */
  teamName: string;
  /** 提交建队链路的预阶段（true = 注入结果并入提交进度，不显独立按钮）。 */
  embedded?: boolean;
  tr: TrFn;
  t: ThemeColors;
}

export default function MillforgeInjectPanel({ core, workers, teamName, embedded, tr, t }: Props) {
  const {
    build,
    injectMode,
    setInjectMode,
    mapping,
    setMapping,
    createRows,
    setCreateRows,
    coreSkill,
    setCoreSkill,
    applySoul,
    setApplySoul,
    injecting,
    injectError,
    injectResult,
    doInject,
  } = core;

  if (!build) return null;
  const budgetAllOk = build.roles.every((r) => r.budget_ok);

  const workerOpts = workers.map((w) => ({
    value: w.name,
    label: `${w.name}（${w.role || "worker"}${w.team ? ` · ${w.team}` : ""}）`,
  }));

  const entryTag = (status: string, verified?: boolean) =>
    status === "ok" ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#52c41a" }}>
        <CheckIcon size={11} /> {tr("成功")}{verified ? `（${tr("读回验证")}）` : ""}
      </span>
    ) : (
      <WbTooltip title={""}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#f5222d" }}>
          <CloseIcon size={11} /> {tr("失败")}
        </span>
      </WbTooltip>
    );

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {/* 注入模式 */}
      <antd.Segmented
        size="small"
        value={injectMode}
        onChange={(v: unknown) => setInjectMode(v as "mapping" | "create")}
        options={[
          { label: tr("更新已选 Worker"), value: "mapping" },
          { label: tr("新建 Worker 并注入"), value: "create" },
        ]}
      />

      {injectMode === "mapping" ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("逐角色选现有 Worker（mapping）")}
          </div>
          {build.roles.map((r) => (
            <div key={r.role} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 110, fontSize: 12, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.role}
                <span style={{ color: t.textSecondary }}>（{r.kind}）</span>
              </span>
              <antd.Select
                size="small"
                allowClear
                style={{ flex: 1 }}
                placeholder={tr("选择现有 Worker（不选 = 该角色不注入）")}
                value={mapping[r.role] || undefined}
                onChange={(v: string | undefined) =>
                  setMapping({ ...mapping, [r.role]: v || "" })
                }
                options={workerOpts}
              />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("新建 Worker 行（create_workers：name/role/model）")}
          </div>
          {createRows.map((row) => (
            <div key={row.key} style={{ display: "grid", gap: 4, border: `1px dashed ${t.border}`, borderRadius: 8, padding: 6 }}>
              <div style={{ fontSize: 11, color: t.textSecondary }}>
                {tr("角色")}: <span style={{ fontFamily: "monospace" }}>{row.role_id}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <antd.Input
                  size="small"
                  style={{ flex: "1 1 160px" }}
                  placeholder={`${tr("Worker 名")}（${teamName || "team"}-${row.role_id}）`}
                  value={row.name}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setCreateRows((prev) =>
                      prev.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)),
                    )
                  }
                />
                <antd.Select
                  size="small"
                  style={{ width: 120 }}
                  value={row.role}
                  onChange={(v: string) =>
                    setCreateRows((prev) =>
                      prev.map((r) => (r.key === row.key ? { ...r, role: v as "team_leader" | "worker" } : r)),
                    )
                  }
                  options={[
                    { value: "team_leader", label: "team_leader" },
                    { value: "worker", label: "worker" },
                  ]}
                />
                <antd.Input
                  size="small"
                  style={{ flex: "1 1 140px" }}
                  placeholder={tr("模型（可选，留空跟随集群默认）")}
                  value={row.model}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setCreateRows((prev) =>
                      prev.map((r) => (r.key === row.key ? { ...r, model: e.target.value } : r)),
                    )
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* core skill / apply soul 开关 */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <antd.Space size={4}>
          <antd.Checkbox checked={coreSkill} onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setCoreSkill(e.target.checked)} />
          <span style={{ fontSize: 12 }}>{tr("core 技能打包（millforge-core，scope=team）")}</span>
        </antd.Space>
        <antd.Space size={4}>
          <antd.Checkbox checked={applySoul} onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setApplySoul(e.target.checked)} />
          <span style={{ fontSize: 12 }}>{tr("写入 SOUL（mapping/新建行）")}</span>
        </antd.Space>
      </div>

      {!budgetAllOk ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("预算未全绿——后端将拒绝注入（回模板层减片段或提预算走人审）")}
        />
      ) : null}

      {/* 注入按钮（embedded 建队链路不显独立按钮——提交建队时自动执行） */}
      {!embedded ? (
        <antd.Button
          size="small"
          type="primary"
          loading={injecting}
          disabled={!budgetAllOk || !teamName}
          onClick={() => void doInject(teamName)}
        >
          {tr("注入到「{name}」", { name: teamName || "—" })}
        </antd.Button>
      ) : (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("提交建队时自动执行：编译（若未编译）→ 千锻注入 → 创建团队")}
        </div>
      )}
      {injectError ? (
        <antd.Alert type="error" showIcon message={tr("注入失败")} description={<span style={{ fontSize: 12, fontFamily: "monospace" }}>{injectError}</span>} />
      ) : null}

      {/* 结果表（逐 worker 状态） */}
      {injectResult ? (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {injectResult.partial ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <WarnIcon size={11} /> {tr("注入结果（部分失败）")}
              </span>
            ) : (
              tr("注入结果（全部成功）")
            )}
          </div>
          <antd.Table
            size="small"
            pagination={false}
            rowKey={(r: { worker?: string; name?: string; role_id: string }) => `${r.role_id}:${r.worker || r.name || ""}`}
            dataSource={[
              ...injectResult.souls.map((s) => ({
                target: s.worker || "—",
                role_id: s.role_id,
                kind: tr("更新 SOUL"),
                status: s.status,
                error: s.error || "",
                verified: s.verified,
              })),
              ...injectResult.created.map((c) => ({
                target: c.name || "—",
                role_id: c.role_id,
                kind: tr("新建 Worker"),
                status: c.status,
                error: c.error || "",
                verified: c.verified,
              })),
            ]}
            columns={[
              { title: tr("Worker"), dataIndex: "target", width: 150, ellipsis: true },
              { title: tr("角色"), dataIndex: "role_id", width: 90, ellipsis: true, render: (v: string) => <span style={{ fontFamily: "monospace", fontSize: 11 }}>{v}</span> },
              { title: tr("动作"), dataIndex: "kind", width: 90 },
              {
                title: tr("状态"),
                dataIndex: "status",
                width: 110,
                render: (v: string, r: { verified?: boolean }) => entryTag(v, r.verified),
              },
              {
                title: tr("错误"),
                dataIndex: "error",
                render: (v: string) =>
                  v ? (
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "#f5222d", wordBreak: "break-all" }}>{v}</span>
                  ) : (
                    "—"
                  ),
              },
            ]}
            locale={{ emptyText: "—" }}
          />
          {/* core skill 结果 */}
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            core 技能：
            {injectResult.core_skill.status === "ok" ? (
              <span style={{ color: "#52c41a" }}>{tr("成功")}{injectResult.core_skill.assigned?.length ? `（${tr("已挂接")}：${injectResult.core_skill.assigned.join("、")}）` : ""}</span>
            ) : injectResult.core_skill.status === "skipped" ? (
              <span>{tr("跳过")}</span>
            ) : (
              <span style={{ color: "#faad14" }}>{tr("部分失败")}</span>
            )}
            {injectResult.core_skill.detail ? ` — ${injectResult.core_skill.detail}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}
