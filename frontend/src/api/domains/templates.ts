// 千锻（Millforge）模板导入域（/agentteams-proxy/templates*）：
// git clone templates 目录 → 本地 pack → 浏览/预览/删除。
// 数据契约 = 千锻仓 templates/（INDEX.yaml 注册表 + {skeleton,industry,
// domain,fragments}/*.md）。本 MVP 只做导入 + 浏览 + 建队预填——
// 不执行千锻编译器（P2 另开单）。

import { requestJson } from "../shared";
import { cachedRequest, invalidateTags } from "../../requestCache";

/** INDEX.yaml 条目（四组同构：skeletons/industry/domain/fragments）。 */
export interface TemplateEntry {
  id: string;
  /** pack 根相对路径（.md），文件预览取数键。 */
  file: string;
  source?: string;
  applies_to?: string;
  budget?: string;
}

/** 解析后的 INDEX 四组。 */
export interface TemplateIndex {
  skeletons: TemplateEntry[];
  industry: TemplateEntry[];
  domain: TemplateEntry[];
  fragments: TemplateEntry[];
}

/** pack 导入元信息（后端 meta.json）。 */
export interface TemplatePackMeta {
  url: string;
  ref: string;
  commit: string;
  imported_at: string;
  files?: string[];
}

/** 单个模板包（list 条目）。index=null + parse_error 非空 = 该包 INDEX
 * 解析失败（诚实降级：元信息/删除仍可用，其余包照常）。 */
export interface TemplatePack {
  /** 包名 = 仓库 slug。 */
  pack: string;
  meta: TemplatePackMeta | null;
  index: TemplateIndex | null;
  parse_error?: string | null;
}

/** GET /templates 响应。 */
export interface TemplatesListResponse {
  packs: TemplatePack[];
}

/** 读单文件（.md/.yaml 只读预览）响应。 */
export interface TemplateFileResponse {
  pack: string;
  path: string;
  size: number;
  content: string;
}

/** 拉取全部模板包（含解析后 INDEX + meta）。失败抛错（调用方降级）。
 * 300s 缓存（近似静态：pack 集合仅在导入/删除时变化，两个写函数已失效）。 */
export function fetchTemplates(): Promise<TemplatesListResponse> {
  return cachedRequest(
    "templates",
    300_000,
    () =>
      requestJson("/agentteams-proxy/templates", undefined, 30000) as Promise<TemplatesListResponse>,
    { tags: ["templates"] },
  );
}

/** 导入千锻模板包（git clone --depth 1；90s 后端超时 → 前端 300s 宽限
 * 覆盖 clone 全链路）。400 = 校验失败（host/ref/大小）；502 = clone 失败。
 * 错误 detail 由 requestJson 提取（FastAPI {detail}），调用方原样展示。 */
export async function importTemplates(
  url: string,
  ref: string,
): Promise<{ ok: boolean; pack: string; files: number; commit: string }> {
  const r = (await requestJson(
    "/agentteams-proxy/templates/import",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ref }),
    },
    300000,
  )) as { ok: boolean; pack: string; files: number; commit: string };
  // 导入新 pack → 模板列表缓存失效（写后必读最新）。
  invalidateTags(["templates"]);
  return r;
}

/** 读 pack 内单文件（path = pack 根相对路径；.md/.yaml；防穿越由后端保证）。
 * 不缓存：pack 内单文件只读预览（大载荷 + 无轮询消费方，缓存在挤 LRU）。 */
export async function fetchTemplateFile(
  pack: string,
  path: string,
): Promise<TemplateFileResponse> {
  const q = new URLSearchParams({ path });
  return (await requestJson(
    `/agentteams-proxy/templates/${encodeURIComponent(pack)}/file?${q.toString()}`,
    undefined,
    30000,
  )) as TemplateFileResponse;
}

/** 删除模板包（幂等：不存在也 ok）。 */
export async function deleteTemplatePack(
  pack: string,
): Promise<{ ok: boolean; deleted: boolean }> {
  const r = (await requestJson(
    `/agentteams-proxy/templates/${encodeURIComponent(pack)}`,
    { method: "DELETE" },
    30000,
  )) as { ok: boolean; deleted: boolean };
  // 删除 pack（幂等）→ 模板列表缓存失效。
  invalidateTags(["templates"]);
  return r;
}
