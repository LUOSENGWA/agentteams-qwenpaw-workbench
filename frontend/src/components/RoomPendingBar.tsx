/**
 * RoomPendingBar.tsx — 房间内「项目阻塞」处理条。
 *
 * 背景（10/30 反馈）：项目 interrupt（paused/blocked）只在工作流页可见，用户在
 * 房间看到「需要人工介入」却无处下手；到工作流页又只看到「阻塞 · 任务 02」，
 * 不知道要处理什么。本组件把**当前房间的** interrupt 待办直接投影到聊天顶部：
 * 显示任务标题 + 原因，就地填写处理意见（发 【干预答复】… 到房间，Leader 据此
 * 恢复/重规划），并给「查看工作流」直达。
 *
 * 数据来源 = pending store（三源合并后的 interrupt 项，带 roomId/projectTitle/
 * taskTitle）。提交后本地 resolve（不等 worker 回报），条目不残留。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { usePendingStore } from "../pending/store";
import type { PendingItem } from "../pending/types";
import { WarnIcon } from "./icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

function Row({
  item,
  onSend,
  canSend,
  onOpenProject,
}: {
  item: PendingItem;
  onSend: (text: string) => Promise<void> | void;
  canSend: boolean;
  onOpenProject?: (runId: string) => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const pending = usePendingStore();
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      // 只读房间（canSend=false）不能提交——明确报错，不落假状态。
      if (!canSend) throw new Error("send unavailable");
      await onSend(`【干预答复】${body}`);
      pending.resolve(item.id, { status: "sent", answer: body.slice(0, 200) });
      setText("");
      antd.message.success(tr("已提交，等待 Leader 处理"));
    } catch {
      antd.message.error(tr("发送失败，请重试（或到工作流页处理）"));
    } finally {
      setBusy(false);
    }
  };

  const title = item.taskTitle || item.taskId || tr("任务");
  return (
    <div
      style={{
        display: "grid",
        gap: 6,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid #fa8c16",
        background: t.mode === "dark" ? "rgba(250,140,22,0.14)" : "rgba(250,140,22,0.06)",
        // 文字走主题色（不像工作流横幅整块橙色，避免按钮继承橙字）
        color: t.text,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", fontSize: 12, fontWeight: 600 }}>
        <span style={{ color: t.mode === "dark" ? "#faad14" : "#d46b08", display: "inline-flex", alignItems: "center", gap: 4 }}>
          <WarnIcon size={12} />
          {item.raw === "paused" ? tr("项目已暂停") : tr("阻塞")}
        </span>
        <span>· {title}</span>
        {item.projectTitle ? (
          <span style={{ fontWeight: 400, opacity: 0.7, fontSize: 11 }}>{item.projectTitle}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>
        {item.question && item.question !== item.raw
          ? `${tr("原因：")}${item.question}`
          : tr("未提供原因——填写你的处理意见，发到本房间由 Leader 跟进。")}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <antd.Input
          size="small"
          value={text}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
          onPressEnter={() => void submit()}
          placeholder={tr("填写处理意见（发到本房间）…")}
          style={{ flex: "1 1 200px", minWidth: 160 }}
        />
        <antd.Button size="small" type="primary" loading={busy} disabled={!canSend} onClick={() => void submit()} style={{ color: "#fff" }}>
          {tr("提交")}
        </antd.Button>
        {onOpenProject && item.projectId ? (
          <antd.Button size="small" onClick={() => onOpenProject(item.projectId!)}>
            {tr("查看工作流")}
          </antd.Button>
        ) : null}
      </div>
    </div>
  );
}

/** 当前房间的项目 interrupt 条（无待办时返回 null，不占位）。 */
export function RoomPendingBar({
  roomId,
  onSend,
  canSend = true,
  onOpenProject,
}: {
  roomId?: string;
  onSend: (text: string) => Promise<void> | void;
  /** 房间只读（canSend=false）时禁用提交，避免落假「已提交」。 */
  canSend?: boolean;
  onOpenProject?: (runId: string) => void;
}) {
  const tr = useT();
  const pending = usePendingStore();
  const items = React.useMemo(
    () =>
      (pending.items || []).filter(
        (it) => it.kind === "interrupt" && !!it.roomId && it.roomId === roomId,
      ),
    [pending.items, roomId],
  );
  if (!roomId || items.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6, padding: "6px 4px 2px" }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>
        {tr("本项目有 {n} 项等待人工介入", { n: items.length })}
      </div>
      {items.map((it) => (
        <Row key={it.id} item={it} onSend={onSend} canSend={canSend} onOpenProject={onOpenProject} />
      ))}
    </div>
  );
}

export default RoomPendingBar;
