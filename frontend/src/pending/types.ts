// P0 人工介入闭环 — 待处理（pending）数据契约（任务书 §2）。
// 纯类型，零依赖（node 可直测）。

export type PendingSource = "attention" | "interrupt" | "room_message";
export type PendingKind = "intervention" | "approval" | "interrupt" | "mention";

export interface PendingOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface PendingItem {
  /** 去重键：attention/interrupt = `${taskId}:${kind}:${attempt}`；
   * room = `${roomId}:${eventId}`。 */
  id: string;
  source: PendingSource;
  kind: PendingKind;
  roomId?: string;
  eventId?: string;
  projectId?: string;
  taskId?: string;
  question?: string;
  /** 项目标题（interrupt/attention 的所属项目名，卡片标题用）。 */
  projectTitle?: string;
  /** 任务标题（interrupt 对应的任务 summary，说明"处理哪个任务"）。 */
  taskTitle?: string;
  options?: PendingOption[];
  multiSelect?: boolean;
  expiresAt?: number;
  sender?: string;
  createdAt: number;
  raw?: string;
}

export interface PendingResolution {
  id: string;
  status: "answered" | "expired";
  actor?: string;
  answer?: string;
  at: number;
}
