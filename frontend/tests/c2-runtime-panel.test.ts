// C2：运行时配置分组面板（ConfigSectionModel + RuntimeConfigPanel）。
// - lib/configSectionModel 纯函数行为断言（node 直 import：零运行时依赖，
//   仅 import type）；分组规则三级回退（field.group/tab/section → key
//   前缀 → other）、顶级段固定顺序、config 段 QwenPaw 二级基准序、
//   filterSection / advancedFields / diffDraft；
// - hermes 夹具（tests/fixtures/hermes-surface.json，102 face；生产代码
//   不得 import/读盘依赖它）做总数守恒 + 分段归属抽检；
// - 源码接线断言：RuntimeConfigPanel 复用 CfgRow/SchemaField（不重写
//   字段渲染），模型与面板不读盘、不引用夹具。
// 直跑：node --experimental-strip-types frontend/tests/c2-runtime-panel.test.ts
//（node:assert/strict；≥10 case）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_SUB_ORDER,
  SECTION_ORDER,
  advancedFields,
  buildSections,
  diffDraft,
  filterSection,
  fieldGroup,
  prefixBucket,
} from "../src/lib/configSectionModel.ts";
import type { RuntimeSurface, SurfaceField } from "../src/api/domains/memberConfig.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

const panelSrc = readFileSync(
  path.join(here, "..", "src", "components", "runtimeCfg", "RuntimeConfigPanel.tsx"),
  "utf8",
);
const modelSrc = readFileSync(path.join(here, "..", "src", "lib", "configSectionModel.ts"), "utf8");

// 夹具：测试输入（生产代码不依赖；此处仅 JSON.parse 构造 buildSections 输入）。
const fixture = JSON.parse(
  readFileSync(path.join(here, "fixtures", "hermes-surface.json"), "utf8"),
) as RuntimeSurface;

// ── 工具 ─────────────────────────────────────────────────────────────
let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
}

function fld(key: string, label: string | undefined, extra: Record<string, unknown> = {}): SurfaceField {
  const o: Record<string, unknown> = { key, type: "string", applies: "hot" };
  if (label !== undefined) o.label = label;
  return Object.assign(o, extra) as SurfaceField;
}
function face(id: string, fields: SurfaceField[]): { id: string; fields: SurfaceField[] } {
  return { id, fields };
}
function surfaceOf(...faces: Array<{ id: string; fields: SurfaceField[] }>): RuntimeSurface {
  return { runtime: "test", surfaceVersion: "1", faces };
}
/** 段内二级 id → 字段 key 列表。 */
function subMap(sec: { subSections: Array<{ id: string; fields: SurfaceField[] }> }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of sec.subSections) out[s.id] = s.fields.map((f) => f.key);
  return out;
}

// ── 1. 无分组字段按 key 前缀归类 ─────────────────────────────────────
ok("无分组字段按前缀归类：llm.temperature → config 段 / llm 二级段", () => {
  const secs = buildSections(surfaceOf(face("a", [fld("llm.temperature")])));
  assert.equal(secs.length, 1);
  assert.equal(secs[0].id, "config");
  assert.equal(secs[0].fields.length, 1);
  assert.equal(secs[0].subSections.length, 1);
  assert.equal(secs[0].subSections[0].id, "llm");
  assert.deepEqual(secs[0].subSections[0].fields.map((f) => f.key), ["llm.temperature"]);
});

ok("前缀归类：memory.window → memory；embedding.model → embedding；model.* 归 llm", () => {
  const secs = buildSections(
    surfaceOf(face("a", [fld("memory.window"), fld("embedding.model"), fld("model.default")])),
  );
  assert.equal(secs.length, 1);
  assert.equal(secs[0].id, "config");
  const sub = subMap(secs[0]);
  assert.deepEqual(sub.memory, ["memory.window"]);
  assert.deepEqual(sub.embedding, ["embedding.model"]);
  assert.deepEqual(sub.llm, ["model.default"]);
});

// ── 2. 未知字段落 other ──────────────────────────────────────────────
ok("未知字段（无分组、前缀不命中）→ other 段", () => {
  const secs = buildSections(surfaceOf(face("a", [fld("foo.bar")])));
  assert.equal(secs.length, 1);
  assert.equal(secs[0].id, "other");
  assert.deepEqual(secs[0].fields.map((f) => f.key), ["foo.bar"]);
});

// ── 3. 顶级段顺序固定（缺段跳过）────────────────────────────────────
ok("段顺序固定 config,mcp,tools,skills,acp,checkpoints,other（乱序声明仍按序；缺段跳过）", () => {
  const secs = buildSections(
    surfaceOf(
      face("o", [fld("x1", undefined, { group: "other" })]),
      face("c", [fld("x2", undefined, { group: "checkpoints" })]),
      face("a", [fld("x3", undefined, { group: "acp" })]),
      face("s", [fld("x4", undefined, { group: "skills" })]),
      face("t", [fld("x5", undefined, { group: "tools" })]),
      face("m", [fld("x6", undefined, { group: "mcp" })]),
      face("k", [fld("x7", undefined, { group: "model" })]), // model → config 段
    ),
  );
  assert.deepEqual(secs.map((s) => s.id), ["config", "mcp", "tools", "skills", "acp", "checkpoints", "other"]);
  const partial = buildSections(
    surfaceOf(face("m", [fld("x1", undefined, { group: "mcp" })]), face("k", [fld("x2", undefined, { group: "model" })])),
  );
  assert.deepEqual(partial.map((s) => s.id), ["config", "mcp"]); // 缺段不出现，config 在 mcp 前
});

// ── 4. config 段二级顺序（QwenPaw 基准）──────────────────────────────
ok("config 段内二级顺序符合 QwenPaw 基准（乱序声明仍按序；未知二级段追加在后）", () => {
  const shuffled = [
    "toolExecutionLevel",
    "memory",
    "zzCustom", // 未知二级段 → 8 个已知段之后
    "context",
    "reactAgent",
    "agentLoop",
    "llmRateLimiter",
    "embeddingModel",
    "llmRetry",
  ];
  const secs = buildSections(surfaceOf(face("a", shuffled.map((g, i) => fld(`k${i}`, undefined, { group: g })))));
  assert.equal(secs.length, 1);
  assert.equal(secs[0].id, "config");
  assert.deepEqual(
    secs[0].subSections.map((s) => s.id),
    [...CONFIG_SUB_ORDER, "zzCustom"],
  );
});

// ── 5. filterSection ─────────────────────────────────────────────────
ok("filterSection：大小写不敏感子串匹配（key/label/描述）；空查询返回全部；二级段同步过滤", () => {
  const secs = buildSections(
    surfaceOf(
      face("a", [
        fld("llm.temperature", "Temperature"),
        fld("memory.max_tokens", "Max Tokens"),
        fld("context.max", "Max", { description: "context window limit" }),
      ]),
    ),
  );
  const sec = secs[0];
  assert.equal(filterSection(sec, "").fields.length, 3);
  assert.equal(filterSection(sec, "   ").fields.length, 3); // 纯空白 = 空查询
  assert.deepEqual(filterSection(sec, "TEMP").fields.map((f) => f.key), ["llm.temperature"]); // 大写查询命中
  assert.deepEqual(filterSection(sec, "MAX").fields.map((f) => f.key), ["memory.max_tokens", "context.max"]);
  assert.deepEqual(filterSection(sec, "window limit").fields.map((f) => f.key), ["context.max"]); // 描述命中
  const r = filterSection(sec, "TEMP");
  assert.equal(r.subSections.length, 1); // 无命中的二级段移除
  assert.equal(r.subSections[0].id, "llm");
});

// ── 6. advancedFields ────────────────────────────────────────────────
ok("advancedFields：名字含 retry/timeout/limit 或 advanced:true 被识别；普通字段不在内", () => {
  // 同段（group=agent → config/agent）内判定，隔离 advancedFields 逻辑。
  const secs = buildSections(
    surfaceOf(
      face("a", [
        fld("llm.retry.max_attempts", "retry attempts", { group: "agent" }),
        fld("agent.gateway.timeout", "gateway timeout", { group: "agent" }),
        fld("database.journal_size_limit", "journal size limit", { group: "agent" }),
        fld("llm.temperature", "temperature", { group: "agent", advanced: true }),
        fld("llm.top_p", "top p", { group: "agent" }),
      ]),
    ),
  );
  assert.deepEqual(
    advancedFields(secs[0]).map((f) => f.key).sort(),
    ["agent.gateway.timeout", "database.journal_size_limit", "llm.retry.max_attempts", "llm.temperature"],
  );
});

// ── 7. diffDraft ─────────────────────────────────────────────────────
ok("diffDraft：无变更 → []；改 1 项 → 该 key；undefined 哨兵恒不算变更；对象深比较", () => {
  assert.deepEqual(diffDraft({ a: 1, b: "x" }, { a: 1, b: "x" }), []);
  assert.deepEqual(diffDraft({ a: 1, b: "y" }, { a: 1, b: "x" }), ["b"]);
  assert.deepEqual(diffDraft({ s: undefined, a: 1 }, { s: "secret", a: 1 }), []); // 敏感哨兵
  assert.deepEqual(diffDraft({ o: { x: 1, y: 2 }, b: "x" }, { o: { x: 1, y: 3 }, b: "x" }), ["o"]);
  assert.deepEqual(diffDraft({ n: "new-entry" }, {}), ["n"]); // 草稿新增条目
});

// ── 8. 分组优先级：自带分组压过前缀 ──────────────────────────────────
ok("字段自带分组优先于前缀：key llm.* 但 group=mcp → mcp 段；tab 作 group 的回退", () => {
  const secs = buildSections(
    surfaceOf(face("a", [fld("llm.temperature", undefined, { group: "mcp" })])),
  );
  assert.deepEqual(secs.map((s) => s.id), ["mcp"]);
  const byTab = buildSections(surfaceOf(face("b", [fld("foo.bar", undefined, { tab: "skills" })])));
  assert.deepEqual(byTab.map((s) => s.id), ["skills"]);
  // fieldGroup 取第一个非空：group 空串 → 落 tab
  assert.equal(fieldGroup({ key: "k", type: "string", applies: "hot", group: "", tab: "acp" }), "acp");
});

// ── 9. 前缀边界 ──────────────────────────────────────────────────────
ok("prefixBucket 边界：window* → context；exec* → tools；models* → llm；retry*/timeout* → reliability", () => {
  assert.equal(prefixBucket("window.size"), "context");
  assert.equal(prefixBucket("context.max_tokens"), "context");
  assert.equal(prefixBucket("exec.timeout"), "tools");
  assert.equal(prefixBucket("tools.shell"), "tools");
  assert.equal(prefixBucket("models.providers.openai"), "llm");
  assert.equal(prefixBucket("retry.backoff"), "reliability");
  assert.equal(prefixBucket("timeout.connect"), "reliability");
  assert.equal(prefixBucket("mcp.servers"), "mcp");
  assert.equal(prefixBucket("weird.thing"), "other");
});

// ── 10. 总数守恒（100 字段 + 完整夹具）──────────────────────────────
ok("100 字段 surface 分段总数守恒：sum(section.fields.length) === 输入字段数", () => {
  // 从夹具按声明顺序截取恰好 100 个字段
  let need = 100;
  const faces: Array<{ id: string; fields: SurfaceField[] }> = [];
  for (const fc of fixture.faces) {
    if (need <= 0) break;
    const take = fc.fields.slice(0, need);
    if (take.length > 0) faces.push({ ...fc, fields: take });
    need -= take.length;
  }
  const total100 = faces.reduce((s, fc) => s + fc.fields.length, 0);
  assert.equal(total100, 100);
  const secs = buildSections({ ...fixture, faces });
  assert.equal(secs.reduce((s, sec) => s + sec.fields.length, 0), 100);
});

ok("hermes 完整夹具（102 face）总数守恒且段 id 合法：sum === 输入字段数，id ⊆ 固定顺序且无重复", () => {
  const total = fixture.faces.reduce((s, fc) => s + fc.fields.length, 0);
  assert.ok(total > 100, `夹具字段数应 >100（实得 ${total}）`);
  const secs = buildSections(fixture);
  assert.equal(secs.reduce((s, sec) => s + sec.fields.length, 0), total);
  for (const id of secs.map((s) => s.id)) assert.ok(SECTION_ORDER.includes(id), `非法段 id：${id}`);
  assert.equal(new Set(secs.map((s) => s.id)).size, secs.length, "段 id 重复");
});

ok("hermes 夹具分段归属抽检：toolsets→tools、mcp.*→mcp、skills→skills、checkpoints→checkpoints、model→config/model 二级", () => {
  const byId: Record<string, ReturnType<typeof buildSections>[number]> = {};
  for (const s of buildSections(fixture)) byId[s.id] = s;
  assert.ok(byId.tools.fields.some((f) => f.key === "toolsets"), "toolsets 应在 tools 段");
  assert.ok(byId.mcp.fields.some((f) => f.key.startsWith("mcp.")), "mcp.* 应在 mcp 段");
  assert.ok(byId.skills && byId.skills.fields.length > 0, "skills 段非空");
  assert.ok(byId.checkpoints && byId.checkpoints.fields.length > 0, "checkpoints 段非空");
  assert.ok(byId.config.subSections.some((s) => s.id === "model"), "config 段含 model 二级段");
  assert.ok(!("acp" in byId), "夹具无 acp 分组 → acp 段不出现");
});

// ── 11. 源码接线：复用既有字段渲染，不读盘、不依赖夹具 ───────────────
ok("源码接线：RuntimeConfigPanel 复用 CfgRow/SchemaField；config 走 Tabs、其余走 Card；tr 透传", () => {
  assert.match(panelSrc, /import\s+CfgRow\s+from\s+["']\.\/CfgRow["']/);
  assert.match(panelSrc, /import\s+SchemaField\s+from\s+["']\.\.\/schema\/SchemaField["']/);
  assert.match(panelSrc, /import\s*{[^}]*buildSections[^}]*}\s*from\s+["']\.\.\/\.\.\/lib\/configSectionModel["']/s);
  assert.match(panelSrc, /tr\?: Tr/); // tr 由调用方传入
  // F-CFG-3 结构：面板按能力桶渲染（config → tabs；能力桶 → 分节），
  // 能力卡片由 ResourceCards 传 bucket 决定。
  assert.match(panelSrc, /antd\.Tabs/);
  assert.match(panelSrc, /filterByBucket/);
  assert.match(panelSrc, /bucket\?: CapabilityBucket/);
  assert.match(panelSrc, /SUB_LABELS/);
  assert.match(panelSrc, /FACE_LABELS/);
});

ok("生产代码不依赖夹具：模型与面板源码均无 fixtures/readFileSync/hermes-surface 引用", () => {
  // Comments may explain the fixture policy; only real code counts.
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [name, src] of [
    ["configSectionModel.ts", modelSrc],
    ["RuntimeConfigPanel.tsx", panelSrc],
  ] as const) {
    const body = code(src);
    assert.ok(!body.includes("fixtures"), `${name} 引用了 fixtures`);
    assert.ok(!body.includes("readFileSync"), `${name} 运行时读盘`);
    assert.ok(!body.includes("hermes-surface"), `${name} 引用夹具名`);
  }
});

console.log(`\n${n} tests passed`);
