// O2：OpenClaw 配置面板控件 + 动态条目 + 字段过滤 —— 纯逻辑单测。
// 直跑：node --experimental-strip-types frontend/tests/o2-surface.test.ts
//（node:assert/strict；import 带 .ts 扩展名；值依赖只经 lib/surfaceForm，
// 不触 window/react/chat 域；memberConfig 仅 type-only import，运行时被擦除。
// 控件层（Switch/InputNumber/Collapse 等）不写组件测试——无 testing-library，
// 由 tsc + build 门兜底）。
import assert from "node:assert/strict";

import {
  changedKeys,
  collectConcreteValues,
  expandEntries,
  filterFields,
  keyMatchesTemplate,
  templateDraftEntries,
} from "../src/lib/surfaceForm.ts";
import type { SurfaceField } from "../src/api/domains/memberConfig.ts";

/** 最小 SurfaceField 字面量（applies 必填，hot 占位）。 */
function field(
  key: string,
  type: SurfaceField["type"],
  extra: Partial<SurfaceField> = {},
): SurfaceField {
  return { key, type, applies: "hot", ...extra };
}

/** 固定字段集：非通配 + 单星 x2 + 双星，覆盖三类过滤形态。 */
const FIELDS: SurfaceField[] = [
  field("gateway.port", "number", { label: "端口" }),
  field("channels.*.enabled", "boolean", { label: "启用" }),
  field("channels.*.apiKey", "secret", { sensitive: true }),
  field("models.providers.*.models.*.id", "string"),
];

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── filterFields ────────────────────────────────────────────────────
ok("filterFields 空 query + 空 changedKeys → 全过、顺序不变", () => {
  assert.deepEqual(filterFields(FIELDS, "", new Set()).map((f) => f.key), [
    "gateway.port",
    "channels.*.enabled",
    "channels.*.apiKey",
    "models.providers.*.models.*.id",
  ]);
});

ok("filterFields 纯空白 query → 按空处理，全过", () => {
  assert.equal(filterFields(FIELDS, "   ", new Set()).length, FIELDS.length);
});

ok("filterFields query 子串命中 key（不区分大小写）", () => {
  const out = filterFields(FIELDS, "PORT", new Set());
  assert.deepEqual(out.map((f) => f.key), ["gateway.port"]);
});

ok("filterFields query 命中 label", () => {
  const out = filterFields(FIELDS, "端口", new Set());
  assert.deepEqual(out.map((f) => f.key), ["gateway.port"]);
});

ok("filterFields query 无命中 → 空", () => {
  assert.deepEqual(filterFields(FIELDS, "no-such-key", new Set()), []);
});

ok("filterFields changedKeys 过滤：只留命中字段（非通配精确匹配）", () => {
  const out = filterFields(FIELDS, "", new Set(["gateway.port"]));
  assert.deepEqual(out.map((f) => f.key), ["gateway.port"]);
});

ok("filterFields 通配 concrete 键参与过滤（单星模板命中）", () => {
  const out = filterFields(FIELDS, "", new Set(["channels.matrix.enabled"]));
  assert.deepEqual(out.map((f) => f.key), ["channels.*.enabled"]);
});

ok("filterFields 形状不符不误伤（段数不同 / 非星段不同）", () => {
  const out = filterFields(
    FIELDS,
    "",
    new Set(["channels.matrix.enabled.extra", "gateway.port2", "telegram.port"]),
  );
  assert.deepEqual(out, []);
});

ok("filterFields 同一模板任一 concrete 键命中即保留", () => {
  const out = filterFields(FIELDS, "", new Set(["a.b.c", "channels.slack.apiKey"]));
  assert.deepEqual(out.map((f) => f.key), ["channels.*.apiKey"]);
});

ok("filterFields 组合（query + changed）取交集", () => {
  const out = filterFields(FIELDS, "channels", new Set(["channels.telegram.apiKey"]));
  assert.deepEqual(out.map((f) => f.key), ["channels.*.apiKey"]);
});

// ── changedKeys ─────────────────────────────────────────────────────
ok("changedKeys 无变化 → 空集", () => {
  const values = { gateway: { port: 18789 }, channels: { matrix: { enabled: true } } };
  const cs = changedKeys(
    { "gateway.port": 18789, "channels.matrix.enabled": true },
    values,
  );
  assert.equal(cs.size, 0);
});

ok("changedKeys 值变化 / 新增键（values 无）→ 进集合", () => {
  const values = { gateway: { port: 18789 } };
  const cs = changedKeys({ "gateway.port": 20000, "channels.slack.enabled": true }, values);
  assert.deepEqual([...cs].sort(), ["channels.slack.enabled", "gateway.port"]);
});

ok("changedKeys sensitive 哨兵（undefined）恒不算修改", () => {
  const values = { gateway: { auth: { token: "***" } } };
  const cs = changedKeys({ "gateway.auth.token": undefined }, values);
  assert.equal(cs.size, 0);
});

ok("changedKeys 对象值深相等 → 未改；嵌套差异 → 已改", () => {
  const values = { a: { x: { y: 1 } } };
  assert.equal(changedKeys({ "a.x": { y: 1 } }, values).size, 0);
  assert.deepEqual([...changedKeys({ "a.x": { y: 2 } }, values)], ["a.x"]);
});

// ── keyMatchesTemplate ──────────────────────────────────────────────
ok("keyMatchesTemplate 精确/通配/段数不符", () => {
  assert.equal(keyMatchesTemplate("gateway.port", "gateway.port"), true);
  assert.equal(keyMatchesTemplate("gateway.host", "gateway.port"), false);
  assert.equal(keyMatchesTemplate("channels.matrix.enabled", "channels.*.enabled"), true);
  assert.equal(keyMatchesTemplate("channels.matrix.x", "channels.*.enabled"), false);
  assert.equal(keyMatchesTemplate("channels.matrix", "channels.*.enabled"), false);
});

// ── collectConcreteValues ───────────────────────────────────────────
ok("collectConcreteValues 单星收集全部 concrete 值", () => {
  const values = { channels: { matrix: { enabled: true }, telegram: { enabled: false } } };
  assert.deepEqual(collectConcreteValues("channels.*.enabled", values), [true, false]);
});

ok("collectConcreteValues 双星笛卡尔收集", () => {
  const values = {
    models: {
      providers: {
        anthropic: { models: { m1: { id: "m1" }, m2: { id: "m2" } } },
        openai: { models: { g1: { id: "g1" } } },
      },
    },
  };
  assert.deepEqual(
    collectConcreteValues("models.providers.*.models.*.id", values),
    ["m1", "m2", "g1"],
  );
});

ok("collectConcreteValues 父路径缺失 → 空", () => {
  assert.deepEqual(collectConcreteValues("models.providers.*.models.*.id", { models: {} }), []);
});

// ── templateDraftEntries ────────────────────────────────────────────
// 注：templateDraftEntries 只负责「本模板」（只认同名 concrete 键）；
// 组级跨模板并集由 SurfaceForm 调用侧做（starFields.flatMap 并集）。
ok("templateDraftEntries 只认本模板同名 concrete 键（去重、键序）", () => {
  const draft = {
    "channels.matrix.enabled": true,
    "channels.slack.apiKey": "x",
    "channels.matrix.apiKey": "y",
    "gateway.port": 1,
  };
  // 只匹配 channels.*.enabled：slack 只有 apiKey（属于别的模板）→ 不计。
  // 组级「任一模板有值即出现」的并集由 SurfaceForm 调用侧
  // starFields.flatMap(...) 完成，不在本纯函数职责内。
  assert.deepEqual(templateDraftEntries("channels.*.enabled", draft), ["matrix"]);
  assert.deepEqual(templateDraftEntries("channels.*.apiKey", draft), ["slack", "matrix"]);
});

ok("templateDraftEntries 非通配模板 → []", () => {
  assert.deepEqual(templateDraftEntries("gateway.port", { "gateway.port": 1 }), []);
});

ok("组级跨模板并集（模拟 SurfaceForm starFields 调用侧）：条目在任一模板下有值即出现", () => {
  const starFields = [
    field("channels.*.enabled", "boolean"),
    field("channels.*.apiKey", "secret", { sensitive: true }),
  ];
  // matrix 只出现在 values（enabled 模板），slack 只在 draft（apiKey 模板）→ 并集取全。
  const values = { channels: { matrix: { enabled: true } } };
  const draft = { "channels.slack.apiKey": "x" };
  const entries = Array.from(
    new Set(
      starFields.flatMap((f) => [
        ...expandEntries(f.key, values),
        ...templateDraftEntries(f.key, draft),
      ]),
    ),
  );
  assert.deepEqual(entries, ["matrix", "slack"]);
});

console.log(`\no2-surface: ${n} passed`);
