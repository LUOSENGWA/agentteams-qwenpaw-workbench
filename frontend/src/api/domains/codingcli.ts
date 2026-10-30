// Coding CLI 管理面（/coding-cli/*）：探测/设置/安装任务。

import { requestJson } from "../shared";
import { cachedRequest, invalidateTags } from "../../requestCache";
import { listCodingRuns } from "./upgrade";
import type { CodingRun } from "./upgrade";

// ── Worker Coding CLI 管理面（上游 1.2.5 #1360/#1377；消费侧对齐
// dashboard worker-coding-cli-panel）────────────────────────────────
// 数据面 = Controller /api/v1/workers/{name}/coding-cli[/{cli}/…]。
// 探测=listCLIs（per-CLI installed/version/auth）；settings=GET/PUT
// （深合并 + *** 哨兵保留密钥）；install=POST 202 task_id → 轮询
// GET /install/{task_id}（running/done/failed）。503=非 embedded /
// 502=容器不可达 / 403=写拒绝（整面只读）/ 404=端点不存在（旧版）。
export type CodingCliId = "qwen-code" | "opencode" | "qoder";

export interface CodingCliProbeItem {
  cli: CodingCliId;
  installed: boolean;
  version?: string;
  auth?: { configured?: boolean; method?: string } | null;
  error?: string;
}

export type SettingsValue =
  | string
  | number
  | boolean
  | null
  | { redacted: true; has_value: boolean }
  | { [k: string]: SettingsValue }
  | SettingsValue[];

export type SettingsObject = { [k: string]: SettingsValue };

/** coding-cli settings 端点响应=wrapper（TOP-LEVEL KEYS
 * [cli, exists, path, settings]）——`settings` 子树才是配置文件的真树
 * （脱敏哨兵在树内）。前端必须 unwrap 到 `.settings` 作树，diff/secret
 * 补丁按「配置文件相对路径」发（controller 对真树 deep-merge）。 */
export interface CliSettingsResponse {
  cli: string;
  path: string;
  exists: boolean;
  settings: SettingsObject;
}

interface CodingCliInstallTask {
  task_id: string;
  cli: string;
  action: string;
  version?: string;
  state: "running" | "done" | "failed";
  exit_code?: number;
  /** Controller 快照字段 = stderr_tail（1.2.5 源码实读）。 */
  stderr_tail?: string;
  pkg?: string;
}

const CLI_BASE = (name: string) =>
  `/agentteams-proxy/controller/api/v1/workers/${encodeURIComponent(
    name,
  )}/coding-cli`;

/** 30s 缓存（探测列表；key=worker 名）。 */
export function listCodingCli(name: string): Promise<CodingCliProbeItem[]> {
  return cachedRequest(`coding-cli:${name}`, 30_000, async () => {
    const body = (await requestJson(CLI_BASE(name), undefined, 30000)) as Record<
      string,
      CodingCliProbeItem
    >;
    if (!body || typeof body !== "object") return [];
    return Object.values(body).filter(
      (v): v is CodingCliProbeItem => !!v && typeof v === "object",
    );
  }, { tags: ["coding-cli"] });
}

/** 60s 缓存（配置类；key=worker+cli；putCliSettings 成功后失效）。 */
export function getCliSettings(
  name: string,
  cli: CodingCliId,
): Promise<CliSettingsResponse> {
  return cachedRequest(`coding-cli-settings:${name}:${cli}`, 60_000, async () => {
    const r = (await requestJson(
      `${CLI_BASE(name)}/${encodeURIComponent(cli)}/settings`,
      undefined,
      30000,
    )) as CliSettingsResponse;
    // 防御：无 settings 键（旧 controller / 异常）→ 空树（unwrap 不炸）。
    return r && typeof r === "object" && r.settings
      ? r
      : { cli, path: "", exists: false, settings: {} };
  }, { tags: ["coding-cli"] });
}

export async function putCliSettings(
  name: string,
  cli: CodingCliId,
  patch: SettingsObject,
): Promise<CliSettingsResponse> {
  // 15.29：超时 30s→180s——服务端同步写（exec 读→merge→mkdir→archive
  // 写→exec mv→同步审计落盘）在慢盘/审计尾延迟下实测 240s+ 才完成
  // （写本身数秒内已成功）；短超时=客户端先放弃，用户看到「失败」但
  // 文件其实已写（状态不一致）。配合 saveSettings 的读回验证兜底。
  const r = (await requestJson(
    `${CLI_BASE(name)}/${encodeURIComponent(cli)}/settings`,
    { method: "PUT", body: JSON.stringify(patch) },
    180000,
  )) as CliSettingsResponse;
  invalidateTags(["coding-cli"]);
  return r && typeof r === "object" && r.settings
    ? r
    : { cli, path: "", exists: true, settings: patch };
}

export async function startCodingCliInstall(
  name: string,
  cli: CodingCliId,
  action: "install" | "uninstall",
  version?: string,
): Promise<{ task_id: string }> {
  const r = (await requestJson(
    `${CLI_BASE(name)}/${encodeURIComponent(cli)}/install`,
    {
      method: "POST",
      body: JSON.stringify(version ? { action, version } : { action }),
    },
    30000,
  )) as { task_id: string };
  // 安装任务启动 → CLI 探测/设置缓存失效（装完状态变化）。
  invalidateTags(["coding-cli"]);
  return r;
}

/** 不缓存：安装任务状态机轮询（running/done/failed，活性即价值）。 */
export async function getCliInstallTask(
  name: string,
  cli: CodingCliId,
  taskId: string,
): Promise<CodingCliInstallTask> {
  return (await requestJson(
    `${CLI_BASE(name)}/${encodeURIComponent(cli)}/install/${encodeURIComponent(
      taskId,
    )}`,
    undefined,
    30000,
  )) as CodingCliInstallTask;
}

/** 检查更新：宿主侧查 npm registry latest（走插件后端，非浏览器直连）。
 *  clis = 逗号分隔子集（空=全部 3 个）；逐 CLI 失败降级为该项 error。
 *  L1 only（无 token 403 → 抛错，面板 catch 后逐 CLI 显不可达）。 */
interface CodingCliLatestItem {
  cli: string;
  npm_package: string;
  latest?: string | null;
  registry?: string;
  checked_at?: number;
  error?: string;
}
interface CodingCliLatestResult {
  items: Record<string, CodingCliLatestItem>;
  registry?: string;
}
/** 300s 缓存（近似静态：npm registry latest 低频变化；key 含 clis；
 * refresh 非零 → force 回源）。 */
export function fetchCodingCliLatest(
  clis?: string,
  refresh = 0,
): Promise<CodingCliLatestResult> {
  const q = new URLSearchParams();
  if (clis) q.set("clis", clis);
  if (refresh) q.set("refresh", String(refresh));
  const qs = q.toString();
  return cachedRequest(
    `coding-cli-latest:${clis ?? ""}`,
    300_000,
    () =>
      requestJson(
        `/agentteams-proxy/coding-cli/latest${qs ? "?" + qs : ""}`,
        undefined,
        25000,
      ) as Promise<CodingCliLatestResult>,
    { force: refresh > 0, tags: ["coding-cli"] },
  );
}

/** 按 worker 过滤 coding runs（list 全量 + 客户端过滤 worker 字段；
 * 服务端无 per-worker 过滤参数，见 1.2.5 源码 ListCodingRuns）。 */
export async function listCodingRunsByWorker(
  worker: string,
): Promise<CodingRun[]> {
  const all = await listCodingRuns();
  return all.filter((r) => (r.worker || "") === worker);
}
