// runtimeLabels：face 标题词典 + 字段兜底（F-CFG-I18N）。
import assert from "node:assert/strict";

import { fieldLabel, labelFor } from "../src/lib/runtimeLabels.ts";

let n = 0;
const ok = (name: string, fn: () => void): void => {
  fn();
  n += 1;
  console.log(`  PASS ${n} ${name}`);
};

ok("OpenClaw face → 中文（gateway/工具/MCP）", () => {
  assert.equal(labelFor("openclaw", "gateway"), "网关");
  assert.equal(labelFor("openclaw", "tools"), "工具");
  assert.equal(labelFor("openclaw", "mcp"), "MCP");
});

ok("Hermes face → 中文（approvals/embedding 类不误翻）", () => {
  assert.equal(labelFor("hermes", "approvals"), "审批");
  assert.equal(labelFor("hermes", "mcp_servers"), "MCP 服务");
});

ok("未知 face：有上游 label 用 label", () => {
  assert.equal(labelFor("hermes", "no_such_face", "Custom Label"), "Custom Label");
});

ok("未知 face：无 label 回原 id", () => {
  assert.equal(labelFor("hermes", "no_such_face"), "no_such_face");
});

ok("两个运行时互不串味", () => {
  // openclaw 没有 approvals 词条 → 不是「审批」而是回 id
  assert.equal(labelFor("openclaw", "approvals"), "approvals");
  assert.equal(labelFor("hermes", "skills-plugins"), "skills-plugins");
});

ok("字段标题：surface label 优先", () => {
  assert.equal(fieldLabel("hermes", "gateway.auth.token", "Token"), "Token");
});

ok("字段标题：无 label 用尾段且去分隔符", () => {
  assert.equal(fieldLabel("hermes", "gateway.max_retry_count", ""), "max retry count");
});

console.log(`runtime-labels: ${n} tests passed`);
