// H2：人员详情 → 工作区访问区（Human CR spec.workspaceAccess，#1502 管理员面）。
// - api/domains/workspaceAccess 纯函数 + 注入断言（esbuild bundle +
//   window shim + host.fetch 注入；先例 c2b-human-model-access）：
//   ① 路径校验（validateAccessPath：files/ 前缀 / 绝对路径 / .. / .trash/ /
//      memory/** 拒绝，files/a/** 通过；非顶层 .trash 段合法）
//   ② 模式越界（grants 带 none 拒绝；restrictions 带 readwrite 拒绝）
//   ③ 同列表团队重复拒绝（两列表可同团队；teams 名单在场时不存在团队拒绝）
//   ④ 保存只改 workspaceAccess（读-改-写 mock 断言：完整 CR 其余字段原样
//      带回；清空 → 发 {}（不是 null/删键，#1502 清空语义）；PUT 405 →
//      PATCH merge-patch 兜底；flat 形状 → spec-direct body）
//   + verifyWorkspaceAccessSaved（re-GET silent-drop 检测）+
//     fetchTeamsForAccess 404/403 降级 + humanMembers 对象/字符串双形状
// - WorkspaceAccessEditor / PeopleSection / i18n(manage.ts) 源码断言
//   （组件依赖 window.QwenPaw host，node 不可直 import）。
// 双跑：node 直跑 = 自执行（下方 ok/okAsync 立即断言）；
// 主控 `npx vitest run` 时按 __vitest_worker__ 注册同一组用例（文件末尾）。
// 直跑：node --experimental-strip-types frontend/tests/h2-workspace-access.test.ts
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const editorSrc = readFileSync(
  new URL("../src/components/WorkspaceAccessEditor.tsx", import.meta.url),
  "utf8",
);
const peopleSrc = readFileSync(
  new URL("../src/manage/PeopleSection.tsx", import.meta.url),
  "utf8",
);
const manageI18nSrc = readFileSync(
  new URL("../src/i18n/domains/manage.ts", import.meta.url),
  "utf8",
);

interface Case {
  name: string;
  fn: () => void | Promise<void>;
}
const cases: Case[] = [];
let n = 0;
function ok(name: string, fn: () => void): void {
  fn();
  n += 1;
  cases.push({ name, fn });
  console.log(`  PASS ${n} ${name}`);
}
async function okAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n += 1;
  cases.push({ name, fn });
  console.log(`  PASS ${n} ${name}`);
}

// ── 注入段：window shim → esbuild bundle → 动态 import ──────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "h2-workspace-access-"));
let wa: typeof import("../src/api/domains/workspaceAccess");
try {
  // shared.requestJsonFull 每次调用读 window.QwenPaw.host——最小 shim
  // （kind 缺省 → hostKind 回退 server，不走 localStorage 模拟层）。
  const hostShim: {
    fetch: ((p: string, init?: unknown) => Promise<unknown>) | null;
  } = { fetch: null };
  (globalThis as Record<string, unknown>).window = {
    QwenPaw: { host: hostShim },
  };

  buildSync({
    entryPoints: [path.join(here, "..", "src", "api", "domains", "workspaceAccess.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(tmp, "workspaceAccess.mjs"),
  });
  wa = (await import(path.join(tmp, "workspaceAccess.mjs"))) as typeof import(
    "../src/api/domains/workspaceAccess"
  );

  const jsonRes = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  type Call = { path: string; method?: string; body?: unknown };

  // ── ① 路径校验 ────────────────────────────────────────────────────
  ok("① validateAccessPath：.. / 绝对路径 / .trash/ / .sync / .control / memory/** / 尾斜杠 / 空段 / 反斜杠 全部拒绝", () => {
    assert.ok(wa.validateAccessPath("files/../etc") !== null, ".. 段");
    assert.ok(wa.validateAccessPath("/files/a") !== null, "绝对路径");
    assert.ok(wa.validateAccessPath("files/.trash/x") !== null, "顶层 .trash/");
    assert.ok(wa.validateAccessPath("files/.trash") !== null, "裸 .trash");
    assert.ok(wa.validateAccessPath("files/.sync/x") !== null, "顶层 .sync/");
    assert.ok(wa.validateAccessPath("files/.control") !== null, "裸 .control");
    assert.ok(wa.validateAccessPath("memory/**") !== null, "memory/** 不可寻址");
    assert.ok(wa.validateAccessPath("digest/x") !== null, "digest/** 不可寻址");
    assert.ok(wa.validateAccessPath("files/a/") !== null, "尾 /");
    assert.ok(wa.validateAccessPath("files//a") !== null, "空段");
    assert.ok(wa.validateAccessPath("files/a/./b") !== null, ". 段");
    assert.ok(wa.validateAccessPath("files\\a") !== null, "反斜杠");
    assert.ok(wa.validateAccessPath("") !== null, "空串");
    assert.ok(wa.validateAccessPath("files/a\u0001b") !== null, "控制字符");
  });

  ok("① validateAccessPath：files/a/** 通过（+ 非顶层 .trash 段合法 + 顶层非保留合法 + 单 * 合法）", () => {
    assert.equal(wa.validateAccessPath("files/a/**"), null);
    assert.equal(wa.validateAccessPath("files/a/*"), null);
    assert.equal(wa.validateAccessPath("files/a"), null);
    assert.equal(wa.validateAccessPath("files/reports/.trash/x"), null, "非顶层 .trash 段合法");
    assert.equal(wa.validateAccessPath("files/a..b/**"), null, "含 .. 子串的普通段合法");
  });

  ok("① validateAccess：非法路径 → bad_path issue（detail = 该路径）；合法 → []", () => {
    const issues = wa.validateAccess(
      { grants: [{ team: "t1", paths: ["memory/**", "files/a/**"], mode: "read" }] },
      null,
    );
    assert.deepEqual(issues, [
      { list: "grants", index: 0, kind: "bad_path", detail: "memory/**" },
    ]);
    assert.deepEqual(
      wa.validateAccess(
        { grants: [{ team: "t1", paths: ["files/a/**"], mode: "readwrite" }] },
        null,
      ),
      [],
    );
  });

  // ── ② 模式越界 ────────────────────────────────────────────────────
  ok("② 模式越界：grants 带 none 拒绝；restrictions 带 readwrite 拒绝；合法模式通过", () => {
    const g = wa.validateAccess(
      { grants: [{ team: "t1", paths: ["files/a"], mode: "none" }] },
      null,
    );
    assert.ok(
      g.some((x) => x.kind === "bad_mode" && x.detail === "none"),
      `grants+none 应报 bad_mode：${JSON.stringify(g)}`,
    );
    const r = wa.validateAccess(
      { restrictions: [{ team: "t1", paths: ["files/a"], mode: "readwrite" }] },
      null,
    );
    assert.ok(
      r.some((x) => x.kind === "bad_mode" && x.detail === "readwrite"),
      `restrictions+readwrite 应报 bad_mode：${JSON.stringify(r)}`,
    );
    assert.deepEqual(
      wa.validateAccess(
        { grants: [{ team: "t1", paths: ["files/a"], mode: "readwrite" }] },
        null,
      ),
      [],
    );
    assert.deepEqual(
      wa.validateAccess(
        { restrictions: [{ team: "t1", paths: ["files/a"], mode: "none" }] },
        null,
      ),
      [],
    );
  });

  // ── ③ 团队重复 / 不存在 ───────────────────────────────────────────
  ok("③ 同列表团队重复拒绝（index = 第二条）；两列表可同团队；空团队拒绝", () => {
    const dup = wa.validateAccess(
      {
        grants: [
          { team: "t1", paths: ["files/a"], mode: "read" },
          { team: "t1", paths: ["files/b"], mode: "readwrite" },
        ],
      },
      null,
    );
    assert.ok(
      dup.some((x) => x.kind === "dup_team" && x.detail === "t1" && x.index === 1),
      `应报 dup_team：${JSON.stringify(dup)}`,
    );
    // 同一团队同时出现在两列表 = 合法（决策时 restriction 优先）
    assert.deepEqual(
      wa.validateAccess(
        {
          grants: [{ team: "t1", paths: ["files/a"], mode: "read" }],
          restrictions: [{ team: "t1", paths: ["files/a"], mode: "none" }],
        },
        null,
      ),
      [],
    );
    const empty = wa.validateAccess(
      { grants: [{ team: "  ", paths: ["files/a"], mode: "read" }] },
      null,
    );
    assert.ok(empty.some((x) => x.kind === "empty_team"));
  });

  ok("③ 团队不存在：teams 名单在场 + 名单外团队 → unknown_team；teams=null → 跳过该检查", () => {
    const unk = wa.validateAccess(
      { grants: [{ team: "ghost", paths: ["files/a"], mode: "read" }] },
      ["t1", "t2"],
    );
    assert.ok(
      unk.some((x) => x.kind === "unknown_team" && x.detail === "ghost"),
      `应报 unknown_team：${JSON.stringify(unk)}`,
    );
    assert.deepEqual(
      wa.validateAccess(
        { grants: [{ team: "ghost", paths: ["files/a"], mode: "read" }] },
        null,
      ),
      [],
    );
  });

  ok("数量上限：>32 规则 → too_many_rules；>16 路径 → too_many_paths；0 路径 → no_paths", () => {
    const manyRules = {
      grants: Array.from({ length: 33 }, (_, i) => ({
        team: `t${i}`,
        paths: ["files/a"],
        mode: "read" as const,
      })),
    };
    assert.ok(wa.validateAccess(manyRules, null).some((x) => x.kind === "too_many_rules"));
    const manyPaths = {
      grants: [
        {
          team: "t1",
          paths: Array.from({ length: 17 }, (_, i) => `files/p${i}`),
          mode: "read" as const,
        },
      ],
    };
    assert.ok(wa.validateAccess(manyPaths, null).some((x) => x.kind === "too_many_paths"));
    assert.ok(
      wa.validateAccess(
        { grants: [{ team: "t1", paths: [], mode: "read" }] },
        null,
      ).some((x) => x.kind === "no_paths"),
    );
  });

  // ── ④ 保存只改 workspaceAccess（读-改-写，mock 断言）──────────────
  const fullCr = {
    apiVersion: "agentteams.io/v1beta1",
    kind: "Human",
    metadata: { name: "alice", labels: { team: "core" } },
    spec: {
      displayName: "Alice",
      permissionLevel: 1,
      accessibleTeams: ["t1"],
      note: "keep me",
    },
  };
  const access = { grants: [{ team: "t2", paths: ["files/a/**"], mode: "read" }] };
  const expectedPayload = { grants: [{ team: "t2", paths: ["files/a/**"], mode: "read" }] };

  await okAsync(
    "④ saveWorkspaceAccess：完整 CR 形状 → PUT 整体 CR，只改 spec.workspaceAccess，其余字段原样带回",
    async () => {
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, fullCr); // GET 读现状
      };
      const r = await wa.saveWorkspaceAccess("alice", access);
      assert.equal(r.method, "PUT");
      const put = calls.find((c) => c.method === "PUT");
      assert.ok(put, "应发一次 PUT");
      assert.equal(put.path, "/agentteams-proxy/controller/api/v1/humans/alice");
      assert.deepEqual(put.body, {
        apiVersion: fullCr.apiVersion,
        kind: fullCr.kind,
        metadata: fullCr.metadata,
        spec: {
          displayName: "Alice",
          permissionLevel: 1,
          accessibleTeams: ["t1"],
          note: "keep me",
          workspaceAccess: expectedPayload, // 仅此字段被写入
        },
      });
    },
  );

  await okAsync(
    "④ 清空（两列表均空）→ 发 workspaceAccess: {}（不是 null、不是删键——#1502 清空语义）",
    async () => {
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, fullCr);
      };
      await wa.saveWorkspaceAccess("alice", { grants: [], restrictions: [] });
      const put = calls.find((c) => c.method === "PUT");
      const spec = (put!.body as Record<string, unknown>).spec as Record<string, unknown>;
      assert.ok("workspaceAccess" in spec, "清空时键必须在场（{} = 清空）");
      assert.deepEqual(spec.workspaceAccess, {});
    },
  );

  await okAsync(
    "④ saveWorkspaceAccess：PUT 405（旧控制器无端点）→ PATCH merge-patch 兜底（只发 workspaceAccess 对象）",
    async () => {
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(405, { message: "method not allowed" });
        if (i?.method === "PATCH") return jsonRes(200, {});
        return jsonRes(200, fullCr);
      };
      const r = await wa.saveWorkspaceAccess("alice", access);
      assert.equal(r.method, "PATCH");
      const patch = calls.find((c) => c.method === "PATCH");
      assert.ok(patch, "405 后应发 PATCH");
      assert.equal(patch.path, "/agentteams-proxy/controller/api/v1/humans/alice");
      assert.deepEqual(patch.body, { spec: { workspaceAccess: expectedPayload } });
    },
  );

  await okAsync(
    "④ flat 形状（本控制器 /humans 惯例）→ PUT spec-direct，其余字段原样带回",
    async () => {
      const flatCr = { name: "bob", permissionLevel: 2, accessibleTeams: ["t2"], note: "flat" };
      const calls: Call[] = [];
      hostShim.fetch = async (p: string, init?: unknown) => {
        const i = init as { method?: string; body?: string } | undefined;
        calls.push({
          path: p,
          method: i?.method,
          body: i?.body ? JSON.parse(i.body) : undefined,
        });
        if (i?.method === "PUT") return jsonRes(200, {});
        return jsonRes(200, flatCr);
      };
      const r = await wa.saveWorkspaceAccess("bob", access);
      assert.equal(r.method, "PUT");
      const put = calls.find((c) => c.method === "PUT");
      assert.deepEqual(put!.body, {
        name: "bob",
        permissionLevel: 2,
        accessibleTeams: ["t2"],
        note: "flat",
        workspaceAccess: expectedPayload,
      });
    },
  );

  ok("buildWorkspaceAccessPayload：{} = 清空；只留合法规则（空团队 / 无路径 / 模式越界行静默丢弃）", () => {
    assert.deepEqual(wa.buildWorkspaceAccessPayload({ grants: [], restrictions: [] }), {});
    assert.deepEqual(wa.buildWorkspaceAccessPayload(null), {});
    assert.deepEqual(
      wa.buildWorkspaceAccessPayload({
        grants: [
          { team: "t1", paths: ["files/a"], mode: "read" },
          { team: "  ", paths: ["files/b"], mode: "read" },
          { team: "t2", paths: [], mode: "read" },
          { team: "t3", paths: ["files/c"], mode: "none" },
        ],
        restrictions: [{ team: "t1", paths: ["files/a"], mode: "readwrite" }],
      }),
      { grants: [{ team: "t1", paths: ["files/a"], mode: "read" }] },
    );
  });

  // ── verifyWorkspaceAccessSaved（re-GET silent-drop 检测）──────────
  await okAsync(
    "verifyWorkspaceAccessSaved：回读等价 → verified；字段缺失（silent drop / 不回显）→ unverified；存空 + 无字段 = 相符",
    async () => {
      // (a) 回读含等价内容（路径序不敏感）
      hostShim.fetch = async () =>
        jsonRes(200, {
          name: "alice",
          workspaceAccess: { grants: [{ team: "t2", paths: ["files/a/**"], mode: "read" }] },
        });
      let v = await wa.verifyWorkspaceAccessSaved("alice", access);
      assert.equal(v.verified, true);
      assert.deepEqual(v.current?.grants, access.grants);

      // (b) 响应不含该字段（旧控制器静默丢弃 / 新控制器不回显）
      hostShim.fetch = async () => jsonRes(200, { name: "alice", displayName: "Alice" });
      v = await wa.verifyWorkspaceAccessSaved("alice", access);
      assert.equal(v.verified, false);
      assert.equal(v.current, null);

      // (c) 所存为空（清空）+ 回读无字段 = 相符
      v = await wa.verifyWorkspaceAccessSaved("alice", { grants: [], restrictions: [] });
      assert.equal(v.verified, true);
    },
  );

  // ── fetchTeamsForAccess（404/403 降级 + humanMembers 双形状）─────
  await okAsync(
    "fetchTeamsForAccess：404 / 403 → {teams:[], membership:{}, unavailable:true}（不抛错）",
    async () => {
      hostShim.fetch = async () => jsonRes(404, { detail: "Not Found" });
      assert.deepEqual(await wa.fetchTeamsForAccess(), {
        teams: [],
        membership: {},
        unavailable: true,
      });
      hostShim.fetch = async () => jsonRes(403, { detail: "Forbidden" });
      assert.deepEqual(await wa.fetchTeamsForAccess(), {
        teams: [],
        membership: {},
        unavailable: true,
      });
    },
  );

  await okAsync(
    "fetchTeamsForAccess：{teams:[...]} 形状（TeamResponse flat：name + humanMembers 对象 {name}，字符串兼容；metadata.name 兜底）",
    async () => {
      hostShim.fetch = async () =>
        jsonRes(200, {
          teams: [
            { name: "t1", humanMembers: [{ name: "alice" }, { name: "bob" }] },
            { name: "t2", humanMembers: ["carol"] },
            { name: "t3" },
            { metadata: { name: "t4" } },
          ],
          total: 4,
        });
      const r = await wa.fetchTeamsForAccess();
      assert.equal(r.unavailable, false);
      assert.deepEqual(r.teams, ["t1", "t2", "t3", "t4"]);
      assert.deepEqual(r.membership, { t1: ["alice", "bob"], t2: ["carol"] });
    },
  );

  // ── getHumanWorkspaceAccess（flat / spec 双形状防御）──────────────
  await okAsync(
    "getHumanWorkspaceAccess：#1502 快照（HumanResponse 不回显）→ access=null；flat 回显 → 取到；完整 CR → 取 spec.workspaceAccess",
    async () => {
      hostShim.fetch = async () =>
        jsonRes(200, {
          name: "alice",
          displayName: "Alice",
          accessibleTeams: ["t1"],
        });
      let v = await wa.getHumanWorkspaceAccess("alice");
      assert.equal(v.access, null, "不回显 → null（编辑器空态）");
      assert.ok(v.cr && typeof v.cr === "object");

      hostShim.fetch = async () =>
        jsonRes(200, {
          name: "alice",
          workspaceAccess: { grants: [{ team: "t2", paths: ["files/a"], mode: "read" }] },
        });
      v = await wa.getHumanWorkspaceAccess("alice");
      assert.deepEqual(v.access?.grants, [{ team: "t2", paths: ["files/a"], mode: "read" }]);

      hostShim.fetch = async () =>
        jsonRes(200, {
          metadata: { name: "alice" },
          spec: {
            displayName: "Alice",
            workspaceAccess: {
              restrictions: [{ team: "t1", paths: ["files/a"], mode: "none" }],
            },
          },
        });
      v = await wa.getHumanWorkspaceAccess("alice");
      assert.deepEqual(v.access?.restrictions, [
        { team: "t1", paths: ["files/a"], mode: "none" },
      ]);
    },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── 源码断言（组件依赖 window.QwenPaw host，node 不可直 import）────
ok("editor：默认访问区 + 授予/限制双列表 + 路径 chips + 未配置（继承默认）+ 行内红字 + 团队降级自由输入", () => {
  assert.match(editorSrc, /默认访问/);
  assert.match(editorSrc, /授予规则/);
  assert.match(editorSrc, /限制规则/);
  assert.match(editorSrc, /未配置（继承默认）/);
  assert.match(editorSrc, /添加路径（支持 \* 和 \*\*）/);
  assert.match(editorSrc, /#ff4d4f/);
  assert.match(editorSrc, /validateAccess\(/);
  assert.match(editorSrc, /团队名（自由输入）/);
  assert.match(editorSrc, /HelpDot/);
});

ok("PeopleSection：工作区访问卡（DoorIcon）+ 读-改-写链 + silent-drop 提示 + /teams 降级", () => {
  assert.match(peopleSrc, /<DoorIcon/);
  assert.match(peopleSrc, /getHumanWorkspaceAccess\(human\.name\)/);
  assert.match(peopleSrc, /fetchTeamsForAccess\(\)/);
  assert.match(peopleSrc, /saveWorkspaceAccess\(human\.name, draft\)/);
  assert.match(peopleSrc, /verifyWorkspaceAccessSaved\(human\.name, draft\)/);
  assert.match(peopleSrc, /当前控制器版本不支持工作区访问（保存未生效）/);
  assert.match(peopleSrc, /isAdmin && dirty && !busy && issues\.length === 0/);
  assert.match(peopleSrc, /readOnly=\{!isAdmin\}/);
});

ok("i18n：H2 键齐全（manage.ts；复用键不重登）", () => {
  for (const key of [
    '"工作区访问":',
    '"工作区访问（{name}）":',
    '"当前控制器版本不支持工作区访问（保存未生效）":',
    '"未配置（继承默认）":',
    '"添加授予规则":',
    '"添加限制规则":',
    '"团队不可为空":',
    '"同一团队在列表中重复":',
    '"模式越界：{m}（此列表允许 {allowed}）":',
  ]) {
    assert.ok(manageI18nSrc.includes(key), `manage.ts 缺键：${key}`);
  }
  // 复用既有键、不重复登记
  assert.doesNotMatch(manageI18nSrc, /"保存":/);
  assert.doesNotMatch(manageI18nSrc, /"取消":/);
  assert.doesNotMatch(manageI18nSrc, /"团队":/);
  assert.doesNotMatch(manageI18nSrc, /"只读":/);
  assert.doesNotMatch(manageI18nSrc, /"读写":/);
  assert.doesNotMatch(manageI18nSrc, /"保存失败":/);
});

console.log(`\nh2-workspace-access: ${n} passed`);

// ── vitest 双跑：主控 `npx vitest run` 时注册同一组用例（node 直跑时
// __vitest_worker__ 缺失 → 跳过，上方已自执行）。.mjs 已删但 ESM 模块
// 缓存按 URL 命中，注入用例可安全重跑（hostShim.fetch 每用例内重注入）。──
if ((globalThis as Record<string, unknown>).__vitest_worker__) {
  const vt = await import("vitest") as {
    test: (name: string, fn: () => void | Promise<void>) => void;
  };
  for (const c of cases) vt.test(c.name, () => c.fn());
}
