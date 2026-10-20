/* 宿主环境契约（两轴模型，2026-10-16 独立模式报告 §0.5/§7-①）：
 *
 * 轴 A —— 宿主形态（host.env.kind，声明式）：「插件后端（Python 54 端点）在不在」
 *   server  = 服务端宿主（QwenPaw 装了本插件）——后端在宿主进程内
 *   local   = 端侧独立宿主（本地插件宿主 shell，无 QwenPaw 服务端）
 *   desktop = 桌面宿主（保留位；数据面语义同 server）
 * 轴 B —— 能力位（host.env.caps，探测式）：「端侧提供什么」
 *   net         端侧网络桥 qpwNet（true 时数据面可经桥直连）
 *   secureStore 端侧安全凭据存储 qpwSecure
 *   notify      通知桥（Notification 桩 → 系统通知中心）
 *
 * 命名纪律：「独立/local」只用于宿主形态，「离线/offline」只用于连通性——
 * 旧 isOffline 单布尔已废弃（独立宿主下数据面可以可达；服务端宿主下也可以
 * 不可达，单布尔必误判）。
 *
 * 兼容：旧 shell 无 env 字段时按 isOffline 布尔回退（15.12 行为）；
 * console 宿主两者皆无 → server（在线路径零改动）。
 */

type HostKind = "server" | "local" | "desktop";

interface QwenPawHostLike {
  kind?: unknown;
  isOffline?: unknown;
  caps?: unknown;
}

function hostObj(): QwenPawHostLike | null {
  const host = (window as unknown as { QwenPaw?: { host?: unknown } }).QwenPaw
    ?.host;
  return host && typeof host === "object"
    ? (host as QwenPawHostLike)
    : null;
}

/** 轴 A 宿主形态。优先 host.env.kind（契约 v1）；旧 shell 回退 isOffline。 */
export function hostKind(): HostKind {
  const host = hostObj();
  if (!host) return "server";
  if (host.kind === "local" || host.kind === "server" || host.kind === "desktop") {
    return host.kind;
  }
  return host.isOffline === true ? "local" : "server";
}

/** 轴 A === local：端侧独立宿主（含旧 shell isOffline 回退）。 */
export function isLocalHost(): boolean {
  return hostKind() === "local";
}
