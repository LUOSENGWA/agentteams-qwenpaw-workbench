// v0.5.0-beta.13.1（9/19 定案：插件模仿 dashboard 成员列表）：
// 房间标题栏右侧的成员头像条。
//   · Worker 头像右下角带会话状态灯（同消息头像的 WorkerSessionDot corner 变体）；
//   · 成员多时收起为 +N——点击展开全部，再点收起（窄屏由标题栏 flexWrap
//     自然落到标题栏下面，两条位置都成立）；
//   · 点头像 = 打开成员面板（既有 Drawer，全量成员 + @ 提及 + 详情）。
// 数据零新增请求：room.members（既有 /sync）+ workerSessionByMxid（既有派生）。

import type * as ReactNS from "react";

import type { TeamMember, TeamRoom } from "../api";
import { MxcAvatar } from "../MxcAvatar";
import WorkerSessionDot from "./WorkerSessionDot";
import type { WorkerSessionState } from "../workerSessionState";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 收起时最多可见的头像数（其余收进 +N）。 */
export const STRIP_MAX = 6;

/** Worker 优先排序（状态灯=可观测对象在前），组内保持房间原顺序。 */
export function orderStripMembers<T extends { mxid: string }>(
  items: T[],
  isWorker: (mxid: string) => boolean,
): T[] {
  return [
    ...items.filter((i) => isWorker(i.mxid)),
    ...items.filter((i) => !isWorker(i.mxid)),
  ];
}

/** 显示名：display_name 优先，否则 MXID localpart（同 RoomChat.senderShortName）。 */
function displayNameOf(mxid: string, room: TeamRoom | null): string {
  const member: TeamMember | undefined = room?.members?.[mxid];
  if (member?.display_name && member.display_name.trim()) {
    return member.display_name;
  }
  return (mxid.split(":")[0] || mxid).replace(/^@/, "") || mxid;
}

export default function MemberStrip({
  room,
  workerSessionByMxid,
  onOpenPanel,
}: {
  room: TeamRoom | null;
  workerSessionByMxid?: Record<string, WorkerSessionState>;
  onOpenPanel?: () => void;
}) {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(false);
  const entries = Object.entries(room?.members || {}).map(([mxid, member]) => ({
    mxid,
    member,
  }));
  if (entries.length <= 2) return null; // 1:1 房间无成员条意义（成员数徽章仍在）
  const isWorker = (mxid: string) => workerSessionByMxid?.[mxid] !== undefined;
  const ordered = orderStripMembers(entries, isWorker);
  const visible = expanded ? ordered : ordered.slice(0, STRIP_MAX);
  const hiddenCount = ordered.length - visible.length;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexWrap: "wrap",
      }}
    >
      {visible.map(({ mxid, member }) => {
        const name = displayNameOf(mxid, room);
        const state = workerSessionByMxid?.[mxid];
        return (
          <antd.Tooltip key={mxid} title={name}>
            <span
              onClick={() => onOpenPanel?.()}
              style={{
                position: "relative",
                display: "inline-flex",
                cursor: onOpenPanel ? "pointer" : "default",
              }}
            >
              <MxcAvatar
                url={member?.avatar_url}
                size={24}
                style={{ backgroundColor: "#ff7f16", fontSize: 11, flexShrink: 0 }}
              >
                {name.slice(0, 1).toUpperCase()}
              </MxcAvatar>
              {state ? <WorkerSessionDot state={state} size={7} corner /> : null}
            </span>
          </antd.Tooltip>
        );
      })}
      {hiddenCount > 0 ? (
        <antd.Button
          size="small"
          type="text"
          style={{ padding: "0 6px", fontSize: 12 }}
          onClick={() => setExpanded(true)}
          title={tr("展开全部成员")}
        >
          +{hiddenCount}
        </antd.Button>
      ) : null}
      {expanded && ordered.length > STRIP_MAX ? (
        <antd.Button
          size="small"
          type="text"
          style={{ padding: "0 6px", fontSize: 12 }}
          onClick={() => setExpanded(false)}
        >
          {tr("收起")}
        </antd.Button>
      ) : null}
    </span>
  );
}
