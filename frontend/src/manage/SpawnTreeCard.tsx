/**
 * SpawnTreeCard.tsx — 「管理」页 Worker 详情 · 子会话卡（旧拓扑
 * components/WorkerManageTree.tsx 的 SpawnRow 递归树迁入）。
 *
 * 数据 = fetchWorkerSpawns()（api/domains/teams，60s 缓存 tags ["spawns"]），
 * 取 byWorker[workerName]；手动刷新 force=true 直回源（无自动轮询）。
 * 老控制器无 /spawns 路由（所有项目 404）→ 整卡隐藏（诚实降级）；网络/其它
 * 失败 → 卡内「加载失败 · 重试」，不外溢到详情其它面板。
 *
 * 展示：按 SpawnNode.children 递归（缩进 + caret 折叠），节点 = 状态灯 +
 * status 标签 + name/session_id + last_activity + created_at；allowedTools /
 * skills 仅上游有值时显示（QwenPaw 2.1+）。点节点「消息」→ 挂载
 * SpawnSessionMessages 懒加载（404 空态 / 403 无权限 / 失败重试 / has_more）。
 */
import type * as ReactNS from "react";

import {
  fetchWorkerSpawns,
  type SpawnNode,
} from "../api/domains/teams";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  ReloadIcon,
  SPAWN_STATUS_COLOR,
  SPAWN_STATUS_LABEL,
  fmtRfc3339,
  fmtTime,
} from "../components/WorkerManageShared";
import { MessageIcon, TeamIcon } from "../components/icons";
import {
  countSpawnNodes,
  flattenSpawnTree,
  spawnRowName,
} from "./spawnModel";
import { SpawnSessionMessages } from "./SpawnMessages";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export type SpawnTreeState =
  | { kind: "loading" }
  | { kind: "ok"; spawns: SpawnNode[] }
  | { kind: "error"; message: string }
  /** 老控制器无 /spawns 路由 → 调用方整卡隐藏。 */
  | { kind: "absent" };

/** 拉取 Worker 的子会话树（永不 reject；错误即状态）。 */
export async function loadWorkerSpawnsFor(
  workerName: string,
  force = false,
): Promise<SpawnTreeState> {
  try {
    const r = await fetchWorkerSpawns(force);
    if (r.endpointMissing) return { kind: "absent" };
    if (!r.apiOk) return { kind: "error", message: "" };
    return { kind: "ok", spawns: r.byWorker[workerName] || [] };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

function Hint({ children }: { children: ReactNS.ReactNode }) {
  const t = useThemeColors();
  return (
    <div style={{ fontSize: 11.5, color: t.textSecondary, padding: "2px 2px 4px" }}>
      {children}
    </div>
  );
}

/** 展开后的卡体（纯展示：给定状态渲染树，不拨号——重试由父级回调）。 */
export function SpawnTreeBody({
  state,
  onRetry,
}: {
  state: SpawnTreeState;
  onRetry?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(
    () => new Set<string>(),
  );
  const [msgs, setMsgs] = React.useState<Set<string>>(() => new Set<string>());

  if (state.kind === "loading") return <Hint>{tr("加载中…")}</Hint>;
  if (state.kind === "absent") return null;
  if (state.kind === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <antd.Button
          size="small"
          danger
          style={{ minHeight: 44 }}
          onClick={onRetry}
        >
          {tr("加载失败")} · {tr("重试")}
        </antd.Button>
        {state.message ? (
          <span style={{ color: t.textSecondary, fontSize: 11 }}>{state.message}</span>
        ) : null}
      </div>
    );
  }
  if (state.spawns.length === 0) return <Hint>{tr("暂无子会话")}</Hint>;

  const rows = flattenSpawnTree(state.spawns, collapsed);
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleMsgs = (id: string) =>
    setMsgs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      {rows.map(({ node, depth, hasChildren }) => {
        const status = node.status;
        const openMsgs = msgs.has(node.session_id);
        return (
          <div key={node.session_id} style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minHeight: 44,
                paddingLeft: depth * 18,
                minWidth: 0,
              }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-expanded={!collapsed.has(node.session_id)}
                  aria-label={tr("展开/收起子会话")}
                  onClick={() => toggleCollapsed(node.session_id)}
                  style={{
                    width: 28,
                    minHeight: 44,
                    border: "none",
                    background: "transparent",
                    color: t.textSecondary,
                    cursor: "pointer",
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  {collapsed.has(node.session_id) ? "▸" : "▾"}
                </button>
              ) : (
                <span style={{ width: 28, flexShrink: 0 }} />
              )}
              <span
                title={tr("子会话状态")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: SPAWN_STATUS_COLOR[status],
                  flexShrink: 0,
                }}
              />
              <span
                title={node.session_id}
                style={{
                  fontSize: 12.5,
                  color: status === "done" ? t.textSecondary : t.text,
                  textDecoration: status === "done" ? "line-through" : "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 260,
                }}
              >
                {spawnRowName(node)}
              </span>
              <antd.Tag
                style={{ margin: 0, fontSize: 10.5, flexShrink: 0 }}
                color={SPAWN_STATUS_COLOR[status]}
              >
                {tr(SPAWN_STATUS_LABEL[status])}
              </antd.Tag>
              {node.last_activity ? (
                <span
                  style={{
                    fontSize: 11,
                    color: t.textSecondary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 150,
                  }}
                >
                  {fmtRfc3339(node.last_activity)}
                </span>
              ) : null}
              {node.created_at ? (
                <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                  {fmtTime(node.created_at)}
                </span>
              ) : null}
              <div style={{ flex: 1 }} />
              {/* 消息端点按项目寻址：仅 /spawns 正源节点带 project_id。 */}
              {node.project_id ? (
                <button
                  type="button"
                  aria-expanded={openMsgs}
                  onClick={() => toggleMsgs(node.session_id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    minHeight: 44,
                    border: "none",
                    background: "transparent",
                    color: t.textSecondary,
                    cursor: "pointer",
                    fontSize: 11.5,
                    flexShrink: 0,
                  }}
                >
                  <MessageIcon size={12} /> {tr("消息")}
                </button>
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
                  paddingLeft: depth * 18 + 62,
                  paddingBottom: 3,
                  minWidth: 0,
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
                        style={{ margin: 0, fontSize: 10.5, lineHeight: "18px" }}
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
                        style={{ margin: 0, fontSize: 10.5, lineHeight: "18px" }}
                      >
                        {skill}
                      </antd.Tag>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
            {openMsgs && node.project_id ? (
              <div style={{ paddingLeft: depth * 18 + 62, paddingBottom: 8 }}>
                <SpawnSessionMessages
                  projectId={node.project_id}
                  sessionId={node.session_id}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function SpawnTreeCard({ workerName }: { workerName: string }) {
  const t = useThemeColors();
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const [state, setState] = React.useState<SpawnTreeState>({ kind: "loading" });
  const forceNext = React.useRef(false);

  React.useEffect(() => {
    let alive = true;
    const force = forceNext.current;
    forceNext.current = false;
    setState((prev) => (prev.kind === "ok" ? prev : { kind: "loading" }));
    void loadWorkerSpawnsFor(workerName, force).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [workerName, tick]);

  // 老控制器无 /spawns 路由 → 整卡不显（诚实降级，不留空壳）。
  if (state.kind === "absent") return null;

  const count = state.kind === "ok" ? countSpawnNodes(state.spawns) : null;
  const subtitle =
    state.kind === "loading"
      ? tr("加载中…")
      : state.kind === "error"
        ? tr("加载失败")
        : count
          ? tr("{n} 个子会话", { n: count })
          : tr("暂无子会话");

  const reload = (force: boolean) => {
    forceNext.current = force;
    setTick((v) => v + 1);
  };

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={tr("子会话")}
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            padding: "8px 12px",
            textAlign: "left",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            background: open ? t.hoverBg : t.cardBg,
            color: "inherit",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <TeamIcon size={15} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 1 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
              {tr("子会话")}
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
              {subtitle}
            </span>
          </span>
          <span style={{ color: t.textSecondary, fontSize: 15, flexShrink: 0 }}>
            {open ? "▾" : "›"}
          </span>
        </button>
        <button
          type="button"
          title={tr("刷新")}
          aria-label={tr("刷新")}
          onClick={() => reload(true)}
          style={{
            width: 44,
            minHeight: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            background: t.cardBg,
            color: t.textSecondary,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <ReloadIcon />
        </button>
      </div>
      {open ? (
        <SpawnTreeBody state={state} onRetry={() => reload(false)} />
      ) : null}
    </div>
  );
}
