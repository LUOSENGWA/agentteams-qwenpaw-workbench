// QC-198 Step 7 · crdmanage 纯叶子 helpers 冒烟（node 直跑）。
// 用仓内 esbuild 把 helpers.ts 转译到 /tmp 临时目录（type-only import 全部擦除、
// 不做 type-check，产物为零依赖纯 JS），动态 import 后断言**实际**函数语义
//（非规格书臆断）。用法：node scripts/crdmanageHelpers.smoke.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const front = path.resolve(here, "..");
const src = path.join(front, "src/crdmanage/helpers.ts");
const out = path.join("/tmp", `qc198-crdmanage-smoke-${process.pid}`);
mkdirSync(out, { recursive: true });
const emitted = path.join(out, "helpers.js");

// esbuild transform（输出到 stdout，transform 模式不吃 --outfile），type-only
// import 全擦除、不做 type-check——避开裸 tsc 无项目 tsconfig 时解析不到全局
// 声明（如 window.QwenPaw）的问题；helpers.ts 纯 TS 无 JSX，产物零依赖可直 import。
const js = execFileSync(path.join(front, "node_modules/.bin/esbuild"), [
  src, "--format=esm", "--target=es2022",
], { cwd: front, stdio: "pipe" });
writeFileSync(emitted, js);

const mod = await import(pathToFileURL(emitted).href);
const { soulBudget, workerOptionLabel, roleSelectOptions, soulLines } = mod;

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("ok  -", msg);
  } else {
    console.error("FAIL -", msg);
    failed++;
  }
}

// soulBudget：Leader ≤250 / 其余（Worker）≤150
assert(soulBudget("team_leader") === 250, 'soulBudget("team_leader") === 250');
assert(soulBudget("worker") === 150, 'soulBudget("worker") === 150');
assert(soulBudget("别的角色") === 150, "soulBudget 非 leader 一律 150");

// workerOptionLabel：`${name} (${parts.join(" · ")})`，parts=有值的 [team, model]；
// 无数据回退纯名字。
const workers = [
  { name: "w1", team: "t1", model: "m1" },
  { name: "w2", team: "", model: "m2" },
  { name: "w3", team: "t3", model: "" },
];
assert(workerOptionLabel("w1", workers) === "w1 (t1 · m1)", "workerOptionLabel 全量 team · model");
assert(workerOptionLabel("w2", workers) === "w2 (m2)", "workerOptionLabel 仅 model");
assert(workerOptionLabel("w3", workers) === "w3 (t3)", "workerOptionLabel 仅 team");
assert(workerOptionLabel("不存在", workers) === "不存在", "workerOptionLabel 无数据回退纯名");

// soulLines：split("\n") 计数——空串=1 行、尾随换行多计 1（实现口径）。
assert(soulLines("") === 1, 'soulLines("") === 1');
assert(soulLines("a") === 1, "soulLines 单行 = 1");
assert(soulLines("a\nb") === 2, "soulLines 真换行两行 = 2");
assert(soulLines("a\\nb") === 1, "soulLines 字面反斜杠-n 不当换行 = 1");
assert(soulLines("a\nb\nc\n") === 4, "soulLines 尾随换行 = 4");

// roleSelectOptions：提交值不变（team_leader/worker），标签走 tr()。
const tr = (s) => s;
const opts = roleSelectOptions(tr);
assert(opts.length === 2, "roleSelectOptions 恰 2 项");
assert(opts[0].value === "team_leader" && opts[0].label === "Leader (team_leader)", "leader 项 value/label");
assert(opts[1].value === "worker" && opts[1].label === "Worker (worker)", "worker 项 value/label");

if (failed) {
  console.error(`SMOKE_FAIL（${failed} 项）`);
  process.exit(1);
}
console.log("SMOKE_OK");
