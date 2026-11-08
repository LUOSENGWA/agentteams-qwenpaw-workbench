/**
 * spawn-messages.vitest.test.ts — 项目 spawn 会话消息查看（只读）单测
 * （vitest 风格）。
 *
 * 运行：npx --no-install vitest run（vitest.config.ts 把 include 限定在
 * *.vitest.test.ts）。
 *
 * 端点契约（主控自 controller 源码逐字核对）：
 * GET /agentteams-proxy/controller/api/v1/projects/{id}/spawns/{sessionId}
 * /messages?limit=N —— 404=空态（不报错）；403=无权限；limit 前端按需传 200。
 *
 * 覆盖（任务书 ①-④ + bonus）：
 * ① URL 编码——project id / session id 含特殊字符 encodeURIComponent + limit；
 * ② 404 → 空态判定——classifySpawnMsgError（404=empty 不报错 / 403=forbidden
 *    无权限查看 / 其余=error 可重试）+ getSpawnMessages 404 错误形态
 *    （httpErrorStatus 可分流，不吞状态码）；
 * ③ has_more → 「仅显示最近 N 条」提示（源码断言：ok 分支渲染点）；
 * ④ 消息渲染纯函数——foldMessageContent（6 行折叠 / 换行保留 / 空输入 /
 *    CRLF / 边界常量）；
 * bonus：200 归一化容错（字段缺失/类型错 → 不臆造）、30s 缓存（重展开不重
 * 拨）+ 在飞去重、源码断言（懒加载门 open / 44px 触控 / 空态落点 / API 路径）。
 */
import { test, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getSpawnMessages } from "../src/api/domains/teams";
import { httpErrorStatus } from "../src/api/shared";
import { __clearCacheForTest } from "../src/requestCache";

// ── window/host shim（requestJsonFull 走 host.fetch；kind=server 使
// isLocalHost()=false，不进独立宿主配置模拟层；与 workspace-files 同款）──
interface CapturedCall {
  path: string;
  init?: RequestInit;
}
const calls: CapturedCall[] = [];
type Responder = (
  path: string,
  init?: RequestInit,
) => { status: number; body?: unknown };
let responder: Responder = () => ({
  status: 200,
  body: { session_id: "s1", messages: [], has_more: false },
});

(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      kind: "server",
      antdIcons: {},
      fetch: async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        const r = responder(path, init);
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          text: async () => (r.body == null ? "" : JSON.stringify(r.body)),
          headers: { get: () => null },
        };
      },
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
      getAuthToken: () => "",
    },
  },
};

// WorkerManageShared 模块级引用 window.QwenPaw.host（antd 图标选取）——
// 静态 import 提升早于上面的 shim 赋值，须 shim 就绪后动态 import。
const {
  foldMessageContent,
  classifySpawnMsgError,
  SPAWN_MSG_FOLD_LINES,
} = await import("../src/components/WorkerManageShared");

const BASE = "/agentteams-proxy/controller/api/v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const srcFile = (p: string) =>
  readFileSync(join(HERE, "..", "src", p), "utf8");

beforeEach(() => {
  calls.length = 0;
  __clearCacheForTest();
  responder = () => ({
    status: 200,
    body: { session_id: "s1", messages: [], has_more: false },
  });
});

// ── ① URL 编码（特殊字符 + limit）───────────────────────────────────

test("① getSpawnMessages：project id / session id 特殊字符 encodeURIComponent + limit=200", async () => {
  const pid = "proj/1 a";
  const sid = "sess:2 b?c";
  await getSpawnMessages(pid, sid, 200);
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(
    `${BASE}/projects/${encodeURIComponent(pid)}/spawns/${encodeURIComponent(sid)}/messages?limit=200`,
  );
  expect(calls[0].path).toContain("projects/proj%2F1%20a/spawns/");
});

test("①b getSpawnMessages：不传 limit → 无 limit 参数（服务端默认）", async () => {
  await getSpawnMessages("p1", "s1");
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(`${BASE}/projects/p1/spawns/s1/messages`);
});

// ── ② 404 → 空态判定（不吞状态码）───────────────────────────────────

test("② 404 → httpErrorStatus=404 且 classify='empty'（空态不报错）", async () => {
  responder = () => ({ status: 404, body: { message: "session not found" } });
  const e = (await getSpawnMessages("p", "missing").catch((err) => err)) as Error;
  expect(httpErrorStatus(e)).toBe(404);
  expect(classifySpawnMsgError(e)).toBe("empty");
  expect(e.message).toContain("session not found");
});

test("②b 403 → 'forbidden'（无权限查看）；500/网络错 → 'error'（可重试）", async () => {
  responder = () => ({ status: 403, body: { message: "cross-team forbidden" } });
  const e403 = (await getSpawnMessages("p", "s403").catch((err) => err)) as Error;
  expect(httpErrorStatus(e403)).toBe(403);
  expect(classifySpawnMsgError(e403)).toBe("forbidden");

  responder = () => ({ status: 500, body: { message: "boom" } });
  const e500 = (await getSpawnMessages("p", "s500").catch((err) => err)) as Error;
  expect(classifySpawnMsgError(e500)).toBe("error");
  expect(classifySpawnMsgError(new Error("network down"))).toBe("error");
});

// ── ③ has_more → 提示（源码断言：ok 分支渲染点）──────────────────────

test("③ has_more → 「仅显示最近 N 条」提示接在 ok 分支（按显示条数）", () => {
  const messages = srcFile("manage/SpawnMessages.tsx");
  expect(messages).toContain("state.data.has_more");
  expect(messages).toContain('"仅显示最近 {n} 条"');
  expect(messages).toContain("state.data.messages.length");
});

// ── ④ 消息渲染纯函数（折叠行数 / 换行保留）────────────────────────────

test("④ foldMessageContent：超 6 行 → 前 6 行 + folded=true（换行保留）", () => {
  const content = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");
  const r = foldMessageContent(content);
  expect(r.folded).toBe(true);
  expect(r.text.split("\n")).toEqual(["L1", "L2", "L3", "L4", "L5", "L6"]);
});

test("④b foldMessageContent：≤6 行原样不折叠（含恰 6 行边界）", () => {
  const content = "a\nb\nc";
  expect(foldMessageContent(content)).toEqual({ text: "a\nb\nc", folded: false });
  const six = Array.from({ length: 6 }, (_, i) => `L${i}`).join("\n");
  expect(foldMessageContent(six)).toEqual({ text: six, folded: false });
});

test("④c foldMessageContent：空/非字符串输入 → 空文本不折叠；CRLF 归一", () => {
  expect(foldMessageContent("")).toEqual({ text: "", folded: false });
  expect(foldMessageContent(undefined)).toEqual({ text: "", folded: false });
  expect(foldMessageContent(null)).toEqual({ text: "", folded: false });
  // CRLF 同样按换行计（不把 \r 留进展示文本、不虚增行数）。
  expect(foldMessageContent("1\r\n2\r\n3")).toEqual({
    text: "1\n2\n3",
    folded: false,
  });
});

test("④d 折叠阈值常量 = 6 行", () => {
  expect(SPAWN_MSG_FOLD_LINES).toBe(6);
});

// ── bonus：200 归一化容错 / 缓存 / 源码接线 ──────────────────────────

test("bonus 200 归一化容错：字段缺失/类型错 → 不臆造（messages 恒数组）", async () => {
  responder = () => ({ status: 200, body: {} });
  const empty = await getSpawnMessages("p", "s");
  expect(empty).toEqual({
    session_id: undefined,
    task: undefined,
    messages: [],
    has_more: false,
  });

  responder = () => ({
    status: 200,
    body: {
      session_id: "s9",
      task: 123,
      messages: [
        { seq: "x", kind: 1, role: "assistant", name: "", content: 42 },
        "garbage",
        { seq: 2, role: "user", content: "ok\nline2" },
      ],
      has_more: "yes",
    },
  });
  const d = await getSpawnMessages("p2", "s2");
  expect(d.session_id).toBe("s9");
  expect(d.task).toBeUndefined(); // 非字符串 → 缺
  expect(d.has_more).toBe(false); // 非布尔 → false
  expect(d.messages).toHaveLength(3);
  expect(d.messages[0]).toEqual({
    seq: undefined,
    kind: undefined,
    role: "assistant",
    name: undefined,
    content: "",
    tool_state: undefined,
    headline: undefined,
    created_at: undefined,
  });
  expect(d.messages[1].content).toBe(""); // 非对象条 → 空消息
  expect(d.messages[2]).toMatchObject({
    seq: 2,
    role: "user",
    content: "ok\nline2",
  });
});

test("bonus 缓存：30s 内同参数二次调用不重拨（重展开不重拉）", async () => {
  responder = () => ({
    status: 200,
    body: {
      session_id: "sc",
      messages: [{ seq: 1, role: "user", content: "hi" }],
      has_more: false,
    },
  });
  const a = await getSpawnMessages("pc", "sc", 200);
  const b = await getSpawnMessages("pc", "sc", 200);
  expect(calls).toHaveLength(1);
  expect(b).toEqual(a);
  expect(a.messages[0].content).toBe("hi");
});

test("bonus 在飞去重：并发同参数 → 只发一次请求", async () => {
  const [a, b] = await Promise.all([
    getSpawnMessages("pd", "sd", 200),
    getSpawnMessages("pd", "sd", 200),
  ]);
  expect(calls).toHaveLength(1);
  expect(b).toEqual(a);
});

test("⑤ 源码接线：spawn 树挂「消息」子项 + 消息组件懒加载（点开才请求）", () => {
  const tree = srcFile("manage/SpawnTreeCard.tsx");
  expect(tree).toContain("node.project_id");
  expect(tree).toContain('tr("消息")');
  // 消息组件由父级按点击挂载；effect 只在挂载后请求（不随树批量拉取）。
  const messages = srcFile("manage/SpawnMessages.tsx");
  expect(messages).toContain("getSpawnMessages(projectId, sessionId, 200)");
  expect(messages).toContain("React.useEffect(() => {");
});

test("⑤b 触控目标 ≥44px：消息行 / 重试按钮 / 展开行 三处 minHeight 44", () => {
  const sources =
    srcFile("manage/SpawnMessages.tsx") + srcFile("manage/SpawnTreeCard.tsx");
  const hits = sources.match(/minHeight: 44/g) || [];
  expect(hits.length).toBeGreaterThanOrEqual(3);
});

test("⑤c 状态落点：空态 / 无权限查看 / 加载失败·重试 / has_more 提示", () => {
  const messages = srcFile("manage/SpawnMessages.tsx");
  expect(messages).toContain('tr("暂无消息")');
  expect(messages).toContain('tr("无权限查看")');
  expect(messages).toContain('tr("加载失败")');
  expect(messages).toContain('tr("重试")');
});

test("⑤d API 路径落点：controller 前缀 + 双段 encodeURIComponent", () => {
  const teams = srcFile("api/domains/teams.ts");
  expect(teams).toContain(
    "/agentteams-proxy/controller/api/v1/projects/",
  );
  expect(teams).toContain("encodeURIComponent(projectId)");
  expect(teams).toContain("encodeURIComponent(sessionId)");
});
