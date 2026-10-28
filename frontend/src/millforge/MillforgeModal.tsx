// 团队管理「千锻注入」对话框（任务书 C）——复用 B 的源/模板/编译预览/
// 注入组件 + D 自定义团队 tab；mapping 默认按该团队现有 worker 角色预填
// （leader 角色→team_leader 成员，其余→worker 成员，按序）；注入成功静默
// 刷新管理数据。无新页面/路由。

import type * as ReactNS from "react";

import type { TeamInfo, WorkerInfo } from "../api";
import { useT } from "../i18n";
import type { ThemeColors } from "../theme";
import MillforgeSourcePack from "./MillforgeSourcePack";
import MillforgeTemplatePicker from "./MillforgeTemplatePicker";
import MillforgeBuildPreview from "./MillforgeBuildPreview";
import MillforgeInjectPanel from "./MillforgeInjectPanel";
import MillforgeCustomTab from "./MillforgeCustomTab";
import MillforgeHistory from "./MillforgeHistory";
import { useMillforgeCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface BodyProps {
  team: TeamInfo;
  workers: WorkerInfo[];
  onRefresh: () => void;
  t: ThemeColors;
}

function MillforgeModalBody({ team, workers, onRefresh, t }: BodyProps) {
  const tr = useT();
  const core = useMillforgeCore(tr);
  const [tab, setTab] = React.useState<"template" | "custom">("template");
  const teamName = team.name;

  // 每次新 build → 按团队现有 worker 角色预填 mapping（leader 角色→
  // team_leader 成员；其余→worker 成员；各自按序，不足留空）。
  React.useEffect(() => {
    if (!core.build) return;
    const members = team.workerMembers || [];
    const leaders = members.filter((m) => m.role === "team_leader");
    const others = members.filter((m) => m.role !== "team_leader");
    let li = 0;
    let oi = 0;
    const m: Record<string, string> = {};
    for (const r of core.build.roles) {
      if (r.kind === "leader") {
        if (leaders[li]) m[r.role] = leaders[li].name;
        li += 1;
      } else {
        if (others[oi]) m[r.role] = others[oi].name;
        oi += 1;
      }
    }
    core.setMapping(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core.build?.build_id]);

  // 注入完成（含部分失败——读回状态已落）→ 静默刷新管理数据。
  const lastInjRef = React.useRef<unknown>(null);
  React.useEffect(() => {
    if (core.injectResult && core.injectResult !== lastInjRef.current) {
      lastInjRef.current = core.injectResult;
      onRefresh();
    }
  }, [core.injectResult, onRefresh]);

  // 打开时拉一次注入历史。
  React.useEffect(() => {
    void core.loadInjections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "grid", gap: 10, maxHeight: "72vh", overflow: "auto", padding: "2px 4px" }}>
      {/* 输入段：模板路径 / 自定义团队 */}
      <antd.Tabs
        size="small"
        activeKey={tab}
        onChange={(k: string) => setTab(k as "template" | "custom")}
        items={[
          {
            key: "template",
            label: tr("千锻模板"),
            children: (
              <div style={{ display: "grid", gap: 8 }}>
                <MillforgeSourcePack core={core} tr={tr} t={t} />
                <MillforgeTemplatePicker core={core} tr={tr} t={t} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <antd.Button
                    size="small"
                    type="primary"
                    loading={core.compiling}
                    disabled={!core.pack}
                    onClick={() => void core.compileWithTemplate(teamName)}
                  >
                    {tr("编译预览")}
                  </antd.Button>
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {tr("编译仅预览 SOUL——注入才写入 Worker CR")}
                  </span>
                </div>
              </div>
            ),
          },
          {
            key: "custom",
            label: tr("自定义团队"),
            children: <MillforgeCustomTab core={core} fallbackTeamName={teamName} tr={tr} t={t} />,
          },
        ]}
      />

      {/* 编译错误（422 detail 美化后） */}
      {core.compileError ? (
        <antd.Alert
          type="error"
          showIcon
          message={tr("编译失败")}
          description={
            <pre
              style={{
                margin: 0,
                fontSize: 11,
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 180,
                overflow: "auto",
              }}
            >
              {core.compileError}
            </pre>
          }
        />
      ) : null}

      {/* 编译预览 + 注入 */}
      {core.build ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
            {tr("编译预览（build {id} · {source}）", {
              id: core.build.build_id,
              source: core.build.source === "custom" ? tr("自定义（team_json）") : tr("模板"),
            })}
          </div>
          <MillforgeBuildPreview build={core.build} tr={tr} t={t} />
          <MillforgeInjectPanel core={core} workers={workers} teamName={teamName} tr={tr} t={t} />
        </div>
      ) : null}

      {/* 注入历史 */}
      <MillforgeHistory core={core} tr={tr} t={t} />
    </div>
  );
}

interface Props {
  /** 目标团队（null = 关闭）。 */
  team: TeamInfo | null;
  /** 在服 Workers（mapping 选项）。 */
  workers: WorkerInfo[];
  /** 注入后静默刷新管理数据。 */
  onRefresh: () => void;
  onClose: () => void;
  t: ThemeColors;
}

export default function MillforgeModal({ team, workers, onRefresh, onClose, t }: Props) {
  const tr = useT();
  return (
    <antd.Modal
      title={team ? `${tr("千锻注入")} — ${team.name}` : tr("千锻注入")}
      open={!!team}
      onCancel={onClose}
      footer={null}
      width={880}
      style={{ maxWidth: "94vw" }}
    >
      {/* key=team.name：切换团队重置本对话框状态（源/pack 保留无妨） */}
      {team ? (
        <MillforgeModalBody
          key={team.name}
          team={team}
          workers={workers}
          onRefresh={onRefresh}
          t={t}
        />
      ) : null}
    </antd.Modal>
  );
}
