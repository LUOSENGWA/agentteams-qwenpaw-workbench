// 文件列表排序（sortModel）纯函数测试：目录在前 / 数值 / 时间 / 缺失末尾 / 持久化。

import { describe, expect, it } from "vitest";

import type { HumanFileEntry } from "../src/api/domains/humanFiles";
import {
  DEFAULT_FILE_SORT,
  nextFileSort,
  parseFileSort,
  serializeFileSort,
  sortFileEntries,
  sortTreeLevels,
} from "../src/manage/files/sortModel";

const f = (
  path: string,
  extra: Partial<HumanFileEntry> = {},
): HumanFileEntry => ({ path, type: "file", ...extra });
const d = (path: string): HumanFileEntry => ({
  path: path.endsWith("/") ? path : `${path}/`,
  type: "directory",
});

describe("sortFileEntries", () => {
  it("directories stay first in both directions", () => {
    const list = [f("files/b.txt"), d("files/z"), f("files/a.txt")];
    const asc = sortFileEntries(list, { key: "name", dir: "asc" }).map((e) => e.path);
    const desc = sortFileEntries(list, { key: "name", dir: "desc" }).map((e) => e.path);
    expect(asc[0]).toBe("files/z/");
    expect(desc[0]).toBe("files/z/");
  });

  it("name comparison is numeric-aware (file2 < file10)", () => {
    const list = [f("files/file10.md"), f("files/file2.md")];
    const got = sortFileEntries(list, { key: "name", dir: "asc" }).map((e) => e.path);
    expect(got).toEqual(["files/file2.md", "files/file10.md"]);
  });

  it("size compares numerically and missing sizes go last", () => {
    const list = [f("files/big.bin", { size: 900 }), f("files/none.bin"), f("files/small.bin", { size: 10 })];
    const asc = sortFileEntries(list, { key: "size", dir: "asc" }).map((e) => e.path);
    expect(asc).toEqual(["files/small.bin", "files/big.bin", "files/none.bin"]);
    const desc = sortFileEntries(list, { key: "size", dir: "desc" }).map((e) => e.path);
    expect(desc.at(-1)).toBe("files/none.bin");
  });

  it("updatedAt compares by timestamp; invalid/missing last", () => {
    const list = [
      f("files/new.md", { updatedAt: "2026-11-08T10:00:00Z" }),
      f("files/old.md", { updatedAt: "2026-11-01T10:00:00Z" }),
      f("files/bad.md", { updatedAt: "not-a-date" }),
    ];
    const got = sortFileEntries(list, { key: "updatedAt", dir: "asc" }).map((e) => e.path);
    expect(got).toEqual(["files/old.md", "files/new.md", "files/bad.md"]);
  });

  it("type sorts by extension label (dirs first anyway)", () => {
    const list = [f("files/a.md"), f("files/b.zip"), d("files/dir")];
    const got = sortFileEntries(list, { key: "type", dir: "asc" }).map((e) => e.path);
    expect(got).toEqual(["files/dir/", "files/a.md", "files/b.zip"]);
  });
});

describe("sort state helpers", () => {
  it("nextFileSort toggles direction on the same column, resets on change", () => {
    expect(nextFileSort({ key: "name", dir: "asc" }, "name")).toEqual({
      key: "name",
      dir: "desc",
    });
    expect(nextFileSort({ key: "name", dir: "desc" }, "size")).toEqual({
      key: "size",
      dir: "asc",
    });
  });

  it("parseFileSort falls back to name asc for junk", () => {
    expect(parseFileSort(null)).toEqual(DEFAULT_FILE_SORT);
    expect(parseFileSort("not json")).toEqual(DEFAULT_FILE_SORT);
    expect(parseFileSort('{"key":"bogus","dir":"up"}')).toEqual(DEFAULT_FILE_SORT);
    expect(parseFileSort('{"key":"size","dir":"desc"}')).toEqual({
      key: "size",
      dir: "desc",
    });
  });

  it("serializeFileSort round-trips", () => {
    const s = { key: "updatedAt", dir: "desc" } as const;
    expect(parseFileSort(serializeFileSort(s))).toEqual(s);
  });
});

describe("sortTreeLevels (tree view)", () => {
  it("sorts roots and every loaded level independently, dirs first", () => {
    const roots = [f("files/b.md"), d("files/Z")];
    const children = new Map<string, HumanFileEntry[]>([
      ["Z/", [f("Z/2.md"), f("Z/10.md"), d("Z/sub")]],
    ]);
    const out = sortTreeLevels(roots, children, { key: "name", dir: "asc" });
    expect(out.roots.map((e) => e.path)).toEqual(["files/Z/", "files/b.md"]);
    expect(out.children.get("Z/")!.map((e) => e.path)).toEqual([
      "Z/sub/",
      "Z/2.md",
      "Z/10.md",
    ]);
    // 不修改入参
    expect(children.get("Z/")!.map((e) => e.path)).toEqual([
      "Z/2.md",
      "Z/10.md",
      "Z/sub/",
    ]);
  });

  it("descending keeps directories first", () => {
    const roots = [d("files/a"), d("files/Z"), f("files/m.md")];
    const out = sortTreeLevels(roots, new Map(), { key: "name", dir: "desc" });
    expect(out.roots.map((e) => e.path)).toEqual([
      "files/Z/",
      "files/a/",
      "files/m.md",
    ]);
  });
});
