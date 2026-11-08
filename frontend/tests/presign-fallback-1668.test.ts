// #1668 预签名失败回退条件修正（405 → 直传）——
// 用户实测：旧控制器无 POST ?presign=1 路由 → 405，旧判定只认 500/501
// → 上传失败未回退直传。修复 = shouldFallbackToDirect 纯函数统一
// uploadFile / doDownload 的回落判定（404/405/500/501/502/503 回落，
// 401/403/409/412/413 不回落）。
// 直跑：node --experimental-strip-types frontend/tests/presign-fallback-1668.test.ts
//（node:assert/strict；加载路径照 h1-files-presign 先例：esbuild buildSync
// bundle humanFiles.ts 到临时 .mjs，window 最小 shim + host.fetch 分发器，
// 预签名对象存储裸 fetch 存根，finally 恢复）。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "api", "domains", "humanFiles.ts");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "presign-fb-1668-"));

/** 记录 host.fetch 调用（plugin 路径通道）。 */
interface Call {
  path: string;
  init?: RequestInit;
}
const calls: Call[] = [];
interface Route {
  match: RegExp;
  respond: (p: string, init?: RequestInit) => Response;
}
const routes: Route[] = [];
function route(match: RegExp, respond: Route["respond"]): void {
  routes.push({ match, respond });
}
function reset(): void {
  calls.length = 0;
  routes.length = 0;
}
const hostFetch = async (path: string, init?: RequestInit): Promise<Response> => {
  calls.push({ path, init });
  for (const r of routes) {
    if (r.match.test(path)) return r.respond(path, init);
  }
  return new Response(JSON.stringify({ message: `no route: ${path}` }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
};
const json = (status: number, obj: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers } },
  );

let n = 0;
async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

const P = "/agentteams-proxy/controller/api/v1/humans/luo/files";
let realFetch: typeof fetch = globalThis.fetch;

try {
  (globalThis as Record<string, unknown>).window = { QwenPaw: { host: { fetch: hostFetch } } };

  buildSync({
    entryPoints: [srcPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "humanFiles.mjs"),
  });

  const mod = (await import(path.join(tmp, "humanFiles.mjs"))) as {
    uploadFile: (
      h: string,
      p: string,
      f: File | Blob,
    ) => Promise<{ path: string; size: number; etag: string; via: string }>;
    shouldFallbackToDirect: (status: number) => boolean;
    HumanFilesError: new (
      status: number,
      message: string,
      code?: string,
    ) => { status: number; code?: string; message: string };
  };
  const { uploadFile, shouldFallbackToDirect, HumanFilesError } = mod;

  // 预签名对象存储的裸 fetch 通道（putPresigned / downloadPresignedUrl）。
  const storageCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    storageCalls.push({ url: String(url), init });
    return new Response("STORE-BODY", { status: 200 });
  }) as typeof fetch;

  // ── ① 回落集合：预签名不可用的状态码 ───────────────────────────
  await ok("shouldFallbackToDirect：405/404/500/501/502/503 → true", () => {
    assert.equal(shouldFallbackToDirect(405), true, "405 = 旧控制器无该路由/方法（用户实测场景）");
    assert.equal(shouldFallbackToDirect(404), true, "404 = 旧控制器无该路由");
    assert.equal(shouldFallbackToDirect(500), true, "500 = 部署未开预签名");
    assert.equal(shouldFallbackToDirect(501), true, "501 = 部署未开预签名");
    assert.equal(shouldFallbackToDirect(502), true, "502 = 上游不可用");
    assert.equal(shouldFallbackToDirect(503), true, "503 = 上游不可用");
  });

  // ── ② 不回落集合：权限与业务限制（回落只会得到同样错误）────────
  await ok("shouldFallbackToDirect：401/403/409/412/413 → false", () => {
    assert.equal(shouldFallbackToDirect(401), false, "401 未认证");
    assert.equal(shouldFallbackToDirect(403), false, "403 权限");
    assert.equal(shouldFallbackToDirect(409), false, "409 业务冲突");
    assert.equal(shouldFallbackToDirect(412), false, "412 etag 冲突");
    assert.equal(shouldFallbackToDirect(413), false, "413 大小/配额");
  });

  // ── ③ 用户实测场景：presign 405 → 回落 writeFileSync，不抛错 ────
  await ok("uploadFile：presign 405（旧版无路由，纯文本 body）→ 直传 via=direct，不抛错", async () => {
    reset();
    storageCalls.length = 0;
    // 旧 Go 控制器 405 响应体是纯文本 "Method Not Allowed"（非 JSON）。
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/job-logs\.txt\?presign=1$/,
      () => new Response("Method Not Allowed", { status: 405 }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/job-logs\.txt$/,
      () => json(200, { path: "files/job-logs.txt", size: 9, etag: "fb1" }),
    );
    const file = new File(["job-log\n"], "job-logs.txt");
    const r = await uploadFile("luo", "job-logs.txt", file);
    assert.equal(r.via, "direct", "405 → 回落直传");
    assert.equal(r.path, "files/job-logs.txt");
    assert.equal(r.etag, "fb1");
    // 顺序：presign POST 405 → 直传 PUT plugin 路径（不触达对象存储/commit）。
    assert.equal(calls[0].path, `${P}/job-logs.txt?presign=1`);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[1].path, `${P}/job-logs.txt`);
    assert.equal(calls[1].init?.method, "PUT");
    assert.equal(storageCalls.length, 0, "回落不触达对象存储");
    assert.ok(!calls.some((c) => c.path.includes("commit")), "直传无 commit 记账");
  });

  // ── ④ 权限错误不回落：presign 403 → 原样上抛 ───────────────────
  await ok("uploadFile：presign 403 → 抛 HumanFilesError(403)，不回落直传", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/g\.txt\?presign=1$/,
      () => json(403, { message: "forbidden" }),
    );
    const file = new File(["q"], "g.txt");
    await assert.rejects(
      () => uploadFile("luo", "g.txt", file),
      (e: unknown) => e instanceof HumanFilesError && e.status === 403,
      "403 = 权限 → 不回落，原样抛（原状态不吞）",
    );
    // 除 presign 那次外无任何调用（没有直传 PUT、没有对象存储）。
    assert.equal(calls.length, 1, "403 不触发直传");
    assert.equal(storageCalls.length, 0);
  });

  // ── ⑤ 5xx 回落（新纳入 502）：行为与 500 同型 ──────────────────
  await ok("uploadFile：presign 502 → 回落直传 via=direct（502 新纳入回落集合）", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/h\.txt\?presign=1$/,
      () => json(502, { message: "upstream unavailable" }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/h\.txt$/,
      () => json(200, { path: "files/h.txt", size: 1, etag: "fb502" }),
    );
    const file = new File(["q"], "h.txt");
    const r = await uploadFile("luo", "h.txt", file);
    assert.equal(r.via, "direct");
    assert.equal(r.etag, "fb502");
    assert.equal(storageCalls.length, 0);
  });

  // ── 接线（源码文本断言：回落判定统一走纯函数，无 500/501 硬编码）─
  await ok("接线：shouldFallbackToDirect 导出 + uploadFile 走纯函数判定", () => {
    assert.ok(src.includes("export function shouldFallbackToDirect(status: number): boolean"), "纯函数导出");
    assert.ok(src.includes("if (shouldFallbackToDirect(r.status)) {"), "uploadFile 回落判定走纯函数");
    assert.doesNotMatch(src, /r\.status === 500 \|\| r\.status === 501/, "uploadFile 无 500/501 硬编码残留");
  });

  console.log(`\npresign-fallback-1668: ${n} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
}
