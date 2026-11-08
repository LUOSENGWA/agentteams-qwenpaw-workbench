// 模块更新：版本选择纯逻辑测试（未装 / 可更新 / 已是最新 / 不一致 / 缺 artifact）。
//
// 双跑：主控 `npx vitest run` 时注册 vitest 用例；容器无 vitest CLI 时
// `node --experimental-strip-types tests/module-update-picker.vitest.test.ts`
// 直接自执行同一组 node:assert 断言（退出码即门）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { IndexVersionEntry } from "../src/api/domains/modules";
import {
  buildVersionOptions,
  directionFor,
  moduleUpdateState,
  pickDefaultVersion,
  selectionFor,
} from "../src/components/moduleUpdatePicker";

const v = (
  version: string,
  extra: Partial<IndexVersionEntry> = {},
): IndexVersionEntry => ({
  version,
  artifact: `millforge-${version}.zip`,
  sha256: `sha-${version}`,
  ...extra,
});

const versions = [v("0.1.0"), v("0.1.1-alpha.1"), v("0.1.1-alpha.2")];

const nodeRun = !(globalThis as Record<string, unknown>).__vitest_worker__;
const cases: { name: string; fn: () => void }[] = [];

function check(name: string, fn: () => void) {
  cases.push({ name, fn });
  if (!nodeRun) return;
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}`);
    throw e;
  }
}

check("未装 → not-installed，默认最新，方向 install（按钮「安装」）", () => {
  const st = moduleUpdateState({ versions, currentVersion: null });
  assert.equal(st, "not-installed");
  const opts = buildVersionOptions(versions, null, "all");
  assert.equal(pickDefaultVersion(opts), "0.1.1-alpha.2");
  assert.equal(directionFor(pickDefaultVersion(opts)!, null), "install");
});

check("已装 0.1.0 + [alpha1, alpha2] → update-available，仅列更新版本，默认 alpha2（按钮「更新」）", () => {
  const st = moduleUpdateState({ versions, currentVersion: "0.1.0" });
  assert.equal(st, "update-available");
  const opts = buildVersionOptions(versions, "0.1.0", "newer");
  assert.deepEqual(
    opts.map((o) => o.value),
    ["0.1.1-alpha.2", "0.1.1-alpha.1"],
  );
  const def = pickDefaultVersion(opts)!;
  assert.equal(def, "0.1.1-alpha.2");
  assert.equal(directionFor(def, "0.1.0"), "update");
});

check("已装 alpha2 → up-to-date，无可更新选项（不下拉、不按钮）", () => {
  const st = moduleUpdateState({ versions, currentVersion: "0.1.1-alpha.2" });
  assert.equal(st, "up-to-date");
  assert.deepEqual(buildVersionOptions(versions, "0.1.1-alpha.2", "newer"), []);
});

check("版本不一致 → inconsistent，全部版本可选，默认最新", () => {
  const st = moduleUpdateState({
    versions,
    currentVersion: null,
    hasInstalled: true,
    consistent: false,
  });
  assert.equal(st, "inconsistent");
  const opts = buildVersionOptions(versions, null, "all");
  assert.deepEqual(
    opts.map((o) => o.value),
    ["0.1.1-alpha.2", "0.1.1-alpha.1", "0.1.0"],
  );
  assert.equal(pickDefaultVersion(opts), "0.1.1-alpha.2");
  assert.equal(directionFor(pickDefaultVersion(opts)!, null), "install");
});

check("缺 artifact/sha256 的版本 disabled（标 unavailable），当前版本标 current 且 disabled", () => {
  const list = [v("0.2.0", { artifact: undefined }), v("0.1.9"), v("0.1.0")];
  const st = moduleUpdateState({ versions: list, currentVersion: "0.1.0" });
  assert.equal(st, "update-available");
  const opts = buildVersionOptions(list, "0.1.0", "newer");
  const byValue = (ver: string) => opts.find((o) => o.value === ver)!;
  assert.equal(byValue("0.2.0").disabled, true);
  assert.equal(byValue("0.2.0").reason, "unavailable");
  assert.equal(byValue("0.1.9").disabled, false);
  assert.equal(pickDefaultVersion(opts), "0.1.9");
  const withCurrent = buildVersionOptions(list, "0.1.0", "all");
  assert.equal(withCurrent.find((o) => o.value === "0.1.0")!.reason, "current");
  assert.equal(withCurrent.find((o) => o.value === "0.1.0")!.disabled, true);
});

check("组件源码：无 versionButtons / 逐版本按钮，卡片内只一个 antd.Button + 状态机", () => {
  const comp = readFileSync(
    new URL("../src/components/ModuleUpdatesBody.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(!comp.includes("versionButtons"), "残留 versionButtons 逐版本按钮");
  const card = comp.slice(
    comp.indexOf("function ModuleCard"),
    comp.indexOf("// ── 主体"),
  );
  assert.ok(card.length > 0, "ModuleCard 切片失败");
  assert.equal((card.match(/<antd\.Button\b/g) ?? []).length, 1);
  assert.ok(card.includes("buildVersionOptions"));
  assert.ok(card.includes("moduleUpdateState"));
  assert.ok(card.includes("pickDefaultVersion"));
  assert.ok(card.includes("canPick"));
  assert.ok(!card.includes('"更新到'), "卡片仍有「更新到 {v}」逐版本文案");
  assert.ok(!card.includes('"降级到'), "卡片仍有「降级到 {v}」逐版本文案");
  assert.ok(!card.includes('"安装 {v}"'), "卡片仍有「安装 {v}」逐版本文案");
  for (const label of ["安装", "更新", "降级", "统一到此版本", "可更新", "已是最新", "版本不一致"]) {
    assert.ok(card.includes(label), `卡片缺状态文案：${label}`);
  }
});

check("选择版本后 onStart 载荷：version/entry/direction 正确（update/降级/首装）", () => {
  const up = selectionFor(versions, "0.1.0", "0.1.1-alpha.2")!;
  assert.equal(up.version, "0.1.1-alpha.2");
  assert.equal(up.entry, versions[2]);
  assert.equal(up.direction, "update");
  assert.equal(up.currentVersion, "0.1.0");

  const down = selectionFor(versions, "0.1.1-alpha.2", "0.1.0")!;
  assert.equal(down.direction, "downgrade");
  assert.equal(down.entry, versions[0]);

  assert.equal(selectionFor(versions, null, "0.1.0")!.direction, "install");
  assert.equal(selectionFor(versions, "0.1.0", null), null);
  assert.equal(selectionFor(versions, "0.1.0", "9.9.9"), null);
});

if (nodeRun) console.log(`\nmodule-update-picker: ${cases.length} passed`);

// ── vitest 双跑：主控 `npx vitest run` 时注册同一组用例（node 直跑时
// __vitest_worker__ 缺失 → 上方已自执行）。──
if (!nodeRun) {
  const vt = (await import("vitest")) as {
    it: (name: string, fn: () => void) => void;
  };
  for (const c of cases) vt.it(c.name, c.fn);
}
