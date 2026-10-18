#!/usr/bin/env python3
"""15.28 P1 逻辑门：LLM 调优 stream 组 env 实际值预填层（esbuild 编译真代码跑）。

断言（8）：
  a1 两 stream 字段有 envKey、无 registryDefault
  a2 worker/team 空 + env=300 → 生效值=300（entrypoint 默认场景）
  a3 worker 覆盖 → 覆盖优先于 env
  a4 team 有值 → team 优先于 env
  a5 env 缺（拉取失败）→ 回退原三层（空串）
  a6 diff：draft=env 继承值 → diff 空（改回继承=不写冗余）
  a7 diff：draft=120 → diff 只含该键
  a8 startup 组不受 env 层影响
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONT = os.path.join(ROOT, "frontend")
LIB = os.path.join(FRONT, "src", "lib", "llm-tuning.ts")
MAIN = "/tmp/llm-env-logic-main.ts"
BUNDLE = "/tmp/llm-env-logic.mjs"

TS = f'''
import {{
  LLM_TUNING_FIELDS, resolveEffectiveLlmTuning,
  diffLlmTuningToOverride, emptyLlmTuning,
}} from {json.dumps(LIB)};
const out = {{}};
const first = "llmStreamFirstContentTimeout", idle = "llmStreamIdleTimeout";
const f = (k) => LLM_TUNING_FIELDS.find((x) => x.key === k);
out.a1 = f(first).envKey === "QWENPAW_LLM_STREAM_FIRST_CONTENT_TIMEOUT"
  && f(idle).envKey === "QWENPAW_LLM_STREAM_IDLE_TIMEOUT"
  && f(first).registryDefault === undefined;
const emptyTeam = emptyLlmTuning();
const noOverride = emptyLlmTuning();
const env300 = {{ [first]: "300", [idle]: "300" }};
out.a2 = (() => {{ const e = resolveEffectiveLlmTuning(noOverride, emptyTeam, env300);
  return e[first] === "300" && e[idle] === "300"; }})();
out.a3 = (() => {{ const ov = {{ ...noOverride, [first]: "60" }};
  const e = resolveEffectiveLlmTuning(ov, emptyTeam, env300);
  return e[first] === "60" && e[idle] === "300"; }})();
out.a4 = (() => {{ const team120 = {{ ...emptyTeam, [idle]: "120" }};
  const e = resolveEffectiveLlmTuning(noOverride, team120, env300);
  return e[idle] === "120" && e[first] === "300"; }})();
out.a5 = (() => {{ const e = resolveEffectiveLlmTuning(noOverride, emptyTeam);
  return e[first] === "" && e[idle] === ""; }})();
out.a6 = (() => {{ const eff2 = resolveEffectiveLlmTuning(noOverride, emptyTeam, env300);
  return Object.keys(diffLlmTuningToOverride(eff2, emptyTeam, noOverride, env300)).length === 0; }})();
out.a7 = (() => {{ const eff2 = resolveEffectiveLlmTuning(noOverride, emptyTeam, env300);
  const d = diffLlmTuningToOverride({{ ...eff2, [first]: "120" }}, emptyTeam, noOverride, env300);
  return d[first] === "120" && Object.keys(d).length === 1; }})();
out.a8 = (() => {{ const e = resolveEffectiveLlmTuning(noOverride, emptyTeam, {{ [first]: "999" }});
  const startupKey = LLM_TUNING_FIELDS.find((x) => x.group === "startup").key;
  return e[startupKey] === "3" && e[idle] === ""; }})();
console.log(JSON.stringify(out));
'''

open(MAIN, "w", encoding="utf-8").write(TS)
r = subprocess.run(
    ["npx", "esbuild", MAIN, "--bundle", "--format=esm", "--platform=node",
     "--outfile=" + BUNDLE],
    cwd=FRONT, capture_output=True, text=True,
)
if r.returncode != 0:
    sys.stderr.write(r.stderr[:2000])
    sys.exit("esbuild failed")
n = subprocess.run(["node", BUNDLE], capture_output=True, text=True)
if n.returncode != 0:
    sys.stderr.write(n.stderr[:500])
    sys.exit("node run failed")
out = json.loads(n.stdout.strip().splitlines()[-1])
fails = [k for k, v in out.items() if not v]
for k in sorted(out):
    print(("PASS " if out[k] else "FAIL ") + k)
if fails:
    sys.exit(f"{len(fails)} assertions failed: {fails}")
print(f"LLM ENV LOGIC GATE: PASS ({len(out)}/{len(out)})")
