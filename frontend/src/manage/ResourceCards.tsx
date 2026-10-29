// ResourceCards.tsx — 「管理」页团队域 · Worker 详情资源卡（方案 §4.1.3，P3）。
//
// 10 卡 = 旧拓扑 Worker 展开面板的管理段 + 合并分支 MCP/插件卡，一格一卡
// （替代旧 4-tab 嵌套）：运行配置 / 环境变量与网关 / Coding CLI / MCP /
// Worker 插件 / 技能 / 工具 / 频道 / 审批模式 / 运行时升级。
//
// 卡 = 入口（标题 + 一行摘要 + 右尖角）；点击打开大弹窗（宽 720，
// 技能/运行时升级 900；竖屏 narrow → NarrowSheet）。内容懒挂载——
// 弹窗关闭时零后台负载（各面板自持 30s 轮询/懒加载，只在打开时运行）。
//
// 权限：L2 写权由各面板自身 l1/403 门控（运行配置 L1-only 字段只读、
// 工具 PATCH 403 转只读等，与旧拓扑同语义）；「环境变量」卡仅在
// envEditable === true 时出现（L2 隐藏，与旧拓扑同门控）。

import type * as ReactNS from "react";

import type { WorkerInfo } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useWbViewport } from "../WbViewportContext";
import { invalidateTags } from "../requestCache";
import NarrowSheet from "../components/NarrowSheet";
import WorkerRuntimeConfig from "../components/WorkerRuntimeConfig";
import WorkerEnvPanel from "../components/WorkerEnvPanel";
import WorkerCodingCliPanel from "../components/WorkerCodingCliPanel";
import WorkerMcpPanel from "../components/WorkerMcpPanel";
import WorkerPluginsPanel from "../components/WorkerPluginsPanel";
import SkillCenter from "../components/SkillCenter";
import WorkerTools from "../components/WorkerTools";
import WorkerChannels from "../components/WorkerChannels";
import ApprovalControl from "../components/ApprovalControl";
import RuntimeUpgradePanel from "../components/RuntimeUpgradePanel";
import {
  SettingsIcon,
  BoltIcon,
  CodeIcon,
  PlugIcon,
  BrickIcon,
  BrainIcon,
  WrenchIcon,
  MessageIcon,
  ShieldIcon,
  MonitorIcon,
} from "../components/icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface ResourceCardDef {
  id: string;
  title: string;
  desc: string;
  icon: (p: { size?: number; style?: ReactNS.CSSProperties }) => ReactNS.ReactElement;
  /** 宽屏弹窗宽度（竖屏走 NarrowSheet，不用此值）。 */
  width: number;
}

export default function ResourceCards({
  worker,
  hasToken,
  onOpenSettings,
}: {
  worker: WorkerInfo;
  hasToken?: boolean;
  onOpenSettings?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { narrow } = useWbViewport();
  const [openCard, setOpenCard] = React.useState<string | null>(null);
  const [hoverId, setHoverId] = React.useState<string | null>(null);

  const envCount = React.useMemo(
    () => Object.keys(worker.env ?? {}).length,
    [worker.env],
  );

  const cards: ResourceCardDef[] = React.useMemo(() => {
    const list: ResourceCardDef[] = [
      {
        id: "cfg",
        title: tr("运行配置"),
        desc: tr("并发 / 上下文 / shell 组（L1 可编辑）"),
        icon: SettingsIcon,
        width: 720,
      },
    ];
    // 环境变量卡——仅 envEditable === true（L2 隐藏，与旧拓扑同门控）。
    if (worker.envEditable === true) {
      list.push({
        id: "env",
        title: tr("环境变量与网关"),
        desc:
          envCount > 0
            ? tr("{n} 个变量 · 模型 / MCP 网关探测", { n: envCount })
            : tr("spec.env · 模型 / MCP 网关探测"),
        icon: BoltIcon,
        width: 720,
      });
    }
    list.push(
      {
        id: "cli",
        title: tr("Coding CLI"),
        desc: tr("安装 / 升级 / 配置（1.2.5+）"),
        icon: CodeIcon,
        width: 720,
      },
      {
        id: "mcp",
        title: tr("MCP"),
        desc:
          (worker.mcpServers?.length ?? 0) > 0
            ? tr("{n} 个 server（CRD 声明 + 自注册合并视图）", {
                n: worker.mcpServers?.length ?? 0,
              })
            : tr("CRD 声明 + Worker 自注册合并视图"),
        icon: PlugIcon,
        width: 720,
      },
      {
        id: "plugins",
        title: tr("Worker 插件"),
        desc: tr("id / 名称 / 版本 / 启用（只读表）"),
        icon: BrickIcon,
        width: 720,
      },
      {
        id: "skills",
        title: tr("技能"),
        desc:
          (worker.skills?.length ?? 0) > 0
            ? tr("已配 {n} 项 · 目录 / 分配矩阵", { n: worker.skills?.length ?? 0 })
            : tr("目录 / 分配矩阵（MCP 独立卡）"),
        icon: BrainIcon,
        width: 900,
      },
      {
        id: "tools",
        title: tr("工具"),
        desc: tr("内置工具启用列表"),
        icon: WrenchIcon,
        width: 720,
      },
      {
        id: "channels",
        title: tr("频道"),
        desc: tr("频道配置 + 二维码授权"),
        icon: MessageIcon,
        width: 720,
      },
      {
        id: "approval",
        title: tr("审批模式"),
        desc: tr("审批档位（QwenPaw 独有）"),
        icon: ShieldIcon,
        width: 720,
      },
      {
        id: "upgrade",
        title: tr("运行时升级"),
        desc: tr("QwenPaw 运行时就地升级（L1 · 二次确认）"),
        icon: MonitorIcon,
        width: 900,
      },
    );
    return list;
  }, [worker.envEditable, worker.env, worker.mcpServers, worker.skills, envCount, tr]);

  // 面板内容懒挂载——只在弹窗打开时渲染（各面板自持轮询/懒加载）。
  // 技能卡 sections 排除 "mcp"（MCP 有独立卡，不重复）。
  const renderContent = React.useCallback(
    (id: string) => {
      switch (id) {
        case "cfg":
          return (
            <WorkerRuntimeConfig
              name={worker.name}
              l1={!!hasToken}
              onOpenSettings={onOpenSettings}
              sheet
            />
          );
        case "env":
          return (
            <WorkerEnvPanel
              worker={worker}
              sheet
              onChanged={() => invalidateTags(["admin"])}
            />
          );
        case "cli":
          return (
            <WorkerCodingCliPanel
              worker={worker}
              sheet
              onChanged={() => invalidateTags(["admin"])}
            />
          );
        case "mcp":
          return <WorkerMcpPanel worker={worker} sheet />;
        case "plugins":
          return <WorkerPluginsPanel worker={worker} sheet />;
        case "skills":
          return (
            <SkillCenter onlyWorker={worker.name} sections={["catalog", "matrix"]} />
          );
        case "tools":
          return <WorkerTools workers={[worker]} />;
        case "channels":
          return <WorkerChannels workers={[worker]} active />;
        case "approval":
          return (
            <ApprovalControl
              workerName={worker.name}
              runtime={worker.runtime}
            />
          );
        case "upgrade":
          // active 显式传——原 useTabActive("ops") 门在顶层运维 tab
          // 移除后恒 false（面板已支持宿主激活）。
          return <RuntimeUpgradePanel active />;
        default:
          return null;
      }
    },
    [worker, hasToken, onOpenSettings],
  );

  const open = openCard ? cards.find((c) => c.id === openCard) ?? null : null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {cards.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => setOpenCard(c.id)}
          onMouseEnter={() => setHoverId(c.id)}
          onMouseLeave={() => setHoverId(null)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            minHeight: 44,
            padding: "8px 12px",
            textAlign: "left",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            background: hoverId === c.id ? t.hoverBg : t.cardBg,
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <c.icon size={15} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 1 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
              {c.title}
            </span>
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {c.desc}
            </span>
          </span>
          <span style={{ color: t.textSecondary, fontSize: 15, flexShrink: 0 }}>
            ›
          </span>
        </button>
      ))}

      {narrow ? (
        <NarrowSheet
          open={!!openCard}
          title={open?.title ?? ""}
          onClose={() => setOpenCard(null)}
        >
          {open ? renderContent(open.id) : null}
        </NarrowSheet>
      ) : (
        <antd.Modal
          open={!!openCard}
          width={open?.width ?? 720}
          style={{ maxWidth: "calc(100vw - 32px)" }}
          title={open?.title ?? ""}
          onCancel={() => setOpenCard(null)}
          footer={null}
          styles={{
            body: {
              maxHeight: "min(70vh, 720px)",
              overflowY: "auto",
              paddingTop: 4,
            },
          }}
        >
          {open ? renderContent(open.id) : null}
        </antd.Modal>
      )}
    </div>
  );
}
