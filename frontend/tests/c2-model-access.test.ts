// C2：接入 Model Access 数据面（#1513）——模型设置的授权/继承/锁定展示。
// - lib/modelAccess 纯函数行为断言（node 直 import：surfaceBadge 五态 /
//   grantedPairs / pairAllowed（含「provider 与 model 不能各取各的」交叉
//   用例）/ lockedAll）；
// - api/domains/modelAccess 的 404 → unsupported（不抛错）/ 500 照抛 /
//   200 透传（esbuild bundle + window shim + host.fetch 注入；先例
//   c1a-provider-first / scripts/requestCache.smoke.mjs）；
// - ModelEditModal / i18n 源码断言（locked 保存禁用 / catalogUnavailable
//   灰条 / 徽标五态 / CLI inherit 编辑禁用 / 授予集候选与保存门）。
// 直跑：node --experimental-strip-types frontend/tests/c2-model-access.test.ts
//（node:assert/strict；lib 模块 node 可直 import——仅 import type，运行时
// 零依赖；组件依赖 window.QwenPaw host，走源码文本断言）。
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

import {
  grantedPairs,
  lockedAll,
  pairAllowed,
  surfaceBadge,
} from "../src/lib/modelAccess.ts";

const modalSrc = readFileSync(
  new URL("../src/manage/ModelEditModal.tsx", import.meta.url),
  "utf8",
);
const apiSrc = readFileSync(
  new URL("../src/api/domains/modelAccess.ts", import.meta.url),
  "utf8",
);
const chatI18nSrc = readFileSync(
  new URL("../src/i18n/domains/chat.ts", import.meta.url),
  "utf8",
);
const workerI18nSrc = readFileSync(
  new URL("../src/i18n/domains/worker.ts", import.meta.url),
  "utf8",
);

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}
async function okAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── surfaceBadge：五态全覆盖 ─────────────────────────────────────────
ok("surfaceBadge：canEdit && !inherit → editable（含 inherit 显式 false）", () => {
  assert.deepEqual(surfaceBadge({ canEdit: true }), { kind: "editable" });
  assert.deepEqual(surfaceBadge({ canEdit: true, inherit: false }), {
    kind: "editable",
  });
});

ok("surfaceBadge：inherit → inherited（带来源）", () => {
  assert.deepEqual(
    surfaceBadge({ canEdit: false, inherit: true, inheritedFrom: "role:manager" }),
    { kind: "inherited", from: "role:manager" },
  );
});

ok("surfaceBadge：inherit 缺 inheritedFrom → from 空串（渲染层兜底显示）", () => {
  assert.deepEqual(surfaceBadge({ canEdit: false, inherit: true }), {
    kind: "inherited",
    from: "",
  });
});

ok("surfaceBadge：!canEdit && !inherit（无 status）→ readonly", () => {
  assert.deepEqual(surfaceBadge({ canEdit: false }), { kind: "readonly" });
  assert.deepEqual(surfaceBadge({ canEdit: false, inherit: false }), {
    kind: "readonly",
  });
});

ok("surfaceBadge：status cli_not_granted → not_granted（比 readonly 更具体，先于兜底）", () => {
  assert.deepEqual(
    surfaceBadge({ canEdit: false, inherit: false, status: "cli_not_granted" }),
    { kind: "not_granted" },
  );
});

ok("surfaceBadge：status byok_unsupported → byok", () => {
  assert.deepEqual(
    surfaceBadge({ canEdit: false, inherit: false, status: "byok_unsupported" }),
    { kind: "byok" },
  );
});

ok("surfaceBadge：防御（null/undefined/非对象 → readonly）；status not_granted 不映射徽标（契约只列 cli_not_granted）→ readonly", () => {
  assert.deepEqual(surfaceBadge(null), { kind: "readonly" });
  assert.deepEqual(surfaceBadge(undefined), { kind: "readonly" });
  assert.deepEqual(surfaceBadge("x" as never), { kind: "readonly" });
  assert.deepEqual(
    surfaceBadge({ canEdit: false, status: "not_granted" }),
    { kind: "readonly" },
  );
});

// ── grantedPairs ─────────────────────────────────────────────────────
ok("grantedPairs：main entries → 成对列表（方向/顺序保留）", () => {
  const s = {
    main: {
      entries: [
        { provider: "provA", model: "m1" },
        { provider: "provA", model: "m2" },
        { provider: "provB", model: "m3" },
      ],
    },
  };
  assert.deepEqual(grantedPairs(s, "main"), [
    { provider: "provA", model: "m1" },
    { provider: "provA", model: "m2" },
    { provider: "provB", model: "m3" },
  ]);
});

ok("grantedPairs：无 entries / surface 缺 / surfaces 缺 / 条目形状非法 → []（不炸）", () => {
  assert.deepEqual(grantedPairs({}, "main"), []);
  assert.deepEqual(grantedPairs({ main: {} }, "main"), []);
  assert.deepEqual(grantedPairs(null, "main"), []);
  assert.deepEqual(grantedPairs(undefined, "main"), []);
  assert.deepEqual(grantedPairs({ main: { entries: [] } }, "main"), []);
  assert.deepEqual(
    grantedPairs({ main: { entries: [null, 42, { provider: "p" }] } }, "main"),
    [],
  );
});

ok("grantedPairs：codingCli 需带 cli 名（错名/缺名 → []）", () => {
  const s = {
    codingCli: { "qwen-code": { entries: [{ provider: "openai", model: "gpt-4o" }] } },
  };
  assert.deepEqual(grantedPairs(s, "codingCli", "qwen-code"), [
    { provider: "openai", model: "gpt-4o" },
  ]);
  assert.deepEqual(grantedPairs(s, "codingCli", "opencode"), []);
  assert.deepEqual(grantedPairs(s, "codingCli"), []);
});

// ── pairAllowed：成对语义（provider 与 model 不能各取各的）──────────
ok("pairAllowed：pairs 空 → true（无限制，兼容旧控制器）", () => {
  assert.equal(pairAllowed([], "provA", "m1"), true);
  assert.equal(pairAllowed([], "", ""), true);
});

ok("pairAllowed：成对存在 → true", () => {
  const pairs = [
    { provider: "provA", model: "m1" },
    { provider: "provB", model: "m2" },
  ];
  assert.equal(pairAllowed(pairs, "provA", "m1"), true);
  assert.equal(pairAllowed(pairs, "provB", "m2"), true);
});

ok("pairAllowed：交叉用例——provider 来自 A、model 来自 B → false（不反向映射/不各取各的）", () => {
  const pairs = [
    { provider: "provA", model: "m1" },
    { provider: "provB", model: "m2" },
  ];
  assert.equal(pairAllowed(pairs, "provA", "m2"), false);
  assert.equal(pairAllowed(pairs, "provB", "m1"), false);
  assert.equal(pairAllowed(pairs, "provA", "nope"), false);
});

// ── lockedAll ────────────────────────────────────────────────────────
ok("lockedAll：null/undefined → false；locked true → true；false/缺 → false", () => {
  assert.equal(lockedAll(null), false);
  assert.equal(lockedAll(undefined), false);
  assert.equal(lockedAll({ capabilities: {}, surfaces: {}, locked: true }), true);
  assert.equal(lockedAll({ capabilities: {}, surfaces: {}, locked: false }), false);
  assert.equal(lockedAll({ capabilities: {}, surfaces: {} } as never), false);
});

// ── fetchModelAccess：404 → unsupported / 其它照抛 / 200 透传（注入）──
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "c2-model-access-"));
try {
  // shared.requestJsonFull 每次调用读 window.QwenPaw.host——最小 shim：
  // kind 缺省 → hostKind 回退 server（不走 localStorage 模拟层）。
  const hostShim: {
    fetch: ((path: string, init?: unknown) => Promise<unknown>) | null;
    lastPath: string | null;
  } = { fetch: null, lastPath: null };
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
  const maApi = (await import(path.join(tmp, "modelAccess.mjs"))) as {
    fetchModelAccess: (worker: string) => Promise<{
      access: unknown;
      unsupported: boolean;
    }>;
  };

  const jsonRes = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });

  await okAsync("fetchModelAccess：404（旧版 controller 无端点）→ {access:null, unsupported:true}，不抛错", async () => {
    hostShim.fetch = async (p: string) => {
      hostShim.lastPath = p;
      return jsonRes(404, { detail: "Not Found" });
    };
    const r = await maApi.fetchModelAccess("w-1");
    assert.deepEqual(r, { access: null, unsupported: true });
    assert.ok(
      hostShim.lastPath ===
        "/agentteams-proxy/controller/api/v1/model-access?worker=w-1",
      `实际请求路径：${hostShim.lastPath}`,
    );
  });

  await okAsync("fetchModelAccess：500 → 照抛（HTTP 500，不降级）", async () => {
    hostShim.fetch = async () => jsonRes(500, { message: "boom" });
    await assert.rejects(maApi.fetchModelAccess("w-1"), /HTTP 500/);
  });

  await okAsync("fetchModelAccess：200 → 透传 payload（locked 等字段原样），unsupported false", async () => {
    const payload = {
      capabilities: {
        main: { canEdit: true },
        spawn: { canEdit: false, inherit: true, inheritedFrom: "role:manager" },
      },
      surfaces: {
        main: { entries: [{ provider: "p", model: "m" }] },
        codingCli: { "qwen-code": { entries: [] } },
      },
      current: { model: "m", modelProvider: "p", subagentModel: "" },
      locked: true,
      catalogUnavailable: true,
    };
    hostShim.fetch = async () => jsonRes(200, payload);
    const r = await maApi.fetchModelAccess("w-2");
    assert.equal(r.unsupported, false);
    assert.deepEqual(r.access, payload);
    assert.equal((r.access as { locked: boolean }).locked, true);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── ModelEditModal：源码断言（依赖 window.QwenPaw host，node 不可直 import）──
ok("locked 时保存按钮禁用（okButtonProps 含 locked + 两 surface 的 pair 门）", () => {
  assert.match(
    modalSrc,
    /okButtonProps=\{\{ disabled: !dirty \|\| locked \|\| !mainPairOk \|\| !subagentPairOk \}\}/,
  );
});

ok("打开时（有 workerName）拉取 fetchModelAccess；非 404 错误 catch 降级为无授权信息", () => {
  assert.match(modalSrc, /if \(!open \|\| !workerName\)/);
  assert.match(modalSrc, /fetchModelAccess\(workerName\)/);
  assert.match(modalSrc, /\.catch\(\(\) => \{/);
});

ok("locked → 顶部提示「当前账号未被授予任何模型，请联系管理员（Model Access）」；catalogUnavailable → 灰条「模型目录暂不可用」", () => {
  assert.ok(
    modalSrc.includes(`tr("当前账号未被授予任何模型，请联系管理员（Model Access）")`),
  );
  assert.match(modalSrc, /access\.catalogUnavailable === true/);
  assert.ok(modalSrc.includes(`tr("模型目录暂不可用")`));
});

ok("主模型区/子代理区各一枚授权徽标（accessBadge × 2 + CodingCLI 行 × 1）；locked 时主/子代理控件禁用", () => {
  assert.match(modalSrc, /accessBadge\(access\?\.capabilities\?\.main, tr\)/);
  assert.match(modalSrc, /accessBadge\(access\?\.capabilities\?\.spawn, tr\)/);
  assert.match(modalSrc, /accessBadge\(cap, tr\)/);
  assert.match(modalSrc, /disabled=\{locked\}/);
  assert.match(modalSrc, /disabled=\{subagentSame \|\| locked\}/);
});

ok("徽标五态文案齐（可编辑/继承自 {x}/只读/未授权/BYOK 不支持）；继承缺来源用 — 兜底", () => {
  assert.match(modalSrc, /tr\("可编辑"\)/);
  assert.match(modalSrc, /tr\("继承自 \{x\}", \{ x: b\.from \|\| "—" \}\)/);
  assert.match(modalSrc, /tr\("只读"\)/);
  assert.match(modalSrc, /tr\("未授权"\)/);
  assert.match(modalSrc, /tr\("BYOK 不支持"\)/);
});

ok("CodingCLI：inherit / !canEdit / locked → 编辑禁用；grant 对传入修改弹层", () => {
  assert.match(modalSrc, /cap \? cap\.inherit \|\| !cap\.canEdit : false/);
  assert.match(modalSrc, /lockedAll\(access\)/);
  assert.match(modalSrc, /grantedPairs\(access\.surfaces, "codingCli", editing\)/);
});

ok("授予集合对限制：主区 provider/模型候选来自授予对；CLI 弹层保存门含 pairOk（不在授予集 → 禁用 + 提示）", () => {
  assert.match(modalSrc, /mainPairs\.filter\(\(p\) => p\.provider === provider\)/);
  assert.match(modalSrc, /pairAllowed\(mainPairs, provider, model\)/);
  assert.match(modalSrc, /okButtonProps=\{\{ disabled: saving \|\| model\.trim\(\) === "" \|\| !pairOk \}\}/);
  assert.ok(modalSrc.includes(`tr("该组合不在授权范围")`));
});

// ── api 域：404 降级源码断言（行为已由注入用例覆盖）─────────────────
ok("api：404 → unsupported（httpErrorStatus 判定）+ 其它错误照抛 + 端点路径", () => {
  assert.match(apiSrc, /\/agentteams-proxy\/controller\/api\/v1\/model-access\?worker=\$\{encodeURIComponent\(/);
  assert.match(apiSrc, /httpErrorStatus\(e\) === 404/);
  assert.match(apiSrc, /if \(httpErrorStatus\(e\) === 404\) return \{ access: null, unsupported: true \};\n    throw e;/);
});

// ── i18n：C2 七新键齐（chat.ts）+ 「只读」复用 worker.ts 不重复 ──────
ok("i18n：C2 七键齐（精确键形）", () => {
  for (const key of [
    '"可编辑":',
    '"继承自 {x}":',
    '"未授权":',
    '"BYOK 不支持":',
    '"当前账号未被授予任何模型，请联系管理员（Model Access）":',
    '"模型目录暂不可用":',
    '"该组合不在授权范围":',
  ]) {
    assert.ok(chatI18nSrc.includes(key), `chat.ts 缺键：${key}`);
  }
});

ok("i18n：「只读」复用 worker.ts 既有键（chat.ts 不重复定义）", () => {
  assert.doesNotMatch(chatI18nSrc, /"只读":/);
  assert.ok(workerI18nSrc.includes('"只读":'));
});

console.log(`\nc2-model-access: ${n} passed`);
