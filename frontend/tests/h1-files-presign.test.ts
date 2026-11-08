// H1：人区文件区（#1518 游标列表 / #1519 预签名上传 / #1501 预签名下载 /
// #1499 同步状态卡）——humanFiles.ts 行为单测。
// 直跑：node --experimental-strip-types frontend/tests/h1-files-presign.test.ts
//（node:assert/strict；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：照 q-quota / c1a 先例——esbuild buildSync 把 humanFiles.ts
// bundle 到临时 .mjs（先注入 window 最小 shim），再动态 import。与 q-quota
// 不同：本用例要走真实请求分支，host shim 带 fetch 分发器（plugin 路径全
// 走 window.QwenPaw.host.fetch——rawJsonFetch / fetchFile 同通道）；
// 预签名对象存储的绝对 URL 走裸 globalThis.fetch（putPresigned /
// downloadPresignedUrl），存根后断言、finally 恢复。Node 22 自带
// Response / FormData / File / Blob 全局。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "api", "domains", "humanFiles.ts");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "h1-files-"));

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
    listFiles: (
      h: string,
      p?: string,
      o?: { recursive?: boolean; limit?: number; cursor?: string },
    ) => Promise<{
      path: string;
      entries: Array<{ name?: string; type?: string; path?: string; size?: number; etag?: string }>;
      nextKey?: string | null;
      paginated: boolean;
    }>;
    uploadFile: (
      h: string,
      p: string,
      f: File | Blob,
    ) => Promise<{ path: string; size: number; etag: string; via: string }>;
    presignDownload: (h: string, p: string) => Promise<
      | { ok: true; value: { url: string; etag?: string; size?: number; expiresAt?: string } }
      | { ok: false; status: number; code?: string; message: string }
    >;
    getSyncStatus: (h: string) => Promise<{
      state: "ok" | "empty" | "denied" | "unsupported";
      entries?: number;
      tombstones?: number;
      generation?: number;
      updatedAt?: string;
      updatedBy?: string;
    }>;
    getSyncManifest: (h: string) => Promise<{ ok: boolean; text?: string; etag?: string; status?: number }>;
    isPaginatedShape: (p: Record<string, unknown> | null) => boolean;
    entryRelPath: (e: { path?: string; name?: string }) => string;
    entryDisplayName: (e: { path?: string; name?: string }) => string;
    isEntryDir: (e: { type?: string; path?: string; size?: number; etag?: string }) => boolean;
    isTicketExpired: (e?: string, now?: number) => boolean;
    HumanFilesError: new (
      status: number,
      message: string,
      code?: string,
    ) => { status: number; code?: string; message: string };
  };
  const {
    listFiles,
    uploadFile,
    presignDownload,
    getSyncStatus,
    getSyncManifest,
    isPaginatedShape,
    entryRelPath,
    entryDisplayName,
    isEntryDir,
    isTicketExpired,
    HumanFilesError,
  } = mod;

  // 预签名对象存储的裸 fetch 通道（putPresigned / downloadPresignedUrl）。
  const storageCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    storageCalls.push({ url: String(url), init });
    return new Response("STORE-BODY", { status: 200 });
  }) as typeof fetch;

  // ── #1518 游标列表 ─────────────────────────────────────────────
  await ok("满页 nextKey=string → paginated + 游标推进", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\?path=docs&recursive=1&limit=1000$/,
      () =>
        json(200, {
          path: "files/docs",
          entries: [
            { path: "files/docs/a.txt", size: 10, etag: "e1", updatedAt: "2026-11-06T00:00:00Z" },
          ],
          nextKey: "abc",
        }),
    );
    const r = await listFiles("luo", "docs", { recursive: true, limit: 1000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, `${P}?path=docs&recursive=1&limit=1000`);
    assert.equal(r.paginated, true);
    assert.equal(r.nextKey, "abc"); // string = 还有下一页
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].path, "files/docs/a.txt");
  });

  await ok("短页 nextKey=null → 到底（空 dir 不带 path 参数）", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\?recursive=1&limit=1000$/,
      () =>
        json(200, { path: "files", entries: [{ path: "files/b.txt", size: 2, etag: "e2" }], nextKey: null }),
    );
    const r = await listFiles("luo", "", { recursive: true, limit: 1000 });
    assert.equal(calls[0].path, `${P}?recursive=1&limit=1000`);
    assert.equal(r.paginated, true);
    assert.equal(r.nextKey, null);
  });

  await ok("cursor 经 URLSearchParams 编码透传", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\?recursive=1&cursor=a\+b%2Fc%3Dd$/,
      () => json(200, { path: "files", entries: [], nextKey: null }),
    );
    const r = await listFiles("luo", "", { recursive: true, cursor: "a b/c=d" });
    assert.ok(calls[0].path.includes("cursor=a+b%2Fc%3Dd"), "cursor 特殊字符编码透传");
    assert.equal(r.nextKey, null);
  });

  await ok("老控制器带参数 → 301 单跳跟随 → 老形态容忍（不报错、无分页）", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/docs\/$/,
      () => json(200, { path: "files/docs/", entries: [{ name: "a.txt", type: "file", size: 3 }] }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\?path=docs&recursive=1&limit=1$/,
      () =>
        new Response("", {
          status: 301,
          headers: { Location: `/agentteams-proxy/controller/api/v1/humans/luo/files/docs/` },
        }),
    );
    const r = await listFiles("luo", "docs", { recursive: true, limit: 1 });
    assert.equal(calls.length, 2, "301 → 单跳跟随");
    assert.equal(r.paginated, false, "老形态容忍");
    assert.equal(r.nextKey, undefined, "无 nextKey 键 → undefined（不启用分页）");
    assert.equal(r.entries[0].name, "a.txt");
  });

  await ok("老分支（无 opts）：尾斜杠路径端点零变化", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/$/,
      () => json(200, { path: "files/", entries: [{ name: "r.txt", type: "file", size: 1 }] }),
    );
    const r = await listFiles("luo");
    assert.equal(calls[0].path, `${P}/`, "空 dir = 根目录尾斜杠");
    assert.equal(r.paginated, false);
    assert.equal(r.nextKey, undefined);
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/docs\/$/,
      () => json(200, { path: "files/docs/", entries: [] }),
    );
    await listFiles("luo", "docs");
    assert.equal(calls[0].path, `${P}/docs/`, "非空 dir 尾斜杠");
  });

  // ── #1519 预签名上传 ───────────────────────────────────────────
  await ok("presign 200 → 对象 PUT → commit 记账（via=presign）", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/a\.txt\?presign=1$/,
      () =>
        json(200, {
          method: "PUT",
          url: "https://store.example/bucket/a.txt",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          maxBytes: 1048576,
        }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/a\.txt\/commit$/,
      () => json(200, { path: "files/a.txt", size: 12, etag: "e2" }),
    );
    const file = new File([new Array(12).fill("x").join("")], "a.txt");
    const r = await uploadFile("luo", "a.txt", file);
    assert.equal(r.via, "presign");
    assert.equal(r.etag, "e2");
    assert.equal(r.size, 12);
    // 顺序：presign 票 → 对象存储 PUT → commit 记账（commit 成功 = 唯一成功点）。
    assert.equal(calls[0].path, `${P}/a.txt?presign=1`);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[1].path, `${P}/a.txt/commit`);
    assert.equal(calls[1].init?.method, "POST");
    assert.equal(storageCalls.length, 1);
    assert.equal(storageCalls[0].url, "https://store.example/bucket/a.txt");
    assert.equal(storageCalls[0].init?.method, "PUT");
  });

  await ok("presign 500 presign_unsupported → 回落直传（via=direct，无 commit）", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/b\.txt\?presign=1$/,
      () => json(500, { message: "not supported", code: "presign_unsupported" }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/b\.txt$/,
      () => json(200, { path: "files/b.txt", size: 4, etag: "d1" }),
    );
    const file = new File([new Array(4).fill("y").join("")], "b.txt");
    const r = await uploadFile("luo", "b.txt", file);
    assert.equal(r.via, "direct", "500 → 回落直传");
    assert.equal(r.etag, "d1");
    // 直传 = PUT plugin 路径（fetchFile → host.fetch 通道）。
    assert.equal(calls[1].path, `${P}/b.txt`);
    assert.equal(calls[1].init?.method, "PUT");
    assert.equal(storageCalls.length, 0, "回落不触达对象存储");
    assert.ok(!calls.some((c) => c.path.includes("commit")), "直传无 commit 记账");
  });

  await ok("presign 404 → 回落直传（#1668 旧版控制器无该路由）", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/c\.txt\?presign=1$/,
      () => new Response("Not Found", { status: 404 }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/c\.txt$/,
      () => json(200, { path: "files/c.txt", size: 1, etag: "d404" }),
    );
    const file = new File(["z"], "c.txt");
    const r = await uploadFile("luo", "c.txt", file);
    assert.equal(r.via, "direct", "404 = 旧版无路由 → 回落直传（#1668）");
    assert.equal(r.etag, "d404");
    assert.equal(calls[1].path, `${P}/c.txt`);
    assert.equal(calls[1].init?.method, "PUT");
    assert.equal(storageCalls.length, 0, "回落不触达对象存储");
  });

  await ok("file.size > maxBytes → 前端拦截（code=max_bytes，不发送）", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/d\.txt\?presign=1$/,
      () => json(200, { method: "PUT", url: "https://store.example/d.txt", maxBytes: 100 }),
    );
    const file = new File([new Array(200).fill("q").join("")], "d.txt");
    await assert.rejects(
      () => uploadFile("luo", "d.txt", file),
      (e: unknown) =>
        e instanceof HumanFilesError &&
        e.status === 0 &&
        e.code === "max_bytes" &&
        e.message === "100",
      "超限 → HumanFilesError(0, '100', 'max_bytes')",
    );
    assert.equal(storageCalls.length, 0, "超限不触达对象存储");
    assert.ok(!calls.some((c) => c.path.includes("commit")), "超限不 commit");
  });

  await ok("commit 409 裸词 body → code=checksum_mismatch（失败在记账步）", async () => {
    reset();
    storageCalls.length = 0;
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/e\.txt\?presign=1$/,
      () => json(200, { method: "PUT", url: "https://store.example/e.txt", maxBytes: 1048576 }),
    );
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/e\.txt\/commit$/,
      () => new Response("checksum_mismatch", { status: 409 }),
    );
    const file = new File(["w"], "e.txt");
    await assert.rejects(
      () => uploadFile("luo", "e.txt", file),
      (e: unknown) =>
        e instanceof HumanFilesError && e.status === 409 && e.code === "checksum_mismatch",
      "commit 409 纯文本裸词 → code=checksum_mismatch",
    );
    assert.equal(storageCalls.length, 1, "对象已传（UI 不得报成功）");
  });

  // ── 票过期判定（纯函数）────────────────────────────────────────
  await ok("isTicketExpired：缺省/解析失败=乐观不过期，过去=过期", () => {
    assert.equal(isTicketExpired(undefined), false, "缺省 → 乐观不过期");
    assert.equal(isTicketExpired("garbage"), false, "解析失败 → 乐观不过期");
    assert.equal(isTicketExpired("2020-01-01T00:00:00Z", Date.now()), true, "过去时刻 → 过期");
    assert.equal(
      isTicketExpired(new Date(Date.now() + 60_000).toISOString(), Date.now()),
      false,
      "未来时刻 → 未过期",
    );
  });

  // ── #1501 预签名下载 ───────────────────────────────────────────
  await ok("presignDownload 200 → {url,etag,size,expiresAt}（逐段编码保留 /）", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/big\/file\.bin\?presign=1$/,
      () =>
        json(200, {
          url: "https://store.example/big/file.bin",
          etag: "be1",
          size: 9_000_000,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
    );
    const r = await presignDownload("luo", "big/file.bin");
    assert.equal(calls[0].path, `${P}/big/file.bin?presign=1`, "encPath 逐段编码、保留 / 分隔符");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.url, "https://store.example/big/file.bin");
      assert.equal(r.value.size, 9_000_000);
      assert.ok(r.value.expiresAt);
    }
  });

  await ok("presignDownload 500 → 类型化失败（不 throw，UI 回落直下）", async () => {
    reset();
    route(
      /^\/agentteams-proxy\/controller\/api\/v1\/humans\/luo\/files\/f\.bin\?presign=1$/,
      () => json(500, { message: "not supported", code: "presign_unsupported" }),
    );
    const r = await presignDownload("luo", "f.bin");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 500);
  });

  // ── #1499 同步状态卡 ───────────────────────────────────────────
  await ok("getSyncStatus：404→unsupported / 403→denied / 200 {}→empty", async () => {
    reset();
    route(/\/sync\/status$/, () => new Response("not found", { status: 404 }));
    assert.deepEqual(await getSyncStatus("luo"), { state: "unsupported" }, "404 老控制器 → 隐藏入口");
    reset();
    route(/\/sync\/status$/, () => new Response("forbidden", { status: 403 }));
    assert.deepEqual(await getSyncStatus("luo"), { state: "denied" }, "403 → 灰条");
    reset();
    route(/\/sync\/status$/, () => json(200, {}));
    assert.deepEqual(await getSyncStatus("luo"), { state: "empty" }, "200 {} → 尚无清单");
  });

  await ok("getSyncStatus 200 计数字段 → ok（只读透传，不解析条目）", async () => {
    reset();
    route(
      /\/sync\/status$/,
      () =>
        json(200, {
          entries: 12,
          tombstones: 3,
          generation: 7,
          updatedAt: "2026-11-06T00:00:00Z",
          updatedBy: "luo",
        }),
    );
    const s = await getSyncStatus("luo");
    assert.equal(s.state, "ok");
    assert.equal(s.entries, 12);
    assert.equal(s.tombstones, 3);
    assert.equal(s.generation, 7);
    assert.equal(s.updatedBy, "luo");
  });

  await ok("getSyncManifest：200 原文 + ETag 头透传 / 404 → {ok:false,status:404}", async () => {
    reset();
    route(
      /\/sync\/manifest$/,
      () =>
        new Response('{"files/a.txt":{"sha256":"..."}}', {
          status: 200,
          headers: { ETag: '"gen-7"' },
        }),
    );
    const m = await getSyncManifest("luo");
    assert.equal(m.ok, true);
    assert.equal(m.text, '{"files/a.txt":{"sha256":"..."}}');
    assert.equal(m.etag, '"gen-7"', "ETag 头透传（核对用）");
    reset();
    route(/\/sync\/manifest$/, () => new Response("nf", { status: 404 }));
    const m2 = await getSyncManifest("luo");
    assert.equal(m2.ok, false, "404 → 不 throw");
    if (!m2.ok) assert.equal(m2.status, 404);
  });

  // ── 双形态纯函数 ───────────────────────────────────────────────
  await ok("isPaginatedShape：nextKey 键存在 / entry 带 path = 新形态", () => {
    assert.equal(isPaginatedShape(null), false);
    assert.equal(isPaginatedShape({ nextKey: null }), true, "nextKey 键存在（即使 null）");
    assert.equal(isPaginatedShape({ entries: [{ path: "files/x" }] }), true);
    assert.equal(isPaginatedShape({ entries: [{ name: "x", type: "file" }] }), false, "老一层形态");
    assert.equal(isPaginatedShape({ entries: [] }), false, "空 entries 无 nextKey");
  });

  await ok("entryRelPath / entryDisplayName：双形态归一", () => {
    assert.equal(entryRelPath({ path: "files/a/b.txt" }), "a/b.txt", "剥 files/ 前缀");
    assert.equal(entryRelPath({ name: "c.txt", type: "file" }), "c.txt", "老形态 = name");
    assert.equal(entryDisplayName({ path: "files/a/b.txt" }), "b.txt", "path 末段");
    assert.equal(entryDisplayName({ name: "c.txt", type: "file" }), "c.txt");
  });

  await ok("isEntryDir：type 优先，path 尾斜杠，size/etag 缺省推断", () => {
    assert.equal(isEntryDir({ type: "directory" }), true);
    assert.equal(isEntryDir({ type: "file" }), false);
    assert.equal(isEntryDir({ path: "files/dir/" }), true);
    assert.equal(isEntryDir({ path: "files/f.txt", size: 5, etag: "e" }), false);
    assert.equal(isEntryDir({ path: "files/f.txt" }), true, "无 size 无 etag → 推断目录");
  });

  // ── 接线（源码文本断言：关键行为落在 shipped 实现）─────────────
  await ok("humanFiles.ts 接线（导出面 + 无 method:'GET' 字面量）", () => {
    for (const name of [
      "export async function listFiles(",
      "export async function uploadFile(",
      "export async function presignUpload(",
      "export async function commitUpload(",
      "export async function presignDownload(",
      "export async function getSyncStatus(",
      "export async function getSyncManifest(",
    ]) {
      assert.ok(src.includes(name), `缺 ${name}`);
    }
    assert.doesNotMatch(src, /method: "GET"/);
  });

  console.log(`\nh1-files-presign: ${n} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
}
