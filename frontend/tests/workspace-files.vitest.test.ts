/**
 * workspace-files.test.ts — 工作区文件 + 拉起就绪端点接入单测（vitest 风格）。
 *
 * 运行：npx vitest run（*.vitest.test.ts 约定）。
 *
 * 覆盖（任务书 ≥5 条）：
 * ① 路径编码——worker name 与 path query 的 encodeURIComponent /
 *    URLSearchParams 编码（listWorkspaceFiles / readWorkspaceFile /
 *    probeWorkspaceFilesSupported 5 段探测路径）；
 * ② payload 字段名——writeWorkspaceFile body 恰为 {"content"}（Go handler
 *    字段正源）+ If-Match 头 presence（现有文件）/absence（新建文件）；
 * ③ 404 降级——probe 判据（400=支持 / 404=隐藏 / 503=隐藏 + TTL 缓存）+
 *    ensureWorkerReadyWithFallback（ensure-ready 404 → 回落 ready 204 成功；
 *    双 404 → 404 原样传出供 UI 隐藏）；
 * ④ 就绪按钮显示条件——shouldShowEnsureReady（Running/Ready 各形态隐藏，
 *    Stopped/Sleeping/Failed/空 → 显示）。
 * bonus：limit 上限钳制（tree 500 / file-content 1MiB）、file-download
 * 404 错误形态。
 */
import { test, expect } from "vitest";

import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  fetchWorkspaceFileBlob,
  probeWorkspaceFilesSupported,
} from "../src/api/domains/workspaceFiles";
import {
  ensureWorkerReadyWithFallback,
  shouldShowEnsureReady,
} from "../src/api/domains/lifecycle";
import { httpErrorStatus } from "../src/api/shared";

// ── window/host shim（requestJsonFull 走 host.fetch；kind=server 使
// isLocalHost()=false，不进独立宿主配置模拟层；与 m2-modules 同款）────
interface CapturedCall {
  path: string;
  init?: RequestInit;
}
const calls: CapturedCall[] = [];
type Responder = (
  path: string,
  init?: RequestInit,
) => { status: number; body?: unknown; blob?: Blob };
let responder: Responder = () => ({ status: 200, body: {} });

(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      kind: "server",
      fetch: async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        const r = responder(path, init);
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          text: async () => (r.body == null ? "" : JSON.stringify(r.body)),
          blob: async () => r.blob ?? new Blob(),
        };
      },
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
      getAuthToken: () => "",
    },
  },
};

const BASE = "/agentteams-proxy/controller/api/v1";

// ── ① 路径编码 ─────────────────────────────────────────────────────

test("① listWorkspaceFiles：worker name encodeURIComponent + path/limit query 编码", async () => {
  calls.length = 0;
  responder = () => ({ status: 200, body: { directory: "", entries: [] } });
  await listWorkspaceFiles("a/b c", "memory/x y.md", { limit: 500 });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(
    `${BASE}/workers/a%2Fb%20c/workspace-files/tree?path=memory%2Fx+y.md&limit=500`,
  );
  expect(calls[0].init?.method).toBe("GET");
});

test("①b readWorkspaceFile：offset/limit query 编码 + limit 上限钳制 1MiB", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: { content: "", etag: '"e1"', offset: 0 },
  });
  await readWorkspaceFile("w1", "digest/2026-11-07.md", {
    offset: 10,
    limit: 2 * 1024 * 1024,
  });
  expect(calls[0].path).toBe(
    `${BASE}/workers/w1/workspace-files/file-content?path=digest%2F2026-11-07.md&offset=10&limit=1048576`,
  );
  // tree 的 limit 上限钳制 500（超限由 controller 400，前端先钳）。
  calls.length = 0;
  await listWorkspaceFiles("w1", "", { limit: 9999 });
  expect(calls[0].path).toBe(
    `${BASE}/workers/w1/workspace-files/tree?path=&limit=500`,
  );
});

test("①c probeWorkspaceFilesSupported：5 段探测路径（段数超限是判据本体）", async () => {
  calls.length = 0;
  responder = () => ({ status: 400, body: { message: "path is too deep" } });
  await probeWorkspaceFilesSupported("probe-w5seg");
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(
    `${BASE}/workers/probe-w5seg/workspace-files/file-metadata?path=memory%2Fa%2Fb%2Fc%2Fd`,
  );
});

// ── ② payload 字段名（Go handler 正源：body {"content"} + If-Match 头）──

test("② writeWorkspaceFile：现有文件 → body 恰为 {content} + If-Match 头", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: { etag: '"new"', path: "MEMORY.md", size: 3 },
  });
  const r = await writeWorkspaceFile("w1", "MEMORY.md", "abc", '"old"');
  expect(calls).toHaveLength(1);
  expect(calls[0].init?.method).toBe("PUT");
  const headers = calls[0].init?.headers as Record<string, string>;
  expect(headers["If-Match"]).toBe('"old"');
  expect(headers["Content-Type"]).toBe("application/json");
  // 字段名以 Go handler 为准：payload struct { Content string `json:"content"` }
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ content: "abc" });
  expect(r).toEqual({ etag: '"new"', path: "MEMORY.md", size: 3 });
});

test("②b writeWorkspaceFile：新建文件 → 不带 If-Match 头（controller 校验，违例 400）", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: { etag: '"n1"', path: "memory/a.md", size: 2 },
  });
  await writeWorkspaceFile("w1", "memory/a.md", "hi");
  const headers = calls[0].init?.headers as Record<string, string>;
  expect("If-Match" in headers).toBe(false);
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ content: "hi" });
});

// ── ③ 404 降级（版本门 / 能力探测 / 回落链）───────────────────────────

test("③ probe 判据：400=支持 / 404=隐藏 / 503 kube=隐藏", async () => {
  // 新控制器：路由存在，5 段路径校验先于 dial → 400。
  responder = () => ({ status: 400, body: { message: "path is too deep" } });
  await expect(probeWorkspaceFilesSupported("probe-400")).resolves.toBe(true);
  // 老控制器：无路由 → 404 → 隐藏。
  responder = () => ({ status: 404, body: { message: "not found" } });
  await expect(probeWorkspaceFilesSupported("probe-404")).resolves.toBe(false);
  // 新控制器 kube 模式：路由存在但 503 → 一并隐藏。
  responder = () => ({ status: 503, body: { message: "kube mode" } });
  await expect(probeWorkspaceFilesSupported("probe-503")).resolves.toBe(false);
});

test("③b probe TTL 缓存：判据确定后不再拨号（隐藏态不重复付探测成本）", async () => {
  responder = () => ({ status: 404, body: { message: "not found" } });
  calls.length = 0;
  await probeWorkspaceFilesSupported("probe-cache-1");
  await probeWorkspaceFilesSupported("probe-cache-1");
  expect(calls).toHaveLength(1);
});

test("③c ensureWorkerReadyWithFallback：ensure-ready 404 → 回落 ready 204 成功", async () => {
  calls.length = 0;
  responder = (path) =>
    path.includes("/ensure-ready")
      ? { status: 404, body: { message: "not found" } }
      : { status: 204, body: null };
  await expect(ensureWorkerReadyWithFallback("wf-1")).resolves.toBeUndefined();
  // 两次调用：ensure-ready 404 + ready 204。
  expect(calls.map((c) => c.path)).toEqual([
    `${BASE}/workers/wf-1/ensure-ready`,
    `${BASE}/workers/wf-1/ready`,
  ]);
});

test("③d ensureWorkerReadyWithFallback：双 404（老控制器）→ 404 原样传出（UI 据此隐藏）", async () => {
  calls.length = 0;
  responder = () => ({ status: 404, body: { message: "not found" } });
  const err = await ensureWorkerReadyWithFallback("wf-2").catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(httpErrorStatus(err)).toBe(404);
  expect(calls.map((c) => c.path)).toEqual([
    `${BASE}/workers/wf-2/ensure-ready`,
    `${BASE}/workers/wf-2/ready`,
  ]);
});

test("③e file-download 404（老控制器/越权/不存在）→ HTTP 404 错误形态", async () => {
  responder = () => ({ status: 404, body: { message: "file not found" } });
  const err = await fetchWorkspaceFileBlob("w1", "memory/a.md").catch((e) => e);
  expect(httpErrorStatus(err)).toBe(404);
  expect(err.message).toContain("file not found");
});

// ── ④ 「拉起就绪」按钮显示条件（phase 门控纯函数）─────────────────────

test("④ shouldShowEnsureReady：Running/Ready 隐藏，其余显示", () => {
  // 隐藏：运行/就绪（大小写与空白不敏感）。
  expect(shouldShowEnsureReady("Running")).toBe(false);
  expect(shouldShowEnsureReady("running")).toBe(false);
  expect(shouldShowEnsureReady(" Ready ")).toBe(false);
  expect(shouldShowEnsureReady("READY")).toBe(false);
  // 显示：停止/休眠/异常/启动中/未上报。
  expect(shouldShowEnsureReady("Stopped")).toBe(true);
  expect(shouldShowEnsureReady("Sleeping")).toBe(true);
  expect(shouldShowEnsureReady("Failed")).toBe(true);
  expect(shouldShowEnsureReady("Error")).toBe(true);
  expect(shouldShowEnsureReady("Pending")).toBe(true);
  expect(shouldShowEnsureReady("Starting")).toBe(true);
  expect(shouldShowEnsureReady("")).toBe(true);
  expect(shouldShowEnsureReady(undefined)).toBe(true);
  expect(shouldShowEnsureReady(null)).toBe(true);
});
