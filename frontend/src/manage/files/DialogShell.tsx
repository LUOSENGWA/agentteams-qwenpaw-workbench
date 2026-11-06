/**
 * DialogShell.tsx — 文件管理模块统一弹窗外壳（F-V3-3）。
 *
 * 回收站弹窗与同步设置弹窗共用同一套 Modal 配置（任务书：禁止两份 Modal
 * 配置）：width 920 + maxWidth 92vw、destroyOnClose、keyboard、
 * maskClosable，标题区支持副标题（subtitle，次级小字）。
 * 关闭走 onClose（Esc / 遮罩 / 右上 X / footer 按钮都汇到这里）；是否
 * 刷新数据由调用方决定（关闭默认不刷新——数据由容器统一 reload 管理）。
 */
import type * as ReactNS from "react";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface DialogShellProps {
  open: boolean;
  /** 主标题（传已 tr() 的字符串）。 */
  title: string;
  /** 副标题（可选；标题下 12px 次级色小字）。 */
  subtitle?: string;
  /** 内容区（默认 maxHeight 68vh 内滚动）。 */
  children?: ReactNS.ReactNode;
  width?: number;
  footer?: ReactNS.ReactNode;
  onClose: () => void;
  keyboard?: boolean;
  maskClosable?: boolean;
  destroyOnClose?: boolean;
}

export default function DialogShell({
  open,
  title,
  subtitle,
  children,
  width = 920,
  footer,
  onClose,
  keyboard = true,
  maskClosable = true,
  destroyOnClose = true,
}: DialogShellProps) {
  return (
    <antd.Modal
      open={open}
      title={
        <div style={{ display: "grid", gap: 2 }}>
          <span>{title}</span>
          {subtitle ? (
            <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.65 }}>{subtitle}</span>
          ) : null}
        </div>
      }
      width={width}
      style={{ maxWidth: "92vw" }}
      styles={{ body: { maxHeight: "68vh", overflowY: "auto" } }}
      onCancel={onClose}
      destroyOnClose={destroyOnClose}
      keyboard={keyboard}
      maskClosable={maskClosable}
      footer={footer}
    >
      {children}
    </antd.Modal>
  );
}
