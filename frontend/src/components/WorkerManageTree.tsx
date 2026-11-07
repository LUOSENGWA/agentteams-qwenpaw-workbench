import type * as ReactNS from "react";

import {
  CheckpointNotSupportedError,
  CheckpointUnavailableError,
  fetchNodeVersion,
  fetchWorkerCheckpointGraph,
  fetchWorkerCheckpointStatus,
  fetchWorkerDetail,
  imageTag,
} from "../api";
import type {
  AdminData,
  CheckpointGraphResponse,
  CheckpointStatusResponse,
  McpServerInfo,
  NodeVersion,
  SpawnNode,
  WorkerSpawnGroup,
} from "../api";
// spawn 会话消息端点（域文件直取，manage/* 同款直取模式）。
import {
  getSpawnMessages,
  type SpawnMessage,
  type SpawnMessagesResponse,
} from "../api/domains/teams";
import {
  BookmarkIcon,
  BrickIcon,
  CodeIcon,
  PlugIcon,
  SettingsIcon,
  WrenchIcon,
} from "./icons";
import ApprovalControl from "./ApprovalControl";
import NarrowSheet from "./NarrowSheet";
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
import { OpenClawIcon } from "./OpenClawIcon";
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
  foldMessageContent,
  classifySpawnMsgError,
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
      {/* 会话消息子项：仅 /spawns 正源节点带 project_id（消息端点按项目
 寻址）；无 project_id 不渲染入口（无可请求的路径）。懒加载在组件内。 */}
      {node.project_id ? (
        <SpawnMessages
          projectId={node.project_id}
          sessionId={node.session_id}
          depth={depth}
        />
      ) : null}
      {(node.children || []).map((child) => (
        <SpawnRow key={child.session_id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

type SpawnMsgState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; data: SpawnMessagesResponse }
  | { kind: "empty" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

/** spawn 会话「消息」子项（懒加载：展开才请求，列表渲染不批量拉取）。
 * 404（会话不存在 / 不属于该项目 / 老控制器无此路由）= 空态不报错；
 * 403 = 行内「无权限查看」；其余失败 = 「加载失败 · 重试」。 */
function SpawnMessages({
  projectId,
  sessionId,
  depth,
}: {
  projectId: string;
  sessionId: string;
  depth: number;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [open, setOpen] = React.useState(false);
  const [tryTick, setTryTick] = React.useState(0);
  const [state, setState] = React.useState<SpawnMsgState>({ kind: "idle" });

  React.useEffect(() => {
    if (!open) return; // 懒加载：收起态不发请求
    let alive = true;
    setState({ kind: "loading" });
    getSpawnMessages(projectId, sessionId, 200)
      .then((data) => {
        if (alive) setState({ kind: "ok", data });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const cls = classifySpawnMsgError(e);
        if (cls === "empty") setState({ kind: "empty" });
        else if (cls === "forbidden") setState({ kind: "forbidden" });
        else
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      alive = false;
    };
  }, [open, tryTick, projectId, sessionId]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          // 触控目标 ≥44px（整行命中，不误触邻行）。
          minHeight: 44,
          cursor: "pointer",
        }}
        onClick={(e: ReactNS.MouseEvent) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <TreeLine depth={depth + 1} isLast />
        <span style={{ width: 12, fontSize: 10, color: t.textSecondary, flexShrink: 0 }}>
          {open ? "▾" : "▸"}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: t.textSecondary,
            fontSize: 12,
          }}
        >
          <MessageIcon size={12} /> {tr("消息")}
        </span>
      </div>
      {open ? (
        <div
          style={{
            marginLeft: (depth + 1) * 22 + 42,
            display: "grid",
            gap: 8,
            paddingBottom: 8,
          }}
        >
          {state.kind === "loading" ? (
            <span style={{ color: t.textSecondary, fontSize: 12 }}>
              {tr("加载中…")}
            </span>
          ) : null}
          {state.kind === "empty" ? (
            <span style={{ color: t.textSecondary, fontSize: 12 }}>{tr("暂无消息")}</span>
          ) : null}
          {state.kind === "forbidden" ? (
            <span style={{ color: t.mode === "dark" ? "#ff7875" : "#cf1322", fontSize: 12 }}>
              {tr("无权限查看")}
            </span>
          ) : null}
          {state.kind === "error" ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <antd.Button
                size="small"
                danger
                style={{ minHeight: 44 }}
                onClick={() => setTryTick((v) => v + 1)}
              >
                {tr("加载失败")} · {tr("重试")}
              </antd.Button>
              <span style={{ color: t.textSecondary, fontSize: 11 }}>{state.message}</span>
            </div>
          ) : null}
          {state.kind === "ok" ? (
            <>
              {state.data.messages.length === 0 ? (
                <span style={{ color: t.textSecondary, fontSize: 12 }}>
                  {tr("暂无消息")}
                </span>
              ) : (
                state.data.messages.map((m, i) => (
                  <SpawnMessageItem key={m.seq ?? `idx-${i}`} m={m} />
                ))
              )}
              {state.data.has_more ? (
                <span style={{ color: t.textSecondary, fontSize: 11 }}>
                  {tr("仅显示最近 {n} 条", {
                    n: state.data.messages.length,
                  })}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 单条 spawn 消息：role/name + created_at（本地时区）+ content
 * （whiteSpace:pre-wrap 保留换行；超 6 行折叠 +「展开」行，触控 ≥44px）。 */
function SpawnMessageItem({ m }: { m: SpawnMessage }) {
  const tr = useT();
  const t = useThemeColors();
  const [expanded, setExpanded] = React.useState(false);
  const { text, folded } = foldMessageContent(m.content);
  return (
    <div style={{ borderLeft: `2px solid ${t.border}`, paddingLeft: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <antd.Tag
          style={{ margin: 0, fontSize: 11 }}
          color={m.role === "user" ? "orange" : "blue"}
        >
          {m.role || "?"}
        </antd.Tag>
        {m.name ? (
          <span style={{ fontSize: 12, fontWeight: 600, color: "#333" }}>
            {m.name}
          </span>
        ) : null}
        {m.created_at ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {fmtRfc3339(m.created_at)}
          </span>
        ) : null}
      </div>
      {m.content ? (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            color: t.text,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            marginTop: 2,
          }}
        >
          {expanded ? m.content : text}
        </div>
      ) : null}
      {folded ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            // 触控目标 ≥44px。
            minHeight: 44,
            cursor: "pointer",
            color: "var(--app-accent, #FF7F16)",
            fontSize: 12,
          }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? tr("收起") : tr("展开")}
        </div>
      ) : null}
    </div>
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
  // 竖屏：环境变量与网关探测（1.2.5+，仅 envEditable 明确 false 隐藏）同款抽屉。
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
  // #1477：列表已投影（fields=spec,status）——列表行不含 skills/mcpServers。
  // Skill/MCP 只读块展开（本组件挂载=树节点展开）才读 detail GET /workers/{name}
  // （15s 缓存，不预取、不 N+1）；loading→「加载中…」；error→错误+重试。
  const [skillMcpDetail, setSkillMcpDetail] = React.useState<{
    state: "loading" | "error" | "ready";
    skills?: string[];
    mcpServers?: McpServerInfo[];
    err?: string;
  }>({ state: "loading" });
  const [skillMcpTry, setSkillMcpTry] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    setSkillMcpDetail({ state: "loading" });
    fetchWorkerDetail(worker.name)
      .then((d) => {
        if (alive)
          setSkillMcpDetail({
            state: "ready",
            skills: d.skills,
            mcpServers: d.mcpServers,
          });
      })
      .catch((e) => {
        if (alive)
          setSkillMcpDetail({
            state: "error",
            err: e instanceof Error ? e.message : tr("读取 Worker 配置失败"),
          });
      });
    return () => {
      alive = false;
    };
  }, [worker.name, skillMcpTry, tr]);
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
  // Skill/MCP 块非 ready 态的公共占位（loading/error+重试；detail 未就绪
  // 不显示列表行的空值冒充真相）。
  const skillMcpPending =
    skillMcpDetail.state === "loading" ? (
      <span style={{ fontSize: 11, color: "rgba(128,128,128,0.85)" }}>
        {tr("加载中…")}
      </span>
    ) : skillMcpDetail.state === "error" ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "#cf1322" }}>
          {tr("读取 Worker 配置失败")}
          {skillMcpDetail.err ? `（${skillMcpDetail.err}）` : ""}
        </span>
        <antd.Button
          size="small"
          type="link"
          style={{ padding: 0, height: "auto", fontSize: 11, lineHeight: "18px" }}
          onClick={() => setSkillMcpTry((v) => v + 1)}
        >
          {tr("重试")}
        </antd.Button>
      </span>
    ) : null;
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
                  {nodeVer.runtime === "openclaw" && (
                    <OpenClawIcon size={12} style={{ marginRight: 4, verticalAlign: "-1px" }} />
                  )}
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
      {/* Worker 已装载 Skill / MCP（只读展示；写路径在技能中心）。
  #1477：列表投影（spec,status）后列表行不含 skills/mcpServers → 正源改
  detail（展开=本组件挂载时取，15s 缓存；不预取）。原条件依赖列表行字段，
  投影后非 qwenpaw worker 恒空=块误隐 → 改恒渲染（状态驱动内容）。
  MCP 行恒显——此列表只含用户自定义 MCP（CRD spec.mcpServers）；内置
  teamharness/workerflow 走镜像插件 bootstrap，永不在此出现。 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
        <Item
          label={tr("Skill")}
          wide
          value={
            skillMcpPending ??
            (skillMcpDetail.skills?.length ? (
              <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                {skillMcpDetail.skills.map((s) => (
                  <antd.Tag key={s} color="blue" style={{ margin: 0, fontSize: 11 }}>
                    {s}
                  </antd.Tag>
                ))}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "rgba(128,128,128,0.85)" }}>
                {tr("无")}
              </span>
            ))
          }
        />
        <Item
          label="MCP"
          wide
          value={
            skillMcpPending ??
            (skillMcpDetail.mcpServers?.length ? (
              <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
                {skillMcpDetail.mcpServers.map((m) => (
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
            ))
          }
        />
      </div>
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
        {/* 竖屏：环境变量与网关探测入口=紧凑按钮（1.2.5+，仅 envEditable
  明确 false=L2 遮蔽才隐藏；undefined=旧 Controller/16.61 投影丢字段
  照常渲染，面板内 detail 加载态降级——与下方内联面板同一门控）。 */}
        {narrow && worker.envEditable !== false ? (
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
          flushTop
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
  仅 envEditable 明确 false（L2 遮蔽）隐藏；undefined（旧 Controller /
  16.61 列表投影丢 envEditable）照常渲染，面板内 detail 加载态降级；
  宽屏内联卡同移 WorkerRow（段头对齐）；竖屏同款抽屉。
  保存后容器重建生效——面板内有二次确认与明示。 */}
      {worker.envEditable !== false && narrow ? (
        <NarrowSheet
          open={envOpen}
          title={tr("环境变量与网关探测")}
          onClose={() => setEnvOpen(false)}
          flushTop
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
          flushTop
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
          flushTop
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
          flushTop
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
          flushTop
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
                key={`rtc-${adminWorker.name}`}
                name={adminWorker.name}
                l1={l1}
                onOpenSettings={onOpenSettings}
              />
              {adminWorker.envEditable !== false ? (
                <WorkerEnvPanel
                  key={`env-${adminWorker.name}`}
                  worker={adminWorker}
                  onChanged={() => invalidateTags(["admin"])}
                />
              ) : null}
              {/* ：Worker MCP（只读合并视图：CRD 声明 + worker 自注册），
  x=33 段头轨对齐；自注册读路径懒加载 + 404 诚实降级（面板内部）。
  key={name} 重挂载：切换 worker 强制 remount（编辑态随卸载清零）。 */}
              <WorkerMcpPanel key={`mcp-${adminWorker.name}`} worker={adminWorker} />
              {/* ：Worker 插件（只读表格：id/name/version/enabled/
  loaded/plugin_type），x=33 段头轨对齐；懒加载 + 404 诚实降级
  （面板内部）。key={name} 重挂载防状态残留。 */}
              <WorkerPluginsPanel key={`plg-${adminWorker.name}`} worker={adminWorker} />
              {/* ：Coding CLI（AgentTeams 1.2.5+ #1360）宽屏内联卡，
  x=33 段头轨对齐（同款视觉家族；404 旧 Controller=面板内横幅，
  L2=只读降级，探测惰性不后台轮询）。key={name} 重挂载。 */}
              <WorkerCodingCliPanel
                key={`cli-${adminWorker.name}`}
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
                  flushTop
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
    | { kind: "notSupported" }
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
        if (e instanceof CheckpointNotSupportedError) {
          // 控制器无检查点路由（404/405；旧版）→ 隐藏入口 + 一行提示，不报错。
          setState({ kind: "notSupported" });
          return;
        }
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
  const notSupported = state.kind === "notSupported";
  return (
    // 段头对齐（10/17 用户）：与卡片族同一 x=33 轨——无卡片边框，
    // marginLeft 23 + paddingLeft 10 = 33（卡片族 = margin 22 + border 1
    // + padding 10）；chevron 槽 12 / 图标 13 / gap 6 / 标题 12/600 同规格。
    <div style={{ marginLeft: 23, fontSize: 12 }}>
      {/* 控制器无检查点路由（404/405；旧版）→ 隐藏入口行，仅留一行灰字提示。 */}
      {!notSupported ? (
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
      ) : null}
      {open && !gated ? (
        <div style={{ display: "grid", gap: 4, paddingLeft: 14 }}>
          {state.kind === "notSupported" ? (
            <span style={{ color: "#999" }}>
              {tr("该控制器不支持检查点图")}
            </span>
          ) : null}
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

