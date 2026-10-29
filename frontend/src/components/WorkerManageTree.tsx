import type * as ReactNS from "react";

import {
  CheckpointUnavailableError,
  fetchNodeVersion,
  fetchWorkerCheckpointGraph,
  fetchWorkerCheckpointStatus,
  imageTag,
} from "../api";
import type {
  AdminData,
  CheckpointGraphResponse,
  CheckpointStatusResponse,
  NodeVersion,
  SpawnNode,
  WorkerSpawnGroup,
} from "../api";
import {
  BookmarkIcon,
  BrickIcon,
  CodeIcon,
  PlugIcon,
  SettingsIcon,
  WrenchIcon,
} from "./icons";
import ApprovalControl from "./ApprovalControl";
import WorkerEnvPanel from "./WorkerEnvPanel";
import WorkerMcpPanel from "./WorkerMcpPanel";
import WorkerPluginsPanel from "./WorkerPluginsPanel";
import WorkerRuntimeConfig from "./WorkerRuntimeConfig";
import WorkerCodingCliPanel from "./WorkerCodingCliPanel";
import WorkerLlmTuningPanel from "./WorkerLlmTuningPanel";
import WorkerResourcePanel from "./WorkerResourcePanel";
import WorkerSessionDot from "./WorkerSessionDot";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useWbViewport } from "../WbViewportContext";
import { isQwenpawOnlyDisabled, RuntimeNotice } from "../runtimeGuard";
import type { WorkerSessionState } from "../workerSessionState";
import { invalidateTags } from "../requestCache";
import { WbTooltip } from "./WbTooltip";
import {
  PRIMARY,
  ROLE_BADGE,
  ROLE_COLOR,
  SPAWN_STATUS_COLOR,
  SPAWN_STATUS_LABEL,
  WakeIcon,
  SleepIcon,
  MessageIcon,
  phaseMeta,
  RUNTIME_TAG_COLOR,
  RUNTIME_LABELS,
  isStateConsistent,
  fmtTime,
  fmtRfc3339,
} from "./WorkerManageShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

function TreeLine({ depth, isLast: _isLast }: { depth: number; isLast: boolean }) {
  const segs: ReactNS.ReactNode[] = [];
  for (let d = 0; d < depth; d++) {
    segs.push(
      <span
        key={`v${d}`}
        style={{
          width: 22,
          flexShrink: 0,
          borderLeft: "1px solid rgba(0,0,0,0.12)",
          height: "100%",
        }}
      />,
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        height: 22,
        marginRight: 6,
      }}
    >
      {segs}
      <span
        style={{
          width: 12,
          flexShrink: 0,
          borderLeft: "1px solid rgba(0,0,0,0.12)",
          borderBottom: "1px solid rgba(0,0,0,0.12)",
          borderBottomLeftRadius: 4,
          height: 11,
          alignSelf: "flex-start",
        }}
      />
    </span>
  );
}

function SpawnRow({
  node,
  depth,
}: {
  node: SpawnNode;
  depth: number;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", padding: "3px 0" }}>
        <TreeLine depth={depth} isLast />
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: SPAWN_STATUS_COLOR[node.status],
            flexShrink: 0,
            marginRight: 8,
          }}
        />
        <WbTooltip title={node.session_id}>
          <span
            style={{
              color: node.status === "done" ? "#999" : "#333",
              textDecoration: node.status === "done" ? "line-through" : "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 380,
              fontSize: 13,
            }}
          >
            {node.name || node.session_id}
          </span>
        </WbTooltip>
        {node.last_activity ? (
          <span
            style={{
              color: t.textSecondary,
              fontSize: 12,
              marginLeft: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 220,
            }}
          >
            {node.last_activity}
          </span>
        ) : null}
        <antd.Tag
          style={{ margin: "0 0 0 8px", fontSize: 11 }}
          color={SPAWN_STATUS_COLOR[node.status]}
        >
          {tr(SPAWN_STATUS_LABEL[node.status])}
        </antd.Tag>
        {node.created_at ? (
          <span style={{ color: "#999", fontSize: 12, marginLeft: 8 }}>
            {fmtTime(node.created_at)}
          </span>
        ) : null}
      </div>
      {node.allowedTools?.length || node.skills?.length ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 4,
            rowGap: 2,
            marginLeft: depth * 22 + 34,
            paddingBottom: 3,
          }}
        >
          {node.allowedTools?.length ? (
            <>
              <span style={{ color: t.textSecondary, fontSize: 11 }}>
                {tr("工具白名单")}
              </span>
              {node.allowedTools.map((tool) => (
                <antd.Tag
                  key={`tool-${tool}`}
                  style={{ margin: 0, fontSize: 11, lineHeight: "18px" }}
                >
                  {tool}
                </antd.Tag>
              ))}
            </>
          ) : null}
          {node.skills?.length ? (
            <>
              <span
                style={{
                  color: t.textSecondary,
                  fontSize: 11,
                  marginLeft: node.allowedTools?.length ? 8 : 0,
                }}
              >
                {tr("技能白名单")}
              </span>
              {node.skills.map((skill) => (
                <antd.Tag
                  key={`skill-${skill}`}
                  color="blue"
                  style={{ margin: 0, fontSize: 11, lineHeight: "18px" }}
                >
                  {skill}
                </antd.Tag>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {(node.children || []).map((child) => (
        <SpawnRow key={child.session_id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

/** 竖屏友好弹窗（narrow = 容器可见宽 < 800）：底部抽屉式 antd Modal——
 * 贴底 + 上缘圆角 + 左右留边（手机近全宽；宽窗口上限 560 居中），
 * body ≤88dvh 纵向可滚，头部标题 + 关闭（antd 自带）。
 * 运行配置 / 资源管理 的 narrow 呈现容器——内容 = 现有面板组件原样复用
 * （只换「内联↔弹窗」的呈现容器，不重写内容）。
 * 关闭动画结束（afterClose）才卸载内容：面板内 30s 轮询/取数随之下线，
 * 关窗后零后台负载（house 口径 = afterClose 卸载，动画期间不闪空）。 */
function NarrowSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNS.ReactNode;
}) {
  const [render, setRender] = React.useState(open);
  React.useEffect(() => {
    if (open) setRender(true);
  }, [open]);
  return (
    <antd.Modal
      open={open}
      afterClose={() => setRender(false)}
      onCancel={onClose}
      footer={null}
      title={title}
      width="min(calc(100vw - 32px), 520px)"
      // 居中弹窗（非底部抽屉）——竖屏友好：不贴底(不靠下)、不超屏底(居中 + body 内滚)。
      // 此前 styles.wrapper 强改 bottom:0 成底部抽屉→"太靠下 + 贴手势条/超底部"。
      centered
      styles={{
        // 内容纵向可滚：body 封顶 66dvh(≈屏高 2/3)，居中后上下留白，不超屏底。
        body: {
          maxHeight: "min(66dvh, 560px)",
          overflowY: "auto",
          // 内容贴弹窗宽（左右内边距收紧 16→10，内层 Card/面板铺满弹窗宽）。
          padding: "8px 10px",
        },
        content: { borderRadius: 12, overflow: "hidden" },
      }}
    >
      {/* wbc-narrow：窄屏弹窗内容标记（全局 CSS 消费——表单行转纵向 + antd 控件
      限宽到容器，治「弹窗内容横向拖」；portal 在 body，规则不带 .wb-main 前缀）。 */}
      {render ? <div className="wbc-narrow" style={{ minWidth: 0 }}>{children}</div> : null}
    </antd.Modal>
  );
}

/** 管理信息面板：原管理页 Worker 表行全字段 + 生命周期操作（唤醒/休眠）。 */
function WorkerManageInfo({
  worker,
  onLifecycle,
  acting,
  l1,
  onOpenSettings,
}: {
  worker: AdminData["workers"][number];
  onLifecycle?: (name: string, action: "wake" | "sleep") => void;
  acting: string | null;
  /** L1 账号（controller token）→ 运行配置面板 L1-only
 * 字段可编辑；L2 只读（PUT 非白名单键会被服务端 403 拒绝）。 */
  l1?: boolean;
  onOpenSettings?: () => void;
}) {
  const tr = useT();
  const { narrow } = useWbViewport();
  // 竖屏：运行配置改底部抽屉弹窗（narrow 下不内联撑长列表）。
  const [rcOpen, setRcOpen] = React.useState(false);
  // 竖屏：环境变量与网关探测（1.2.5+，envEditable=true 才渲染）同款抽屉。
  const [envOpen, setEnvOpen] = React.useState(false);
  // 竖屏：Worker MCP（只读合并视图：CRD 声明 + worker 自注册）同款抽屉。
  const [mcpOpen, setMcpOpen] = React.useState(false);
  // 竖屏：Worker 插件（只读表格：id/name/version/enabled/loaded/plugin_type）同款抽屉。
  const [pluginsOpen, setPluginsOpen] = React.useState(false);
  // 竖屏：Coding CLI（1.2.5+ #1360）同款抽屉。
  const [cliOpen, setCliOpen] = React.useState(false);
  // 竖屏：LLM 调优（1.2.5+，L1-only 可编辑）同款抽屉。
  const [llmOpen, setLlmOpen] = React.useState(false);
  // 运行时版本（node-version 端点：Controller docker 代理容器内 exec 探测
  // qwenpaw/openclaw 实际版本；后端 10min 缓存。L1 only——无 token 不拨号，
  // 显占位。宿主 QwenPaw 版本 ≠ worker 内版本（2.2.2 vs 2.2.1 实锤），
  // 必须 per-node 探测，不可拿宿主值冒充。）
  const [nodeVer, setNodeVer] = React.useState<NodeVersion | null>(null);
  const [nodeVerErr, setNodeVerErr] = React.useState("");
  React.useEffect(() => {
    if (!l1) return;
    let alive = true;
    setNodeVer(null);
    setNodeVerErr("");
    fetchNodeVersion(worker.name)
      .then((d) => {
        if (alive) setNodeVer(d);
      })
      .catch((e) => {
        if (alive)
          setNodeVerErr(e instanceof Error ? e.message : tr("探测失败"));
      });
    return () => {
      alive = false;
    };
  }, [l1, worker.name, tr]);
  const meta = phaseMeta(worker.phase);
  const sleeping = worker.phase === "Sleeping" || worker.phase === "Stopped";
  const busy = acting != null;
  const Item = ({
    label,
    value,
    wide,
    warn,
  }: {
    label: string;
    value: ReactNS.ReactNode;
    wide?: boolean;
    warn?: boolean;
  }) => (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        minWidth: wide ? 260 : 140,
      }}
    >
      <span style={{ color: "#999", fontSize: 12, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: 12.5,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: warn ? "#cf1322" : undefined,
          fontWeight: warn ? 600 : undefined,
        }}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
  return (
    <div
      style={{
        marginLeft: 30,
        borderLeft: `2px solid ${PRIMARY}`,
        paddingLeft: 10,
        padding: "8px 0 8px 10",
        display: "grid",
        gap: 6,
      }}
    >
      {/* ：非 qwenpaw runtime 统一提醒——下方运行
  配置(#1)/审批(#2)/频道(#3)/技能 preload(#4)/时间线(#7) 均为
  QwenPaw 独有面，非 qwenpaw 会被服务端 400/无数据。顶部一条说明
  （各面板另按矩阵做入口禁用/空态，双保险）。qwenpaw/空 runtime 不显。 */}
      <RuntimeNotice runtime={worker.runtime} compact />
      {/* 两层状态分开命名：Worker 状态 = CRD phase（Controller），容器状态 = docker 层；
 两行都显示（不隐藏——字段稳定可预期），不一致时容器值红色高亮 = crashloop 诊断信号 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
        <Item label={tr("Worker 状态")} value={<antd.Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</antd.Tag>} />
        <Item label={tr("团队")} value={worker.team || "—"} />
        <Item label={tr("角色")} value={worker.role || "—"} />
        {/* AgentTeams 版本=Worker 镜像 tag（WorkerResponse.image 正源；
  10/17 用户纠偏：v1.2.5 是 AgentTeams 发布版本，不是运行时版本——
  旧标签「运行时版本」已改名；tooltip 悬停看完整镜像）。 */}
        <Item
          label={tr("AgentTeams 版本")}
          value={
            worker.image ? (
              <WbTooltip
                title={
                  <span style={{ fontFamily: "monospace", wordBreak: "break-all", maxWidth: 320 }}>
                    {worker.image}
                  </span>
                }
              >
                <antd.Tag style={{ margin: 0, fontSize: 11, cursor: "help" }}>
                  {imageTag(worker.image)}
                </antd.Tag>
              </WbTooltip>
            ) : "—"
          }
        />
        {/* 运行时版本=容器内运行时实际版本（node-version 端点 exec 探测；
  覆盖 qwenpaw/copaw/openclaw/hermes/deepseek-harness 全 runtime 族——
  探测链 qwenpaw 包元数据优先、openclaw --version 兜底）。L1 only；
  探测失败/非 L1 → —（tooltip 带原因）。 */}
        <Item
          label={tr("运行时版本")}
          value={
            !l1 ? (
              "—"
            ) : nodeVer ? (
              nodeVer.runtime_version ? (
                <antd.Tag color="green" style={{ margin: 0, fontSize: 11 }}>
                  {RUNTIME_LABELS[nodeVer.runtime || ""] || nodeVer.runtime} {nodeVer.runtime_version}
                </antd.Tag>
              ) : (
                <WbTooltip title={nodeVer.runtime_version_error || tr("未知")}>
                  <span style={{ color: "#999", cursor: "help" }}>—</span>
                </WbTooltip>
              )
            ) : nodeVerErr ? (
              <WbTooltip title={nodeVerErr}>
                <span style={{ color: "#999", cursor: "help" }}>—</span>
              </WbTooltip>
            ) : (
              <span style={{ color: "#999" }}>…</span>
            )
          }
        />
        <Item label={tr("模型")} value={worker.model || "—"} wide />
        <Item
          label={tr("容器状态")}
          value={worker.containerState || "—"}
          warn={!!worker.containerState && !isStateConsistent(worker.state, worker.containerState)}
        />
      </div>
      {/* ：心跳任务运行态四字段
 （worker-agent-status 契约——任务级真相；旧版 Controller 无
 → 整行隐藏，不显空占位）。 */}
      {worker.agentStatus ||
      worker.runningTaskCount != null ||
      worker.lastRunAt ||
      worker.lastFinishAt ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
          <Item label={tr("心跳态")} value={worker.agentStatus || "—"} />
          <Item
            label={tr("在跑任务")}
            value={String(worker.runningTaskCount ?? 0)}
            warn={(worker.runningTaskCount ?? 0) > 0}
          />
          <Item
            label={tr("上次运行")}
            value={worker.lastRunAt ? fmtRfc3339(worker.lastRunAt) : "—"}
            wide
          />
          <Item
            label={tr("上次完成")}
            value={worker.lastFinishAt ? fmtRfc3339(worker.lastFinishAt) : "—"}
            wide
          />
        </div>
      ) : null}
      {/* ：Worker 已装载 Skill / MCP——零新后端
 （Controller /workers 响应已含 skills/mcpServers，通用代理透传）。
 写路径（员工自助增删）等上游 PR，此处只读展示。
 ：MCP 行恒显——此列表只含用户自定义
 MCP（CRD spec.mcpServers）；内置 teamharness/workerflow 走镜像插件
 bootstrap，永不在此出现（历史缺陷「MCP 全没配」误诊的误导源）。 */}
      {worker.skills?.length || worker.mcpServers?.length || worker.runtime === "qwenpaw" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
          {worker.skills?.length ? (
            <Item
              label={tr("Skill")}
              wide
              value={
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                  {worker.skills.map((s) => (
                    <antd.Tag key={s} color="blue" style={{ margin: 0, fontSize: 11 }}>
                      {s}
                    </antd.Tag>
                  ))}
                </span>
              }
            />
          ) : null}
          <Item
            label="MCP"
            wide
            value={
              worker.mcpServers?.length ? (
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                  {worker.mcpServers.map((m) => (
                    <WbTooltip
                      key={m.name}
                      title={
                        <span style={{ fontFamily: "monospace", wordBreak: "break-all", maxWidth: 320 }}>
                          {m.url}
                        </span>
                      }
                    >
                      <antd.Tag style={{ margin: 0, fontSize: 11, cursor: "help" }}>
                        {m.name}
                        {m.transport ? ` · ${m.transport}` : ""}
                      </antd.Tag>
                    </WbTooltip>
                  ))}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: "rgba(128,128,128,0.85)" }}>
                  {tr("无用户自定义 MCP · 内置 teamharness/workerflow 由容器启动时自动注册，不在此列表")}
                </span>
              )
            }
          />
        </div>
      ) : null}
      {/* 竖屏：五按钮 min-content 461px > 390px 容器 274px（10/19 用户反馈实测
          +187px 溢出）→ 允许换行（两行 3+2）；宽屏单行不受影响。 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {sleeping ? (
          <WbTooltip title={tr("唤醒 {name}", { name: worker.name })}>
            <antd.Button
              type="text"
              size="small"
              icon={<WakeIcon style={{ color: "#52c41a" }} />}
              disabled={busy}
              loading={acting === `wake:${worker.name}`}
              onClick={() => onLifecycle?.(worker.name, "wake")}
            >
              {tr("唤醒")}
            </antd.Button>
          </WbTooltip>
        ) : (
          <WbTooltip title={tr("休眠 {name}（释放算力）", { name: worker.name })}>
            <antd.Button
              type="text"
              size="small"
              icon={<SleepIcon style={{ color: "#888" }} />}
              disabled={busy}
              loading={acting === `sleep:${worker.name}`}
              onClick={() => onLifecycle?.(worker.name, "sleep")}
            >
              {tr("休眠")}
            </antd.Button>
          </WbTooltip>
        )}
        {/* 竖屏：运行配置入口=紧凑按钮（内容进 NarrowSheet 底部抽屉，
  不再内联撑长）；宽屏 undefined → 不渲染（下方内联面板即入口）。 */}
        {narrow ? (
          <antd.Button
            size="small"
            icon={<SettingsIcon size={12} />}
            onClick={() => setRcOpen(true)}
          >
            {tr("运行配置")}
          </antd.Button>
        ) : null}
        {/* 竖屏：环境变量与网关探测入口=紧凑按钮（1.2.5+ envEditable
  才渲染；L2/旧 Controller 隐藏——与下方内联面板同一门控）。 */}
        {narrow && worker.envEditable === true ? (
          <antd.Button
            size="small"
            icon={<SettingsIcon size={12} />}
            onClick={() => setEnvOpen(true)}
          >
            {tr("环境变量")}
          </antd.Button>
        ) : null}
        {/* 竖屏：Worker MCP 入口=紧凑按钮（只读合并视图；不依赖
  envEditable——自注册读路径由面板内部诚实降级）。 */}
        {narrow ? (
          <antd.Button
            size="small"
            icon={<PlugIcon size={12} />}
            onClick={() => setMcpOpen(true)}
          >
            {tr("Worker MCP")}
          </antd.Button>
        ) : null}
        {/* 竖屏：Worker 插件入口=紧凑按钮（只读表格；Controller 端点
  未合时由面板内部诚实降级）。 */}
        {narrow ? (
          <antd.Button
            size="small"
            icon={<BrickIcon size={12} />}
            onClick={() => setPluginsOpen(true)}
          >
            {tr("Worker 插件")}
          </antd.Button>
        ) : null}
        {/* 竖屏：Coding CLI 入口=紧凑按钮（1.2.5+ #1360；admin 侧渲染——
  L2 打开后面板自行 403 降级只读，与宽屏同语义）。 */}
        {narrow ? (
          <antd.Button
            size="small"
            icon={<CodeIcon size={12} />}
            onClick={() => setCliOpen(true)}
          >
            {tr("Coding CLI")}
          </antd.Button>
        ) : null}
        {/* 竖屏：LLM 调优入口=紧凑按钮（1.2.5+，L1 可编辑 / L2 只读降级）。 */}
        {narrow ? (
          <antd.Button
            size="small"
            icon={<SettingsIcon size={12} />}
            onClick={() => setLlmOpen(true)}
          >
            {tr("LLM 调优")}
          </antd.Button>
        ) : null}
      </div>
      {/* ：Worker 运行配置（上游 #1231 消费）——
 默认折叠，展开内懒加载；非 qwenpaw runtime 由面板 400 门自解释。
 宽屏内联卡已移至 WorkerRow 展开区（段头对齐：本容器带 30+2+10=42px
 偏移，卡留在里面段头会被顶到 x=75，与资源管理/检查点/工具执行安全的
  x=33 轨错位——10/17 用户「四个菜单没有水平对齐」根因）。
 竖屏（narrow）：紧凑按钮 → NarrowSheet 底部抽屉（fixed 定位弹窗，
 容器内渲染无碍；面板 sheet=true 去卡片外框/自动展开）。 */}
      {narrow ? (
        <NarrowSheet
          open={rcOpen}
          title={tr("运行配置")}
          onClose={() => setRcOpen(false)}
        >
          <WorkerRuntimeConfig
            sheet
            name={worker.name}
            l1={l1}
            onOpenSettings={onOpenSettings}
          />
        </NarrowSheet>
      ) : null}
      {/* ：Worker 环境变量 + 网关探测（AgentTeams 1.2.5+ #1306）。
  envEditable=true 才渲染（L2=遮蔽 false / 旧 Controller=undefined，
  两者隐藏——优雅降级）；宽屏内联卡同移 WorkerRow（段头对齐）；
  竖屏同款抽屉。保存后容器重建生效——面板内有二次确认与明示。 */}
      {worker.envEditable === true && narrow ? (
        <NarrowSheet
          open={envOpen}
          title={tr("环境变量与网关探测")}
          onClose={() => setEnvOpen(false)}
        >
          <WorkerEnvPanel
            sheet
            worker={worker}
            onChanged={() => invalidateTags(["admin"])}
          />
        </NarrowSheet>
      ) : null}
      {/* ：Worker MCP（只读合并视图：CRD 声明 + worker 自注册）竖屏同款
  抽屉（自注册读路径懒加载 + 诚实降级，面板内部处理）。 */}
      {narrow ? (
        <NarrowSheet
          open={mcpOpen}
          title={tr("Worker MCP")}
          onClose={() => setMcpOpen(false)}
        >
          <WorkerMcpPanel sheet worker={worker} />
        </NarrowSheet>
      ) : null}
      {/* ：Worker 插件（只读表格）竖屏同款抽屉（懒加载 + 诚实降级，
  面板内部处理）。 */}
      {narrow ? (
        <NarrowSheet
          open={pluginsOpen}
          title={tr("Worker 插件")}
          onClose={() => setPluginsOpen(false)}
        >
          <WorkerPluginsPanel sheet worker={worker} />
        </NarrowSheet>
      ) : null}
      {/* ：Coding CLI（AgentTeams 1.2.5+ #1360）竖屏同款抽屉。 */}
      {narrow ? (
        <NarrowSheet
          open={cliOpen}
          title={tr("Coding CLI（安装/升级/settings）")}
          onClose={() => setCliOpen(false)}
        >
          <WorkerCodingCliPanel
            sheet
            worker={worker}
            onChanged={() => invalidateTags(["admin"])}
          />
        </NarrowSheet>
      ) : null}
      {/* ：LLM 调优（AgentTeams 1.2.5+，L1-only 可编辑）竖屏同款抽屉。 */}
      {narrow ? (
        <NarrowSheet
          open={llmOpen}
          title={tr("LLM 调优（重试与限流 / 流式超时）")}
          onClose={() => setLlmOpen(false)}
        >
          <WorkerLlmTuningPanel
            sheet
            worker={worker}
            l1={l1}
            onChanged={() => invalidateTags(["admin"])}
          />
        </NarrowSheet>
      ) : null}
    </div>
  );
}

/** Worker 行：拓扑节点 + 状态摘要；展开 = 管理信息面板 + spawn 子任务树 + 检查点。 */
export function WorkerRow({
  group,
  depth,
  onDm,
  adminWorker,
  onLifecycle,
  acting,
  sessionState,
  l1,
  onOpenSettings,
}: {
  group: WorkerSpawnGroup;
  depth: number;
  onDm?: (mxid: string, roomId?: string) => void;
  adminWorker?: AdminData["workers"][number];
  onLifecycle?: (name: string, action: "wake" | "sleep") => void;
  acting: string | null;
  /** L1 账号 → 运行配置面板 L1-only 字段可编辑。 */
  l1?: boolean;
  /** L1 只读 Alert「去设置」跳转透传。 */
  onOpenSettings?: () => void;
  /** 该 Worker 的 session 状态（typing/last_ts 派生）。
 * 与行首既有圆点（CR phase / spawn running，进程级）并存——两轴不同。 */
  sessionState?: WorkerSessionState;
}) {
  const tr = useT();
  const { narrow } = useWbViewport();
  const [expanded, setExpanded] = React.useState(false);
  // 竖屏：资源管理改底部抽屉弹窗（narrow 下不内联撑长列表）。
  const [resOpen, setResOpen] = React.useState(false);
  const spawns = group.spawns || [];
  const hasRunning = spawns.some((s) => s.status === "running");
  /* admin 数据未加载（L2/未配 token）时回退 tree 数据
 的 phase/runtime（后端 team-structure 已透传，零新请求）。 */
  const phase = adminWorker?.phase || group.phase || "";
  const rowRuntime = adminWorker?.runtime || group.runtime || "";
  // legacy 角标判据——controller ≥#1327 对
  // copaw 存量置 runtimeDeprecated=true（admin 源有；tree 源 undefined=
  // 降级为仅按 runtime 判定）。
  const rowDeprecated = !!(
    adminWorker?.runtimeDeprecated || group.runtimeDeprecated
  );
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          // 竖屏：单行放不下 角色/名/状态/模型/运行时/版本/mxid——详情自动换到
          // 第 2 行（rowGap 分隔），消除横向溢出；宽屏保持单行 nowrap 不变。
          flexWrap: narrow ? "wrap" : "nowrap",
          rowGap: 4,
          // 触屏：整行可点的行高 = TreeLine 22 + 上下 padding——narrow 下
          // 11×2 把行扩到 ≥44px（稳定命中展开/收起、不误触邻行）；
          // 宽屏 5px 原值不变。
          padding: narrow ? "11px 0" : "5px 0",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <TreeLine depth={depth} isLast />
        <span style={{ width: 14, fontSize: 11, color: "#888", flexShrink: 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: phase ? phaseMeta(phase).color : hasRunning ? "#52c41a" : "#ddd",
            boxShadow:
              hasRunning && !phase
                ? "0 0 0 3px rgba(82,196,26,0.15)"
                : "none",
            flexShrink: 0,
            marginRight: 8,
          }}
        />
        <antd.Tag
          color={ROLE_COLOR[group.role]}
          style={{
            margin: "0 6px 0 0",
            minWidth: 22,
            textAlign: "center",
            fontSize: 11,
          }}
        >
          {tr(ROLE_BADGE[group.role])}
        </antd.Tag>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {group.worker_name}
        </span>
        {sessionState ? <WorkerSessionDot state={sessionState} /> : null}
        {group.is_self ? (
          <antd.Tag style={{ margin: "0 0 0 6px", fontSize: 11 }}>我</antd.Tag>
        ) : null}
        {adminWorker ? (
          <antd.Tag
            color={phaseMeta(phase).color}
            style={{ margin: "0 0 0 6px", fontSize: 11 }}
          >
            {phaseMeta(phase).label}
          </antd.Tag>
        ) : null}
        {/* meta 组（模型/运行时/legacy/版本/MXID/spawns 徽标/DM 按钮）：
 窄屏整组换行到第 2 行（width:100% 的 flex 行，触屏行更疏朗）；宽屏
 display:contents = 布局上不存在此包裹，单行呈现与既往逐像素一致。 */}
        <div
          style={
            narrow
              ? { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", width: "100%" }
              : { display: "contents" }
          }
        >
        {/* （不圈在一起——模型/运行时各一个
 标签，颜色区分，参考 dashboard RuntimeBadge）：模型=蓝、
 运行时=按运行时着色（RUNTIME_TAG_COLOR），版本=灰小字+悬停全量。
 / 数据源不变：WorkerInfo.runtime/version，未加载回退 tree
 group.runtime。 */}
        {adminWorker?.model ? (
          <antd.Tag
            color="blue"
            style={{
              margin: "0 0 0 6px",
              fontSize: 11,
              maxWidth: 180,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={adminWorker.model}
          >
            {adminWorker.model}
          </antd.Tag>
        ) : null}
        {rowRuntime ? (
          <antd.Tag
            color={RUNTIME_TAG_COLOR[rowRuntime] ?? "default"}
            style={{ margin: "0 0 0 6px", fontSize: 11 }}
            title={`${rowRuntime}${adminWorker?.version ? ` · ${adminWorker.version}` : ""}`}
          >
            {rowRuntime}
          </antd.Tag>
        ) : null}
        {/* ：legacy 运行时统一角标（含升级指引）。 */}
        {rowDeprecated ? <RuntimeNotice kind="legacy" compact /> : null}
        {adminWorker?.version ? (
          <span style={{ color: "#999", fontSize: 11, marginLeft: 2 }}>
            {adminWorker.version}
          </span>
        ) : null}
        {/* MXID 长串：窄屏换行行内允许断行（不顶破容器）。 */}
        <span style={{ color: "#888", fontSize: 12, marginLeft: 6, wordBreak: "break-all" }}>
          {group.mxid}
        </span>
        {spawns.length ? (
          <antd.Badge
            count={spawns.length}
            size="small"
            style={{ backgroundColor: "var(--app-accent, #FF7F16)", marginLeft: 8 }}
          />
        ) : null}
        {onDm && !group.is_self ? (
          <WbTooltip title={tr("私聊 {name}", { name: group.worker_name })}>
            <antd.Button
              type="text"
              size="small"
              shape="circle"
              style={{
                marginLeft: 8,
                color: "#888",
                borderColor: "transparent",
                // 触屏：antd small 圆形按钮仅 24px——narrow 下内联
                // width/height 覆盖扩到 32px；宽屏 undefined → 原 24px。
                width: narrow ? 32 : undefined,
                height: narrow ? 32 : undefined,
              }}
              icon={<MessageIcon />}
              onClick={(e: ReactNS.MouseEvent) => {
                e.stopPropagation();
                // Worker 个人
                // 房间（CR roomID）直跳——Worker 容器无法接受 Matrix 邀请，
                // 新建 DM 房间 Worker 进不来=死路。无 room_id 才 fallback openDm。
                onDm(group.mxid || group.worker_name, group.room_id);
              }}
            />
          </WbTooltip>
        ) : null}
        </div>
      </div>
      {expanded ? (
        <>
          {adminWorker ? (
            <WorkerManageInfo
              worker={adminWorker}
              onLifecycle={onLifecycle}
              acting={acting}
              l1={l1}
              onOpenSettings={onOpenSettings}
            />
          ) : null}
          {/* 段头对齐（10/17 用户）：运行配置/环境变量宽屏内联卡从
  WorkerManageInfo 42px 偏移容器移到此——与下方资源管理/检查点/
  工具执行安全同一条 x=33 段头轨（chevron 槽 12 + 图标 13 + 标题 12/600）。
  narrow 走 WorkerManageInfo 内的紧凑按钮 + NarrowSheet，不受影响。 */}
          {adminWorker && !narrow ? (
            <>
              <WorkerRuntimeConfig
                name={adminWorker.name}
                l1={l1}
                onOpenSettings={onOpenSettings}
              />
              {adminWorker.envEditable === true ? (
                <WorkerEnvPanel
                  worker={adminWorker}
                  onChanged={() => invalidateTags(["admin"])}
                />
              ) : null}
              {/* ：Worker MCP（只读合并视图：CRD 声明 + worker 自注册），
  x=33 段头轨对齐；自注册读路径懒加载 + 404 诚实降级（面板内部）。 */}
              <WorkerMcpPanel worker={adminWorker} />
              {/* ：Worker 插件（只读表格：id/name/version/enabled/
  loaded/plugin_type），x=33 段头轨对齐；懒加载 + 404 诚实降级
  （面板内部）。 */}
              <WorkerPluginsPanel worker={adminWorker} />
              {/* ：Coding CLI（AgentTeams 1.2.5+ #1360）宽屏内联卡，
  x=33 段头轨对齐（同款视觉家族；404 旧 Controller=面板内横幅，
  L2=只读降级，探测惰性不后台轮询）。 */}
              <WorkerCodingCliPanel
                worker={adminWorker}
                onChanged={() => invalidateTags(["admin"])}
              />
              {/* ：LLM 调优（AgentTeams 1.2.5+）宽屏内联卡，x=33 段头轨对齐。
  L1-only 可编辑（checkScopedWorkerUpdate forbidden L2/L3）；L2=只读降级；
  挂载 key={name} 重挂载（编辑态随卸载清零，同 dashboard）。 */}
              <WorkerLlmTuningPanel
                key={`llm-${adminWorker.name}`}
                worker={adminWorker}
                l1={l1}
                onChanged={() => invalidateTags(["admin"])}
              />
            </>
          ) : null}
          {/* ：per-Worker 资源管理
 （技能/MCP/频道/工具 四页签，就地编辑）。
 技能/MCP 改为技能中心同款可编辑卡直接嵌入
 （SkillCenter onlyWorker），撤「去技能中心编辑」跳转。
 竖屏（narrow）：内联 → 竖屏友好弹窗（紧凑按钮 → NarrowSheet
 底部抽屉；面板 sheet=true 去卡片外框/标题行，内容与懒挂载逻辑不变）；
 宽屏：保持内联。 */}
          {adminWorker ? (
            narrow ? (
              <>
                <div style={{ display: "flex", marginLeft: 30 }}>
                  <antd.Button
                    size="small"
                    icon={<WrenchIcon size={12} />}
                    onClick={() => setResOpen(true)}
                  >
                    {tr("资源管理")}
                  </antd.Button>
                </div>
                <NarrowSheet
                  open={resOpen}
                  title={tr("资源管理（技能 / MCP / 频道 / 工具）")}
                  onClose={() => setResOpen(false)}
                >
                  <WorkerResourcePanel sheet worker={adminWorker} l1={l1} />
                </NarrowSheet>
              </>
            ) : (
              <WorkerResourcePanel worker={adminWorker} l1={l1} />
            )
          ) : null}
          {spawns.length
            ? spawns.map((node) => (
                <SpawnRow key={node.session_id} node={node} depth={depth + 1} />
              ))
            : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "2px 0",
                  color: "#999",
                  fontSize: 12,
                }}
              >
                <TreeLine depth={depth + 1} isLast />
                <span>{tr("暂无活跃会话——接入 spawn 端点后显示")}</span>
              </div>
            )}
          {group.worker_name ? (
            <CheckpointCard workerName={group.worker_name} runtime={rowRuntime} />
          ) : null}
          {group.worker_name ? (
            <ApprovalControl workerName={group.worker_name} workerDetail />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Worker 执行检查点（checkpoint 端点；懒加载：展开时才请求）。
 * runtime 非 qwenpaw → 禁用入口 + 说明
 * （不发起无谓的 checkpoint 拨号）。 */
function CheckpointCard({
  workerName,
  runtime,
}: {
  workerName: string;
  runtime?: string;
}) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  // 非 qwenpaw 禁用入口 + 不发起拨号。
  const gated = isQwenpawOnlyDisabled(runtime);
  const [state, setState] = React.useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | {
        kind: "ok";
        status: CheckpointStatusResponse;
        graph: CheckpointGraphResponse;
      }
    | { kind: "unavailable" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  React.useEffect(() => {
    if (!open || gated) return; // D4 #7：非 qwenpaw 不拨号
    let alive = true;
    setState({ kind: "loading" });
    Promise.all([
      fetchWorkerCheckpointStatus(workerName),
      fetchWorkerCheckpointGraph(workerName, 100),
    ])
      .then(([status, graph]) => {
        if (alive) setState({ kind: "ok", status, graph });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof CheckpointUnavailableError) {
          setState({ kind: "unavailable" });
          return;
        }
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      alive = false;
    };
  }, [open, workerName, gated]);

  const nodes = state.kind === "ok" ? state.graph.nodes.slice(0, 5) : [];
  return (
    // 段头对齐（10/17 用户）：与卡片族同一 x=33 轨——无卡片边框，
    // marginLeft 23 + paddingLeft 10 = 33（卡片族 = margin 22 + border 1
    // + padding 10）；chevron 槽 12 / 图标 13 / gap 6 / 标题 12/600 同规格。
    <div style={{ marginLeft: 23, fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: gated ? "not-allowed" : "pointer",
          color: gated ? "#bbb" : "#888",
          padding: "2px 0 2px 10",
        }}
        onClick={() => !gated && setOpen((v) => !v)}
      >
        <span style={{ width: 12, fontSize: 10, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><BookmarkIcon size={13} /> {tr("检查点")}</span>
        {gated ? (
          <span style={{ fontSize: 11, color: "#bbb" }}>{tr("仅 QwenPaw 运行时可用")}</span>
        ) : null}
        {state.kind === "ok" && state.graph.summary.total > 0 ? (
          <antd.Badge
            count={state.graph.summary.total}
            size="small"
            style={{ backgroundColor: "#8c8c8c" }}
          />
        ) : null}
      </div>
      {open && !gated ? (
        <div style={{ display: "grid", gap: 4, paddingLeft: 14 }}>
          {state.kind === "loading" ? (
            <span style={{ color: "#999" }}>{tr("加载中…")}</span>
          ) : null}
          {state.kind === "unavailable" ? (
            <span style={{ color: "#999" }}>
              {tr("该 Worker 需 QwenPaw 2.1 才有检查点")}
            </span>
          ) : null}
          {state.kind === "error" ? (
            <span style={{ color: "#999" }}>
              {/HTTP 404/.test(state.message)
                ? tr("Controller 升级后自动生效")
                : `${tr("检查点加载失败")}：${state.message}`}
            </span>
          ) : null}
          {state.kind === "ok" ? (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <antd.Tag
                  style={{ margin: 0, fontSize: 11 }}
                  color={state.status.auto_enabled ? "green" : "default"}
                >
                  {state.status.auto_enabled
                    ? tr("自动打点开")
                    : tr("自动打点关")}
                </antd.Tag>
                {state.graph.summary.total > 0 ? (
                  <>
                    <antd.Tag style={{ margin: 0, fontSize: 11 }} color="blue">
                      {tr("自动")} {state.graph.summary.auto}
                    </antd.Tag>
                    <antd.Tag style={{ margin: 0, fontSize: 11 }} color="green">
                      {tr("快照")} {state.graph.summary.snapshots}
                    </antd.Tag>
                    <antd.Tag style={{ margin: 0, fontSize: 11 }} color="orange">
                      {tr("恢复点")} {state.graph.summary.safety}
                    </antd.Tag>
                  </>
                ) : (
                  <span style={{ color: "#999" }}>{tr("暂无打点")}</span>
                )}
              </div>
              {nodes.map((n) => (
                <div key={n.ref} style={{ color: "#666", display: "grid", gap: 2 }}>
                  <div>
                    <antd.Tag
                      style={{ margin: 0, fontSize: 11 }}
                      color={
                        n.kind === "auto"
                          ? "blue"
                          : n.kind === "snap"
                            ? "green"
                            : "orange"
                      }
                    >
                      {n.kind}
                    </antd.Tag>
                    <span style={{ marginLeft: 6 }}>
                      {fmtTime(n.timestamp_ms)}
                    </span>
                    {n.is_head ? (
 <span style={{ color: "var(--app-accent, #FF7F16)", marginLeft: 6 }}>●</span>
                    ) : null}
                  </div>
                  {n.query ? (
                    <div
                      style={{
                        color: "#999",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: 320,
                      }}
                      title={n.query}
                    >
                      {n.query}
                    </div>
                  ) : n.subject ? (
                    <div style={{ color: "#999" }}>{n.subject}</div>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

