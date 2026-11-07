// C2b：人员详情 → 模型授权区（Human CR spec.modelAccess，#1513 管理员面）。
// - api/domains/modelAccess（human 级）纯函数 + 注入断言
//   （esbuild bundle + window shim + host.fetch 注入；先例 c2-model-access）：
//   ① entries 成对校验（findPairIssues / isCompletePair）
//   ② inherit 开关序列化（serializeScope：spawn/CLI inherit=true → {inherit:true}，
//      entries 丢弃；main 无 inherit；role 空白省略；空 scope → null）
//   ③ 保存只改 modelAccess（读-改-写 mock 断言：完整 CR 其余字段原样带回；
//      payload=null → 字段移除=fail-closed；PUT 405 → PATCH merge-patch 兜底；
//      flat 形状 → spec-direct body）
//   + getHumanModelAccess（resolve=1 提取 / 404 降级）+ 共享表 404 降级
//   + allSurfacesLocked 全锁判定
// - ModelAccessEditor / PeopleSection / i18n(manage.ts) 源码断言
//   （组件依赖 window.QwenPaw host，node 不可直 import）。
// 双跑：node 直跑 = 自执行（下方 ok/okAsync 立即断言）；
// 主控 `npx vitest run` 时按 __vitest_worker__ 注册同一组用例（文件末尾）。
// 直跑：node --experimental-strip-types frontend/tests/c2b-human-model-access.test.ts
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectionReadyToCommit } from "../src/lib/modelSelection.ts";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const editorSrc = readFileSync(
  new URL("../src/components/ModelAccessEditor.tsx", import.meta.url),
  "utf8",
);
const peopleSrc = readFileSync(
  new URL("../src/manage/PeopleSection.tsx", import.meta.url),
  "utf8",
);
const manageI18nSrc = readFileSync(
  new URL("../src/i18n/domains/manage.ts", import.meta.url),
  "utf8",
);

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const cases: Case[] = [];
let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  cases.push({ name, fn });
  console.log(`  PASS ${n} ${name}`);
}
async function okAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n += 1;
  cases.push({ name, fn });
  console.log(`  PASS ${n} ${name}`);
}

// ── ① entries 成对校验 ──────────────────────────────────────────────
// （纯函数在 bundle 内；断言在注入段执行——见下方 ma 导入后）

// ── 注入段：window shim → esbuild bundle → 动态 import ──────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "c2b-human-model-access-"));
let ma: typeof import("../src/api/domains/modelAccess");
try {
  // shared.requestJsonFull 每次调用读 window.QwenPaw.host——最小 shim
  // （kind 缺省 → hostKind 回退 server，不走 localStorage 模拟层）。
  const hostShim: {
    fetch: ((p: string, init?: unknown) => Promise<unknown>) | null;
  } = { fetch: null };
  (globalThis as Record<string, unknown>).window = {
    QwenPaw: { host: hostShim },
  };

  buildSync({
    entryPoints: [path.join(here, "..", "src", "api", "domains", "modelAccess.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "modelAccess.mjs"),
  });
  ma = (await import(path.join(tmp, "modelAccess.mjs"))) as typeof import(
    "../src/api/domains/modelAccess"
  );

  const jsonRes = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  type Call = { path: string; method?: string; body?: unknown };

  // ── ① entries 成对校验（findPairIssues / isCompletePair）──────────
  ok("① findPairIssues：main 行1缺 model + spawn 行0缺 provider → 精确 issue 列表", () => {
    const scope = {
      role: "*",
      main: { entries: [{ provider: "q", model: "m1" }, { provider: "q", model: "" }] },
      spawn: { entries: [{ provider: "", model: "m" }] },
      codingCli: { "qwen-code": { entries: [{ provider: "p", model: "m" }] } },
    };
    assert.deepEqual(ma.findPairIssues(scope), [
      { surface: "main", index: 1 },
      { surface: "spawn", index: 0 },
    ]);
  });

  ok("① findPairIssues：codingCli 行带 cli 名；全完整 → []；null/undefined/entries 非数组 → []", () => {
    const scope = {
      codingCli: {
        "qwen-code": { entries: [{ provider: "p", model: "m" }, { model: "x" }] },
        opencode: { entries: [{ provider: "p2", model: "m2" }] },
      },
    };
    assert.deepEqual(ma.findPairIssues(scope), [
      { surface: "codingCli", cli: "qwen-code", index: 1 },
    ]);
    assert.deepEqual(
      ma.findPairIssues({
        main: { entries: [{ provider: "a", model: "b" }] },
        spawn: { entries: [{ provider: "a", model: "b" }] },
      }),
      [],
    );
    assert.deepEqual(ma.findPairIssues(null), []);
    assert.deepEqual(ma.findPairIssues(undefined), []);
    assert.deepEqual(ma.findPairIssues({ main: { entries: null } }), []);
    assert.deepEqual(ma.findPairIssues({ main: {} }), []);
  });

  ok("① isCompletePair：provider/model 必须都是非空（trim 后）字符串", () => {
    assert.equal(ma.isCompletePair({ provider: "q", model: "m" }), true);
    assert.equal(ma.isCompletePair({ provider: "q", model: "" }), false);
    assert.equal(ma.isCompletePair({ provider: "  ", model: "m" }), false);
    assert.equal(ma.isCompletePair({ provider: "q" }), false);
    assert.equal(ma.isCompletePair({ model: "m" }), false);
    assert.equal(ma.isCompletePair(null), false);
    assert.equal(ma.isCompletePair("q/m"), false);
  });

  // ── ② inherit 开关序列化（spawn/CLI）─────────────────────────────
  ok("② serializeScope：spawn inherit=true → {inherit:true}（entries 丢弃，继承优先）", () => {
    const s = ma.serializeScope({
      role: "*",
      spawn: { inherit: true, entries: [{ provider: "p", model: "m" }] },
    });
    assert.deepEqual(s, { role: "*", spawn: { inherit: true } });
  });

  ok("② serializeScope：inherit 省略 + entries → 只留完整对（不完整行丢弃）", () => {
    const s = ma.serializeScope({
      spawn: {
        entries: [{ provider: "p", model: "m" }, { provider: "x", model: "" }],
      },
    });
    assert.deepEqual(s, { spawn: { entries: [{ provider: "p", model: "m" }] } });
  });

  ok("② serializeScope：CLI inherit=true → codingCli 数组项 {cli, inherit:true}；CLI 名 trim、空白名丢弃", () => {
    const s = ma.serializeScope({
      codingCli: {
        "qwen-code": { inherit: true, entries: [{ provider: "p", model: "m" }] },
        "  ": { entries: [{ provider: "p", model: "m" }] },
      },
    });
    // CRD 契约：codingCli 是数组（[]ModelAccessCli），不是 map。
    assert.deepEqual(s, { codingCli: [{ cli: "qwen-code", inherit: true }] });
  });

  ok("② serializeScope：main 无 inherit（不写 inherit 键）；role 空白省略键；table 保留", () => {
    const s = ma.serializeScope({
      table: "std-workers",
      main: { entries: [{ provider: "q", model: "m" }] },
    });
    assert.deepEqual(s, {
      table: "std-workers",
      main: { entries: [{ provider: "q", model: "m" }] },
    });
    assert.ok(!("inherit" in (s.main as Record<string, unknown>)));
    assert.deepEqual(ma.serializeScope({ role: "   " }), null);
    assert.deepEqual(ma.serializeScope({}), null);
    assert.deepEqual(ma.serializeScope(null), null);
  });

  ok("② buildModelAccessPayload：undefined/全空 → null（清除=fail-closed）；只留有效 scope", () => {
    assert.equal(ma.buildModelAccessPayload(undefined), null);
    assert.equal(ma.buildModelAccessPayload(null), null);
    assert.equal(ma.buildModelAccessPayload({ scopes: [{ role: "  " }, {}] }), null);
    assert.deepEqual(
      ma.buildModelAccessPayload({
        scopes: [{ role: "worker", table: "std-workers" }, {}],
      }),
      { scopes: [{ role: "worker", table: "std-workers" }] },
    );
  });

  // ── ③ 保存只改 modelAccess（读-改-写，mock 断言）─────────────────
  const fullCr = {
    apiVersion: "agentteams.io/v1beta1",
    kind: "Human",
    metadata: { name: "alice", labels: { team: "core" } },
    spec: {
      displayName: "Alice",
      permissionLevel: 1,
      accessibleTeams: ["t1"],
      modelAccess: { scopes: [{ role: "worker", table: "old" }] },
      note: "keep me",
    },
  };
  const payload = {
    scopes: [
      {
        role: "*",
        main: { entries: [{ provider: "qwen", model: "qwen3.6-27b-fp8" }] },
        spawn: { inherit: true },
      },
    ],
  };

  await okAsync(
    "③ saveHumanModelAccess：完整 CR 形状 → PUT 整体 CR，只改 spec.modelAccess，其余字段原样带回",
    async () => {
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, fullCr); // GET 读现状
      };
      const r = await ma.saveHumanModelAccess("alice", payload);
      assert.equal(r.method, "PUT");
      const put = calls.find((c) => c.method === "PUT");
      assert.ok(put, "应发一次 PUT");
      assert.equal(put.path, "/agentteams-proxy/controller/api/v1/humans/alice");
      assert.deepEqual(put.body, {
        apiVersion: fullCr.apiVersion,
        kind: fullCr.kind,
        metadata: fullCr.metadata,
        spec: {
          displayName: "Alice",
          permissionLevel: 1,
          accessibleTeams: ["t1"],
          note: "keep me",
          modelAccess: payload, // 仅此字段被替换
        },
      });
    },
  );

  await okAsync(
    "③ saveHumanModelAccess：payload=null → PUT body 的 spec 无 modelAccess 键（清除=fail-closed）",
    async () => {
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, fullCr);
      };
      const r = await ma.saveHumanModelAccess("alice", null);
      assert.equal(r.method, "PUT");
      const put = calls.find((c) => c.method === "PUT");
      const spec = (put!.body as Record<string, unknown>).spec as Record<string, unknown>;
      assert.ok(!("modelAccess" in spec), "清除后 spec 不应带 modelAccess 键");
      assert.deepEqual(spec, {
        displayName: "Alice",
        permissionLevel: 1,
        accessibleTeams: ["t1"],
        note: "keep me",
      });
    },
  );

  await okAsync(
    "③ saveHumanModelAccess：PUT 405（旧控制器无端点）→ PATCH merge-patch 兜底（只发 spec.modelAccess）",
    async () => {
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(405, { message: "method not allowed" });
        if (i?.method === "PATCH") return jsonRes(200, {});
        return jsonRes(200, fullCr);
      };
      const r = await ma.saveHumanModelAccess("alice", payload);
      assert.equal(r.method, "PATCH");
      const patch = calls.find((c) => c.method === "PATCH");
      assert.ok(patch, "405 后应发 PATCH");
      assert.equal(patch.path, "/agentteams-proxy/controller/api/v1/humans/alice");
      assert.deepEqual(patch.body, { spec: { modelAccess: payload } });
    },
  );

  await okAsync(
    "③ saveHumanModelAccess：flat 形状（本控制器 /humans 惯例）→ PUT spec-direct，其余字段原样带回",
    async () => {
      const flatCr = { name: "bob", permissionLevel: 2, accessibleTeams: ["t2"], note: "flat" };
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, flatCr);
      };
      const r = await ma.saveHumanModelAccess("bob", payload);
      assert.equal(r.method, "PUT");
      const put = calls.find((c) => c.method === "PUT");
      assert.deepEqual(put!.body, {
        name: "bob",
        permissionLevel: 2,
        accessibleTeams: ["t2"],
        note: "flat",
        modelAccess: payload,
      });
    },
  );

  // ── getHumanModelAccess：resolve=1 提取 / 404 降级 ────────────────
  await okAsync(
    "getHumanModelAccess：plain CR + resolve=1 → modelAccess 取 plain 配置值、capabilities 取 resolve（writeVia 数组 / status）",
    async () => {
      const crWithCaps = {
        metadata: { name: "alice" },
        spec: {
          displayName: "Alice",
          modelAccess: {
            scopes: [{ role: "*", main: { entries: [{ provider: "q", model: "m" }] } }],
            capabilities: {
              main: { canEdit: true, writeVia: ["human"], reason: "direct" },
              spawn: { canEdit: false, inherit: true, inheritedFrom: "main" },
              codingCli: {
                "qwen-code": { canEdit: false, status: "cli_not_granted", reason: "not granted" },
              },
            },
          },
        },
      };
      hostShim.fetch = async (p: string) => {
        if (p.endsWith("?resolve=1")) return jsonRes(200, crWithCaps);
        return jsonRes(200, fullCr);
      };
      const v = await ma.getHumanModelAccess("alice");
      // modelAccess 恒取自 plain GET（配置值，编辑面基准）；capabilities 才来自 resolve 响应
      assert.deepEqual(v.modelAccess, { scopes: [{ role: "worker", table: "old" }] });
      assert.equal(v.capabilities?.main?.canEdit, true);
      assert.deepEqual(v.capabilities?.main?.writeVia, ["human"]);
      assert.equal(v.capabilities?.main?.reason, "direct");
      assert.equal(v.capabilities?.codingCli?.["qwen-code"]?.status, "cli_not_granted");
    },
  );

  await okAsync(
    "getHumanModelAccess：resolve=1 404（旧控制器）→ capabilities=null 降级，主读 modelAccess 仍取",
    async () => {
      hostShim.fetch = async (p: string) => {
        if (p.endsWith("?resolve=1")) return jsonRes(404, { detail: "no resolve" });
        return jsonRes(200, fullCr);
      };
      const v = await ma.getHumanModelAccess("alice");
      assert.equal(v.capabilities, null);
      assert.deepEqual(v.modelAccess, { scopes: [{ role: "worker", table: "old" }] });
    },
  );

  // ── 共享表端点（404 降级 = 隐藏表选择器）──────────────────────────
  await okAsync(
    "listModelAccessTables：404 → {supported:false, tables:[]}（不抛错）",
    async () => {
      hostShim.fetch = async () => jsonRes(404, { detail: "Not Found" });
      assert.deepEqual(await ma.listModelAccessTables(), { supported: false, tables: [] });
    },
  );

  await okAsync(
    "listModelAccessTables：200 宽松形状（items+metadata.name / 纯字符串数组）→ 表名去重列表",
    async () => {
      hostShim.fetch = async (p: string) => {
        if (p.endsWith("model-access-tables")) {
          return jsonRes(200, {
            items: [
              { metadata: { name: "std-workers" } },
              { name: "dev" },
              { metadata: { name: "std-workers" } },
              { metadata: {} },
            ],
          });
        }
        return jsonRes(200, { names: ["a", "a", "b"] });
      };
      assert.deepEqual(await ma.listModelAccessTables(), {
        supported: true,
        tables: ["std-workers", "dev"],
      });
      // 纯字符串数组形状
      hostShim.fetch = async () => jsonRes(200, ["t1", "t2"]);
      assert.deepEqual(await ma.listModelAccessTables(), {
        supported: true,
        tables: ["t1", "t2"],
      });
    },
  );

  await okAsync(
    "getModelAccessTable：404 → {supported:false}；200 {entries:[...]} → 只留合法对",
    async () => {
      hostShim.fetch = async () => jsonRes(404, { detail: "nf" });
      assert.deepEqual(await ma.getModelAccessTable("std-workers"), {
        supported: false,
        entries: [],
        raw: null,
      });
      hostShim.fetch = async () =>
        jsonRes(200, {
          entries: [
            { provider: "q", model: "m1" },
            { provider: "q", model: "" },
            null,
          ],
        });
      const d = await ma.getModelAccessTable("std-workers");
      assert.equal(d.supported, true);
      assert.deepEqual(d.entries, [{ provider: "q", model: "m1" }]);
    },
  );

  // ── allSurfacesLocked（整体只读判定）──────────────────────────────
  ok("allSurfacesLocked：null → false；main+spawn 均 false → true；CLI 全 false → true；任一可编辑 → false", () => {
    assert.equal(ma.allSurfacesLocked(null), false);
    assert.equal(
      ma.allSurfacesLocked({ main: { canEdit: false }, spawn: { canEdit: false } }),
      true,
    );
    assert.equal(
      ma.allSurfacesLocked({
        main: { canEdit: false },
        spawn: { canEdit: false },
        codingCli: { q: { canEdit: false } },
      }),
      true,
    );
    assert.equal(
      ma.allSurfacesLocked({ main: { canEdit: false }, spawn: { canEdit: true } }),
      false,
    );
    assert.equal(
      ma.allSurfacesLocked({
        main: { canEdit: false },
        spawn: { canEdit: false },
        codingCli: { q: undefined },
      }),
      false, // CLI 值非法（非 capability）→ 不宣称全锁（防御）
    );
    assert.equal(
      ma.allSurfacesLocked({
        main: { canEdit: false },
        spawn: { canEdit: false },
        codingCli: { q: { canEdit: false }, z: { canEdit: true } },
      }),
      false,
    );
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── 源码断言（组件依赖 window.QwenPaw host，node 不可直 import）────
ok("editor：多选式录入（provider→model）+ 成对校验红字 + inherit Switch + 只读回显 + tables=null 隐藏表选择器", () => {
  assert.match(editorSrc, /Provider 与 model 必须成对填写/);
  assert.match(editorSrc, /antd\.Switch/);
  assert.match(editorSrc, /cap\.writeVia/);
  assert.match(editorSrc, /cap\.reason/);
  assert.match(editorSrc, /tables && tables\.length/);
  // F-CFG-4：不再逐行增删——provider / model 两个多选框（可搜索），
  // 模型候选按所选 provider 过滤（modelsByProvider）。
  assert.match(editorSrc, /mode="multiple"/);
  assert.match(editorSrc, /modelsByProvider/);
  assert.match(editorSrc, /selectionToPairs/);
  assert.doesNotMatch(editorSrc, /添加行/);
  assert.match(editorSrc, /写入路径：\{via\}/);
});

ok("PeopleSection：人员详情模型授权卡 + 读-改-写链 + fail-closed 提示 + 只读条件（非 admin / 全锁）", () => {
  assert.match(peopleSrc, /getHumanModelAccess\(human\.name\)/);
  assert.match(peopleSrc, /saveHumanModelAccess\(human\.name, buildModelAccessPayload\(draft\)\)/);
  assert.match(peopleSrc, /fail-closed/);
  assert.match(peopleSrc, /readOnly=\{!isAdmin \|\| allLocked\}/);
  assert.match(peopleSrc, /<BrainIcon/);
});

ok("i18n：C2b 键齐全（manage.ts；复用键不重登）", () => {
  for (const key of [
    '"模型授权":',
    '"模型授权（{name}）":',
    '"添加作用域":',
    '"Provider 与 model 必须成对填写":',
    '"未配置模型授权（fail-closed）：该人员名下的 Worker 默认全部模型锁定":',
    '"只读：当前授权由上游继承或策略限制（各分区有原因提示）":',
    '"写入路径：{via}":',
    '"共享表与内联 entries 二选一，内联 entries 优先":',
  ]) {
    assert.ok(manageI18nSrc.includes(key), `manage.ts 缺键：${key}`);
  }
  // 复用既有键、不重复登记
  assert.doesNotMatch(manageI18nSrc, /"保存失败":/);
  assert.doesNotMatch(manageI18nSrc, /"Provider":/);
  assert.doesNotMatch(manageI18nSrc, /"可编辑":/);
});


  ok("多选提交门：只选 provider 不提交（否则整条 CLI 授权被删）", () => {
    assert.equal(selectionReadyToCommit({ providers: ["deepseek"], models: [] }), false);
    assert.equal(selectionReadyToCommit({ providers: ["deepseek"], models: ["m1"] }), true);
    assert.equal(selectionReadyToCommit({ providers: [], models: [] }), true); // 全清 = 删除
  });

console.log(`\nc2b-human-model-access: ${n} passed`);

// ── vitest 双跑：主控 `npx vitest run` 时注册同一组用例（node 直跑时
// __vitest_worker__ 缺失 → 跳过，上方已自执行）。.mjs 已删但 ESM 模块
// 缓存按 URL 命中，注入用例可安全重跑（hostShim.fetch 每用例内重注入）。──
if ((globalThis as Record<string, unknown>).__vitest_worker__) {
  const vt = await import("vitest") as {
    test: (name: string, fn: () => void | Promise<void>) => void;
  };
  for (const c of cases) vt.test(c.name, () => c.fn());
}
