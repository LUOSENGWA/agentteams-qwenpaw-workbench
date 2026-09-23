/**
 * ⚙️ 资源治理（v0.5.0-beta.13.15 B5b 团队拓扑集成）。
 *
 * 位置：团队拓扑 Worker 行展开区（WorkerManage → WorkerRow）。
 * 装验反馈（13.14）：「Worker 技能分配矩阵不错，再根据团队分类，最好集成
 * 在上面的团队拓扑，包括技能中心和频道和 MCP 和工具」——把四个资源维度
 * 收进拓扑节点本身（就近治理），不再只去底部折叠区找。
 *
 * 四页签（全部复用既有组件，不裸重写）：
 *  ① 技能 = 双层只读视图（分配层 spec.skills ∪ 物化层 runtime /api/skills，
 *     B6 真相同款）+ 「去技能中心编辑」入口（底部折叠区技能中心 = 全量
 *     矩阵编辑器，编辑仍归那里——拓扑侧只读概览，避免双写入口）。
 *  ② MCP = adminWorker.mcpServers 只读列表（与技能中心 ③ 同正源）。
 *  ③ 频道 = 嵌入 <WorkerChannels workers={[w]}>（单 Worker 自动选中；
 *     版本门/二维码/冲突检查全继承）。
 *  ④ 工具 = 嵌入 <WorkerTools workers={[w]}>（#1255；版本门同款）。
 */
import { BoltIcon, PlugIcon, WrenchIcon, NotesIcon } from "./icons";
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  type WorkerInfo,
  type WorkerRuntimeSkill,
  fetchWorkerSkills,
} from "../api";
import WorkerChannels from "./WorkerChannels";
import WorkerTools from "./WorkerTools";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 技能双层只读视图（B6 真相同款：分配层 CRD ∪ 物化层 runtime）。 */
function WorkerSkillsView({ worker }: { worker: WorkerInfo }) {
  const t = useThemeColors();
  const tr = useT();
  const assigned = React.useMemo(
    () => (worker.skills || []).map((s) => s.split(/::|\//).pop() || s),
    [worker.skills],
  );
  const [mat, setMat] = React.useState<
    WorkerRuntimeSkill[] | "loading" | "err" | null
  >(null);
  React.useEffect(() => {
    setMat("loading");
    let dead = false;
    void fetchWorkerSkills(worker.name)
      .then((list) => {
        if (!dead) setMat(list || []);
      })
      .catch(() => {
        if (!dead) setMat("err");
      });
    return () => {
      dead = true;
    };
  }, [worker.name]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div>
        <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 4 }}>
          {tr("分配层（CRD spec.skills——显式分配）")}
        </div>
        {assigned.length ? (
          <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
            {assigned.map((s) => (
              <antd.Tag key={s} color="blue" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                {s}
              </antd.Tag>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("未显式分配")}
          </span>
        )}
      </div>
      <div>
        <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 4 }}>
          {tr("物化层（运行时实际装载——可调用）")}
        </div>
        {mat === "loading" ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("加载中…")}</span>
        ) : mat === "err" ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("不可用（Controller 未含该端点或无权限）")}
          </span>
        ) : mat && mat.length ? (
          <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
            {mat.map((s) => {
              const inAssigned = assigned.includes(s.name);
              return (
                <antd.Tag
                  key={s.name}
                  color={inAssigned ? "blue" : "cyan"}
                  style={{ marginInlineEnd: 0, fontSize: 10.5 }}
                  title={
                    inAssigned
                      ? tr("已分配 + 已物化")
                      : tr("仅物化（团队层自动物化/内置恢复/镜像自带）")
                  }
                >
                  {s.name}
                  {inAssigned ? " ✓" : ""}
                </antd.Tag>
              );
            })}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("运行时未装载技能")}
          </span>
        )}
      </div>
      {assigned.length === 0 && Array.isArray(mat) && mat.length ? (
        <antd.Alert
          type="info"
          showIcon
          style={{ fontSize: 11 }}
          message={tr(
            "分配层为空但物化层非空——技能由团队层自动物化/内置恢复/镜像自带，非显式分配，属预期",
          )}
        />
      ) : null}
    </div>
  );
}

export default function WorkerResourcePanel({
  worker,
  onOpenSkillCenter,
}: {
  worker: WorkerInfo;
  onOpenSkillCenter?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState("skills");
  // 懒挂载：首次打开才渲染子组件（频道/工具编辑器自带版本门与取数）。
  const [mounted, setMounted] = React.useState<Record<string, boolean>>({});
  const showTab = (k: string) => {
    setTab(k);
    setMounted((prev) => (prev[k] ? prev : { ...prev, [k]: true }));
  };

  const mcpList = worker.mcpServers || [];

  const items = [
    {
      key: "skills",
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <BoltIcon size={13} /> {tr("技能")}
        </span>
      ),
      children: (
        <div>
          <WorkerSkillsView worker={worker} />
          {onOpenSkillCenter ? (
            <antd.Button
              size="small"
              type="link"
              style={{ padding: 0, marginTop: 8, fontSize: 12 }}
              onClick={onOpenSkillCenter}
            >
              {tr("去技能中心编辑（全量矩阵）")}
            </antd.Button>
          ) : null}
        </div>
      ),
    },
    {
      key: "mcp",
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <PlugIcon size={13} /> {tr("MCP")}
        </span>
      ),
      children: mcpList.length ? (
        <div style={{ display: "grid", gap: 4 }}>
          {mcpList.map((m) => (
            <div
              key={m.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                borderRadius: 6,
                border: `1px solid ${t.border}`,
                background: t.cardBg,
                fontSize: 12,
              }}
            >
              <span style={{ fontWeight: 600 }}>{m.name}</span>
              {m.transport ? (
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>
                  {m.transport}
                </antd.Tag>
              ) : null}
              <span
                style={{
                  color: t.textSecondary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
                title={m.url}
              >
                {m.url}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <antd.Empty
          image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
          description={tr("未挂载 MCP Server")}
        />
      ),
    },
    {
      key: "channels",
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <NotesIcon size={13} /> {tr("频道")}
        </span>
      ),
      children: mounted.channels ? (
        <WorkerChannels workers={[worker]} />
      ) : (
        <div style={{ padding: 8, color: t.textSecondary, fontSize: 12 }}>
          {tr("首次打开加载频道编辑器…")}
        </div>
      ),
    },
    {
      key: "tools",
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <WrenchIcon size={13} /> {tr("工具")}
        </span>
      ),
      children: mounted.tools ? (
        <WorkerTools workers={[worker]} />
      ) : (
        <div style={{ padding: 8, color: t.textSecondary, fontSize: 12 }}>
          {tr("首次打开加载工具面板…")}
        </div>
      ),
    },
  ];

  return (
    <div
      style={{
        margin: "4px 0 4px 22px",
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          cursor: "pointer",
          background: open ? t.popoverBg : "transparent",
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ width: 12, fontSize: 10, color: "#888" }}>
          {open ? "▾" : "▸"}
        </span>
        <WrenchIcon size={13} />
        <span style={{ fontWeight: 600, fontSize: 12 }}>
          {tr("资源治理（技能 / MCP / 频道 / 工具）")}
        </span>
      </div>
      {open ? (
        <div style={{ padding: "0 10px 8px" }}>
          <antd.Tabs
            size="small"
            activeKey={tab}
            onChange={showTab}
            items={items}
          />
        </div>
      ) : null}
    </div>
  );
}
