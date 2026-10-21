import type * as ReactNS from "react";

import type { SpawnNode, WorkerSpawnGroup } from "../api";

const host = window.QwenPaw.host;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;

export const ReloadIcon = pick("ReloadOutlined");
export const WakeIcon = pick("CaretRightOutlined");
export const SleepIcon = pick("PauseOutlined");
export const MessageIcon = pick("MessageOutlined");

export const PRIMARY = "var(--app-accent, #FF7F16)";

// 存 key 不用 tr：模块级常量不能调 hook；组件内 useT 后 tr(ROLE_BADGE[role])。
export const ROLE_BADGE: Record<WorkerSpawnGroup["role"], string> = {
  leader: "领",
  worker: "工",
  critic: "审",
  unknown: "?",
};
export const ROLE_COLOR: Record<WorkerSpawnGroup["role"], string> = {
  leader: "#FF7F16",
  worker: "#1677ff",
  critic: "#fa8c16",
  unknown: "#999",
};
export const SPAWN_STATUS_COLOR: Record<SpawnNode["status"], string> = {
  idle: "#999",
  running: "#52c41a",
  done: "#bbb",
};
export const SPAWN_STATUS_LABEL: Record<SpawnNode["status"], string> = {
  idle: "待命",
  running: "进行中",
  done: "已完成",
};
const PHASE_COLOR: Record<string, string> = {
  Active: "#52c41a",
  Running: "#52c41a",
  Ready: "#52c41a",
  Pending: "#fa8c16",
  Starting: "#1677ff",
  Failed: "#ff4d4f",
  Error: "#ff4d4f",
  Stopped: "#999",
  Sleeping: "#999",
};

export function phaseMeta(phase: string): { label: string; color: string } {
  return {
    label: phase || "?",
    color: PHASE_COLOR[phase] || "#999",
  };
}

/** （模型/运行时=两个独立标签+颜色区分，
 * 参考 dashboard RuntimeBadge 配色）：qwenpaw 橙 / openclaw 蓝 / copaw 绿 /
 * hermes 紫 / openhuman 青（对齐 dashboard runtime-meta badgeClass）。
 * 补 deepseek-harness 洋红（上游新运行时，新建 Worker
 * 可选后 Worker 行/Manager 表标签需着色；copaw 退役但存量 CR 可能仍显示，
 * 颜色保留兼容）。 */
export const RUNTIME_TAG_COLOR: Record<string, string> = {
  qwenpaw: "orange",
  openclaw: "geekblue",
  copaw: "green",
  hermes: "purple",
  openhuman: "cyan",
  "deepseek-harness": "magenta",
};

/** 运行时显示名（运行时版本标签用；CRD runtime 值 → 产品名）。
 * copaw=legacy 兼容名，实际跑 QwenPaw 引擎，标注「（legacy）」。 */
export const RUNTIME_LABELS: Record<string, string> = {
  qwenpaw: "QwenPaw",
  copaw: "QwenPaw（legacy）",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  openhuman: "OpenHuman",
  "deepseek-harness": "DeepSeek Harness",
};

/** 状态一致性：容器 running + CRD 状态非异常 = 一致（容器行可隐藏）。
 * CRD state 为空（未同步）时仅看容器：running = 一致。 */
export function isStateConsistent(state: string, containerState: string): boolean {
  const c = (containerState || "").toLowerCase();
  if (c !== "running") return false; // 容器非 running = 异常，必须显示
  const s = (state || "").toLowerCase();
  return s === "" || s === "running" || s === "ready" || s === "active";
}

export function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ：RFC3339（UTC/Z）→ 本地时区
 * MM-DD HH:mm:ss；解析失败原样返回（不吞字段）。 */
export function fmtRfc3339(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 树形连线：行首缩进 + 竖线 + 横线（经典树视觉）。 */
