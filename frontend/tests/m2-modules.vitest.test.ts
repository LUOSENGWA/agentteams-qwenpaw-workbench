/**
 * M2（#1526 模块更新，三平面）— api/domains/modules 域单测（vitest 风格）。
 *
 * 运行：npx vitest run（vitest.config.ts 把 include 限定在
 * *.vitest.test.ts；既有 14 个 tests/*.test.ts 为 node-assert 风格，
 * 走 node --experimental-strip-types，不进 vitest 面）。
 *
 * 覆盖（任务书 ≥3 条）：
 * ① 索引参数拼装（URLSearchParams 编码，含 ref 空白→main 默认）；
 * ② 安装 payload 逐字段（三平面路径编码 + body 逐字段相等）；
 * ③ 404 → {supported:false, reason:"controller_too_old"} 降级（三平面读）
 *    + 非 404（502）原样上抛 + 索引 404 上抛（语义区分：索引=空态、读=不支持）；
 * bonus：读 200 形态、moduleEntryVersions 两形态宽容解析、
 * compareModuleVersions、entryPluginId、isInstallableKind、
 * i18n 门（本单范围，与 scripts/i18n-gate.mjs 同判据：本单键 missing=0
 * 且无重复登记——全树基线本身红，不越界断言）。
 */
import { test, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareModuleVersions,
  entryPluginId,
  getIndex,
  getManagerPlugins,
  getTeamModules,
  getWorkerPlugins,
  installManagerPlugin,
  installTeamModule,
  installWorkerPlugin,
  isInstallableKind,
  moduleEntryVersions,
  normalizeIndexResponse,
} from "../src/api/domains/modules";
import type { IndexModuleEntry } from "../src/api/domains/modules";

// ── window/host shim（requestJsonFull 走 host.fetch；kind=server 使
// isLocalHost()=false，不进独立宿主配置模拟层）────────────────────
interface CapturedCall {
  path: string;
  init?: RequestInit;
}
const calls: CapturedCall[] = [];
type Responder = (
  path: string,
  init?: RequestInit,
) => { status: number; body: unknown };
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
        };
      },
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};

// ── ① 索引参数拼装 ────────────────────────────────────────────────

test("① getIndex：source/repo/ref/channel 四参拼装（/ → %2F 编码）", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: {
      schema: 1,
      channel: "alpha",
      modules: [],
      source: "gitcode",
      repo: "me/fork",
      fetched_at: "2026-11-06T00:00:00Z",
    },
  });
  const r = await getIndex({
    source: "gitcode",
    repo: "me/fork",
    ref: "release/1.2",
    channel: "alpha",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(
    "/agentteams-proxy/controller/api/v1/millforge/index?source=gitcode&repo=me%2Ffork&ref=release%2F1.2&channel=alpha",
  );
  expect(r.channel).toBe("alpha");
});

test("①b getIndex：ref 空白 → 默认 main", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: { schema: 1, channel: "stable", modules: [] },
  });
  await getIndex({
    source: "github",
    repo: "LUOSENGWA/Millforge",
    ref: "   ",
    channel: "stable",
  });
  expect(calls[0].path).toBe(
    "/agentteams-proxy/controller/api/v1/millforge/index?source=github&repo=LUOSENGWA%2FMillforge&ref=main&channel=stable",
  );
});

test("①c 索引 404 上抛（空态语义——区别于读端点的 supported:false）", async () => {
  responder = () => ({ status: 404, body: { message: "no such channel" } });
  await expect(
    getIndex({ source: "github", repo: "x/y", ref: "main", channel: "beta" }),
  ).rejects.toThrow("HTTP 404");
});

// ── ①d 索引规范化（上游 modules/versions 对象 map——16.124 崩溃回归）──

/** 真实 beta channels.json 形状（2026-11-05）：modules 是对象 map，
 * versions 是对象 map，制品在 artifacts[]（zip + tar.gz）。 */
function betaChannelsPayload() {
  return {
    schema: 1,
    channel: "beta",
    updated_at: "2026-11-05T01:00:35Z",
    modules: {
      looprunner: {
        kind: "runner",
        latest: null,
        versions: {},
        note: "reserved in 1.2.6; the runner is not shipped with this release",
      },
      teamharness: {
        kind: "plugin",
        latest: "0.1.0",
        versions: {
          "0.1.0": {
            artifacts: [
              {
                name: "teamharness-qwenpaw-0.1.0.zip",
                sha256:
                  "e4d07e30619b5d2e3452490303d33ab1423da056a241ceb5f8739a35cd7be77b",
              },
              {
                name: "teamharness.tar.gz",
                sha256:
                  "595f33fb8680410ad5fa0be82c6d460bd6ab5baa5910df3e8c38eed8f3551533",
              },
            ],
            requires: {
              agentteams: ">=1.2.6",
              contracts: "1",
              tool_schema: "1",
            },
            commit: "8795080efdd7edcecdce025d83f8994d0600f31f",
            published_at: "2026-11-05T01:00:35Z",
            deprecated: false,
          },
        },
      },
      "agentteams-matrix": {
        kind: "bundle",
        pluginId: "agentteams-matrix-channel",
        latest: "0.1.0",
        versions: {
          "0.1.0": {
            artifacts: [
              {
                name: "agentteams-matrix-channel-0.1.0.zip",
                sha256:
                  "dd46b308bdd4b3ae80f4b098a4e282855f8736bdefa7c477c2b780aec4d9b44f",
              },
            ],
            requires: { agentteams: ">=1.2.6" },
            commit: "8795080efdd7edcecdce025d83f8994d0600f31f",
            published_at: "2026-11-05T01:00:35Z",
            deprecated: false,
          },
        },
      },
    },
  };
}

test("①d getIndex：modules/versions 对象 map 规范化为数组（崩溃回归）", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: {
      ...betaChannelsPayload(),
      source: "github",
      repo: "LUOSENGWA/Millforge",
      fetched_at: "2026-11-07T00:00:00Z",
    },
  });
  const r = await getIndex({
    source: "github",
    repo: "LUOSENGWA/Millforge",
    ref: "main",
    channel: "beta",
  });
  // 对象 map → 数组（UI 的 modules.find 不再崩）
  expect(Array.isArray(r.modules)).toBe(true);
  expect(r.modules).toHaveLength(3);
  expect(r.modules.map((m) => m.module).sort()).toEqual([
    "agentteams-matrix",
    "looprunner",
    "teamharness",
  ]);
  expect(r.schema).toBe(1);
  expect(r.channel).toBe("beta");
  expect(r.source).toBe("github");
  expect(r.repo).toBe("LUOSENGWA/Millforge");

  const th = r.modules.find((m) => m.module === "teamharness");
  expect(th?.kind).toBe("plugin");
  expect(th?.latest).toBe("0.1.0");
  expect(entryPluginId(th as IndexModuleEntry)).toBe("teamharness");
  expect(Array.isArray(th?.versions)).toBe(true);
  expect(th?.versions).toHaveLength(1);
  expect(th?.versions?.[0].version).toBe("0.1.0");
  // artifacts[] → artifact/sha256（优先 zip；否则 UI 版本按钮全禁用）
  expect(th?.versions?.[0].artifact).toBe("teamharness-qwenpaw-0.1.0.zip");
  expect(th?.versions?.[0].sha256).toBe(
    "e4d07e30619b5d2e3452490303d33ab1423da056a241ceb5f8739a35cd7be77b",
  );
  expect(th?.versions?.[0].requires).toEqual({
    agentteams: ">=1.2.6",
    contracts: "1",
    tool_schema: "1",
  });
  expect(th?.versions?.[0].commit).toBe("8795080efdd7edcecdce025d83f8994d0600f31f");
  expect(th?.versions?.[0].deprecated).toBe(false);

  // bundle：pluginId 保留（≠ module），版本列表同源
  const mx = r.modules.find((m) => m.module === "agentteams-matrix");
  expect(mx?.kind).toBe("bundle");
  expect(mx?.pluginId).toBe("agentteams-matrix-channel");
  expect(entryPluginId(mx as IndexModuleEntry)).toBe("agentteams-matrix-channel");
  expect(mx?.versions?.[0].version).toBe("0.1.0");

  // runner：空 versions map → []，且不可安装
  const lr = r.modules.find((m) => m.module === "looprunner");
  expect(lr?.versions).toEqual([]);
  expect(lr?.note).toContain("runner");
  expect(isInstallableKind(lr as IndexModuleEntry)).toBe(false);

  // moduleEntryVersions 与规范化后的条目一致
  const viaHelper = moduleEntryVersions(th);
  expect(viaHelper.map((v) => v.version)).toEqual(["0.1.0"]);
  expect(viaHelper[0].artifact).toBe("teamharness-qwenpaw-0.1.0.zip");
});

test("①e normalizeIndexResponse：空/缺失 modules → []；数组形态仍兼容", () => {
  expect(normalizeIndexResponse({ schema: 1, channel: "beta", modules: {} }).modules).toEqual([]);
  expect(normalizeIndexResponse({ schema: 1, channel: "beta" }).modules).toEqual([]);
  expect(normalizeIndexResponse(null).modules).toEqual([]);
  expect(normalizeIndexResponse({ modules: [null, 123, { nope: 1 }] }).modules).toEqual([]);

  const arr = normalizeIndexResponse({
    schema: 1,
    channel: "alpha",
    modules: [
      {
        module: "teamharness",
        kind: "plugin",
        pluginId: "millforge-teamharness",
        versions: [
          { version: "0.2.0", artifact: "th-0.2.0.zip", sha256: "abc" },
          { version: 7 },
        ],
      },
      {
        module: "solo",
        version: "0.3.0",
        artifact: "solo.zip",
        sha256: "def",
      },
    ],
  });
  expect(arr.modules).toHaveLength(2);
  expect(arr.modules[0].module).toBe("teamharness");
  expect(arr.modules[0].versions).toHaveLength(1);
  expect(arr.modules[0].versions?.[0]).toEqual({
    version: "0.2.0",
    artifact: "th-0.2.0.zip",
    sha256: "abc",
  });
  // 单版本条目形态：versions 补成单条目
  expect(arr.modules[1].versions).toEqual([
    { version: "0.3.0", artifact: "solo.zip", sha256: "def" },
  ]);
});

test("①f moduleEntryVersions：versions 对象 map 兜底（绕过 getIndex 的原始载荷）", () => {
  const entry = {
    module: "teamharness",
    versions: {
      "0.1.0": {
        artifacts: [
          { name: "teamharness.tar.gz", sha256: "tar" },
          { name: "teamharness-qwenpaw-0.1.0.zip", sha256: "zip" },
        ],
        requires: { contracts: "1" },
      },
      bad: 42,
    },
  } as unknown as IndexModuleEntry;
  const vs = moduleEntryVersions(entry);
  expect(vs.map((v) => v.version)).toEqual(["0.1.0"]);
  expect(vs[0].artifact).toBe("teamharness-qwenpaw-0.1.0.zip");
  expect(vs[0].sha256).toBe("zip");
  expect(vs[0].requires).toEqual({ contracts: "1" });
});


// ── ② 安装 payload 逐字段 ────────────────────────────────────────

test("② installTeamModule：路径编码 + payload 逐字段一致", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: {
      updated: ["w1", "w2"],
      failed: null,
      target_version: "0.2.0",
      module: "team harness",
      members: [],
      versions: { "0.2.0": 2 },
      consistent: true,
      pluginId: "millforge-teamharness",
    },
  });
  const r = await installTeamModule("sys dev", "team harness", {
    source: "github",
    repo: "owner/repo",
    ref: "main",
    version: "0.2.0",
    artifact: "teamharness-0.2.0.zip",
    sha256: "abc123",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(
    "/agentteams-proxy/controller/api/v1/teams/sys%20dev/modules/team%20harness/install",
  );
  expect(calls[0].init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    source: "github",
    repo: "owner/repo",
    ref: "main",
    version: "0.2.0",
    artifact: "teamharness-0.2.0.zip",
    sha256: "abc123",
  });
  expect(r.consistent).toBe(true);
  expect(r.updated).toEqual(["w1", "w2"]);
});

test("② installManagerPlugin / installWorkerPlugin：body 含 module + 路径编码", async () => {
  calls.length = 0;
  responder = () => ({
    status: 200,
    body: { installed: true, loaded: true, previous_version: "0.1.0" },
  });
  const body = {
    source: "gitcode",
    repo: "me/fork",
    ref: "v1",
    version: "0.2.0",
    artifact: "a.zip",
    sha256: "abc",
    module: "team harness",
  };
  const rm = await installManagerPlugin("mgr 1", body);
  const rw = await installWorkerPlugin("wkr 1", body);
  expect(calls[0].path).toBe(
    "/agentteams-proxy/controller/api/v1/managers/mgr%201/plugins/install",
  );
  expect(calls[1].path).toBe(
    "/agentteams-proxy/controller/api/v1/workers/wkr%201/plugins/install",
  );
  expect(JSON.parse(String(calls[0].init?.body))).toEqual(body);
  expect(JSON.parse(String(calls[1].init?.body))).toEqual(body);
  expect(rm.previous_version).toBe("0.1.0");
  expect(rw.loaded).toBe(true);
});

// ── ③ 404 降级 / 非 404 上抛 / 200 形态 ──────────────────────────

test("③ 404 → {supported:false, reason:'controller_too_old'}（三平面读）", async () => {
  responder = () => ({ status: 404, body: { message: "404 page not found" } });
  const t = await getTeamModules("t-404");
  expect(t).toEqual({ supported: false, reason: "controller_too_old" });
  const m = await getManagerPlugins("m-404");
  expect(m).toEqual({ supported: false, reason: "controller_too_old" });
  const w = await getWorkerPlugins("w-404");
  expect(w).toEqual({ supported: false, reason: "controller_too_old" });
});

test("③ 非 404 错误原样上抛（保留 status+message）", async () => {
  responder = () => ({ status: 502, body: { message: "worker offline" } });
  await expect(getWorkerPlugins("w-502")).rejects.toThrow("HTTP 502");
});

test("③ 读 200：supported=true 形态 + plugins 宽容解析（{plugins:[]} 与裸数组）", async () => {
  responder = (path: string) => {
    if (path.includes("/teams/t-ok/modules"))
      return {
        status: 200,
        body: {
          team: "t-ok",
          modules: [
            {
              module: "teamharness",
              name: "TeamHarness",
              kind: "bundle",
              pluginId: "millforge-teamharness",
              members: [{ worker: "w1", version: "0.1.0", loaded: true }],
              versions: { "0.1.0": 1 },
              consistent: true,
            },
          ],
          errors: [{ worker: "w2", error: "offline" }],
        },
      };
    if (path.includes("/managers/m-ok/plugins"))
      return {
        status: 200,
        body: {
          plugins: [
            {
              id: "millforge-teamharness",
              name: "TeamHarness",
              version: "0.1.0",
              loaded: true,
            },
          ],
        },
      };
    if (path.includes("/workers/w-ok/plugins"))
      // 老形态：裸数组（既有 worker plugins 代理透传形态）
      return { status: 200, body: [{ id: "solo-plugin", version: "0.0.1" }] };
    return { status: 404, body: { message: "nf" } };
  };
  const t = await getTeamModules("t-ok");
  expect(t.supported).toBe(true);
  expect(t.team).toBe("t-ok");
  expect(t.modules?.[0]?.consistent).toBe(true);
  expect(t.modules?.[0]?.members).toEqual([
    { worker: "w1", version: "0.1.0", loaded: true },
  ]);
  expect(t.errors).toEqual([{ worker: "w2", error: "offline" }]);
  const m = await getManagerPlugins("m-ok");
  expect(m.supported).toBe(true);
  expect(m.plugins?.[0]?.id).toBe("millforge-teamharness");
  const w = await getWorkerPlugins("w-ok");
  expect(w.supported).toBe(true);
  expect(w.plugins?.[0]?.id).toBe("solo-plugin");
});

// ── bonus：宽容解析 / 版本比较 / i18n 门 ─────────────────────────

test("bonus moduleEntryVersions：versions 数组 / 单版本条目两形态 + 空", () => {
  const noisy = [
    { version: "0.1.0", artifact: "a.zip", sha256: "s1" },
    { version: 123 },
    null,
  ] as unknown[];
  const main = moduleEntryVersions({
    module: "a",
    versions: noisy as IndexModuleEntry["versions"],
  });
  expect(main).toHaveLength(1);
  expect(main[0].artifact).toBe("a.zip");
  const single = moduleEntryVersions({
    module: "b",
    version: "0.2.0",
    artifact: "b.zip",
    sha256: "s2",
  });
  expect(single).toEqual([
    { version: "0.2.0", artifact: "b.zip", sha256: "s2", requires: undefined },
  ]);
  expect(moduleEntryVersions({ module: "c" })).toEqual([]);
  expect(moduleEntryVersions(null)).toEqual([]);
});

test("bonus compareModuleVersions：数字段比较（非字典序）", () => {
  expect(compareModuleVersions("0.1.0", "0.1.0")).toBe(0);
  expect(compareModuleVersions("1.9.0", "1.10.0")).toBe(-1);
  expect(compareModuleVersions("0.2.0", "0.1.0")).toBe(1);
  expect(compareModuleVersions("1.2.6", "1.2.7")).toBe(-1);
});

test("bonus entryPluginId：缺省 = 模块名", () => {
  expect(entryPluginId({ module: "teamharness" })).toBe("teamharness");
  expect(
    entryPluginId({ module: "teamharness", pluginId: "millforge-teamharness" }),
  ).toBe("millforge-teamharness");
});

test("bonus isInstallableKind：runner 不可装，其余可装", () => {
  expect(isInstallableKind({ module: "a", kind: "runner" })).toBe(false);
  expect(isInstallableKind({ module: "b", kind: "bundle" })).toBe(true);
  expect(isInstallableKind({ module: "c" })).toBe(true);
});

test("bonus i18n 门（本单范围，与 scripts/i18n-gate.mjs 同判据）：本单键 missing=0 且无重复登记", () => {
  // 全树基线本身是红的（2026-11-06 直跑 gate：缺=74 重=4——「已保存/操作/
  // 无改动/跳过」等，均为其他既有组件欠债）——本单不越界补别人的键，
  // 门控范围收为本单引入键：ModuleUpdatesBody.tsx（原 Panel，2026-11-07 搬进
  // 千锻弹窗）的全部 tr("字面量")
  // 必须已在字典（i18n.ts + i18n/domains/*.ts 并集）且每个恰好登记一次
  // （本单未新增重复登记；复用键如 刷新/取消/关闭 本就只登记一次）。
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcDir = join(root, "src");
  const dictFiles = [join(srcDir, "i18n.ts")];
  const domainDir = join(srcDir, "i18n", "domains");
  if (existsSync(domainDir)) {
    dictFiles.push(
      ...readdirSync(domainDir)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => join(domainDir, f)),
    );
  }
  const occ = new Map<string, number>();
  for (const f of dictFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /^\s*"([^"]+)"\s*:\s*\{\s*en:/gm,
    ))
      occ.set(m[1], (occ.get(m[1]) ?? 0) + 1);
  }
  const panelText = readFileSync(
    join(srcDir, "components", "ModuleUpdatesBody.tsx"),
    "utf8",
  );
  const mine = new Set<string>();
  for (const m of panelText.matchAll(/(?<![A-Za-z])tr\(\s*"([^"]+)"/g))
    mine.add(m[1]);
  expect(mine.size).toBeGreaterThanOrEqual(40); // 文案规模哨兵（防正则失配假绿）
  const missing = [...mine].filter((k) => !occ.has(k)).sort();
  const reRegistered = [...mine].filter((k) => (occ.get(k) ?? 0) > 1).sort();
  expect(missing).toEqual([]);
  expect(reRegistered).toEqual([]);
});
