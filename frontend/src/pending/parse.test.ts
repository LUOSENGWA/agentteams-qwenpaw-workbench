// P0 人工介入闭环 — parse 单测（任务书 §4.1 用例 1-7）。
//
// 无测试框架（仓库无 jest/vitest，scripts 仅 build）——本文件是
// 框架无关脚本：tsc 编译后 node 直跑，全部用例 PASS 退出码 0，
// 任一 FAIL 退出码 1。用例与任务书 §4.1 一一对应。

import {
  parseAttentionMessage,
  parseOptions,
  classifyMentions,
  attentionPendingKind,
} from "./parse";

declare const process: { exitCode?: number };

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 用例 1：ATTENTION_APPROVAL 首行识别 ────────────────────────────
{
  const body = " @leader:server ATTENTION_APPROVAL: task-123 - 是否允许执行迁移？";
  const r = parseAttentionMessage(body);
  check("1a kind=APPROVAL", r?.kind === "APPROVAL", `got ${r?.kind}`);
  check("1b taskId=task-123", r?.taskId === "task-123", `got ${r?.taskId}`);
  check(
    "1c question=是否允许执行迁移？",
    r?.question === "是否允许执行迁移？",
    `got ${r?.question}`,
  );
}

// ── 用例 2：多行选项 1）/2）/3） → 3 项、顺序、裸 id ─────────────────
{
  const q = "选择方案：\n1）方案 A\n2）方案 B\n3）方案 C";
  const opts = parseOptions(q);
  check("2a 3 options", opts?.length === 3, `got ${opts?.length}`);
  check(
    "2b ids 1/2/3 顺序",
    opts?.map((o) => o.id).join(",") === "1,2,3",
    `got ${opts?.map((o) => o.id).join(",")}`,
  );
  check(
    "2c labels 方案 A/B/C",
    opts?.map((o) => o.label).join("|") === "方案 A|方案 B|方案 C",
    `got ${opts?.map((o) => o.label).join("|")}`,
  );
  // 整行压缩形态（QwenPaw 常把选项组压成一行）。
  const inline = parseOptions("1）方案 A / 2）方案 B / 3）方案 C");
  check(
    "2d inline ids 1/2/3",
    inline?.map((o) => o.id).join(",") === "1,2,3",
    `got ${inline?.map((o) => o.id).join(",")}`,
  );
  check(
    "2e inline labels 干净（无 / 尾巴）",
    inline?.[0]?.label === "方案 A" && inline?.[2]?.label === "方案 C",
    `got ${inline?.map((o) => o.label).join("|")}`,
  );
}

// ── 用例 3：字母选项 A. / B. → id "A"/"B" ───────────────────────────
{
  const opts = parseOptions("配色选哪个？\nA. 深色\nB. 浅色");
  check("3a alpha ids A/B", opts?.map((o) => o.id).join(",") === "A,B", `got ${opts?.map((o) => o.id).join(",")}`);
  check("3b alpha labels", opts?.map((o) => o.label).join("|") === "深色|浅色", `got ${opts?.map((o) => o.label).join("|")}`);
}

// ── 用例 4：代码块内的 1）xx 不解析 ─────────────────────────────────
{
  const q = "是否继续？\n```\n1）xx\n2）yy\n```";
  const opts = parseOptions(q);
  check("4 code block not parsed", opts === undefined, `got ${JSON.stringify(opts)}`);
}

// ── 用例 5：自由问句无选项 → undefined ──────────────────────────────
{
  check("5 free question → undefined", parseOptions("是否继续？") === undefined);
}

// ── 用例 6：非 ATTENTION → null ────────────────────────────────────
{
  check("6a 普通消息", parseAttentionMessage("普通消息") === null);
  check(
    "6b 无前导空格不认",
    parseAttentionMessage("@a:b ATTENTION_APPROVAL: t1 - q") === null,
  );
  check("6c 空串", parseAttentionMessage("") === null);
}

// ── 用例 7：m.mentions.user_ids 含当前用户 → @我 命中 ───────────────
{
  const me = "@luo:matrix.local";
  check(
    "7a mention hit",
    classifyMentions({ "m.mentions": { user_ids: ["@bot:matrix.local", me] } }, me) === true,
  );
  check(
    "7b mention miss",
    classifyMentions({ "m.mentions": { user_ids: ["@bot:matrix.local"] } }, me) === false,
  );
  check("7c 无 m.mentions 载荷", classifyMentions(null, me) === false);
}

// ── 附加口径：pending kind 与答复语义（供接线层回归）────────────────
{
  check("K1 有 question=intervention", attentionPendingKind("怎么做？") === "intervention");
  check("K2 无 question=approval", attentionPendingKind("") === "approval");
}

console.log(`\nparse.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
