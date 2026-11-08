/**
 * SpawnMessages.tsx — 子会话消息（旧拓扑 components/WorkerManageTree.tsx 的
 * SpawnMessages / SpawnMessageItem 迁入；新页面唯一挂载点）。
 *
 * 懒加载：由父级「消息」按钮控制挂载（点开才渲染 → 组件 effect 才拨号），
 * 不随 spawn 树批量拉取。四态：
 * - 404（会话不存在 / 不属于该项目 / 老控制器无路由）= 空态，不报错；
 * - 403（跨团队无权）= 行内「无权限查看」；
 * - 其余失败 = 「加载失败 · 重试」；
 * - 200 = 消息列表 + has_more「仅显示最近 N 条」。
 * 单条消息：role/name/时间 + pre-wrap 正文，超 6 行折叠（展开/收起 ≥44px）。
 */
import type * as ReactNS from "react";

import {
  getSpawnMessages,
  type SpawnMessage,
  type SpawnMessagesResponse,
} from "../api/domains/teams";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  classifySpawnMsgError,
  foldMessageContent,
  fmtRfc3339,
} from "../components/WorkerManageShared";
import { spawnHasMoreCount } from "./spawnModel";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export type SpawnMsgState =
  | { kind: "loading" }
  | { kind: "ok"; data: SpawnMessagesResponse }
  | { kind: "empty" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

/** 单条 spawn 消息：role/name + created_at + 正文（6 行折叠）。 */
export function SpawnMessageItem({ m }: { m: SpawnMessage }) {
  const tr = useT();
  const t = useThemeColors();
  const [expanded, setExpanded] = React.useState(false);
  const { text, folded } = foldMessageContent(m.content);
  return (
    <div style={{ borderLeft: `2px solid ${t.border}`, paddingLeft: 8, minWidth: 0 }}>
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
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
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
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: 44,
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            color: "var(--app-accent, #FF7F16)",
            fontSize: 12,
          }}
        >
          {expanded ? tr("收起") : tr("展开")}
        </button>
      ) : null}
    </div>
  );
}

/** 子会话消息列表（挂载即请求；重试 = 重新挂载 effect）。 */
export function SpawnSessionMessages({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [tick, setTick] = React.useState(0);
  const [state, setState] = React.useState<SpawnMsgState>({ kind: "loading" });

  React.useEffect(() => {
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
  }, [projectId, sessionId, tick]);

  if (state.kind === "loading") {
    return <span style={{ color: t.textSecondary, fontSize: 12 }}>{tr("加载中…")}</span>;
  }
  if (state.kind === "empty") {
    return <span style={{ color: t.textSecondary, fontSize: 12 }}>{tr("暂无消息")}</span>;
  }
  if (state.kind === "forbidden") {
    return (
      <span
        style={{
          color: t.mode === "dark" ? "#ff7875" : "#cf1322",
          fontSize: 12,
        }}
      >
        {tr("无权限查看")}
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <antd.Button
          size="small"
          danger
          style={{ minHeight: 44 }}
          onClick={() => setTick((v) => v + 1)}
        >
          {tr("加载失败")} · {tr("重试")}
        </antd.Button>
        <span style={{ color: t.textSecondary, fontSize: 11 }}>{state.message}</span>
      </div>
    );
  }

  const moreN = spawnHasMoreCount(
    state.data.has_more,
    state.data.messages.length,
  );
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
      {state.data.messages.length === 0 ? (
        <span style={{ color: t.textSecondary, fontSize: 12 }}>{tr("暂无消息")}</span>
      ) : (
        state.data.messages.map((m, i) => (
          <SpawnMessageItem key={m.seq ?? `idx-${i}`} m={m} />
        ))
      )}
      {moreN > 0 ? (
        <span style={{ color: t.textSecondary, fontSize: 11 }}>
          {tr("仅显示最近 {n} 条", { n: moreN })}
        </span>
      ) : null}
    </div>
  );
}
