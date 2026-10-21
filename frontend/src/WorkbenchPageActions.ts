// WorkbenchPage 拆分模块——聊天发送/管理操作。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import {
  fetchRoomPowerInfo,
  fetchTeamsSync,
  renameRoom,
  openDm,
  redactRoomMessage,
  leaveRoom,
  sendRoomMessage,
  sendApprovalCommand,
  sendRoomMessageEdit,
  sendRoomFile,
  sendReaction,
  setRoomMuted,
  uploadMedia,
  setCachedRooms,
  type RoomMessage,
  type TeamRoom,
  type WorkbenchConfig,
} from "./api";
import { buildFileRefsContent, type FileRef } from "./lib/file-refs";
import { useT } from "./i18n";
import { detectMentions } from "./WorkbenchPageShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;

export interface WorkbenchPageActionsCtx {
  activeRoom: TeamRoom | null;
  config: WorkbenchConfig | null;
  mutedRooms: string[];
  setMessages: React.Dispatch<React.SetStateAction<RoomMessage[]>>;
  setSending: (v: boolean) => void;
  refreshMessages: (room: TeamRoom, silent?: boolean) => Promise<void>;
  setActiveRoom: React.Dispatch<React.SetStateAction<TeamRoom | null>>;
  refreshRooms: (silent?: boolean, force?: boolean) => Promise<void>;
  setRooms: React.Dispatch<React.SetStateAction<TeamRoom[]>>;
  setMutedRooms: React.Dispatch<React.SetStateAction<string[]>>;
  setTabState: React.Dispatch<React.SetStateAction<string>>;
  writeUiState: (tab: string, roomId: string | null) => void;
  tr: ReturnType<typeof useT>;
}

export function useWorkbenchChatActions(ctx: WorkbenchPageActionsCtx) {
  const { activeRoom, config, mutedRooms, setMessages, setSending, refreshMessages, setActiveRoom, refreshRooms, setRooms, setMutedRooms, setTabState, writeUiState, tr } = ctx;

  const handleSend = React.useCallback(
    async (
      text: string,
      replyTo?: { event_id: string; sender: string; body: string },
      threadRoot?: string,
      fileRefs?: FileRef[],
    ) => {
      if (!activeRoom) return;
      // 乐观回显：先本地插入 pending 消息，成功后 refresh 拉正式事件替换；
      // 失败标记 failed（红叹号徽标）保留在列表里可识别。
      const pendingId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const pendingMsg: RoomMessage = {
        event_id: pendingId,
        sender: config?.matrix?.user_id || "",
        body: text,
        msgtype: "m.text",
        origin_server_ts: Date.now(),
        pending: true,
        ...(fileRefs && fileRefs.length > 0 ? { file_refs: fileRefs } : {}),
        ...(replyTo?.event_id
          ? { reply: replyTo }
          : threadRoot
            ? { reply: { event_id: threadRoot, sender: "", body: "" } }
            : {}),
      };
      setMessages((prev) => [...prev, pendingMsg]);
      setSending(true);
      try {
 // @mention 三件套（body 短名不变；formatted_body=matrix.to
        // 链接；m.mentions 三元组负责通知——Element 同款，api.ts 内构造）。
        const detected = detectMentions(text, activeRoom.members);
        const mentionList = detected.map((mxid) => ({
          mxid,
          localpart: (mxid.split(":")[0] || mxid).replace(/^@/, ""),
        }));
        await sendRoomMessage(
          activeRoom.room_id,
          text,
          replyTo,
          threadRoot,
          mentionList,
          // #87 文件引用并入 content（envelope 键，服务端透传；无引用=空对象）。
          buildFileRefsContent(fileRefs),
        );
        await refreshMessages(activeRoom);
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.event_id === pendingId ? { ...m, pending: false, failed: true } : m,
          ),
        );
        message.error(e instanceof Error ? e.message : tr("发送失败"));
      } finally {
        setSending(false);
      }
    },
    [activeRoom, config?.matrix?.user_id, refreshMessages],
  );

  // 审批命令带 @Worker（裸文本群内不被 Worker 消费）。
  const handleSendApproval = React.useCallback(
    async (
      targetMxid: string,
      cmd: string,
      replyTo?: { event_id: string; sender: string; body: string },
    ) => {
      if (!activeRoom || !targetMxid) return;
      try {
        await sendApprovalCommand(
          activeRoom.room_id,
          targetMxid,
          cmd,
          replyTo,
        );
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("发送失败"));
        throw e;
      }
    },
    [activeRoom, refreshMessages],
  );

  // 表情反应：发 m.reaction 后刷新消息（聚合计数更新）。
  const handleReact = React.useCallback(
    async (eventId: string, emoji: string) => {
      if (!activeRoom) return;
      try {
        await sendReaction(activeRoom.room_id, eventId, emoji);
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("反应发送失败"));
      }
    },
    [activeRoom, refreshMessages],
  );

  // 文件发送：上传 → mxc → 发 m.file/m.image（反向交付通道）。
  const handleSendFiles = React.useCallback(
    async (files: File[]) => {
      if (!activeRoom || files.length === 0) return;
      setSending(true);
      try {
        for (const f of files) {
          const mxc = await uploadMedia(f);
          const msgtype = f.type.startsWith("image/") ? "m.image" : "m.file";
          await sendRoomFile(activeRoom.room_id, {
            mxcUri: mxc,
            filename: f.name || "file",
            msgtype,
            mimetype: f.type,
            size: f.size,
          });
        }
        message.success(tr("已发送 {n} 个文件", { n: files.length }));
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("文件发送失败"));
      } finally {
        setSending(false);
      }
    },
    [activeRoom, refreshMessages],
  );

  // ── Element 对齐四件（编辑/撤回/退出/静音）──────────
  /** 编辑自己的消息（m.replace 标注替换，Element 同款）。 */
  const handleSendEdit = React.useCallback(
    async (originalEventId: string, body: string) => {
      if (!activeRoom) return;
      try {
        await sendRoomMessageEdit(activeRoom.room_id, originalEventId, body);
        await refreshMessages(activeRoom, true);
      } catch (e) {
        throw e; // RoomChat 编辑态保留草稿
      }
    },
    [activeRoom, refreshMessages],
  );

  /** 撤回自己的消息（redaction；他人事件 403 透传 toast）。 */
  const handleRedact = React.useCallback(
    async (eventId: string) => {
      if (!activeRoom) return;
      try {
        await redactRoomMessage(activeRoom.room_id, eventId);
        message.success(tr("已撤回"));
        await refreshMessages(activeRoom, true);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("撤回失败"));
      }
    },
    [activeRoom, refreshMessages],
  );

  /** 退出房间（leave；scope 房间会被 Controller 调和器重新邀请）。 */
  const handleLeaveRoom = React.useCallback(async () => {
    if (!activeRoom) return;
    const roomName = activeRoom.name;
    try {
      await leaveRoom(activeRoom.room_id);
      message.success(tr("已退出「{name}」", { name: roomName }));
      setActiveRoom(null);
      void refreshRooms(true, true); // force：房间立即从列表消失
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("退出房间失败"));
    }
  }, [activeRoom, refreshRooms]);

  /** 房间重命名（m.room.name state 事件）。
 * 团队房间权限表普遍为 null（平台侧已知问题）→ 403 时展示
 * fetchRoomPowerInfo 诊断 + 修复指引，而非裸错误。 */
  const handleRenameRoom = React.useCallback(
    async (name: string) => {
      if (!activeRoom) return;
      const nm = name.trim();
      if (!nm) {
        message.warning(tr("房间名不能为空"));
        return;
      }
      try {
        await renameRoom(activeRoom.room_id, nm);
        const rid = activeRoom.room_id;
        setRooms((prev) =>
          prev.map((r) => (r.room_id === rid ? { ...r, name: nm } : r)),
        );
        setActiveRoom((prev) =>
          prev && prev.room_id === rid ? { ...prev, name: nm } : prev,
        );
        message.success(tr("已重命名为「{n}」", { n: nm }));
        void refreshRooms(true, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/403|FORBIDDEN|power/i.test(msg)) {
          void (async () => {
            let detail = "";
            try {
              const info = await fetchRoomPowerInfo(
                activeRoom.room_id,
                config?.matrix?.user_id || "",
              );
              detail = info.content
                ? tr(
                    "你的权限 {a}/{b}（需 ≥ {b}）——找房间管理员（Manager）在房间内提权后重试。",
                    { a: String(info.myLevel), b: String(info.nameRequired) },
                  )
                : tr(
                    "该房间没有有效的权限设置（平台侧已知问题）。请管理员修复房间的权限设置后重试。",
                  );
            } catch {
              /* 诊断失败用默认文案 */
            }
            antd.Modal.error({
              title: tr("改名失败：权限不足"),
              content: detail || msg,
            });
          })();
          return;
        }
        message.error(msg || tr("改名失败"));
      }
    },
    [activeRoom, config, refreshRooms, tr],
  );

  /** 房间静音切换（m.muted_room account data；通知引擎 sync_watcher
 * 同数据源消费——静音房间不再触发 @/任务状态通知）。 */
  const handleToggleMute = React.useCallback(async () => {
    if (!activeRoom) return;
    const userId = config?.matrix?.user_id;
    if (!userId) return;
    const nowMuted = !mutedRooms.includes(activeRoom.room_id);
    try {
      await setRoomMuted(activeRoom.room_id, userId, nowMuted);
      setMutedRooms((prev) =>
        nowMuted
          ? [...prev, activeRoom.room_id]
          : prev.filter((r) => r !== activeRoom.room_id),
      );
      message.success(
        nowMuted ? tr("已静音该房间（@/任务通知不再推送）") : tr("已取消静音"),
      );
      // force 重同步（自审：60s 服务端缓存会让下一轮背景刷新用旧值
      // 覆盖乐观更新的静音状态——force 立即拿到新 account_data）。
      void refreshRooms(true, true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("静音设置失败"));
    }
  }, [activeRoom, config, mutedRooms]);

  // Phase 2: DM entry — click a member → create-or-reuse DM → open room.
  const handleDm = React.useCallback(
    async (mxid: string, roomId?: string) => {
      // Worker 个人房间（CR roomID）
      // 直跳——Worker 容器无法接受 Matrix 邀请，新建 DM 房间 Worker 进不来
      // （房间建了、消息发不出去）= 死路。room_id 存在且房间在列表 → 直跳；
      // 房间不在列表（已退房/数据未同步）→ fallthrough 走 openDm 兜底。
      if (roomId) {
        try {
          const p0 = await fetchTeamsSync(true);
          setRooms(p0.rooms);
          setCachedRooms(p0);
          const direct = p0.rooms.find((r) => r.room_id === roomId);
          if (direct) {
            setTabState("chat");
            writeUiState("chat", roomId);
            setActiveRoom(direct);
            void refreshMessages(direct);
            message.success(tr("已打开 {target} 的个人房间", { target: mxid }));
            return;
          }
        } catch (e) {
          message.warning(
            tr("个人房间打开失败（{e}），回退新建 DM", {
              e: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
      try {
        const dm = await openDm(mxid);
        // 先验证房间真的出现在房间列表，再报成功——
        // 修「Worker 管理点私聊说已创建、实际没有」的假成功（房间未落地/
        // homeserver 错位时静默吞掉）。
        const payload = await fetchTeamsSync(true);
        setRooms(payload.rooms);
        setCachedRooms(payload);
        let room = payload.rooms.find((r) => r.room_id === dm.room_id);
        if (!room) {
          // New DM may not appear in joined_rooms instantly; retry once.
          await new Promise((res) => setTimeout(res, 1500));
          const p2 = await fetchTeamsSync(true);
          setRooms(p2.rooms);
          setCachedRooms(p2);
          room = p2.rooms.find((r) => r.room_id === dm.room_id);
        }
        if (room) {
          const members = room.member_count ?? 0;
          message.success(
            dm.created && members <= 1
              ? tr("已创建私聊，等待对方接受邀请")
              : dm.created
                ? tr("已创建与 {target} 的私聊", { target: dm.target })
                : tr("打开已有私聊"),
          );
          // 开 DM 必切聊天 tab——从团队管理/首页发起时此前房间
          // 在后台打开、屏幕停在原地，用户视角「说已创建实际没有」（与
          // openRoom「开房间必落聊天 tab」同模式，跳转修复的私聊版）。
          setTabState("chat");
          writeUiState("chat", dm.room_id);
          setActiveRoom(room);
          void refreshMessages(room);
        } else {
          message.error(
            tr("房间创建返回成功但未出现在房间列表（homeserver 配置可能错位），请检查配置后重试"),
          );
        }
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("打开私聊失败"));
      }
    },
    [refreshMessages],
  );
  return {
    handleSend,
    handleSendApproval,
    handleReact,
    handleSendFiles,
    handleSendEdit,
    handleRedact,
    handleLeaveRoom,
    handleRenameRoom,
    handleToggleMute,
    handleDm,
  };
}
