// #1666c：文件区目录导航守卫（DirListGuard）——「进入子目录后列表不刷新 /
// 显示根内容」行为单测（顺序化 guard + 失败清列表）。
// 直跑：node --experimental-strip-types frontend/tests/h1-files-nav.test.ts
//（node:assert/strict；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：照 h1-files-presign 先例——esbuild buildSync 把 humanFiles.ts
// bundle 到临时 .mjs（先注入 window 最小 shim），再动态 import；host shim
// 带 fetch 分发器（listFiles 全走 window.QwenPaw.host.fetch）。
// 「组件模拟」层复刻组件侧契约：只有守卫 apply 返回非 null 才把状态写入
// 「列表」——与 FilesSection.load() 的 if (!applied) return; 同形。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "api", "domains", "humanFiles.ts");
const src = readFileSync(srcPath, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "h1-files-nav-"));

/** 记录 host.fetch 调用（plugin 路径通道）。 */
const calls: string[] = [];
interface Route {
  match: RegExp;
  respond: (p: string) => Response | Promise<Response>;
}
const routes: Route[] = [];
function route(match: RegExp, respond: Route["respond"]): void {
  routes.push({ match, respond });
}
function reset(): void {
  calls.length = 0;
  routes.length = 0;
}
const hostFetch = async (path: string): Promise<Response> => {
  calls.push(path);
  for (const r of routes) {
    if (r.match.test(path)) return r.respond(path);
  }
  return new Response(JSON.stringify({ message: `no route: ${path}` }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
};
const json = (status: number, obj: unknown): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let n = 0;
async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

const P = "/agentteams-proxy/controller/api/v1/humans/luo/files";
/** 老形态条目字面量（name/type/size）。 */
const E = (name: string, type: "file" | "directory", size = 1) => ({ name, type, size });

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
    listFiles: (h: string, p?: string) => Promise<{
      path: string;
      entries: Array<Record<string, unknown>>;
      nextKey?: string | null;
      paginated: boolean;
    }>;
    DirListGuard: new () => {
      isCurrent(tag: string): boolean;
      begin(dir: string): string;
      applyResult: (tag: string, resp: {
        path: string;
        entries: Array<Record<string, unknown>>;
        nextKey?: string | null;
        paginated: boolean;
      }) => {
        entries: Array<Record<string, unknown>>;
        nextKey: string | null | undefined;
        paginated: boolean;
        status: string;
        error: string;
      } | null;
      applyError: (tag: string, status: number, error: string) => {
        entries: Array<Record<string, unknown>>;
        nextKey: string | null | undefined;
        paginated: boolean;
        status: string;
        error: string;
      } | null;
    };
    HumanFilesError: new (
      status: number,
      message: string,
      code?: string,
    ) => { status: number; code?: string; message: string };
  };
  const { listFiles, DirListGuard, HumanFilesError } = mod;
  const g = new DirListGuard();

  // 组件模拟：仅守卫 apply 返回非 null 时写入「列表」（与 load() 同契约）。
  const view = { entries: [] as Array<Record<string, unknown>>, status: "", error: "" };
  const apply = (tag: string, resp: Parameters<typeof g.applyResult>[1]) => {
    const r = g.applyResult(tag, resp);
    if (r) {
      view.entries = r.entries;
      view.status = r.status;
      view.error = r.error;
    }
    return r;
  };
  const applyErr = (tag: string, status: number, error: string) => {
    const r = g.applyError(tag, status, error);
    if (r) {
      view.entries = r.entries;
      view.status = r.status;
      view.error = r.error;
    }
    return r;
  };

  // ① 顺序化 guard：目录 A 的响应晚于目录 B 到达 → 丢弃 A，不得覆盖 B
  await ok("① A 响应晚到（B 已应用）→ 不覆盖 B 的列表（顺序化 guard）", async () => {
    reset();
    let releaseA: (v: Response) => void = () => {};
    route(new RegExp(`^${P}/a/$`), () => new Promise<Response>((res) => { releaseA = res; }));
    route(new RegExp(`^${P}/b/$`), () => json(200, { path: "files/b/", entries: [E("b.txt", "file")] }));

    const tagA = g.begin("a");
    const pa = listFiles("luo", "a"); // A 在途（hold）
    const tagB = g.begin("b"); // 用户进入 B（A 未回）
    const rb = await listFiles("luo", "b");
    assert.ok(g.isCurrent(tagB), "B 的标签当前有效");
    assert.ok(apply(tagB, rb), "B 的响应被应用");
    assert.deepEqual(view.entries, [E("b.txt", "file")], "列表 = B 内容");

    releaseA(json(200, { path: "files/a/", entries: [E("a.txt", "file"), E("lsw", "directory")] }));
    const ra = await pa; // A 晚到
    assert.equal(apply(tagA, ra), null, "A 的过期响应被丢弃");
    assert.ok(!g.isCurrent(tagA), "A 的标签已失效");
    assert.deepEqual(view.entries, [E("b.txt", "file")], "列表仍是 B 的（未被 A 覆盖）");
  });

  // ② 请求失败（500）→ 列表被清空且暴露错误（不保留旧数据）
  await ok("② 请求失败（500）→ 列表清空 + 暴露错误（不保留旧数据）", async () => {
    reset();
    // 先建立「旧数据」：目录 A 加载成功
    route(new RegExp(`^${P}/a/$`), () => json(200, { path: "files/a/", entries: [E("a.txt", "file")] }));
    const tagA = g.begin("a");
    const ra = await listFiles("luo", "a");
    assert.ok(apply(tagA, ra), "A 加载成功（旧数据建立）");
    assert.equal(view.entries.length, 1, "旧数据 = A 的列表");

    // 进入目录 B → B 的列表请求 500
    route(new RegExp(`^${P}/b/$`), () => json(500, { message: "boom" }));
    const tagB = g.begin("b");
    let err: unknown;
    try {
      await listFiles("luo", "b");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof HumanFilesError, "listFiles 抛 HumanFilesError");
    assert.equal((err as { status: number }).status, 500);

    const applied = applyErr(tagB, 500, "加载失败：HTTP 500: boom");
    assert.ok(applied, "失败状态被应用（标签仍最新）");
    assert.equal(applied.status, "err");
    assert.equal(applied.error, "加载失败：HTTP 500: boom");
    assert.deepEqual(view.entries, [], "列表被清空（旧数据不保留）");
    assert.equal(view.status, "err", "错误状态暴露（UI 渲染 Alert + 重试）");
    assert.ok(calls.includes(`${P}/b/`), "B 目录端点确实被请求");
  });

  // ③ 已切走目录的失败 → 丢弃（不污染新目录状态）
  await ok("③ 已切走目录 A 的 500 被丢弃（不污染 B 的状态）", async () => {
    reset();
    let releaseA: (v: Response) => void = () => {};
    route(new RegExp(`^${P}/a/$`), () => new Promise<Response>((res) => { releaseA = res; }));
    route(new RegExp(`^${P}/b/$`), () => json(200, { path: "files/b/", entries: [E("b.txt", "file")] }));

    const tagA = g.begin("a");
    const pa = listFiles("luo", "a"); // A 在途
    const tagB = g.begin("b");
    const rb = await listFiles("luo", "b");
    assert.ok(apply(tagB, rb), "B 应用");

    releaseA(json(500, { message: "boom" }));
    let err: unknown;
    try {
      await pa;
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof HumanFilesError && (err as { status: number }).status === 500);
    assert.equal(applyErr(tagA, 500, "boom"), null, "A 的过期错误被丢弃");
    assert.deepEqual(view.entries, [E("b.txt", "file")], "列表仍是 B 的");
    assert.equal(view.status, "", "B 的成功状态未被 A 的失败污染");
  });

  // ④ 404 → status=404（占位卡语义，无错误文案；轮询停重试由组件门控）
  await ok("④ 404 → status=404 占位语义（无错误文案）", async () => {
    reset();
    route(new RegExp(`^${P}/missing/$`), () => json(404, { message: "not found" }));
    const tag = g.begin("missing");
    let err: unknown;
    try {
      await listFiles("luo", "missing");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof HumanFilesError && (err as { status: number }).status === 404);
    const applied = applyErr(tag, 404, "");
    assert.ok(applied, "404 状态被应用");
    assert.equal(applied.status, "404");
    assert.equal(applied.error, "");
  });

  // ⑤ 接线：shipped 实现导出守卫且契约完整
  await ok("⑤ humanFiles.ts 接线（DirListGuard 导出 + 契约方法齐备）", () => {
    for (const s of ["export class DirListGuard", "applyResult(tag: string", "applyError(tag: string", "begin(dir: string): string"]) {
      assert.ok(src.includes(s), `缺 ${s}`);
    }
  });

  console.log(`\nh1-files-nav: ${n} passed`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
