// A1b：团队级 attention 收件箱接到「待处理」页签（#1503）——API 层单测。
// 直跑：node --experimental-strip-types frontend/tests/a1b-team-attention.test.ts
//（node:assert/strict；11 case；断言 shipped 实现而非分叉副本）。
//
// 加载路径说明：attention.ts 值依赖 ../shared 与 ../../requestCache（无扩展名
// 相对 import，浏览器 bundle 形态），node ESM 无法直 import → 照 c1a / q-quota
// 先例用 esbuild buildSync 把 attention.ts bundle 到临时 .mjs（先注入 window
// 最小 shim），再动态 import 断言。依赖链（shared → hostEnv /
// localConfigBackend / requestCache）顶层无浏览器全局访问（已审计），
// shim 为零成本兜底。
//
// fetchTeamAttention 的 404/200/400 走注入 fetch（window.QwenPaw.host.fetch
// 桩），无真实网络；overdue 为服务端派生值，前端只透传、不本地计算
// （Date.now() 源码断言）。
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AttentionItem,
  TeamAttentionNotified,
  TeamAttentionRow,
} from "../src/api/domains/attention.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, "..", "src", "api", "domains", "attention.ts");
const attentionSrc = readFileSync(srcPath, "utf8");
const ncSrc = readFileSync(
  path.join(here, "..", "src", "components", "NotificationCenter.tsx"),
  "utf8",
);

// ── 注入 fetch：记录请求路径，按用例返回固定 Response（无真实网络）──
const calls: string[] = [];
let nextResponse: Response = new Response("{}", { status: 200 });
const fakeFetch = async (p: string): Promise<Response> => {
  calls.push(p);
  return nextResponse;
};
(globalThis as Record<string, unknown>).window = {
  QwenPaw: { host: { fetch: fakeFetch } },
};

const tmp = mkdtempSync(path.join(tmpdir(), "a1b-attention-"));
try {
  buildSync({
    entryPoints: [srcPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "attention.mjs"),
  });
  const mod = (await import(path.join(tmp, "attention.mjs"))) as {
    teamRowToAttentionItem: (row: TeamAttentionRow) => AttentionItem;
    fetchTeamAttention: (
      team: string,
      status: "open" | "overdue" | "resolved" | "all",
      limit?: number,
    ) => Promise<{ rows: TeamAttentionRow[]; skipped: number; unsupported: boolean }>;
  };
  const { teamRowToAttentionItem, fetchTeamAttention } = mod;

  let n = 0;
  async function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
    await fn();
    n += 1;
    console.log(`  PASS ${n} ${name}`);
  }

  const fullRow: TeamAttentionRow = {
    taskId: "task-42",
    teamId: "team-a",
    projectId: "proj-7",
    kind: "decision",
    question: "Pick a deployment target",
    options: [
      { id: "opt-a", label: "Staging", description: "Canary first" },
      { id: "opt-b", label: "Prod" },
    ],
    requestedAt: "2026-11-06T02:00:00Z",
    timeoutAt: "2026-11-06T03:00:00Z",
    overdue: true,
    resolved: false,
    resolvedVia: null,
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
    freeform: "Freeform question text",
    notified: {
      sent: true,
      roomAccepted: true,
      channelAccepted: null,
      recipients: ["@u1:example.org"],
      gaps: ["channel"],
      at: "2026-11-06T02:00:05Z",
    },
    roomId: "!room:example.org",
    url: "https://ctl.example/tasks/task-42",
  };

  // ── teamRowToAttentionItem：全字段映射 ─────────────────────────────
  await ok("全字段映射（options.description / url / roomId / timeout_at / freeform）", () => {
    const it = teamRowToAttentionItem(fullRow);
    assert.equal(it.task_id, "task-42");
    assert.equal(it.team_id, "team-a");
    assert.equal(it.project_id, "proj-7");
    assert.equal(it.kind, "decision");
    assert.equal(it.question, "Pick a deployment target");
    assert.equal(it.attempt, 0, "行无 attempt 字段 → 0（聚合视图键约定 ?? 1 不受影响）");
    assert.equal(it.requested_at, "2026-11-06T02:00:00Z");
    assert.equal(it.timeout_at, "2026-11-06T03:00:00Z");
    assert.equal(it.overdue, true, "overdue 透传服务端值");
    assert.equal(it.resolved, false);
    assert.equal(it.freeform, "Freeform question text");
    assert.equal(it.room_id, "!room:example.org");
    assert.equal(it.url, "https://ctl.example/tasks/task-42");
    assert.equal(it.options?.length, 2);
    assert.equal(it.options?.[0].description, "Canary first");
    assert.equal(it.options?.[1].description, undefined, "缺 description → undefined");
    assert.equal(it.notified?.sent, true);
    assert.equal(it.notified?.channelAccepted, null, "null 原样透传");
    assert.deepEqual(it.notified?.recipients, ["@u1:example.org"]);
    assert.deepEqual(it.notified?.gaps, ["channel"]);
  });

  // ── notified 不推断契约 ────────────────────────────────────────────
  await ok("notified 缺失/null → item.notified=null（绝不从 roomAccepted 推断 sent）", () => {
    const rNull: TeamAttentionRow = { ...fullRow, notified: null };
    assert.equal(teamRowToAttentionItem(rNull).notified, null);
    const rUndef: TeamAttentionRow = { ...fullRow, notified: undefined };
    assert.equal(teamRowToAttentionItem(rUndef).notified, null);
    // sent=false + roomAccepted=true：room 接受不得反推 sent=true
    const rRoom: TeamAttentionRow = {
      ...fullRow,
      notified: { sent: false, roomAccepted: true, channelAccepted: null },
    };
    const it = teamRowToAttentionItem(rRoom);
    assert.equal(it.notified?.sent, false, "不推断：sent 保持 false");
    assert.equal(it.notified?.roomAccepted, true, "room 接受独立展示");
  });

  await ok("notified 三态（channelAccepted true/false/null 原样，互不推断）", () => {
    for (const v of [true, false, null] as const) {
      const it = teamRowToAttentionItem({
        ...fullRow,
        notified: { sent: true, roomAccepted: true, channelAccepted: v },
      });
      assert.equal(it.notified?.channelAccepted, v);
      assert.equal(it.notified?.sent, true);
    }
  });

  await ok("resolved* + resolution 映射（null → undefined，有值透传）", () => {
    const r: TeamAttentionRow = {
      ...fullRow,
      resolved: true,
      resolvedVia: "dashboard",
      resolvedBy: "alice",
      resolvedAt: "2026-11-06T04:00:00Z",
      resolution: "opt-a",
    };
    const it = teamRowToAttentionItem(r);
    assert.equal(it.resolved, true);
    assert.equal(it.resolvedVia, "dashboard");
    assert.equal(it.resolvedBy, "alice");
    assert.equal(it.resolvedAt, "2026-11-06T04:00:00Z");
    assert.equal(it.resolution, "opt-a");
    assert.equal(teamRowToAttentionItem(fullRow).resolvedVia, undefined, "null → undefined");
  });

  // ── fetchTeamAttention（注入 fetch，无真实网络）────────────────────
  await ok("404 → unsupported=true（不抛错；rows=[]；路径 status/limit 逐字）", async () => {
    nextResponse = new Response(JSON.stringify({ detail: "no such endpoint" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    calls.length = 0;
    const res = await fetchTeamAttention("team/x", "open");
    assert.equal(res.unsupported, true);
    assert.deepEqual(res.rows, []);
    assert.equal(res.skipped, 0);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0],
      "/agentteams-proxy/controller/api/v1/teams/team%2Fx/attention?status=open&limit=200",
    );
  });

  await ok("200 → rows 透传 + X-Attention-Skipped 计数（裸数组信封）", async () => {
    const rows = [
      { ...fullRow, taskId: "t1", notified: null },
      { ...fullRow, taskId: "t2", overdue: false, notified: null },
    ];
    nextResponse = new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Attention-Skipped": "2" },
    });
    calls.length = 0;
    const res = await fetchTeamAttention("team-a", "overdue", 50);
    assert.equal(res.unsupported, false);
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[0].taskId, "t1");
    assert.equal(res.skipped, 2, "响应头 2 → skipped=2");
    assert.ok(
      calls[0].endsWith("/teams/team-a/attention?status=overdue&limit=50"),
      `路径尾部逐字：${calls[0]}`,
    );
  });

  await ok("X-Attention-Skipped 缺失 → skipped=0；{rows:[...]} 信封兼容", async () => {
    nextResponse = new Response(JSON.stringify({ rows: [{ ...fullRow, taskId: "t9" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const res = await fetchTeamAttention("team-a", "all");
    assert.equal(res.skipped, 0, "无头 → 0");
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].taskId, "t9");
  });

  await ok("400（limit>1000 等参数错）原样抛错（不吞）", async () => {
    nextResponse = new Response(JSON.stringify({ detail: "limit too large" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(fetchTeamAttention("team-a", "open", 5000), /HTTP 400/);
  });

  // ── 源码断言：契约面 + 无本地 overdue 计算 ─────────────────────────
  await ok("attention.ts：读 X-Attention-Skipped / 404→unsupported / overdue 透传不计算", () => {
    assert.match(attentionSrc, /X-Attention-Skipped/);
    assert.match(attentionSrc, /httpErrorStatus\(e\) === 404/);
    assert.match(attentionSrc, /unsupported: true/);
    assert.match(attentionSrc, /overdue: row\.overdue/, "overdue=服务端值透传");
    assert.equal(
      attentionSrc.includes("Date.now()"),
      false,
      "attention.ts 不得含本地逾期计算（Date.now）",
    );
  });

  await ok("NotificationCenter：接 fetchTeamAttention / unsupported 降级 / 无本地 overdue", () => {
    assert.match(ncSrc, /fetchTeamAttention/, "接团队视角拉取");
    assert.match(ncSrc, /teamUnsupported/, "unsupported 状态");
    assert.match(ncSrc, /res\.unsupported/);
    assert.match(ncSrc, /X-Attention-Skipped/, "skipped 计数来源标注");
    assert.match(ncSrc, /当前控制器不支持团队视角（需 #1503）/, "404 黄条");
    assert.match(ncSrc, /聚合视图/, "降级时聚合内容标注");
    assert.match(ncSrc, /tr\("全部（聚合）"\)/, "范围选择默认项");
    assert.equal(
      ncSrc.includes("Date.now()"),
      false,
      "NotificationCenter 无本地时间派生",
    );
    assert.equal(
      ncSrc.includes("timeoutAt"),
      false,
      "UI 不得用 timeoutAt 本地派生 overdue",
    );
  });

  await ok("「全部（聚合）」为默认范围（scopeTeam 初始=空 → 聚合视图现状行为）", () => {
    assert.match(ncSrc, /const \[scopeTeam, setScopeTeam\] = React\.useState\(""\)/);
    assert.match(ncSrc, /teamRowToAttentionItem/, "团队行映射进现有行样式");
    assert.match(ncSrc, /listTeamNames/, "团队名来自既有 teams 域、一次并缓存");
  });

  console.log(`\na1b-team-attention: ${n} passed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
