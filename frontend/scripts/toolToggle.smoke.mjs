// v0.5.0-beta.14.26（F3 回归锁）：工具开关成功横幅四分支语义。
// 旧版 bug：文案只按 field 分支不看 value——关工具（value=false）仍
// 显示「{w} 已启用」（实盘反馈 10/8 实盘）。横幅必须与开关终态一致。
// 用法：node scripts/toolToggle.smoke.mjs
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert";

const tmp = mkdtempSync(path.join(tmpdir(), "tt-smoke-"));
buildSync({
  entryPoints: ["src/util.ts"],
  bundle: true,
  format: "esm",
  outfile: path.join(tmp, "util.mjs"),
  platform: "node",
});
const { toolToggleMessage } = await import(path.join(tmp, "util.mjs"));

// tr 探针：原样回键 + {w} 展开——断键名即可精确锁定分支。
const tr = (key, vars) => key.replace("{w}", (vars || {}).w || "?");

// enabled 字段：开→「已启用」/ 关→「已停用」（14.26 修复点）。
assert.strictEqual(
  toolToggleMessage(tr, "enabled", "shell", true),
  "shell 已启用",
  "T1 enabled=true → 已启用",
);
assert.strictEqual(
  toolToggleMessage(tr, "enabled", "shell", false),
  "shell 已停用",
  "T2 enabled=false → 已停用（旧版此处误报「已启用」）",
);
// asyncExecution 字段：开/关各归其位，不再借用 enabled 的文案。
assert.strictEqual(
  toolToggleMessage(tr, "asyncExecution", "browser", true),
  "browser 异步执行已启用",
  "T3 async=true → 异步执行已启用（旧版误报「已启用」）",
);
assert.strictEqual(
  toolToggleMessage(tr, "asyncExecution", "browser", false),
  "browser 异步执行已停用",
  "T4 async=false → 异步执行已停用（旧版误报「已停用」但字段张冠李戴）",
);

rmSync(tmp, { recursive: true, force: true });
console.log("toolToggle smoke: 4/4 OK");
