/**
 * CodingCLI 弹窗 · QwenCode 卡「QwenPaw × QwenCode 桥」栏单测（vitest 风格）。
 *
 * 运行：（frontend/ 下）npx vitest run tests/codingcli-bridge.vitest.test.ts
 * ——容器内无 npx/vitest CLI 时由宿主侧执行，见交付报告。
 *
 * 覆盖（任务书 9 条）：
 * ① 未装 → not-installed，默认最新，按钮安装；
 * ② installed 0.2.0 + [0.3.0] → update-available，仅 0.3.0 可选，按钮更新；
 * ③ installed 0.3.0 → up-to-date，无选项/按钮；
 * ④ latest null / 空 versions → no-versions；
 * ⑤ 三频道常量 = stable/beta/alpha，默认 stable；
 * ⑥ 切 beta（null）→ no-versions，切回 stable → update-available；
 * ⑦ 安装 body channel = 当前频道、module/pluginId 映射正确；
 * ⑧ 非 qwenpaw 不渲染桥栏（源码断言：runtimeGuard 判据）；
 * ⑨ 源码无逐版本按钮循环（状态 + 下拉 + 单按钮）。
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_CHANNELS,
  BRIDGE_DEFAULT_CHANNEL,
  BRIDGE_MODULE_KEY,
  BRIDGE_PLUGIN_ID,
  bridgeChannelLabel,
  bridgeDirection,
  bridgeHasAction,
  bridgeInstallBody,
  bridgeInstalledVersion,
  bridgeOptions,
  bridgeState,
  bridgeVersions,
  pickBridgeModule,
} from "../src/components/bridgeModuleModel";
import type {
  IndexModuleEntry,
  IndexVersionEntry,
} from "../src/api/domains/modules";

const here = dirname(fileURLToPath(import.meta.url));

function ver(version: string, installable = true): IndexVersionEntry {
  return {
    version,
    artifact: installable
      ? `qwenpaw-qwencode-bridge-${version}.zip`
      : undefined,
    sha256: installable ? `sha-${version}` : undefined,
  };
}

function bridgeEntry(
  versions: IndexVersionEntry[],
  latest: string | null = versions[0]?.version ?? null,
): IndexModuleEntry {
  return {
    module: BRIDGE_MODULE_KEY,
    kind: "plugin",
    pluginId: BRIDGE_PLUGIN_ID,
    latest,
    versions,
  };
}

// ── ① 未装 ────────────────────────────────────────────────────────

test("① 未装：not-installed + 默认最新 + 方向 install", () => {
  const entry = bridgeEntry([ver("0.3.0")]);
  const versions = bridgeVersions(entry);
  expect(bridgeState({ installedVersion: null, versions, latest: entry.latest })).toBe(
    "not-installed",
  );
  const options = bridgeOptions(versions, null);
  expect(options.find((o) => o.defaultSelected)?.version).toBe("0.3.0");
  expect(options.filter((o) => !o.disabled).map((o) => o.version)).toEqual(["0.3.0"]);
  expect(bridgeDirection("0.3.0", null)).toBe("install");
  expect(bridgeHasAction("not-installed")).toBe(true);
});

// ── ② 可更新 ──────────────────────────────────────────────────────

test("② installed 0.2.0 + [0.3.0]：update-available，仅 0.3.0 可选", () => {
  const entry = bridgeEntry([ver("0.3.0")]);
  const versions = bridgeVersions(entry);
  const state = bridgeState({
    installedVersion: "0.2.0",
    versions,
    latest: entry.latest,
  });
  expect(state).toBe("update-available");
  const options = bridgeOptions(versions, "0.2.0");
  // 当前版本只在 ≥ 已装集合里时出现（本用例 0.2.0 不在索引里 → 无 current）
  expect(options.filter((o) => !o.disabled).map((o) => o.version)).toEqual(["0.3.0"]);
  expect(options.find((o) => o.defaultSelected)?.version).toBe("0.3.0");
  expect(bridgeDirection("0.3.0", "0.2.0")).toBe("update");
  expect(bridgeHasAction(state)).toBe(true);

  // 索引同时含当前版本 → 标「当前」且 disabled，不可选
  const withCurrent = bridgeOptions(
    bridgeVersions(bridgeEntry([ver("0.3.0"), ver("0.2.0")])),
    "0.2.0",
  );
  expect(withCurrent.find((o) => o.version === "0.2.0")).toMatchObject({
    current: true,
    disabled: true,
  });
  expect(withCurrent.filter((o) => !o.disabled).map((o) => o.version)).toEqual([
    "0.3.0",
  ]);
});

// ── ③ 已是最新 ────────────────────────────────────────────────────

test("③ installed 0.3.0：up-to-date，无选项/按钮", () => {
  const entry = bridgeEntry([ver("0.3.0")]);
  const versions = bridgeVersions(entry);
  const state = bridgeState({
    installedVersion: "0.3.0",
    versions,
    latest: entry.latest,
  });
  expect(state).toBe("up-to-date");
  const options = bridgeOptions(versions, "0.3.0");
  expect(options).toEqual([
    { version: "0.3.0", current: true, disabled: true, defaultSelected: false },
  ]);
  expect(options.some((o) => !o.disabled)).toBe(false);
  expect(bridgeHasAction(state)).toBe(false);
});

// ── ④ 该频道暂无版本 ──────────────────────────────────────────────

test("④ latest null / 空 versions → no-versions", () => {
  const versions = [ver("0.3.0")];
  expect(bridgeState({ installedVersion: null, versions, latest: null })).toBe(
    "no-versions",
  );
  expect(
    bridgeState({ installedVersion: "0.2.0", versions: [], latest: null }),
  ).toBe("no-versions");
  expect(bridgeState({ installedVersion: "0.2.0", versions: [] })).toBe(
    "no-versions",
  );
  // 索引里没有桥模块 → 空版本列表
  expect(bridgeVersions(null)).toEqual([]);
  expect(bridgeHasAction("no-versions")).toBe(false);
});

// ── ⑤ 三频道常量 ──────────────────────────────────────────────────

test("⑤ 频道常量 = stable/beta/alpha，默认 stable", () => {
  expect(BRIDGE_CHANNELS).toEqual(["stable", "beta", "alpha"]);
  expect(BRIDGE_DEFAULT_CHANNEL).toBe("stable");
  expect(BRIDGE_CHANNELS.map(bridgeChannelLabel)).toEqual([
    "stable",
    "beta",
    "alpha",
  ]);
});

// ── ⑥ 频道切换（beta 空 → 回 stable 恢复）───────────────────────

test("⑥ 切 beta（null）→ no-versions；切回 stable → update-available", () => {
  const installed = "0.2.0";
  const beta = bridgeEntry([], null);
  const stable = bridgeEntry([ver("0.3.0")]);

  const betaVersions = bridgeVersions(beta);
  expect(
    bridgeState({
      installedVersion: installed,
      versions: betaVersions,
      latest: beta.latest,
    }),
  ).toBe("no-versions");

  const stableVersions = bridgeVersions(stable);
  expect(
    bridgeState({
      installedVersion: installed,
      versions: stableVersions,
      latest: stable.latest,
    }),
  ).toBe("update-available");
});

// ── ⑦ 安装 body / 插件映射 ───────────────────────────────────────

test("⑦ 安装 body：channel=当前频道；module 用模块键，已装对账用 pluginId", () => {
  const v = ver("0.3.0");
  expect(bridgeInstallBody(v, "LUOSENGWA/Millforge", "beta")).toEqual({
    module: BRIDGE_MODULE_KEY,
    source: "github",
    repo: "LUOSENGWA/Millforge",
    ref: "main",
    channel: "beta",
    version: "0.3.0",
    artifact: "qwenpaw-qwencode-bridge-0.3.0.zip",
    sha256: "sha-0.3.0",
  });
  expect(bridgeInstallBody(v).channel).toBe("stable");
  expect(BRIDGE_MODULE_KEY).toBe("qwenpaw-qwencode-bridge");
  expect(BRIDGE_PLUGIN_ID).toBe("qwen-code-bridge");
  expect(
    bridgeInstalledVersion([{ id: BRIDGE_PLUGIN_ID, version: "0.3.0" }]),
  ).toBe("0.3.0");
  expect(bridgeInstalledVersion([{ id: "other", version: "9.9.9" }])).toBeNull();
});

test("⑦b pickBridgeModule：模块键优先（plumbing 供频道索引共用）", () => {
  const other = { module: "teamharness" } as IndexModuleEntry;
  const bridge = bridgeEntry([ver("0.3.0")]);
  expect(pickBridgeModule({ schema: 1, channel: "stable", modules: [other] })).toBeNull();
  expect(
    pickBridgeModule({ schema: 1, channel: "stable", modules: [other, bridge] }),
  ).toBe(bridge);
});

// ── ⑧ 非 qwenpaw 不渲染 ───────────────────────────────────────────

test("⑧ 非 qwenpaw 不渲染桥栏（runtimeGuard 判据 + QwenCode 卡内挂载）", () => {
  const section = readFileSync(
    join(here, "..", "src", "components", "QwenCodeBridgeSection.tsx"),
    "utf8",
  );
  expect(section).toContain("isQwenpawOnlyDisabled(runtime)");
  expect(section).toContain("if (isQwenpawOnlyDisabled(runtime)) return null;");

  const panel = readFileSync(
    join(here, "..", "src", "components", "WorkerCodingCliPanel.tsx"),
    "utf8",
  );
  // 桥栏只在 QwenCode 卡展开块内挂载
  expect(panel).toMatch(
    /\{cli\.id === "qwen-code" \? \(\s*<QwenCodeBridgeSection/,
  );
});

// ── ⑨ 无逐版本按钮循环 ───────────────────────────────────────────

test("⑨ 源码无逐版本按钮循环（状态标签 + 下拉 + 单按钮）", () => {
  const section = readFileSync(
    join(here, "..", "src", "components", "QwenCodeBridgeSection.tsx"),
    "utf8",
  );
  expect(section).not.toMatch(/versions\.map\(/);
  expect(section).not.toContain("versionButtons");
  // 动作按钮唯一：文案由 direction 决定，不是每版本一颗
  expect(section).toContain("{actionText}");
  expect(section).toContain("bridgeHasAction(state)");
});
