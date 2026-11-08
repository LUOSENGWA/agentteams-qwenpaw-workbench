// 文件管理「全局搜索」（跨目录名称 / 路径）纯逻辑 + 源码接线单测。
//
// 纯逻辑（files/globalSearch.ts）：
// - parseSearchQuery：trim / 大小写归一 / 最小 2 字符；
// - rankSearchResults：名称前缀 > 名称包含 > 路径包含、目录优先、200 上限；
// - formatResultPath / resultRelPath：结果行相对路径（父目录）；
// - searchPageState：首屏 1000 项 · 有下一页 → 「加载更多」。
//
// 接线断言（组件依赖 window.QwenPaw host，node 不渲染）：FilesSection 用
// 同一套纯函数、递归根目录拉取（limit=SEARCH_FETCH_LIMIT）、250ms 去抖、
// 清除 / 降级 / 结果标题。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { HumanFileEntry } from "../src/api/domains/humanFiles";
import {
  formatResultPath,
  parseSearchQuery,
  rankSearchResults,
  resultRelPath,
  searchPageState,
  SEARCH_DEBOUNCE_MS,
  SEARCH_FETCH_LIMIT,
  SEARCH_MIN_CHARS,
  SEARCH_RESULT_CAP,
} from "../src/manage/files/globalSearch";

const SRC = join(process.cwd(), "src");
const readSrc = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const f = (path: string, extra: Partial<HumanFileEntry> = {}): HumanFileEntry => ({
  path,
  type: "file",
  ...extra,
});
const d = (path: string): HumanFileEntry => ({
  path: path.endsWith("/") ? path : `${path}/`,
  type: "directory",
});
const names = (list: HumanFileEntry[]): string[] =>
  list.map((e) => e.path ?? e.name ?? "");

describe("parseSearchQuery — 输入归一 / 最小长度", () => {
  it("<2 字符不触发（提示至少 2 个字符）", () => {
    expect(SEARCH_MIN_CHARS).toBe(2);
    const one = parseSearchQuery("a");
    expect(one.active).toBe(false);
    expect(one.tooShort).toBe(true);
    const empty = parseSearchQuery("   ");
    expect(empty.active).toBe(false);
    expect(empty.tooShort).toBe(false);
  });

  it("trim + 大小写归一；2 字符起可触发", () => {
    const q = parseSearchQuery("  Report  ");
    expect(q.raw).toBe("  Report  ");
    expect(q.display).toBe("Report");
    expect(q.term).toBe("report");
    expect(q.active).toBe(true);
    expect(q.tooShort).toBe(false);
  });

  it("不足 2 字符的查询 → 空结果（不发匹配）", () => {
    const entries = [f("files/a.txt")];
    expect(rankSearchResults(entries, "a")).toEqual({
      results: [],
      matched: 0,
      capped: false,
    });
  });
});

describe("rankSearchResults — 匹配与排序", () => {
  it("名称前缀 > 名称包含 > 路径包含", () => {
    const entries = [
      f("files/docs/photo.png"), // 名称前缀
      f("files/docs/myphoto.png"), // 名称包含
      f("files/photo/readme.md"), // 仅路径包含
    ];
    const got = rankSearchResults(entries, "photo");
    expect(names(got.results)).toEqual([
      "files/docs/photo.png",
      "files/docs/myphoto.png",
      "files/photo/readme.md",
    ]);
    expect(got.matched).toBe(3);
    expect(got.capped).toBe(false);
  });

  it("同组目录优先、名称升序；大小写不敏感", () => {
    const entries = [
      f("files/REPORT-b.txt"),
      d("files/report-a"),
      f("files/Report-0.md"),
    ];
    const got = rankSearchResults(entries, "report");
    expect(names(got.results)).toEqual([
      "files/report-a/", // 目录优先
      "files/Report-0.md", // 名称升序（Report-0 < REPORT-b）
      "files/REPORT-b.txt",
    ]);
  });

  it("中文名称 / 中文路径", () => {
    const entries = [
      f("files/项目计划.md"), // 名称前缀
      f("files/存档/项目计划.md"), // 名称包含
      f("files/存档/说明.txt"), // 路径包含（中文目录）
    ];
    const got = rankSearchResults(entries, "项目");
    expect(names(got.results).slice(0, 2)).toEqual([
      "files/项目计划.md",
      "files/存档/项目计划.md",
    ]);
    const pathOnly = rankSearchResults(entries, "存档");
    expect(pathOnly.results).toHaveLength(2);
    expect(names(pathOnly.results).sort()).toEqual(
      ["files/存档/项目计划.md", "files/存档/说明.txt"].sort(),
    );
  });

  it("无结果 → 空列表（UI「没有匹配的文件或文件夹」）", () => {
    const got = rankSearchResults([f("files/a.txt"), d("files/docs")], "zzz");
    expect(got.results).toEqual([]);
    expect(got.matched).toBe(0);
    expect(got.capped).toBe(false);
  });
});

describe("200 上限 + 分页状态", () => {
  it("匹配数 > 200 → 只展示 200 条并标记 capped", () => {
    expect(SEARCH_RESULT_CAP).toBe(200);
    const entries = Array.from({ length: 250 }, (_, i) =>
      f(`files/hit-${String(i).padStart(3, "0")}.txt`),
    );
    const got = rankSearchResults(entries, "hit");
    expect(got.results).toHaveLength(200);
    expect(got.matched).toBe(250);
    expect(got.capped).toBe(true);
  });

  it("首屏拉满 1000 且 nextKey 存在 → 「加载更多」", () => {
    const entries = Array.from({ length: SEARCH_FETCH_LIMIT }, (_, i) =>
      f(`files/x-${i}.txt`),
    );
    const page = searchPageState({ entries, nextKey: "cursor-1" });
    expect(page.loaded).toBe(SEARCH_FETCH_LIMIT);
    expect(page.limit).toBe(SEARCH_FETCH_LIMIT);
    expect(page.hasMore).toBe(true);
    expect(page.atLimit).toBe(true);
  });

  it("nextKey = null（到底）/ undefined（老控制器）→ 无「加载更多」", () => {
    const entries = [f("files/a.txt")];
    expect(searchPageState({ entries, nextKey: null }).hasMore).toBe(false);
    expect(searchPageState({ entries, nextKey: undefined }).hasMore).toBe(false);
    expect(searchPageState({ entries, nextKey: null }).atLimit).toBe(false);
  });
});

describe("formatResultPath / resultRelPath", () => {
  it("文件 = 父目录；目录 = 自身上级；根层为空串", () => {
    expect(formatResultPath(f("files/docs/a.txt"))).toBe("docs");
    expect(formatResultPath(f("files/a.txt"))).toBe("");
    expect(formatResultPath(d("files/docs/sub"))).toBe("docs");
    expect(formatResultPath(d("files/docs"))).toBe("");
  });

  it("老形态（无 path）回落 dirPath + name", () => {
    const legacy: HumanFileEntry = { name: "a.txt", type: "file" };
    expect(formatResultPath(legacy, "docs")).toBe("docs");
    expect(resultRelPath(legacy, "docs")).toBe("docs/a.txt");
  });

  it("结果行完整相对路径剥 files/ 前缀", () => {
    expect(resultRelPath(f("files/docs/a.txt"))).toBe("docs/a.txt");
    expect(resultRelPath(d("files/docs/"))).toBe("docs/");
  });
});

describe("FilesSection 源码接线", () => {
  const files = readSrc("manage/FilesSection.tsx");

  it("使用同一套全局搜索纯函数", () => {
    expect(files).toMatch(/from "\.\/files\/globalSearch"/);
    expect(files).toMatch(/parseSearchQuery\(/);
    expect(files).toMatch(/rankSearchResults\(/);
    expect(files).toMatch(/searchPageState\(/);
  });

  it("首次搜索 = 根目录递归平铺（limit = SEARCH_FETCH_LIMIT）", () => {
    expect(files).toMatch(
      /listFiles\(humanName, "", \{ recursive: true, limit: SEARCH_FETCH_LIMIT \}\)/,
    );
    // 后续分页经 nextKey 游标
    expect(files).toMatch(/cursor: searchNextKey/);
  });

  it("输入去抖 250ms（SEARCH_DEBOUNCE_MS）+ <2 字符不触发", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(250);
    expect(files).toMatch(/SEARCH_DEBOUNCE_MS/);
    expect(files).toMatch(/searchQuery\.active \? searchQuery\.term : ""/);
  });

  it("工具条搜索框：placeholder / allowClear / Esc 清除", () => {
    expect(files).toMatch(/搜索全部文件（名称或路径）/);
    expect(files).toMatch(/allowClear/);
    expect(files).toMatch(/fs\.onSearchClear\(\)/);
    expect(files).toMatch(/输入至少 2 个字符/);
  });

  it("搜索期间隐藏面包屑 / 目录内容，显示结果标题与降级提示", () => {
    expect(files).toMatch(/搜索结果 · \{n\} 项/);
    expect(files).toMatch(/没有匹配的文件或文件夹/);
    expect(files).toMatch(/全局搜索不可用/);
    expect(files).toMatch(/<SearchResults \{\.\.\.sub\} \/>/);
    expect(files).toMatch(/仅显示前 \{n\} 条，继续输入缩小范围/);
    expect(files).toMatch(/结果基于前 \{n\} 项/);
  });

  it("搜索状态不写 URL（无 location / history / search 参数写入）", () => {
    expect(files).not.toMatch(/location\.(search|hash)/);
    expect(files).not.toMatch(/history\.(push|replace)State/);
  });
});
