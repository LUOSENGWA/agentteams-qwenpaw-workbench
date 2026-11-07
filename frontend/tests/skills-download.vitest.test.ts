/**
 * skills-download.vitest.test.ts — 技能包下载
 * （GET /api/v1/skills/{name}/download 流式 zip）单测（vitest 风格）。
 *
 * 运行：npx vitest run（vitest.config.ts 把 include 限定在
 * *.vitest.test.ts；与 workspace-files 同款 host shim）。
 *
 * 覆盖（任务书 ≥5 条）：
 * ① 路径构造——name encodeURIComponent + team query 有/无（作用域与
 *    目录 ?team= 契约一致）；
 * ② 文件名解析——Content-Disposition（filename 引号/裸值、filename*
 *    RFC 5987 优先）/ 缺省回退 <name>.zip / 路径穿越消毒；
 * ③ 404/405 降级判定——isSkillDownloadUnavailable（404/405 → 隐藏不报错；
 *    403/5xx/网络错 → 提示可重试）+ downloadSkill 错误形态
 *    （`HTTP {status}: {detail}`，httpErrorStatus 可分流）；
 * ④ 源码断言——目录行接上下载动作（DownloadIcon + 44px 触控 + gone 隐藏）、
 *    鉴权走 host.fetch（无裸 <a href> 指向端点）、i18n 键齐全、barrel 导出。
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  downloadSkill,
  isSkillDownloadUnavailable,
  parseSkillDownloadFilename,
  skillDownloadKey,
} from "../src/api/domains/skills";
import { httpErrorStatus } from "../src/api/shared";

// ── window/host shim（host.fetch 分支；headers.get 供
// Content-Disposition 解析；与 workspace-files 同款）─────────────────
interface CapturedCall {
  path: string;
  init?: RequestInit;
}
const calls: CapturedCall[] = [];
type Responder = (
  path: string,
  init?: RequestInit,
) => { status: number; body?: unknown; blob?: Blob; headers?: Record<string, string> };
let responder: Responder = () => ({
  status: 200,
  blob: new Blob([new Uint8Array([1, 2, 3, 4])]),
});

(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      kind: "server",
      fetch: async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        const r = responder(path, init);
        const hm = r.headers ?? {};
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          text: async () => (r.body == null ? "" : JSON.stringify(r.body)),
          blob: async () => r.blob ?? new Blob(),
          headers: { get: (k: string) => hm[k.toLowerCase()] ?? null },
        };
      },
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
      getAuthToken: () => "",
    },
  },
};

const BASE = "/agentteams-proxy/controller/api/v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const srcFile = (p: string) =>
  readFileSync(join(HERE, "..", "src", p), "utf8");

// ── ① 路径构造（name 编码 + team 作用域 query）────────────────────────

test("① downloadSkill：无 team → 路径恰为 /skills/{name}/download", async () => {
  calls.length = 0;
  responder = () => ({ status: 200, blob: new Blob([new Uint8Array([1])]) });
  await downloadSkill("my-skill");
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(`${BASE}/skills/my-skill/download`);
  expect(calls[0].init).toBeUndefined();
});

test("①b downloadSkill：带 team → ?team= 编码（L2/onlyTeam 作用域契约）", async () => {
  calls.length = 0;
  responder = () => ({ status: 200, blob: new Blob([new Uint8Array([1])]) });
  await downloadSkill("my-skill", "team a");
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe(
    `${BASE}/skills/my-skill/download?team=${encodeURIComponent("team a")}`,
  );
});

// ── ② 文件名解析（Content-Disposition / 回退 / 消毒）──────────────────

test("② 文件名取 Content-Disposition（filename 引号形）且 blob 原样", async () => {
  responder = () => ({
    status: 200,
    blob: new Blob([new Uint8Array([9, 8, 7])]),
    headers: { "Content-Disposition": 'attachment; filename="my-skill.zip"' },
  });
  const r = await downloadSkill("my-skill");
  expect(r.filename).toBe("my-skill.zip");
  expect(r.blob.size).toBe(3);
  expect(await r.blob.text()).toBe(String.fromCharCode(9, 8, 7));
});

test("②b 无 Content-Disposition → 回退 <name>.zip", async () => {
  responder = () => ({ status: 200, blob: new Blob([new Uint8Array([1])]) });
  const r = await downloadSkill("some-skill");
  expect(r.filename).toBe("some-skill.zip");
});

test("③ parseSkillDownloadFilename：filename*（RFC 5987）优先 + 各形态", () => {
  // filename* percent-encoded 优先于 filename 普通形。
  expect(
    parseSkillDownloadFilename(
      'attachment; filename="ascii.zip"; filename*=UTF-8\'\'skill-%E4%B8%AD.zip',
      "fb.zip",
    ),
  ).toBe("skill-中.zip");
  // 引号形 / 裸值形。
  expect(
    parseSkillDownloadFilename('attachment; filename="a b.zip"', "fb.zip"),
  ).toBe("a b.zip");
  expect(parseSkillDownloadFilename("attachment; filename=c.zip", "fb.zip")).toBe(
    "c.zip",
  );
  // 穿越消毒：只取最后一段（恶意 Content-Disposition 不可带目录）。
  expect(
    parseSkillDownloadFilename('attachment; filename="../../x.zip"', "fb.zip"),
  ).toBe("x.zip");
  expect(
    parseSkillDownloadFilename('attachment; filename="..\\..\\x.zip"', "fb.zip"),
  ).toBe("x.zip");
  // 头缺失/空 → 回退（回退本身也消毒）。
  expect(parseSkillDownloadFilename(null, "fb.zip")).toBe("fb.zip");
  expect(parseSkillDownloadFilename("", "a/b.zip")).toBe("b.zip");
  // filename* 非法 percent 序列 → 回落 filename 普通形。
  expect(
    parseSkillDownloadFilename(
      "attachment; filename=\"ok.zip\"; filename*=UTF-8''bad-%zz.zip",
      "fb.zip",
    ),
  ).toBe("ok.zip");
});

// ── ④ 404/405 降级判定（能力降级不报错）───────────────────────────────

test("④ downloadSkill 404 → HTTP 404 错误形态 + 判「不可用」", async () => {
  responder = () => ({
    status: 404,
    body: { message: 'skill "builtin-x" not found under agents/global/skills/' },
  });
  const err = (await downloadSkill("builtin-x").catch((e) => e)) as Error;
  expect(httpErrorStatus(err)).toBe(404);
  expect(isSkillDownloadUnavailable(err)).toBe(true);
  expect(err.message).toContain("not found");
});

test("④b 降级判定矩阵：405 隐藏；403/500/网络错 → 提示可重试", async () => {
  responder = () => ({ status: 405, body: { message: "method not allowed" } });
  const e405 = (await downloadSkill("a").catch((e) => e)) as Error;
  expect(httpErrorStatus(e405)).toBe(405);
  expect(isSkillDownloadUnavailable(e405)).toBe(true);

  responder = () => ({ status: 403, body: { message: "forbidden" } });
  const e403 = (await downloadSkill("a").catch((e) => e)) as Error;
  expect(httpErrorStatus(e403)).toBe(403);
  expect(isSkillDownloadUnavailable(e403)).toBe(false);

  responder = () => ({ status: 500, body: { message: "boom" } });
  const e500 = (await downloadSkill("a").catch((e) => e)) as Error;
  expect(isSkillDownloadUnavailable(e500)).toBe(false);

  // 非 HTTP 错误（网络层）→ 同样走提示分支。
  expect(isSkillDownloadUnavailable(new Error("network down"))).toBe(false);
});

// ── ⑤ skillDownloadKey（作用域×技能名 键控）───────────────────────────

test("⑤ skillDownloadKey：无 team='*' 前缀；不同作用域同名技能独立键", () => {
  expect(skillDownloadKey(undefined, "a")).toBe("*::a");
  expect(skillDownloadKey("t1", "a")).toBe("t1::a");
  expect(skillDownloadKey(undefined, "a")).not.toBe(skillDownloadKey("t1", "a"));
});

// ── ⑥ 源码断言（接线/鉴权/i18n 落点）─────────────────────────────────

test("⑥ 目录行接下载：矩阵卡有 DownloadIcon + 44px 触控 + gone 隐藏", () => {
  const matrix = srcFile("components/SkillCenterMatrix.tsx");
  expect(matrix).toContain("import { DownloadIcon } from \"./icons\";");
  expect(matrix).toContain("<DownloadIcon size={14} />");
  expect(matrix).toContain("minWidth: 44");
  expect(matrix).toContain("minHeight: 44");
  // 404/405 判 gone → 该行隐藏下载操作。
  expect(matrix).toContain('skillDlState(s) !== "gone"');
  expect(matrix).toContain("onSkillDownload(s)");
});

test("⑥b 鉴权在 fetch 侧完成：无裸 <a href> 指向下载端点；保存走 object URL", () => {
  const center = srcFile("components/SkillCenter.tsx");
  const matrix = srcFile("components/SkillCenterMatrix.tsx");
  // 两个组件文件都不允许出现指向 skills/*/download 的裸锚点（无 token）。
  const rawAnchor = /<a\b[^>]*href=[^>]*(?:download|skills)/;
  expect(center).not.toMatch(rawAnchor);
  expect(matrix).not.toMatch(rawAnchor);
  // 保存路径 = object URL + a.download（鉴权后的 blob 本地落盘）。
  expect(center).toContain("URL.createObjectURL(blob)");
  expect(center).toContain("a.download = filename");
  // 404/405 降级判定接在 handler 上（不弹错、隐藏该操作）。
  expect(center).toContain("isSkillDownloadUnavailable(e)");
  expect(center).toContain("downloadSkill(name, dlTeamScope)");
});

test("⑥c i18n 键齐全（worker 域）+ barrel 导出 skills 域", () => {
  const dict = srcFile("i18n/domains/worker.ts");
  const pairs: [string, string][] = [
    ["下载技能包（zip）", "Download skill package (zip)"],
    ["开始下载 {name}", "Downloading {name}"],
    ["下载失败：{m}", "Download failed: {m}"],
  ];
  for (const [key, en] of pairs) {
    expect(dict).toContain(`"${key}": { en: "${en}" }`);
  }
  // 「下载」按钮 aria 文案既有键（team 域，DICT 合并后全局可用）。
  expect(srcFile("i18n/domains/team.ts")).toContain('"下载": { en: "Download" }');
  expect(srcFile("api.ts")).toContain(
    'export * from "./api/domains/skills";',
  );
});
