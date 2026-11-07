/**
 * httpUrl.ts — 地址协议自动识别（纯函数，node 可测）。
 *
 * 用户输入后端地址时常常省略 `http://`（`192.168.54.107:6866`、`node1:8090`）。
 * 统一在**保存前**归一：
 * - 去首尾空白；空串原样返回（= 清空条目）；
 * - 已带 `http://` / `https://`（大小写不敏感）→ 保留协议，仅规范化（去尾斜杠）；
 * - 其它协议（`ws://`、`ftp://`、`javascript:` 等）→ 原样返回，交给校验层拒绝（不静默改写）；
 * - 无协议 → 前缀 `http://`；
 * - 末尾 `/` 去掉（避免 `/api` 拼接成 `//api`），根路径 `http://h/` → `http://h`。
 */
export function normalizeHttpUrl(raw: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return "";
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(s);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return s;
    const rest = s.slice(m[0].length).replace(/\/+$/, "");
    return rest ? `${scheme}://${rest}` : `${scheme}://`;
  }
  // 无 `://`：只有已知的**非 http 协议**才原样返回（交给校验层拒绝）；
  // `host:port` / `host/path` 一律按缺省 http 处理。
  if (/^(ws|wss|ftp|ftps|file|data|mailto|javascript|blob):/i.test(s)) return s;
  return `http://${s.replace(/\/+$/, "")}`;
}
