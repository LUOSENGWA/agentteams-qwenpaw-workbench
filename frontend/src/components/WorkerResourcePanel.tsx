/**
 * ⚙️ 资源管理（v0.5.0-beta.13.15 B5b 集成 / 13.16 合并重构）。
 *
 * 位置：团队拓扑 Worker 行展开区（WorkerManage → WorkerRow）。
 * 装验反馈（13.14）：「技能中心和频道和 MCP 和工具集成到团队拓扑」；
 * 13.15 装验再收口：「技能中心和 MCP 完全和 worker 拓扑合并 + 做好 UI/UX
 * + 点开工具不应再选 Worker」——四维全部就地可管理，不再跳页。
 *
 * 四页签（全部复用既有组件/编辑链路，不裸重写）：
 *  ① 技能 = <SkillCenter onlyWorker onlyTeam sections=[catalog,matrix]>：
 *     目录（搜索/上传/自定义/下载，团队 scope）+ 技能中心的可编辑
 *     矩阵（分配 + 物化双层语义原样继承；保存走同一 updateWorker 链路）。
 *  ② MCP = <SkillCenter onlyWorker sections=[mcp]>：MCP 卡（L1 就地编辑
 *     mcpServers；L2 只读=上游契约）。
 *  ③ 频道 = 嵌入 <WorkerChannels workers={[w]}>（单 Worker 自动选中且
 *     选择器隐去；版本门/二维码/冲突检查全继承）。
 *  ④ 工具 = 嵌入 <WorkerTools workers={[w]}>（#1255 版本门同款；单 Worker
 *     自动选中且选择器隐去）。
 */
import { BoltIcon, PlugIcon, WrenchIcon, NotesIcon } from "./icons";
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { type WorkerInfo } from "../api";
import SkillCenter from "./SkillCenter";
import WorkerChannels from "./WorkerChannels";
import WorkerTools from "./WorkerTools";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export default function WorkerResourcePanel({
  worker,
  l1,
}: {
  worker: WorkerInfo;
  /** L1（Controller admin token）→ 技能/MCP 卡可写；L2 = 只读（MCP 写权限
   *  另待上游 elevated capability 设计，技能 skills 在 L2 白名单内可写）。 */
  l1?: boolean;
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
  const l2 = !l1;

  const items = [
    {
      key: "skills",
      // v0.5.0-beta.13.16（13.15 装验「技能中心和 MCP 完全和 worker 拓扑
      // 合并」）：只读概览 + 跳转链接 → 直接嵌入技能中心的可编辑矩阵
      // （SkillCenter onlyWorker+sections——同一组件、同一保存链路，就地编辑）。
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <BoltIcon size={13} /> {tr("技能")}
        </span>
      ),
      children: (
        // v0.5.0-beta.13.21（13.20 装验「worker 也是，和技能中心一样的搜索/
        // 上传/自定义等，都集成在拓扑里面」）：技能节=目录（搜索/上传/自定义/
        // 下载，scope=该 Worker 所属团队）+ 可编辑分配矩阵（preload 等）。
        <SkillCenter
          l2={l2}
          onlyWorker={worker.name}
          onlyTeam={worker.team || undefined}
          sections={["catalog", "matrix"]}
        />
      ),
    },
    {
      key: "mcp",
      // v0.5.0-beta.13.16：只读列表 → 嵌入技能中心 MCP 卡（L1 就地编辑
      // mcpServers；L2 只读——elevated capability 设计前契约如此）。
      label: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <PlugIcon size={13} /> {tr("MCP")}
        </span>
      ),
      children: (
        <SkillCenter l2={l2} onlyWorker={worker.name} sections={["mcp"]} />
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
          {tr("资源管理（技能 / MCP / 频道 / 工具）")}
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
