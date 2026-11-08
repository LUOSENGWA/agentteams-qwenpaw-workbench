// dmTarget.ts — 管理页私聊入口的纯判定（Worker / Manager 共用）。
// 有 MXID 才可私聊（房间可选：有 personal room 就直跳，无则后端建/找 DM）。

export interface DmTarget {
  mxid: string;
  /** 个人房间（Controller roomID）；缺省 = onDm 只传 mxid。 */
  roomId?: string;
}

/** 账号记录 → 私聊目标；无 MXID（旧数据/异常投影）→ null（入口隐藏）。 */
export function dmTargetFor(
  account:
    | { matrixUserID?: string; roomID?: string }
    | null
    | undefined,
): DmTarget | null {
  const mxid = (account?.matrixUserID || "").trim();
  if (!mxid) return null;
  const roomId = (account?.roomID || "").trim();
  return roomId ? { mxid, roomId } : { mxid };
}
