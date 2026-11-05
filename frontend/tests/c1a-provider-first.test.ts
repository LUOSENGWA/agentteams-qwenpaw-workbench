// C1a-1：模型设置统一「先 Provider 后模型」——纯函数单测。
// 直跑：node --experimental-strip-types frontend/tests/c1a-provider-first.test.ts
//（node:assert/strict；≥8 case；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：modelUnion.ts 顶层有 `const host = window.QwenPaw.host;`
//（插件宿主注入）+ 无扩展名相对 import（`./api`/`./modelCatalog`，node ESM
// 要求显式扩展名而无法解析）→ 照仓库 scripts/requestCache.smoke.mjs 先例，
// 用 esbuild buildSync 把 src/modelUnion.ts bundle 到临时 .mjs（先注入
// window 最小 shim），再动态 import 断言。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "c1a-provider-first-"));
try {
  // modelUnion.ts 顶层 const 需要插件宿主——最小 shim 即可
  //（被测纯函数不触 host；api 依赖链已审计：顶层无浏览器全局访问）。
  (globalThis as Record<string, unknown>).window = { QwenPaw: { host: {} } };

  buildSync({
    entryPoints: [path.join(here, "..", "src", "modelUnion.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "modelUnion.mjs"),
  });

  const mod = (await import(path.join(tmp, "modelUnion.mjs"))) as {
    filterModelOptionsByProvider: (
      allOptions: unknown[],
      gatewayOptions: unknown[],
      provider: string,
    ) => unknown[];
    providerModelMismatch: (
      gatewayOptions: unknown[],
      model: string,
      provider: string,
    ) => boolean;
  };
  const { filterModelOptionsByProvider, providerModelMismatch } = mod;

  // ── fixtures（与 buildModelOptionGroups 输出同形）────────────────
  // gatewayOptions：alias-a/alias-c → provX，alias-b → provY；
  // builtin 无 binding（不属于任何 Provider）。
  const gw = [
    {
      alias: "alias-a",
      kind: "configured",
      binding: { providerName: "provX", routeName: "r1", targetModel: "real-a" },
    },
    {
      alias: "alias-b",
      kind: "configured",
      binding: { providerName: "provY", routeName: "r2", targetModel: "real-b" },
    },
    {
      alias: "alias-c",
      kind: "configured",
      binding: { providerName: "provX", routeName: "r3", targetModel: "real-c" },
    },
    { alias: "gpt-5.4", kind: "builtin" },
    { alias: "qwen3.6-plus", kind: "builtin" },
  ];
  const grouped = [
    {
      value: "gateway-configured",
      label: "Higress alias（路由可解析）",
      options: [
        { value: "alias-a", label: "alias-a → r1/real-a" },
        { value: "alias-b", label: "alias-b → r2/real-b" },
        { value: "alias-c", label: "alias-c → r3/real-c" },
      ],
    },
    {
      value: "gateway-builtin",
      label: "Higress 内置 alias（需配路由映射）",
      options: [{ value: "gpt-5.4" }, { value: "qwen3.6-plus" }],
    },
    {
      value: "local",
      label: "在服+在用",
      options: [{ value: "qwen3.6:27b-fp8" }, { value: "local-m2" }],
    },
  ];
  const groupedBefore = JSON.parse(JSON.stringify(grouped));
  const flat = [
    { value: "qwen3.6:27b-fp8" },
    { value: "local-m2" },
    { value: "alias-a" },
    { value: "alias-b" },
    { value: "alias-c" },
  ];

  let n = 0;
  function ok(name: string, fn: () => void): void {
    fn();
    n += 1;
    console.log(`  PASS ${n} ${name}`);
  }

  // ── filterModelOptionsByProvider ─────────────────────────────────
  ok("filter provider 为空 → 原样返回（同一引用）", () => {
    assert.equal(filterModelOptionsByProvider(grouped, gw, ""), grouped);
    assert.equal(filterModelOptionsByProvider(grouped, gw, "   "), grouped);
  });

  ok("filter 分组 + provX → 只留 alias-a/alias-c（原标签保留），builtin 组落空，在服+在用恒保留", () => {
    assert.deepEqual(filterModelOptionsByProvider(grouped, gw, "provX"), [
      {
        value: "gateway-configured",
        label: "Higress alias（路由可解析）",
        options: [
          { value: "alias-a", label: "alias-a → r1/real-a" },
          { value: "alias-c", label: "alias-c → r3/real-c" },
        ],
      },
      {
        value: "local",
        label: "在服+在用",
        options: [{ value: "qwen3.6:27b-fp8" }, { value: "local-m2" }],
      },
    ]);
  });

  ok("filter 分组 + provY → configured 组只剩 alias-b", () => {
    assert.deepEqual(filterModelOptionsByProvider(grouped, gw, "provY"), [
      {
        value: "gateway-configured",
        label: "Higress alias（路由可解析）",
        options: [{ value: "alias-b", label: "alias-b → r2/real-b" }],
      },
      {
        value: "local",
        label: "在服+在用",
        options: [{ value: "qwen3.6:27b-fp8" }, { value: "local-m2" }],
      },
    ]);
  });

  ok("filter 分组 + 未知 provider → 只剩在服+在用组", () => {
    assert.deepEqual(filterModelOptionsByProvider(grouped, gw, "noSuchProv"), [
      {
        value: "local",
        label: "在服+在用",
        options: [{ value: "qwen3.6:27b-fp8" }, { value: "local-m2" }],
      },
    ]);
  });

  ok("filter 平铺 + provX → 非网关条目保留 + 命中 alias 保留", () => {
    assert.deepEqual(filterModelOptionsByProvider(flat, gw, "provX"), [
      { value: "qwen3.6:27b-fp8" },
      { value: "local-m2" },
      { value: "alias-a" },
      { value: "alias-c" },
    ]);
  });

  ok("filter 平铺 + 未知 provider → 只剩非网关条目", () => {
    assert.deepEqual(filterModelOptionsByProvider(flat, gw, "noSuchProv"), [
      { value: "qwen3.6:27b-fp8" },
      { value: "local-m2" },
    ]);
  });

  ok("filter 不 mutate 入参", () => {
    filterModelOptionsByProvider(grouped, gw, "provX");
    assert.deepEqual(grouped, groupedBefore);
  });

  // ── providerModelMismatch ────────────────────────────────────────
  ok("mismatch configured alias 的 Provider ≠ 所选 → true", () => {
    assert.equal(providerModelMismatch(gw, "alias-a", "provY"), true);
  });

  ok("mismatch configured alias 的 Provider = 所选 → false", () => {
    assert.equal(providerModelMismatch(gw, "alias-a", "provX"), false);
  });

  ok("mismatch 在服模型（非 configured alias）→ false", () => {
    assert.equal(providerModelMismatch(gw, "qwen3.6:27b-fp8", "provX"), false);
  });

  ok("mismatch builtin alias（无 binding）→ false", () => {
    assert.equal(providerModelMismatch(gw, "gpt-5.4", "provX"), false);
  });

  ok("mismatch 任一为空 → false（未选 Provider 不做失配判定）", () => {
    assert.equal(providerModelMismatch(gw, "alias-a", ""), false);
    assert.equal(providerModelMismatch(gw, "", "provX"), false);
    assert.equal(providerModelMismatch(gw, "  ", "provX"), false);
  });

  console.log(`\nc1a-provider-first: ${n} passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
