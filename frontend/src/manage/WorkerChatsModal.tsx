// WorkerChatsModal.tsx — Worker 详情「会话」弹窗容器（只做壳，不复制聊天逻辑）。
//
// 内容 = 聊天页同一个 WorkerChats（workers=[worker] + fixedWorker +
// showKindTabs，智能体会话 / 子代理会话双 tab 仍由它提供）；本组件只负责
// 弹窗承载与响应式分叉：
// - 宽屏：antd.Modal，宽 min(100vw-32px, 900px)，body 定高
//   min(76vh, 720px) + overflow hidden（内容高度固定，弹窗不随会话列表
//   跳动），滚动交内层容器 / ChatDetail 自身的消息区。
// - 窄屏：NarrowSheet（与 ResourceCards narrow 模式同容器，flushTop），
//   内层定高避免列表/详情切换时高度抖动。
//
// 关闭即卸载：调用方传 open=false 时本组件不渲染 WorkerChats（内部列表/
// 详情状态与刷新一并销毁，无后台轮询）。
import type * as ReactNS from "react";

import type { WorkerInfo } from "../api";
import { useT } from "../i18n";
import { useWbViewport } from "../WbViewportContext";
import NarrowSheet from "../components/NarrowSheet";
import WorkerChats from "../components/WorkerChats";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export default function WorkerChatsModal({
  worker,
  open,
  onClose,
}: {
  worker: WorkerInfo;
  open: boolean;
  onClose: () => void;
}) {
  const tr = useT();
  const { narrow } = useWbViewport();

  // open=false → 内容整体卸载（key 随 worker：切 Worker 复位列表/详情态）。
  const content = open ? (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <WorkerChats
          key={`modal-chats-${worker.name}`}
          workers={[worker]}
          fixedWorker={worker.name}
          showKindTabs
        />
      </div>
    </div>
  ) : null;

  if (narrow) {
    return (
      <NarrowSheet
        open={open}
        title={`${tr("会话")} · ${worker.name}`}
        onClose={onClose}
        flushTop
      >
        {/* 定高（< NarrowSheet body 66dvh 上限）→ 双 tab / 详情切换高度稳定。 */}
        <div style={{ height: "min(62dvh, 540px)", minHeight: 260, minWidth: 0 }}>
          {content}
        </div>
      </NarrowSheet>
    );
  }

  return (
    <antd.Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={`${tr("会话")} · ${worker.name}`}
      width="min(calc(100vw - 32px), 900px)"
      centered
      styles={{
        body: {
          // 定高 + 不整块滚：滚动在内层容器（列表）与 ChatDetail 消息区。
          height: "min(76vh, 720px)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
          padding: "12px 16px",
        },
      }}
    >
      {content}
    </antd.Modal>
  );
}
