// B1 目标目录 + B2 选择模型接线（源码级静态断言 + 纯函数）：
// - 新建 / 上传共用 resolveTargetDir（树选中目录优先，嵌套路径正确）；
// - 弹窗标题 / 占位显示「在 <目标目录>/ 下新建」；
// - 三视图复选框 switch 批量选择（不设目标、不触发展开），目录可选；
// - 行点击走 clickSelection（焦点 + 批量选择分离），表头全选三态；
// - 批量下载跳过目录并提示；批量删除跳过目录并提示。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTargetDir, targetDirLabel } from "../src/manage/files/targetDir";

const SRC = join(process.cwd(), "src");
const filesSrc = (): string => readFileSync(join(SRC, "manage", "FilesSection.tsx"), "utf8");

describe("resolveTargetDir — 树选中目录优先（含嵌套）", () => {
  it("无树选择 → 当前目录；根目录 = \"\"", () => {
    expect(resolveTargetDir("", "")).toBe("");
    expect(resolveTargetDir("", "a/b")).toBe("a/b");
    expect(resolveTargetDir(null, "a/b")).toBe("a/b");
  });

  it("树选中目录优先于当前目录，且去尾斜杠（新形态 rowPath 带 /）", () => {
    expect(resolveTargetDir("docs/", "root")).toBe("docs");
    expect(resolveTargetDir("docs/sub/", "")).toBe("docs/sub");
    expect(resolveTargetDir("/a/b//", "root")).toBe("/a/b");
  });
});

describe("targetDirLabel — 弹窗展示", () => {
  it("根 = 「我的文件」；非根带尾斜杠", () => {
    expect(targetDirLabel("", "我的文件")).toBe("我的文件");
    expect(targetDirLabel("docs", "我的文件")).toBe("docs/");
    expect(targetDirLabel("docs/sub/", "我的文件")).toBe("docs/sub/");
  });
});

describe("FilesSection 接线 — B1 目标目录", () => {
  it("新建文件夹 = resolveTargetDir(targetDir)（不再只用 dirPath）", () => {
    const src = filesSrc();
    expect(src).toMatch(/const targetDir = resolveTargetDir\(inp\.uploadDirRef\.current, inp\.dirPath\)/);
    expect(src).toContain("${fullPath(targetDir, name)}/.keep");
    expect(src).not.toContain("${fullPath(inp.dirPath, name)}/.keep");
  });

  it("上传入队与新建共用同一目标解析（拖拽空白区同样回落树选中目标）", () => {
    const src = filesSrc();
    expect(src).toMatch(
      /queue\.enqueue\(files, resolveTargetDir\(inp\.uploadDirRef\.current, inp\.dirPath\)\)/,
    );
    expect(src).toMatch(
      /dir !== undefined\s*\?\s*dir\s*:\s*resolveTargetDir\(uploadDirRef\.current, dirPath\)/,
    );
  });

  it("弹窗标题 / 占位显示「在 <目标目录>/ 下新建」，成功后保留目标", () => {
    const src = filesSrc();
    expect(src).toContain('title={tr("在 {dir} 下新建", { dir: actions.folderTargetLabel })}');
    expect(src).toContain(
      'placeholder={tr("在 {dir} 下新建", { dir: actions.folderTargetLabel })}',
    );
    // 成功分支只关弹窗 + 清名称 + reload，不清 uploadDirRef（目标保留）。
    const fn = src.slice(
      src.indexOf("const createFolderInner"),
      src.indexOf("/** 拖拽上传：先按相对路径建子目录"),
    );
    expect(fn).toContain("inp.reload({ silent: true })");
    expect(fn).not.toContain("uploadDirRef.current = \"\"");
  });
});

describe("FilesSection 接线 — B2 选择模型", () => {
  it("行点击统一走 fs.onRowClick（列表 / 网格 / 树）", () => {
    const src = filesSrc();
    const hits = src.match(/fs\.onRowClick\(/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(5); // 列表行 + 网格卡 + 树 activateRow + 键盘
    expect(src).toContain("clickSelection(selected, p, {");
  });

  it("三视图复选框都切换批量选择，目录不再硬编码 isDir:false", () => {
    const src = filesSrc();
    expect(src).not.toContain("fs.onToggleSelect(path, { isDir: false");
    expect(src).not.toContain("fs.onToggleSelect(p, { isDir: false");
    // 列表行 / 网格卡 / 树行 checkbox → onToggleSelect({ shiftKey, paths })
    expect(src).toMatch(/fs\.onToggleSelect\(path, \{ shiftKey, paths \}\)/);
    expect(src).toMatch(/onToggleSelect\(path, shiftKey\)/);
    // 复选框在目录行也渲染（不再 isDir 占位分支）。
    expect(src).not.toMatch(/\{isDir \? \(\s*<span aria-hidden="true" \/>/);
  });

  it("表头/工具条全选按当前可见行三态（列表 / 树 / 网格）", () => {
    const src = filesSrc();
    expect(src).toContain("onToggle={() => fs.onSelectAll(viewPaths)}");
    expect(src).toContain("onToggle={() => fs.onSelectAll(visiblePaths)}");
    expect(src).toContain("const selState = selectAllState(fs.selected, viewPaths)");
    expect(src).toContain("const selState = selectAllState(fs.selected, visiblePaths)");
  });

  it("批量下载跳过目录并提示；批量删除同样显式跳过（不静默）", () => {
    const src = filesSrc();
    expect(src).toContain("batchTargets.filter((it) => !it.isDir)");
    expect(src).toContain('tr("目录不支持下载，已跳过 {n} 个", { n: skippedDirs })');
    expect(src).toContain("batchTargets.filter((e) => !e.isDir)");
    expect(src).toContain(
      'tr("目录删除暂不支持，已跳过 {n} 个（请逐个删除文件）", {',
    );
  });

  it("键盘：Space 切换选择、Enter 激活/进入", () => {
    const src = filesSrc();
    expect(src).toMatch(/e\.key === " "\s*\) \{\s*e\.preventDefault\(\);\s*toggleSel\(e\.shiftKey\)/);
    expect(src).toContain('if (e.key === "Enter")');
  });
});
