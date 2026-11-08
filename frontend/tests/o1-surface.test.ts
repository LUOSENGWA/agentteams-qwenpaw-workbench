// O1：OpenClaw surface 类型对齐 + 动态条目纯逻辑 —— 单测。
// 直跑：node --experimental-strip-types frontend/tests/o1-surface.test.ts
//（node:assert/strict；import 带 .ts 扩展名；值依赖只经 lib/surfaceForm，
// 不触 window/react/chat 域；memberConfig 仅 type-only import，运行时被擦除）。
import assert from "node:assert/strict";

import {
  buildDraft,
  concreteKey,
  diffNested,
  expandEntries,
  formatFieldValue,
  isReadOnlyField,
  normalizeSurface,
} from "../src/lib/surfaceForm.ts";
import type { RuntimeSurface, SurfaceField } from "../src/api/domains/memberConfig.ts";

/** 最小 SurfaceField 字面量（applies 必填，hot 占位）。 */
function field(key: string, type: SurfaceField["type"], extra: Partial<SurfaceField> = {}): SurfaceField {
  return { key, type, applies: "hot", ...extra };
}

/** 单 face surface。 */
function surfaceOf(fields: SurfaceField[]): RuntimeSurface {
  return { runtime: "openclaw", surfaceVersion: "1.0.0", faces: [{ id: "main", fields }] };
}

let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

// ── expandEntries ────────────────────────────────────────────────────
ok("expandEntries 对象才计：标量/数组不计（任务书裁定）", () => {
  const values = { channels: { matrix: { enabled: true }, telegram: {}, discord: "x" } };
  // 任务书示例原写 ["matrix","telegram","discord"]，裁定后 discord（值 "x"，标量）不计。
  assert.deepEqual(expandEntries("channels.*.enabled", values), ["matrix", "telegram"]);
});

ok("expandEntries 父路径缺失 → []", () => {
  assert.deepEqual(expandEntries("channels.*.enabled", {}), []);
});

ok("expandEntries 该段是数组 → []", () => {
  assert.deepEqual(expandEntries("channels.*.enabled", { channels: [{ enabled: true }] }), []);
});

ok("expandEntries 深层父路径中途缺失 → []", () => {
  assert.deepEqual(expandEntries("models.providers.*.apiKey", { models: {} }), []);
});

ok("expandEntries 双星模板 → []（仅单星可展开）", () => {
  const values = { models: { anthropic: { models: { m1: { id: "m1" } } } } };
  assert.deepEqual(expandEntries("models.providers.*.models.*.id", values), []);
});

// ── concreteKey ──────────────────────────────────────────────────────
ok("concreteKey 单星拼接", () => {
  assert.equal(concreteKey("channels.*.enabled", "matrix"), "channels.matrix.enabled");
  assert.equal(concreteKey("models.providers.*.apiKey", "anthropic"), "models.providers.anthropic.apiKey");
});

ok("concreteKey 非通配模板原样返回", () => {
  assert.equal(concreteKey("gateway.port", "x"), "gateway.port");
});

// ── isReadOnlyField ──────────────────────────────────────────────────
ok("isReadOnlyField 双星 → true", () => {
  assert.equal(
    isReadOnlyField(field("models.providers.*.models.*.id", "string", { class: "definition" })),
    true,
  );
});

ok("isReadOnlyField 单星 → false", () => {
  assert.equal(isReadOnlyField(field("channels.*.enabled", "boolean")), false);
});

ok("isReadOnlyField 无星 → false", () => {
  assert.equal(isReadOnlyField(field("gateway.port", "number")), false);
});

// ── buildDraft ───────────────────────────────────────────────────────
ok("buildDraft 单星展开：每个 entry 一个 concrete 键", () => {
  const s = surfaceOf([field("channels.*.enabled", "boolean")]);
  const values = { channels: { matrix: { enabled: true }, telegram: { enabled: false } } };
  assert.deepEqual(buildDraft(s, values), {
    "channels.matrix.enabled": true,
    "channels.telegram.enabled": false,
  });
});

ok("buildDraft sensitive 读回 *** → undefined 哨兵（键存在）", () => {
  const s = surfaceOf([field("channels.*.apiKey", "secret", { sensitive: true })]);
  const values = { channels: { matrix: { apiKey: "***" } } };
  const draft = buildDraft(s, values);
  assert.ok(Object.prototype.hasOwnProperty.call(draft, "channels.matrix.apiKey"));
  assert.equal(draft["channels.matrix.apiKey"], undefined);
});

ok("buildDraft sensitive 缺失且无 default → undefined 哨兵", () => {
  const s = surfaceOf([field("gateway.auth.token", "secret", { sensitive: true })]);
  const draft = buildDraft(s, {});
  assert.ok(Object.prototype.hasOwnProperty.call(draft, "gateway.auth.token"));
  assert.equal(draft["gateway.auth.token"], undefined);
});

ok("buildDraft 双星不进草稿", () => {
  const s = surfaceOf([field("models.providers.*.models.*.id", "string", { class: "definition" })]);
  const values = { models: { anthropic: { models: { m1: { id: "m1" } } } } };
  assert.deepEqual(buildDraft(s, values), {});
});

ok("buildDraft 非通配回归（default / 显式值）", () => {
  const s = surfaceOf([field("gateway.port", "number", { default: 18789 })]);
  assert.deepEqual(buildDraft(s, {}), { "gateway.port": 18789 });
  assert.deepEqual(buildDraft(s, { gateway: { port: 20000 } }), { "gateway.port": 20000 });
});

// ── diffNested ───────────────────────────────────────────────────────
ok("diffNested 通配变化叶子进嵌套 patch", () => {
  const values = { channels: { matrix: { enabled: true } } };
  const patch = diffNested({ "channels.matrix.enabled": false }, values);
  assert.deepEqual(patch, { channels: { matrix: { enabled: false } } });
});

ok("diffNested 未变 → 空 patch", () => {
  const values = { gateway: { port: 18789 } };
  assert.deepEqual(diffNested({ "gateway.port": 18789 }, values), {});
});

ok("diffNested 新增 entry（values 没有的 entry）→ 进 patch", () => {
  const values = { channels: {} };
  const patch = diffNested({ "channels.slack.enabled": true }, values);
  assert.deepEqual(patch, { channels: { slack: { enabled: true } } });
});

ok("diffNested 草稿含字面 * 键 → 被跳过", () => {
  const values = { channels: { matrix: { enabled: true } } };
  const patch = diffNested(
    { "channels.*.enabled": false, "channels.matrix.enabled": false },
    values,
  );
  assert.deepEqual(patch, { channels: { matrix: { enabled: false } } });
});

ok("diffNested sensitive 哨兵永不进 patch", () => {
  const values = { gateway: { auth: { token: "***" } } };
  const patch = diffNested({ "gateway.auth.token": undefined }, values);
  assert.deepEqual(patch, {});
});

// ── normalizeSurface ─────────────────────────────────────────────────
ok("normalizeSurface 5 类别名归一（enum 属性保留）", () => {
  const s = surfaceOf([
    field("a.i", "int"),
    field("a.f", "float"),
    field("a.b", "bool"),
    field("a.l", "string-list"),
    field("a.mode", "enum", { enum: ["local", "remote"] }),
  ]);
  const out = normalizeSurface(s);
  assert.deepEqual(
    out.faces[0].fields.map((f) => f.type),
    ["number", "number", "boolean", "array", "string"],
  );
  assert.deepEqual(out.faces[0].fields[4].enum, ["local", "remote"]);
});

ok("normalizeSurface 幂等", () => {
  const s = surfaceOf([field("a.i", "int"), field("a.b", "boolean"), field("a.r", "record")]);
  const once = normalizeSurface(s);
  assert.deepEqual(normalizeSurface(once), once);
});

ok("normalizeSurface 不 mutate 入参", () => {
  const s = surfaceOf([field("a.i", "int")]);
  normalizeSurface(s);
  assert.equal(s.faces[0].fields[0].type, "int");
});

// ── formatFieldValue ─────────────────────────────────────────────────
ok("formatFieldValue boolean/bool → 是/否", () => {
  assert.equal(formatFieldValue(field("a.b", "boolean"), true), "是");
  assert.equal(formatFieldValue(field("a.b", "boolean"), false), "否");
  assert.equal(formatFieldValue(field("a.b", "bool"), true), "是");
});

ok("formatFieldValue secret 掩码（非空 → ••••，空串 → 空）", () => {
  assert.equal(formatFieldValue(field("a.t", "secret"), "sk-live-123"), "••••");
  assert.equal(formatFieldValue(field("a.t", "secret"), ""), "");
});

ok("formatFieldValue number 字符串化", () => {
  assert.equal(formatFieldValue(field("a.n", "number"), 18789), "18789");
});

console.log(`\no1-surface: ${n} passed`);
