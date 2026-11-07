/**
 * httpUrl.ts — 地址协议自动识别（纯函数，node 可测）。
 *
 * 用户输入后端地址时常常省略 `http://`（`192.168.54.107:6866`、`node1:8090`）。
 * 前端**不再**强行补 `http://`（服务端可能是 TLS 端口，明文请求被拒 400
 * "plain HTTP request was sent to HTTPS port"）——无协议时原样提交，由后端
 * 在保存/测试时识别（https 优先，失败回退 http；两者都不通按 https 保存）：
 * - 去首尾空白；空串原样返回（= 清空条目）；
 * - 已带 `http://` / `https://`（大小写不敏感）→ 保留协议，仅规范化（去尾斜杠）；
 * - 其它协议（`ws://`、`ftp://`、`javascript:` 等）→ 原样返回，交给校验层拒绝（不静默改写）；
 * - 无协议 → 原样保留 `host:port`（仅去末尾 `/`，避免 `/api` 拼接成 `//api`）。
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
  // `host:port` / `host/path` 原样透传——协议由后端 https 优先探测决定。
  if (/^(ws|wss|ftp|ftps|file|data|mailto|javascript|blob):/i.test(s)) return s;
  return s.replace(/\/+$/, "");
}
