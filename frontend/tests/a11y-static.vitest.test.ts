// a11y 静态门（R4）：关键 5 页（文件列表/同步设置、工作流看板、Worker 详情、
// 设置页）的源码级可访问性断言。axe-core 不在 devDeps（不新增依赖）→
// 纯函数扫描（src/lib/a11yStatic.ts）。
//
// 六个规则：图标按钮名字 / 可点 div 的 role / role=button 的键盘可达 /
// role=checkbox 的 aria-checked / 自绘 dialog 的 aria-modal / 表单控件名字。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findA11yIssues,
  formatA11yIssue,
  listExemptions,
  scanTags,
  type A11yIssue,
} from "../src/lib/a11yStatic";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

const report = (src: string, issues: A11yIssue[]): string[] =>
  issues.map((i) => formatA11yIssue(src, i));

/** 关键 5 页的源码面（含页内共享组件）。 */
const PAGES = {
  "文件页·列表": ["src/manage/FilesSection.tsx"],
  "文件页·同步设置": [
    "src/manage/files/SyncSettingsModal.tsx",
    "src/manage/files/SyncScopeDialog.tsx",
  ],
  "工作流看板": [
    "src/components/WorkflowBoard.tsx",
    "src/workflowboard/BoardView.tsx",
    "src/workflowboard/blocks.tsx",
    "src/workflowboard/panels.tsx",
  ],
  "Worker 详情": ["src/manage/WorkerDetailPane.tsx"],
  "设置页": ["src/components/SettingsTabView.tsx", "src/components/SettingsTabShared.tsx"],
} as const;

describe("a11y 静态扫描器（纯函数）", () => {
  it("解析标签：属性 / 自闭合 / 嵌套子节点 / 花括号表达式", () => {
    const src = `
      <div className="a">
        <antd.Button size="small" icon={<ReloadIcon />} onClick={f} />
        <span>{tr("刷新")}</span>
      </div>`;
    const tags = scanTags(src).map((t) => t.name);
    expect(tags).toEqual(["div", "antd.Button", "span"]);
    const btn = scanTags(src).find((t) => t.name === "antd.Button");
    expect(btn?.selfClosing).toBe(true);
    expect(btn?.attrs).toContain("icon=");
  });

  it("图标按钮：无名字报错，补 aria-label / title 后放行", () => {
    const bad = `<antd.Button type="text" icon={<ReloadIcon />} onClick={f} />`;
    const rules = findA11yIssues(bad).map((i) => i.rule);
    expect(rules).toEqual(["icon-button-name"]);

    const labeled = `<antd.Button type="text" aria-label="刷新" icon={<ReloadIcon />} onClick={f} />`;
    expect(findA11yIssues(labeled)).toEqual([]);

    const titled = `<antd.Button type="text" title="刷新" icon={<ReloadIcon />} onClick={f} />`;
    expect(findA11yIssues(titled)).toEqual([]);

    // 有可见文本（含 tr() 表达式）时不算图标按钮。
    const withText = `<antd.Button icon={<ReloadIcon />} onClick={f}>{tr("刷新")}</antd.Button>`;
    expect(findA11yIssues(withText)).toEqual([]);
  });

  it("可点 div：缺 role 报错；role=button 还须 tabIndex + onKeyDown", () => {
    const bad = `<div onClick={() => open()}>标题</div>`;
    expect(findA11yIssues(bad).map((i) => i.rule)).toEqual(["clickable-div-role"]);

    const half = `<div role="button" onClick={() => open()}>标题</div>`;
    expect(findA11yIssues(half).map((i) => i.rule)).toEqual(["clickable-div-keyboard"]);

    const full = `<div role="button" tabIndex={0} onClick={() => open()} onKeyDown={(e) => enter(e)}>标题</div>`;
    expect(findA11yIssues(full)).toEqual([]);

    // 非交互 role 等同缺 role。
    const wrong = `<div role="group" onClick={() => open()}>标题</div>`;
    expect(findA11yIssues(wrong).map((i) => i.rule)).toEqual(["clickable-div-role"]);
  });

  it("role=checkbox：aria-checked 缺失/非法报错，true/false/mixed 合法", () => {
    const missing = `<button type="button" role="checkbox">x</button>`;
    expect(findA11yIssues(missing).map((i) => i.rule)).toEqual(["checkbox-aria-checked"]);

    const illegal = `<button type="button" role="checkbox" aria-checked="partial">x</button>`;
    expect(findA11yIssues(illegal).map((i) => i.rule)).toEqual(["checkbox-aria-checked"]);

    for (const v of ["true", "false", "mixed"]) {
      const ok = `<button type="button" role="checkbox" aria-checked="${v}">x</button>`;
      expect(findA11yIssues(ok)).toEqual([]);
    }

    // 表达式形态（indeterminate ? "mixed" : checked）静态不可判 → 只要求属性存在。
    const expr = `<button type="button" role="checkbox" aria-checked={indeterminate ? "mixed" : checked}>x</button>`;
    expect(findA11yIssues(expr)).toEqual([]);
  });

  it("自绘 dialog 必须 aria-modal=\"true\"", () => {
    const bad = `<div role="dialog">内容</div>`;
    expect(findA11yIssues(bad).map((i) => i.rule)).toEqual(["dialog-aria-modal"]);

    const ok = `<div role="dialog" aria-modal="true">内容</div>`;
    expect(findA11yIssues(ok)).toEqual([]);
  });

  it("表单控件必须有名字：placeholder 不算，aria-hidden 隐藏域不算", () => {
    const bad = `<antd.Input placeholder="192.168.1.10:6866" value={v} onChange={f} />`;
    expect(findA11yIssues(bad).map((i) => i.rule)).toEqual(["form-control-name"]);

    const ok = `<antd.Input aria-label="Matrix 内网地址" placeholder="192.168.1.10:6866" value={v} onChange={f} />`;
    expect(findA11yIssues(ok)).toEqual([]);

    const byLabelledBy = `<antd.Select aria-labelledby="addr-mode-label" value={v} onChange={f} />`;
    expect(findA11yIssues(byLabelledBy)).toEqual([]);

    const hiddenFile = `<input type="file" aria-hidden="true" style={{ display: "none" }} />`;
    expect(findA11yIssues(hiddenFile)).toEqual([]);
  });

  it("注释里贴的 JSX 示例不参与检查", () => {
    const src = `
      /** 批量选择 checkbox（裸 \`<button role="checkbox">\`——注释示例）。 */
      <div role="button" tabIndex={0} onKeyDown={f} onClick={f}>行</div>`;
    expect(findA11yIssues(src)).toEqual([]);
  });
});

describe("关键 5 页零违规", () => {
  for (const [page, files] of Object.entries(PAGES)) {
    it(`${page}：${files.length} 个文件`, () => {
      const failures: string[] = [];
      for (const rel of files) {
        const src = read(rel);
        for (const line of report(src, findA11yIssues(src))) failures.push(`${rel}: ${line}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("豁免声明必须带理由", () => {
  it("关键页面里的 a11y-static-exempt 均有非空理由", () => {
    for (const files of Object.values(PAGES)) {
      for (const rel of files) {
        for (const reason of listExemptions(read(rel))) {
          expect(reason.length, `${rel} 的豁免理由为空`).toBeGreaterThan(3);
        }
      }
    }
  });
});
