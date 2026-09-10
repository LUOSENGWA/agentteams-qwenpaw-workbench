import type * as ReactNS from "react";

import {
  fetchEventContext,
  searchMessages,
  type EventContextPage,
  type RoomMessage,
  type SearchResultItem,
  type TeamRoom,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

const PRIMARY = "#FF7F16";

/** sender MXID → 短名（@alice:example.org → alice）。 */
export function senderShort(sender: string): string {
  return (sender.split(":")[0] || sender).replace(/^@/, "");
}

/** 时间格式：今天 HH:MM，更早 MM-DD HH:MM。 */
function formatWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

/** 0.4.99 B6：Levenshtein 编辑距离（短串，>2 提前退出）。 */
function levDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length;
  const n = b.length;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 0.4.99 B6：房间名模糊匹配打分（微信式）——
 *  100 子串命中（位置越靠前分越高）/ 50 有序子序列（"lead"→team-lead）/
 *  30 短名（≤12 字符）编辑距离 ≤2（容错 "devbt"→devbot）。
 *  不做拼音匹配：需内置 4000 字拼音表（数百 KB）价值低，房间名通常整段/片段输入。 */
function fuzzyRoomScore(name: string, q: string): number {
  const n = name.toLowerCase();
  const pos = n.indexOf(q);
  if (pos !== -1) return 100 - Math.min(pos, 50);
  let qi = 0;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 50;
  if (n.length <= 12 && q.length <= 12 && q.length >= 3) {
    if (levDistance(n, q) <= 2) return 30;
  }
  return 0;
}

/** 关键词高亮：term 在 text 中出现处包 <mark>（大小写不敏感）。 */
function highlightParts(
  text: string,
  term: string,
): ReactNS.ReactNode[] {
  const t = term.trim();
  if (!t) return [text];
  const lower = text.toLowerCase();
  const lt = t.toLowerCase();
  const parts: ReactNS.ReactNode[] = [];
  let idx = 0;
  let pos = lower.indexOf(lt, idx);
  let key = 0;
  while (pos !== -1) {
    if (pos > idx) parts.push(text.slice(idx, pos));
    parts.push(
      <mark
        key={key++}
        style={{
          background: "rgba(255,127,22,0.22)",
          color: "inherit",
          borderRadius: 3,
          padding: "0 1px",
        }}
      >
        {text.slice(pos, pos + t.length)}
      </mark>,
    );
    idx = pos + t.length;
    pos = lower.indexOf(lt, idx);
  }
  if (idx < text.length) parts.push(text.slice(idx));
  return parts;
}

/** 上下文预览块：目标消息高亮，前后各数条浅显展示。 */
function ContextPreview(props: {
  ctx: EventContextPage;
  highlightId: string;
  term: string;
  onJump?: (eventId: string) => void;
}) {
  const { ctx, highlightId, term, onJump } = props;
  const t = useThemeColors();
  const tr = useT();
  const rows: RoomMessage[] = [
    ...ctx.events_before,
    ...(ctx.event ? [ctx.event] : []),
    ...ctx.events_after,
  ];
  const msgRow = (m: RoomMessage) => {
    const isTarget = m.event_id === highlightId;
    return (
      <div
        key={m.event_id}
        style={{
          padding: "6px 10px",
          borderRadius: 8,
          marginBottom: 4,
          fontSize: 12.5,
          background: isTarget
            ? "rgba(255,127,22,0.10)"
            : t.bubbleOther,
          border: isTarget ? `1px solid ${PRIMARY}` : "1px solid transparent",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
        }}
      >
        <div
          style={{
            color: t.textSecondary,
            fontSize: 11.5,
            marginBottom: 2,
            display: "flex",
            gap: 6,
          }}
        >
          <span style={{ fontWeight: 600, color: t.text }}>
            {senderShort(m.sender)}
          </span>
          <span>{formatWhen(m.origin_server_ts)}</span>
          {isTarget ? (
            <span style={{ color: PRIMARY, fontWeight: 700 }}>●</span>
          ) : null}
        </div>
        <div style={{ color: t.text }}>
          {highlightParts(m.body.slice(0, 600), isTarget ? term : "")}
        </div>
      </div>
    );
  };
  return (
    <div
      style={{
        borderTop: `1px solid ${t.border}`,
        paddingTop: 8,
        marginTop: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, color: t.textSecondary, fontWeight: 600 }}>
          {tr("上下文预览")}
        </span>
        {onJump ? (
          <antd.Button
            size="small"
            style={{ fontSize: 12 }}
            onClick={() => onJump(highlightId)}
          >
            📍 {tr("定位到聊天")}
          </antd.Button>
        ) : null}
      </div>
      {rows.map(msgRow)}
    </div>
  );
}

export interface MessageSearchProps {
  open: boolean;
  onClose: () => void;
  /** 房间内搜索：固定房间；跨房间模式不传。 */
  roomId?: string;
  /** 跨房间：点击结果 → 打开该房间并定位（父组件切房 + jump）。 */
  onOpenRoom?: (roomId: string, eventId: string) => void;
  /** 房间内：点击结果 → 定位已加载消息。 */
  onJump?: (eventId: string) => void;
  /** 再版 13（微信式）：群名搜索——房间列表 + 点击直达房间。 */
  rooms?: TeamRoom[];
  onOpenRoomOnly?: (roomId: string) => void;
}

/** 消息搜索面板（B1，§6.6 + 再版 13 群名搜索）：Drawer，房间内/跨房间。 */
export default function MessageSearch(props: MessageSearchProps) {
  const {
    open,
    onClose,
    roomId,
    onOpenRoom,
    onJump,
    rooms,
    onOpenRoomOnly,
  } = props;
  const t = useThemeColors();
  const tr = useT();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResultItem[]>([]);
  const [count, setCount] = React.useState(0);
  const [nextBatch, setNextBatch] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState("");
  const [searched, setSearched] = React.useState(false);
  // 展开上下文预览的结果项 event_id。
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [ctx, setCtx] = React.useState<EventContextPage | null>(null);
  const [ctxLoading, setCtxLoading] = React.useState(false);
  const debounceRef = React.useRef<number | null>(null);
  // 当前已提交的搜索词（分页继续用）。
  const termRef = React.useRef("");

  // 再版 13（微信式）：群名匹配——查询非空时，房间名包含关键词的置顶展示，
  // 点击直达房间（不定位消息）。仅跨房间模式生效。
  const roomMatches = React.useMemo(() => {
    if (roomId || !rooms || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    // 0.4.99 B6：模糊匹配（子串 > 子序列 > 短名编辑距离≤2），按分排序。
    return rooms
      .map((r) => [r, fuzzyRoomScore(r.name || "", q)] as const)
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1] || (b[0].last_ts || 0) - (a[0].last_ts || 0))
      .slice(0, 10)
      .map(([r]) => r);
  }, [rooms, query, roomId]);

  // 关闭时重置（下次打开干净状态）。
  React.useEffect(() => {
    if (!open) {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      setQuery("");
      setResults([]);
      setCount(0);
      setNextBatch("");
      setError("");
      setSearched(false);
      setExpandedId(null);
      setCtx(null);
      setLoading(false);
      setLoadingMore(false);
      termRef.current = "";
    }
  }, [open]);

  const runSearch = React.useCallback(
    async (term: string, pageBatch?: string, append = false) => {
      if (!term.trim()) return;
      termRef.current = term.trim();
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const page = await searchMessages(term, {
          roomId,
          nextBatch: pageBatch,
          limit: 15,
        });
        setCount(page.count);
        setNextBatch(page.next_batch);
        setResults((prev) =>
          append ? [...prev, ...page.results] : page.results,
        );
        setSearched(true);
        if (!append) setExpandedId(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [roomId],
  );

  const onSearch = (value: string) => {
    setQuery(value);
    void runSearch(value);
  };

  const onInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void runSearch(value);
    }, 250);
  };

  const toggleContext = async (item: SearchResultItem) => {
    if (expandedId === item.event_id) {
      setExpandedId(null);
      setCtx(null);
      return;
    }
    setExpandedId(item.event_id);
    setCtx(null);
    setCtxLoading(true);
    try {
      const page = await fetchEventContext(item.room_id, item.event_id, 4);
      setCtx(page);
    } catch (e) {
      setCtx(null);
    } finally {
      setCtxLoading(false);
    }
  };

  const clickResult = (item: SearchResultItem) => {
    if (onOpenRoom) {
      // 跨房间：打开房间 + 定位 + 关面板。
      onOpenRoom(item.room_id, item.event_id);
      onClose();
      return;
    }
    // 房间内：定位 + 展开上下文预览。
    if (onJump) onJump(item.event_id);
    void toggleContext(item);
  };

  return (
    <antd.Drawer
      open={open}
      onClose={onClose}
      width={Math.min(430, Math.max(320, window.innerWidth * 0.55))}
      title={
        <span style={{ fontSize: 15, fontWeight: 700 }}>
          🔍 {tr("搜索消息")}
          {roomId ? (
            <span style={{ fontSize: 12, color: t.textSecondary, fontWeight: 400 }}>
              {" "}
              · {tr("当前房间")}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: t.textSecondary, fontWeight: 400 }}>
              {" "}
              · {tr("全部房间")}
            </span>
          )}
        </span>
      }
      styles={{ body: { padding: "10px 14px", background: t.bg } }}
    >
      <antd.Input.Search
        autoFocus
        value={query}
        placeholder={
          roomId
            ? tr("输入关键词搜索当前房间历史消息")
            : tr("搜索消息和群聊")
        }
        onSearch={onSearch}
        onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
          onInput(e.target.value)
        }
        allowClear
        style={{ marginBottom: 10 }}
      />
      {error ? (
        <div style={{ color: "#ff4d4f", fontSize: 13, marginBottom: 8 }}>
          ⚠️ {tr("搜索失败")}：{error}
        </div>
      ) : null}
      {roomMatches.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 12,
              color: t.textSecondary,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            {tr("群 / 会话")}
            <span style={{ fontWeight: 400, marginLeft: 6 }}>
              {tr("点击直达")}
            </span>
          </div>
          {roomMatches.map((r) => (
            <div
              key={r.room_id}
              onClick={() => {
                onOpenRoomOnly?.(r.room_id);
                onClose();
              }}
              title={tr("打开该房间")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 10px",
                borderRadius: 8,
                background: t.cardBg,
                border: `1px solid ${t.border}`,
                marginBottom: 6,
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 15 }}>
                {r.unread ? "💬" : "👥"}
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: t.text,
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {highlightParts(r.name || r.room_id, query.trim())}
              </span>
              {r.unread ? (
                <antd.Badge
                  count={r.unread}
                  size="small"
                  style={{ background: PRIMARY }}
                />
              ) : null}
            </div>
          ))}
          <div
            style={{
              borderTop: `1px solid ${t.border}`,
              paddingTop: 10,
              marginBottom: 8,
            }}
          />
        </div>
      ) : null}
      {searched && !loading && count === 0 && !error ? (
        <div style={{ color: t.textSecondary, fontSize: 13, padding: "18px 0" }}>
          {tr("无搜索结果")}
        </div>
      ) : null}
      {searched && !loading && count > 0 ? (
        <div
          style={{
            color: t.textSecondary,
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {tr("匹配 {count} 条", { count })}
        </div>
      ) : null}
      {loading ? (
        <div style={{ color: t.textSecondary, fontSize: 13, padding: "18px 0" }}>
          {tr("加载中…")}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>
        {results.map((item, idx) => (
          <div
            key={item.event_id}
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 10,
              padding: "8px 10px",
              background: t.cardBg,
              animation: `wbResultIn 0.28s ease-out both`,
              animationDelay: `${Math.min(idx, 12) * 35}ms`,
            }}
          >
            <div
              style={{ cursor: "pointer" }}
              onClick={() => clickResult(item)}
              title={
                onOpenRoom
                  ? tr("打开房间并定位")
                  : tr("定位消息并查看上下文")
              }
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 3,
                }}
              >
                {!roomId ? (
                  <span
                    style={{
                      color: PRIMARY,
                      fontWeight: 600,
                      fontSize: 12,
                      maxWidth: "70%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.room_name}
                  </span>
                ) : null}
                <span style={{ fontWeight: 600, fontSize: 12.5, color: t.text }}>
                  {senderShort(item.sender)}
                </span>
                <span style={{ color: t.textSecondary, fontSize: 11.5 }}>
                  {formatWhen(item.origin_server_ts)}
                </span>
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: t.text,
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {highlightParts(item.body, termRef.current)}
              </div>
            </div>
            {expandedId === item.event_id ? (
              ctxLoading ? (
                <div
                  style={{
                    color: t.textSecondary,
                    fontSize: 12,
                    padding: "8px 0 2px",
                  }}
                >
                  {tr("加载中…")}
                </div>
              ) : ctx ? (
                <ContextPreview
                  ctx={ctx}
                  highlightId={item.event_id}
                  term={termRef.current}
                  onJump={onJump}
                />
              ) : (
                <div
                  style={{
                    color: t.textSecondary,
                    fontSize: 12,
                    padding: "8px 0 2px",
                  }}
                >
                  {tr("上下文不可用")}
                </div>
              )
            ) : null}
          </div>
        ))}
      </div>
      {nextBatch ? (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <antd.Button
            size="small"
            loading={loadingMore}
            onClick={() => void runSearch(termRef.current, nextBatch, true)}
          >
            {tr("加载更多")}
          </antd.Button>
        </div>
      ) : null}
    </antd.Drawer>
  );
}
