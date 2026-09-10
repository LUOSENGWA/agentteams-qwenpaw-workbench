import type * as ReactNS from "react";

import {
  CheckpointUnavailableError,
  fetchWorkerCheckpointGraph,
  fetchWorkerCheckpointStatus,
  postController,
  requestJson,
  updateManagerModel,
  type AdminData,
  type CheckpointGraphResponse,
  type CheckpointStatusResponse,
  type ManagerInfo,
  type SpawnNode,
  type WorkerSpawnGroup,
  type WorkerTreeTeam,
} from "../api";
import {
  modelVerdictText,
  useModelUnionOptions,
  validateModelValue,
} from "../modelUnion";
import ApprovalControl from "./ApprovalControl";
import CrdManage from "./CrdManage";
import MyScopeCard from "./MyScopeCard";
import WorkerChannels from "./WorkerChannels";
import SkillCenter from "./SkillCenter";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");
const WakeIcon = pick("CaretRightOutlined");
const SleepIcon = pick("PauseOutlined");
const MessageIcon = pick("MessageOutlined");

const PRIMARY = "#FF7F16";

// 存 key 不用 tr：模块级常量不能调 hook；组件内 useT 后 tr(ROLE_BADGE[role])。
const ROLE_BADGE: Record<WorkerSpawnGroup["role"], string> = {
  leader: "领",
  worker: "工",
  critic: "审",
  unknown: "?",
};
const ROLE_COLOR: Record<WorkerSpawnGroup["role"], string> = {
  leader: "#FF7F16",
  worker: "#1677ff",
  critic: "#fa8c16",
  unknown: "#999",
};
const SPAWN_STATUS_COLOR: Record<SpawnNode["status"], string> = {
  idle: "#999",
  running: "#52c41a",
  done: "#bbb",
};
const SPAWN_STATUS_LABEL: Record<SpawnNode["status"], string> = {
  idle: "待命",
  running: "进行中",
  done: "已完成",
};
const PHASE_COLOR: Record<string, string> = {
  Active: "#52c41a",
  Running: "#52c41a",
  Ready: "#52c41a",
  Pending: "#fa8c16",
  Starting: "#1677ff",
  Failed: "#ff4d4f",
  Error: "#ff4d4f",
  Stopped: "#999",
  Sleeping: "#999",
};

function phaseMeta(phase: string): { label: string; color: string } {
  return {
    label: phase || "?",
    color: PHASE_COLOR[phase] || "#999",
  };
}

/** v0.5.0-beta.12（9/10 装验纠偏：模型/运行时=两个独立标签+颜色区分，
 *  参考 dashboard RuntimeBadge 配色）：qwenpaw 橙 / openclaw 蓝 / copaw 绿 /
 *  hermes 紫 / openhuman 青（对齐 dashboard runtime-meta badgeClass）。 */
const RUNTIME_TAG_COLOR: Record<string, string> = {
  qwenpaw: "orange",
  openclaw: "geekblue",
  copaw: "green",
  hermes: "purple",
  openhuman: "cyan",
};

/** 状态一致性：容器 running + CRD 状态非异常 = 一致（容器行可隐藏）。
 *  CRD state 为空（未同步）时仅看容器：running = 一致。 */
function isStateConsistent(state: string, containerState: string): boolean {
  const c = (containerState || "").toLowerCase();
  if (c !== "running") return false; // 容器非 running = 异常，必须显示
  const s = (state || "").toLowerCase();
  return s === "" || s === "running" || s === "ready" || s === "active";
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 树形连线：行首缩进 + 竖线 + 横线（经典树视觉）。 */
function TreeLine({ depth, isLast }: { depth: number; isLast: boolean }) {
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
        <antd.Tooltip title={node.session_id}>
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
        </antd.Tooltip>
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
      {(node.children || []).map((child) => (
        <SpawnRow key={child.session_id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

/** 管理信息面板：原管理页 Worker 表行全字段 + 生命周期操作（唤醒/休眠）。 */
function WorkerManageInfo({
  worker,
  onLifecycle,
  acting,
}: {
  worker: AdminData["workers"][number];
  onLifecycle?: (name: string, action: "wake" | "sleep") => void;
  acting: string | null;
}) {
  const tr = useT();
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
      {/* 两层状态分开命名（用户 8/17 定案）：Worker 状态 = CRD phase（Controller），容器状态 = docker 层；
          两行都显示（不隐藏——字段稳定可预期），不一致时容器值红色高亮 = crashloop 诊断信号 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
        <Item label={tr("Worker 状态")} value={<antd.Tag color={meta.color} style={{ margin: 0 }}>{meta.label}</antd.Tag>} />
        <Item label={tr("团队")} value={worker.team || "—"} />
        <Item label={tr("角色")} value={worker.role || "—"} />
        <Item label={tr("模型")} value={worker.model || "—"} wide />
        <Item
          label={tr("容器状态")}
          value={worker.containerState || "—"}
          warn={!!worker.containerState && !isStateConsistent(worker.state, worker.containerState)}
        />
      </div>
      {/* v0.4.98（M33 G2 读路径）：Worker 已装载 Skill / MCP——零新后端
          （Controller /workers 响应已含 skills/mcpServers，通用代理透传）。
          写路径（员工自助增删）等上游 G3 PR，此处只读展示。
          v0.5.0-beta.10（事故报告 G5）：MCP 行恒显——此列表只含用户自定义
          MCP（CRD spec.mcpServers）；内置 teamharness/workerflow 走镜像插件
          bootstrap，永不在此出现（9/2「MCP 全没配」误诊的误导源）。 */}
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
                    <antd.Tooltip
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
                    </antd.Tooltip>
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
      <div style={{ display: "flex", gap: 6 }}>
        {sleeping ? (
          <antd.Tooltip title={tr("唤醒 {name}", { name: worker.name })}>
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
          </antd.Tooltip>
        ) : (
          <antd.Tooltip title={tr("休眠 {name}（释放算力）", { name: worker.name })}>
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
          </antd.Tooltip>
        )}
      </div>
    </div>
  );
}

/** Worker 行：拓扑节点 + 状态摘要；展开 = 管理信息面板 + spawn 子任务树 + 检查点。 */
function WorkerRow({
  group,
  depth,
  onDm,
  adminWorker,
  onLifecycle,
  acting,
}: {
  group: WorkerSpawnGroup;
  depth: number;
  onDm?: (mxid: string, roomId?: string) => void;
  adminWorker?: AdminData["workers"][number];
  onLifecycle?: (name: string, action: "wake" | "sleep") => void;
  acting: string | null;
}) {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(false);
  const spawns = group.spawns || [];
  const hasRunning = spawns.some((s) => s.status === "running");
  /* v0.5.0-beta.12（A8b）：admin 数据未加载（L2/未配 token）时回退 tree 数据
     的 phase/runtime（后端 team-structure 已透传，零新请求）。 */
  const phase = adminWorker?.phase || group.phase || "";
  const rowRuntime = adminWorker?.runtime || group.runtime || "";
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "5px 0",
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
        {/* v0.5.0-beta.12（9/10 装验纠偏：不圈在一起——模型/运行时各一个
            标签，颜色区分，参考 dashboard RuntimeBadge）：模型=蓝、
            运行时=按运行时着色（RUNTIME_TAG_COLOR），版本=灰小字+悬停全量。
            A6/A8b 数据源不变：WorkerInfo.runtime/version，未加载回退 tree
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
        {adminWorker?.version ? (
          <span style={{ color: "#999", fontSize: 11, marginLeft: 2 }}>
            {adminWorker.version}
          </span>
        ) : null}
        <span style={{ color: "#888", fontSize: 12, marginLeft: 6 }}>
          {group.mxid}
        </span>
        {spawns.length ? (
          <antd.Badge
            count={spawns.length}
            size="small"
            style={{ backgroundColor: "#FF7F16", marginLeft: 8 }}
          />
        ) : null}
        {onDm && !group.is_self ? (
          <antd.Tooltip title={tr("私聊 {name}", { name: group.worker_name })}>
            <antd.Button
              type="text"
              size="small"
              shape="circle"
              style={{
                marginLeft: 8,
                color: "#888",
                borderColor: "transparent",
              }}
              icon={<MessageIcon />}
              onClick={(e: ReactNS.MouseEvent) => {
                e.stopPropagation();
                // v0.5.0-beta.12（A8a-fix，9/7 调研 v1.2 定案）：Worker 个人
                // 房间（CR roomID）直跳——Worker 容器无法接受 Matrix 邀请，
                // 新建 DM 房间 Worker 进不来=死路。无 room_id 才 fallback openDm。
                onDm(group.mxid || group.worker_name, group.room_id);
              }}
            />
          </antd.Tooltip>
        ) : null}
      </div>
      {expanded ? (
        <>
          {adminWorker ? (
            <WorkerManageInfo
              worker={adminWorker}
              onLifecycle={onLifecycle}
              acting={acting}
            />
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
            <CheckpointCard workerName={group.worker_name} />
          ) : null}
          {group.worker_name ? (
            <ApprovalControl workerName={group.worker_name} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Worker 执行检查点（PR #1186 checkpoint 端点；懒加载：展开时才请求）。 */
function CheckpointCard({ workerName }: { workerName: string }) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
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
    if (!open) return;
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
  }, [open, workerName]);

  const nodes = state.kind === "ok" ? state.graph.nodes.slice(0, 5) : [];
  return (
    <div style={{ marginLeft: 30, fontSize: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          color: "#888",
          padding: "2px 0",
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ fontSize: 11 }}>{open ? "▾" : "▸"}</span>
        <span>🔖 {tr("检查点")}</span>
        {state.kind === "ok" && state.graph.summary.total > 0 ? (
          <antd.Badge
            count={state.graph.summary.total}
            size="small"
            style={{ backgroundColor: "#8c8c8c" }}
          />
        ) : null}
      </div>
      {open ? (
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
                      <span style={{ color: "#FF7F16", marginLeft: 6 }}>●</span>
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

function TeamNode({
  team,
  onDm,
  adminByWorker,
  onLifecycle,
  acting,
}: {
  team: WorkerTreeTeam;
  onDm?: (mxid: string) => void;
  adminByWorker: Map<string, AdminData["workers"][number]>;
  onLifecycle?: (name: string, action: "wake" | "sleep") => void;
  acting: string | null;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const workerCount = team.workers.length;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 0",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ width: 14, fontSize: 11, color: "#888" }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 14, marginRight: 6 }}>🏛</span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{team.team_name}</span>
        <antd.Tag style={{ margin: "0 0 0 8px", fontSize: 11 }}>
          {workerCount} 人
        </antd.Tag>
        <antd.Tooltip title={team.room_id}>
          <span
            style={{
              color: "#999",
              fontSize: 11,
              marginLeft: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 260,
            }}
          >
            {team.room_id}
          </span>
        </antd.Tooltip>
      </div>
      {expanded
        ? team.workers.map((g) => (
            <WorkerRow
              key={g.mxid}
              group={g}
              depth={1}
              onDm={onDm}
              adminWorker={g.worker_name ? adminByWorker.get(g.worker_name) : undefined}
              onLifecycle={onLifecycle}
              acting={acting}
            />
          ))
        : null}
    </div>
  );
}

/** 长文本单元格：单行截断，点击展开完整内容到 Modal（8/17 用户反馈：
 *  tableLayout auto 窄屏撑破 → fixed 约束 + 点击展开弹窗）。 */
function ExpandableText({
  items,
  text,
  title,
}: {
  items?: string[];
  text?: string;
  title: string;
}) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const value = items ? items.join("、") : text || "";
  return (
    <>
      <antd.Tooltip title={tr("点击展开")}>
        <span
          onClick={() => setOpen(true)}
          style={{
            display: "block",
            width: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          {value || "—"}
        </span>
      </antd.Tooltip>
      <antd.Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={560}
        title={title}
      >
        {items ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {items.map((n) => (
              <antd.Tag key={n}>{n}</antd.Tag>
            ))}
          </div>
        ) : (
          <div style={{ wordBreak: "break-all", lineHeight: 1.8 }}>{text}</div>
        )}
      </antd.Modal>
    </>
  );
}

function TeamTable({ teams }: { teams: AdminData["teams"] }) {
  const tr = useT();
  return (
    <antd.Table
      rowKey="name"
      size="small"
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: 620 }}
      dataSource={teams}
      columns={[
        {
          title: tr("团队"),
          dataIndex: "name",
          width: 110,
          render: (v: string) => <b>{v}</b>,
        },
        {
          title: tr("状态"),
          dataIndex: "phase",
          width: 90,
          render: (v: string) => (
            <antd.Tag color={phaseMeta(v).color} style={{ margin: 0 }}>
              {phaseMeta(v).label}
            </antd.Tag>
          ),
        },
        { title: "Leader", dataIndex: "leaderName", width: 110 },
        {
          title: tr("Worker"),
          render: (_: unknown, r: AdminData["teams"][number]) =>
            `${r.readyWorkers}/${r.totalWorkers}`,
        
        },
        {
          title: tr("成员"),
          dataIndex: "workerNames",
          width: 240,
          render: (names: string[]) => (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(names || []).map((n) => (
                <antd.Tag key={n} style={{ margin: 0, fontSize: 11 }}>
                  {n}
                </antd.Tag>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

function HumanTable({ humans }: { humans: AdminData["humans"] }) {
  const tr = useT();
  return (
    <antd.Table
      rowKey="name"
      size="small"
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: 620 }}
      dataSource={humans}
      columns={[
        {
          title: tr("用户"),
          dataIndex: "name",
          width: 130,
          render: (v: string) => <b>{v}</b>,
        },
        { title: tr("显示名"), dataIndex: "displayName", width: 100 },
        {
          title: tr("状态"),
          dataIndex: "phase",
          width: 80,
          render: (v: string) => (
            <antd.Tag color={phaseMeta(v).color} style={{ margin: 0 }}>
              {phaseMeta(v).label}
            </antd.Tag>
          ),
        },
        {
          title: tr("权限"),
          dataIndex: "permissionLevel",
          width: 90,
          render: (v: number) => (v === 1 ? tr("L1 管理员") : v === 2 ? "L2" : String(v ?? "")),
        },
        {
          title: tr("可访问团队"),
          dataIndex: "accessibleTeams",
          width: 220,
          render: (teams: string[]) => (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(teams || []).map((t) => (
                <antd.Tag key={t} style={{ margin: 0, fontSize: 11 }}>
                  {t}
                </antd.Tag>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

/** A11（9/10）：Manager 模型选择——与 CrdManage 三入口同一候选并集
 *  （SGLang 在服 ∪ 在用 ∪ 网关 alias，../modelUnion）+ 同一写前校验。
 *  写路径 = PUT /managers/{name} {model}（Controller 合并语义，provider 不动）。
 *  面板 hasToken 门控（L1 only）——L2 结构上不可达（A12 插件侧零改动）。 */
/** A6（批次 0，9/10）：Manager 详情面板（表格展开行）——image/version/个人房间
    + 私聊直跳（roomID，A8a-fix 同款逻辑）+ L1 日志（docker-logs 既有代理，
    零新端点）。wake/sleep = dashboard/插件两端都没有（9/7 轮 3 实锤），不做。 */
function ManagerDetail({
  mgr,
  hasToken,
  onDm,
}: {
  mgr: ManagerInfo;
  hasToken?: boolean;
  onDm?: (mxid: string, roomId?: string) => void;
}) {
  const tr = useT();
  const [logs, setLogs] = React.useState<string[] | null>(null);
  const [logsErr, setLogsErr] = React.useState("");
  const [logsLoading, setLogsLoading] = React.useState(false);

  const loadLogs = React.useCallback(async () => {
    setLogsLoading(true);
    setLogsErr("");
    try {
      const data = (await requestJson(
        `/agentteams-proxy/docker-logs/${encodeURIComponent(mgr.name)}?tail=300`,
      )) as {
        lines?: { timestamp: string; level: string; message: string }[];
      };
      setLogs(
        (data.lines || []).map(
          (l) => `${l.timestamp || ""} ${l.level === "error" ? "❌ " : ""}${l.message}`,
        ),
      );
    } catch (e) {
      setLogs(null);
      setLogsErr(
        (e instanceof Error ? e.message : tr("日志拉取失败")) +
          `（容器名按 Manager 名解析，如不符请在运维页查实际容器名）`,
      );
    } finally {
      setLogsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mgr.name]);

  return (
    <div style={{ display: "grid", gap: 10, padding: "4px 8px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          fontSize: 12,
        }}
      >
        <span style={{ color: "#999" }}>{tr("镜像")}</span>
        <ExpandableText text={mgr.image || "—"} title={tr("镜像")} />
        <span style={{ color: "#999" }}>{tr("版本")}</span>
        <ExpandableText text={mgr.version || "—"} title={tr("版本")} />
        <span style={{ color: "#999" }}>MXID</span>
        <ExpandableText text={mgr.matrixUserID || "—"} title="MXID" />
        <span style={{ color: "#999" }}>{tr("个人房间")}</span>
        <ExpandableText text={mgr.roomID || "—"} title={tr("个人房间")} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {onDm && mgr.matrixUserID ? (
          <antd.Button
            size="small"
            onClick={() => onDm(mgr.matrixUserID, mgr.roomID || undefined)}
          >
            💬 {tr("私聊（个人房间）")}
          </antd.Button>
        ) : null}
        {hasToken ? (
          <antd.Button
            size="small"
            loading={logsLoading}
            onClick={() => void loadLogs()}
          >
            📜 {tr("日志（最近 300 行）")}
          </antd.Button>
        ) : null}
      </div>
      {logsErr ? (
        <div style={{ fontSize: 12, color: "#cf1322" }}>{logsErr}</div>
      ) : null}
      {logs ? (
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: "rgba(0,0,0,0.04)",
            borderRadius: 4,
            fontSize: 11,
            maxHeight: 260,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {logs.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

/** beta.12（9/10 装验：竖屏 Manager 表模型列太宽——894px 总宽下 240 模型列
 *  要滚到底才见）：≤700px 视口紧凑列宽（总宽 894→664，模型列 240→180）。 */
function useIsPortrait(): boolean {
  const q = "(max-width: 700px)";
  const [p, setP] = React.useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(q).matches : false,
  );
  React.useEffect(() => {
    const m = window.matchMedia(q);
    const fn = () => setP(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return p;
}

/** beta.12：导出供渲染审计（dev-overflow.html）与未来复用。 */
export function ManagerTable({
  managers,
  usedModels,
  onRefreshAdmin,
  l1TokenMode,
  onDm,
  hasToken,
}: {
  managers: AdminData["managers"];
  usedModels: string[];
  onRefreshAdmin?: (silent?: boolean) => void;
  l1TokenMode?: boolean;
  /** v0.5.0-beta.12（A6）：详情面板私聊按钮。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** v0.5.0-beta.12（A6）：L1 门控（日志按钮）。 */
  hasToken?: boolean;
}) {
  const tr = useT();
  const portrait = useIsPortrait();
  /** beta.12：竖屏紧凑列宽（模型列 240→180，总宽 894→664）。 */
  const W = portrait
    ? { mgr: 110, phase: 64, runtime: 72, model: 180, version: 110, tail: 128 }
    : { mgr: 150, phase: 88, runtime: 96, model: 240, version: 150, tail: 170 };
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);
  const union = useModelUnionOptions(usedModels, tr);

  const saveModel = React.useCallback(
    async (name: string, value: string) => {
      const verdict = validateModelValue(value, union.candidates);
      if (verdict.level === "error") {
        antd.message.error(modelVerdictText(tr, verdict, value, union.candidates));
        return;
      }
      setSaving(name);
      try {
        await updateManagerModel(name, value.trim());
        antd.message.success(
          verdict.level === "warn"
            ? tr("已保存（提示：{t}）", { t: modelVerdictText(tr, verdict, value, union.candidates) })
            : tr("Manager 模型已保存（重启容器后生效）"),
        );
        setDrafts((p) => {
          const n = { ...p };
          delete n[name];
          return n;
        });
        onRefreshAdmin?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      } finally {
        setSaving(null);
      }
    },
    [union.candidates, onRefreshAdmin, tr],
  );

  return (
    <div>
      {/* A13：token 模式无 Higress Console 会话 → 网关 alias 层不可见（显式提示）。 */}
      {l1TokenMode && union.gatewayLoaded && !union.gatewayAvailable ? (
        <div
          style={{
            fontSize: 12,
            color: "#ad6800",
            background: "#fffbe6",
            border: "1px solid #ffe58f",
            borderRadius: 4,
            padding: "4px 8px",
            marginBottom: 8,
          }}
        >
          ⚠️ {tr("token 模式无 Higress Console 会话——「Higress alias」分组当前不可见。配置 admin 账号密码后可读；或等待 P1-3 上游 PR（controller_token 直连 Higress Console）合入。")}
        </div>
      ) : null}
      <antd.Table
        rowKey="name"
        size="small"
        pagination={false}
        tableLayout="fixed"
        /* v0.5.0-beta.12（9/10 装验纠偏：模型列定宽 262 后「左边列被严重
           挤压」——fixed 布局下剩余空间只够喂一个浮动列，列间互相抢宽。
           定案=全列显式定宽 + 横向滚动兜底：谁也不挤压，窄屏出滚动条。
           beta.12：≤700px 紧凑列宽（竖屏少滚 230px，模型列提前可见）。 */
        scroll={{ x: W.mgr + W.phase + W.runtime + W.model + W.version + W.tail }}
        dataSource={managers}
        /* v0.5.0-beta.12（A6）：展开行 = Manager 详情面板（零新端点）。 */
        expandable={{
          expandedRowRender: (mgr: ManagerInfo) => (
            <ManagerDetail mgr={mgr} hasToken={hasToken} onDm={onDm} />
          ),
        }}
        columns={[
          {
            title: tr("Manager"),
            dataIndex: "name",
            width: W.mgr,
            render: (v: string) => <b>{v}</b>,
          },
          {
            title: tr("状态"),
            dataIndex: "phase",
            width: W.phase,
            render: (v: string) => (
              <antd.Tag color={phaseMeta(v).color} style={{ margin: 0 }}>
                {phaseMeta(v).label}
              </antd.Tag>
            ),
          },
          /* v0.5.0-beta.12（9/10 装验：运行时管理归团队管理）：每个 Manager
             直接显示自己的 runtime（ManagerResponse.runtime，零新端点）。 */
          {
            title: tr("运行时"),
            dataIndex: "runtime",
            width: W.runtime,
            render: (v: string) =>
              v ? (
                <antd.Tag
                  color={RUNTIME_TAG_COLOR[v] ?? "default"}
                  style={{ margin: 0, fontSize: 11 }}
                >
                  {v}
                </antd.Tag>
              ) : (
                "–"
              ),
          },
          /* v0.5.0-beta.12（9/10 装验两轮纠偏：beta.12 单列定宽 262 后
             左列反被挤压）：全列定宽方案下模型列=240（170 输入框+保存按钮）。 */
          {
            title: tr("模型"),
            dataIndex: "model",
            width: W.model,
            render: (v: string, mgr: { name: string }) => {
              const draft = drafts[mgr.name] ?? v ?? "";
              const dirty = draft !== (v || "");
              return (
                <antd.Space size={4} wrap={false}>
                  <antd.AutoComplete
                    size="small"
                    style={{ width: 170 }}
                    value={draft}
                    options={union.options}
                    allowClear
                    placeholder={tr("留空=跟随集群默认")}
                    onChange={(val: string) =>
                      setDrafts((p) => ({ ...p, [mgr.name]: val || "" }))
                    }
                  />
                  {dirty ? (
                    <antd.Button
                      size="small"
                      type="link"
                      style={{ padding: 0, height: "auto" }}
                      loading={saving === mgr.name}
                      onClick={() => void saveModel(mgr.name, draft)}
                    >
                      {tr("保存")}
                    </antd.Button>
                  ) : null}
                </antd.Space>
              );
            },
          },
          {
            title: tr("版本"),
            dataIndex: "version",
            width: W.version,
            render: (v: string) => (
              <ExpandableText text={v} title={tr("版本")} />
            ),
          },
          {
            title: "MXID",
            dataIndex: "matrixUserID",
            width: W.tail,
            render: (v: string) => <ExpandableText text={v} title="MXID" />,
          },
        ]}
      />
    </div>
  );
}

export interface WorkerManageProps {
  teams: WorkerTreeTeam[];
  admin: AdminData | null;
  treeLoading?: boolean;
  adminLoading?: boolean;
  /** 刷新拓扑树/管理数据。silent=true = 静默刷新（不闪 loading，用户 8/17 要求）。 */
  onRefreshTree?: (silent?: boolean) => void;
  onRefreshAdmin?: (silent?: boolean) => void;
  /** 点击 Worker 的"私聊"按钮 → 优先直跳 Worker 个人房间（roomId=CR roomID），
   *  无 roomId 才 fallback 新建 DM。v0.5.0-beta.12 A8a-fix。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** 是否已配置 Controller 管理员 token（决定管理信息面板/三表是否可用）。 */
  hasToken?: boolean;
  /** 当前 tab 是否激活（rc-tabs 保活：不激活时自动刷新跳过）。 */
  active?: boolean;
  /**
   * 团队结构数据来源（v0.4.97）："controller-workers"=正源；
   * "room-fallback"=Controller 未接入的房间聚合（群聊冒充团队——警示横幅）。
   */
  treeSource?: string;
  /** v0.4.98（M33 G5②）：当前 Matrix 登录账号 MXID → 「我的团队/权限」卡。 */
  myUserId?: string;
  /** A13：L1 走 controller_token（无 Console 会话 → 网关 alias 层不可见提示）。 */
  l1TokenMode?: boolean;
}

/**
 * 👷 Worker 管理（v0.4.58：合并原「Worker 树」+「管理」两 tab）。
 * 主视图 = 拓扑树（团队 → Worker → spawns）；Worker 行展开 = 管理信息面板
 * （状态/团队/角色/模型/容器 + 唤醒/休眠）+ spawn 子任务树 + 检查点；
 * 底部折叠区 = 团队/用户/Manager 三表（原管理页无损下沉）。
 */
export default function WorkerManage(props: WorkerManageProps) {
  const t = useThemeColors();
  const tr = useT();
  const {
    teams,
    admin,
    treeLoading,
    adminLoading,
    onRefreshTree,
    onRefreshAdmin,
    onDm,
    hasToken,
    active = true,
    treeSource = "",
    myUserId = "",
    l1TokenMode,
  } = props;
  const [acting, setActing] = React.useState<string | null>(null);

  // 自动刷新（30s）：拓扑 + 管理数据。rc-tabs 保活（切走不卸载），
  // 所以用 active 门控：仅当前 tab 激活时才轮询。
  const refreshRef = React.useRef({
    tree: onRefreshTree,
    admin: onRefreshAdmin,
    active,
  });
  refreshRef.current = { tree: onRefreshTree, admin: onRefreshAdmin, active };
  React.useEffect(() => {
    const id = window.setInterval(() => {
      if (!refreshRef.current.active) return;
      // 静默刷新（用户 8/17）：30s 自动刷不闪页——旧数据在屏，diff 无变化零重渲染
      void refreshRef.current.tree?.(true);
      void refreshRef.current.admin?.(true);
    }, 30000);
    return () => window.clearInterval(id);
  }, []);

  const handleLifecycle = React.useCallback(
    async (name: string, action: "wake" | "sleep") => {
      setActing(`${action}:${name}`);
      try {
        await postController(`/workers/${encodeURIComponent(name)}/${action}`);
        antd.message.success(
          action === "wake" ? tr("{name} 已唤醒", { name }) : tr("{name} 已休眠", { name }),
        );
        void onRefreshAdmin?.();
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      } finally {
        setActing(null);
      }
    },
    [onRefreshAdmin],
  );

  const adminByWorker = React.useMemo(() => {
    const m = new Map<string, AdminData["workers"][number]>();
    for (const w of admin?.workers ?? []) m.set(w.name, w);
    return m;
  }, [admin]);

  const refresh = onRefreshTree || onRefreshAdmin;
  const refreshLoading = Boolean(treeLoading) || Boolean(adminLoading);

  const items =
    hasToken && admin
      ? [
          {
            key: "teams",
            label: tr("团队（{n}）", { n: admin.teams.length }),
            children: <TeamTable teams={admin.teams} />,
          },
          {
            key: "humans",
            label: tr("用户（{n}）", { n: admin.humans.length }),
            children: <HumanTable humans={admin.humans} />,
          },
          {
            key: "managers",
            label: `Manager（${admin.managers.length}）`,
            children: (
              <ManagerTable
                managers={admin.managers}
                usedModels={[
                  ...admin.workers.map((w) => w.model || ""),
                  ...admin.managers.map((m) => m.model || ""),
                ]}
                onRefreshAdmin={onRefreshAdmin}
                l1TokenMode={l1TokenMode}
                onDm={onDm}
                hasToken={hasToken}
              />
            ),
          },
          // v0.5.0-beta.11：频道接入（调研 v0.3 定案——「👷 团队管理」下，
          // 不独立成 tab；Controller #1219 未合时整节 404 版本门占位）。
          {
            key: "channels",
            label: tr("频道"),
            children: <WorkerChannels workers={admin.workers} />,
          },
          // v0.5.0-beta.11 再版 2：技能中心从顶层 tab 收编（9/5 设计定案——团队级
          // 技能/MCP 资源治理归团队管理，不独立顶层 tab）。
          {
            key: "skills-center",
            label: tr("技能中心"),
            children: <SkillCenter />,
          },
        ]
      : [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>👷 {tr("团队管理")}</span>
        <antd.Tooltip
          title={tr(
            "拓扑树（团队 → Worker → spawn）；点 Worker 行展开管理信息（Worker 状态[CRD] / 容器状态[docker，不一致时标红] / 模型 / 唤醒休眠）与检查点；底部团队/用户/Manager 全量表；自动刷新不闪页（静默+diff）",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </antd.Tooltip>
        <span style={{ color: "#bbb", fontSize: 11 }}>{tr("自动刷新 30 秒")}</span>
        <div style={{ flex: 1 }} />
        {refresh ? (
          <antd.Tooltip title={tr("刷新")}>
            <antd.Button
              type="text"
              size="small"
              icon={<ReloadIcon />}
              loading={refreshLoading}
              onClick={() => {
                void onRefreshTree?.();
                void onRefreshAdmin?.();
              }}
            />
          </antd.Tooltip>
        ) : null}
      </div>
      {/* v0.4.98（M33 G5②/D4）：我的团队/我的权限——员工视角只读半边
          （管理员半边 = CrdManage 团队访问配置矩阵）。登录即显示。 */}
      <MyScopeCard
        myUserId={myUserId}
        hasToken={!!hasToken}
        humans={admin?.humans ?? []}
        teams={teams}
        treeSource={treeSource}
      />
      {treeSource === "room-fallback" ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr(
            "团队数据未接通——以下为房间聚合（群聊），不是真实团队结构",
          )}
          description={tr(
            "到配置页填 Controller 地址 + 管理员 token（L1），或用 Human permissionLevel=2 的账号 Matrix 登录（L2），即可看到真实团队结构。",
          )}
        />
      ) : null}
      <antd.Card
        size="small"
        loading={treeLoading}
        styles={{ body: { padding: "12px 16px" } }}
      >
        {teams.length ? (
          <div style={{ display: "grid", gap: 2 }}>
            {teams.map((team) => (
              <TeamNode
                key={team.room_id}
                team={team}
                onDm={onDm}
                adminByWorker={adminByWorker}
                onLifecycle={hasToken ? handleLifecycle : undefined}
                acting={acting}
              />
            ))}
          </div>
        ) : (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              hasToken
                ? tr("未获取到团队数据——检查 Controller 地址与 token")
                : tr("暂未发现团队房间——加入团队房间后这里显示你的团队结构")
            }
          />
        )}
      </antd.Card>
      {hasToken && !admin ? (
        <antd.Card size="small">
          <antd.Spin spinning={adminLoading}>
            <div style={{ color: "#999", fontSize: 12, padding: 12 }}>
              {tr("管理数据加载中——团队/用户/Manager 全量状态")}
            </div>
          </antd.Spin>
        </antd.Card>
      ) : null}
      {hasToken && admin ? (
        <CrdManage
          admin={admin}
          onRefresh={onRefreshAdmin}
          l1TokenMode={l1TokenMode}
        />
      ) : null}
      {items.length ? (
        <antd.Card size="small" styles={{ body: { padding: "4px 16px" } }}>
          <antd.Collapse
            size="small"
            items={items}
            ghost
          />
        </antd.Card>
      ) : null}
    </div>
  );
}
