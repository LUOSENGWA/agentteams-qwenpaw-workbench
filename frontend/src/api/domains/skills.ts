/**
 * skills.ts — 技能包下载域（GET /api/v1/skills/{name}/download）。
 *
 * 端点（controller skills_handler.go DownloadSkill，已合 main）：
 *   - 直接流式 zip（Content-Type: application/zip +
 *     Content-Disposition: attachment; filename="<name>.zip"）——
 *     不是 JSON/URL 中转，鉴权必须走 host.fetch / Bearer token
 *     （裸 <a href> 无 token，一律禁止）。
 *   - 作用域与目录一致：?team=T → teams/T/skills/<name>/（L2 本团队 /
 *     L1 指定团队）；无 team → agents/global/skills/<name>/（admin 全局
 *     层）。builtin 技能不在存储里 → 404（能力降级，不是故障）。
 *   - 404 = 技能在该作用域无包 / 老控制器无路由 / W8 越权隐藏（同目录
 *     语义）；405 = 路由存在但方法不符（形态防御）——两者一律「隐藏该
 *     操作」，不弹错。
 *
 * 鉴权/错误形态与 workspaceFiles.fetchWorkspaceFileBlob 同范式
 * （host.fetch 优先，无 token 不拨号语义由代理层承担；失败抛
 * `HTTP {status}{detail}`，调用方用 httpErrorStatus 分流）。
 */
import { httpErrorStatus } from "../shared";

export interface SkillDownload {
  blob: Blob;
  /** 落盘文件名（Content-Disposition 优先，缺省 <name>.zip）。 */
  filename: string;
}

/** 落盘文件名消毒：只取最后一段路径 + 去控制字符
 * （恶意 Content-Disposition 穿越防御——文件名不可含目录）。 */
function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/**
 * 从 Content-Disposition 头解析落盘文件名（RFC 6266 / 5987）：
 * `filename*`（扩展形，percent-encoded）优先于 `filename`（普通形）；
 * 两者皆无/解析为空 → 回退 fallback（调用方传 `<name>.zip`）。
 * 纯函数（无 window 依赖）——单测直打。
 */
export function parseSkillDownloadFilename(
  header: string | null | undefined,
  fallback: string,
): string {
  if (header) {
    // filename*=charset'lang'value（UTF-8''… 最常见；charset 宽容匹配）。
    const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
    if (star) {
      try {
        const decoded = decodeURIComponent(star[1].trim());
        const s = sanitizeFilename(decoded);
        if (s) return s;
      } catch {
        // 非法 percent 序列 → 落到 filename 普通形。
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
    if (plain) {
      const s = sanitizeFilename(plain[1].trim());
      if (s) return s;
    }
  }
  return sanitizeFilename(fallback);
}

/**
 * 404/405 = 「当前作用域无此下载」（builtin 技能无存储包 / 老控制器无
 * 路由 / 越权隐藏 / 方法不符）→ 调用方隐藏该操作（能力降级，不报错）。
 * 其余错误（403/5xx/网络）原样上抛由 UI 提示重试。
 */
export function isSkillDownloadUnavailable(e: unknown): boolean {
  const s = httpErrorStatus(e);
  return s === 404 || s === 405;
}

/** 下载状态缓存键（team 作用域 × 技能名）：同名技能在不同作用域的
 * 「无包」判定独立（L2 切团队后不复用旧作用域的隐藏态）。 */
export function skillDownloadKey(
  team: string | undefined,
  name: string,
): string {
  return `${team || "*"}::${name}`;
}

/**
 * 下载技能包 → {blob, filename}。
 * 失败（含 404/405）抛 `HTTP {status}: {detail}`（与
 * fetchWorkspaceFileBlob 同形——isSkillDownloadUnavailable 判降级）。
 */
export async function downloadSkill(
  name: string,
  team?: string,
): Promise<SkillDownload> {
  const host = window.QwenPaw.host;
  const q = team ? `?team=${encodeURIComponent(team)}` : "";
  const full = `/agentteams-proxy/controller/api/v1/skills/${encodeURIComponent(
    name,
  )}/download${q}`;
  let token = "";
  try {
    token = host.getApiToken?.() || "";
  } catch {
    token = "";
  }
  let resp: Response;
  if (host?.fetch) {
    resp = await host.fetch(full);
  } else {
    const headers: Record<string, string> = { Accept: "application/zip" };
    if (token) headers.Authorization = `Bearer ${token}`;
    resp = await fetch(host.getApiUrl(full), { headers });
  }
  if (!resp.ok) {
    let detail = "";
    try {
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        detail = data.message || data.detail || "";
      } catch {
        detail = text;
      }
    } catch {
      detail = "";
    }
    detail = detail ? `: ${detail}` : "";
    throw new Error(`HTTP ${resp.status}${detail}`);
  }
  const blob = await resp.blob();
  const filename = parseSkillDownloadFilename(
    resp.headers.get("Content-Disposition"),
    `${name}.zip`,
  );
  return { blob, filename };
}
