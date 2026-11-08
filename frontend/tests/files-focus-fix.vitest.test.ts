// files-focus-fix：文件管理树视图「文件夹高亮点别处不取消」修复契约。
//
// 实机现象（设备截图）：树里点文件夹后高亮；点列表空白 / 别处高亮仍在，
// 且首帧就有两个文件夹同时灰底。根因四处：
// ① TreeArea 的 focusIndex 初值 0 → focused={i === idx} 让第一行恒亮；
// ② selectedDir 是 TreeArea 本地状态，父级空白点击只清 nav.selectedFile；
// ③ 空白点击 handler 只挂在列表列 div（工具栏 / 面包屑 / 页面空白不触发）；
// ④ 点文件行不清 selectedDir → 旧文件夹高亮残留。
//
// 契约：
// ① focusIndex 初值 / 切目录 = -1（无焦点）→ 初始进入没有任何行高亮；
// ② 清树高亮三态 helper = {selectedDir:"", focusIndex:-1, uploadDir:""}；
// ③ 空白判定：行 / 行内按钮不算空白；aside（详情栏）内空白也不算「点别处」；
// ④ 源码接线：根容器 onClick / clearNonce → TreeArea effect / Esc / 点文件行。
//
// 纯逻辑（files/treeFocus）可直接 node 直跑；涉及 JSX 的接线用源码断言。
// 直跑：node --experimental-strip-types frontend/tests/files-focus-fix.vitest.test.ts
//（显式 .ts 扩展名 = 同 files-v3-4.test.ts 口径；vite/vitest 亦接受）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TREE_FOCUS_NONE,
  initialTreeFocusIndex,
  isBlankClickTarget,
  isPageBlankClickTarget,
  treeClearState,
  treeFocusRow,
} from "../src/manage/files/treeFocus.ts";

const src = readFileSync(join(process.cwd(), "src", "manage", "FilesSection.tsx"), "utf8");

/** 假点击目标：closest(selector) 命中 hit() 里的选择器才算「落在控件 / 容器内」。 */
const fakeTarget = (hit: (selector: string) => boolean): EventTarget =>
  ({ closest: (s: string) => (hit(s) ? ({} as Element) : null) }) as unknown as EventTarget;

describe("① 树焦点初值 = 无焦点（首帧不点亮任何行）", () => {
  it("initialTreeFocusIndex() === -1", () => {
    expect(initialTreeFocusIndex()).toBe(-1);
    expect(TREE_FOCUS_NONE).toBe(-1);
  });

  it("focusIndex 以 initialTreeFocusIndex 为初值（源码接线）", () => {
    expect(src).toContain("React.useState<number>(initialTreeFocusIndex)");
  });

  it("treeFocusRow：无焦点 / 空列表 → -1（无高亮）；越界夹到末行", () => {
    expect(treeFocusRow(-1, 5)).toBe(-1);
    expect(treeFocusRow(0, 0)).toBe(-1);
    expect(treeFocusRow(0, 5)).toBe(0);
    expect(treeFocusRow(2, 5)).toBe(2);
    expect(treeFocusRow(9, 3)).toBe(2);
  });

  it("切目录重置为 TREE_FOCUS_NONE（源码接线）", () => {
    expect(src).toContain("setFocusIndex(TREE_FOCUS_NONE)");
  });
});

describe("② 清树高亮三态 helper", () => {
  it("treeClearState → selectedDir '' / focusIndex -1 / uploadDir ''", () => {
    expect(treeClearState()).toEqual({
      selectedDir: "",
      focusIndex: -1,
      uploadDir: "",
    });
  });
});

describe("③ 空白点击判定（行 / 行内按钮 / aside）", () => {
  it("行内 button → 不算空白", () => {
    expect(isBlankClickTarget(fakeTarget((s) => s.includes("button")))).toBe(false);
  });

  it("树行 / 列表行（data-hf-row）→ 不算空白", () => {
    expect(isBlankClickTarget(fakeTarget((s) => s.includes("[data-hf-row]")))).toBe(false);
  });

  it("复选框 / 菜单项 → 不算空白；null → false", () => {
    expect(isBlankClickTarget(fakeTarget((s) => s.includes('role="checkbox"')))).toBe(false);
    expect(isBlankClickTarget(fakeTarget((s) => s.includes('role="menuitem"')))).toBe(false);
    expect(isBlankClickTarget(null)).toBe(false);
  });

  it("aside 不在空白白名单里 → isBlankClickTarget 视为空白，须由页面 handler 额外排除", () => {
    const inAside = fakeTarget((s) => s === "aside");
    expect(isBlankClickTarget(inAside)).toBe(true);
    expect(isPageBlankClickTarget(inAside)).toBe(false);
    expect(readFileSync(join(process.cwd(), "src", "manage", "files", "treeFocus.ts"), "utf8")).toContain(
      'el.closest("aside") === null',
    );
  });

  it("页面根容器空白（不在 aside 内）→ 清；null → false", () => {
    expect(isPageBlankClickTarget(fakeTarget(() => false))).toBe(true);
    expect(isPageBlankClickTarget(null)).toBe(false);
  });
});

describe("④ 源码接线（根容器 / clearNonce / Esc / 点文件行）", () => {
  it("空白点击挂在页面根容器，不再只挂列表列 div", () => {
    const root = src.slice(src.indexOf("ref={widthRef}"), src.indexOf("<FilesToolbar"));
    expect(root).toContain("onClick={onListBlankClick}");
    const listCol = src.slice(src.indexOf("ref={setListCol}"), src.indexOf("{dropNode}"));
    expect(listCol.includes("onClick={onListBlankClick}")).toBe(false);
    // 根容器 handler 走「空白 + 非 aside」判定。
    expect(src).toContain("if (!isPageBlankClickTarget(e.target)) return;");
  });

  it("clearNonce：父级状态 + 传给 TreeArea + TreeArea effect 清本地三态", () => {
    expect(src).toContain("const [treeClearNonce, setTreeClearNonce] = React.useState(0)");
    expect(src).toContain("setTreeClearNonce((n) => n + 1)");
    expect(src).toContain("clearNonce={treeClearNonce}");
    expect(src).toContain("clearNonce = 0,");
    const effectEnd = src.indexOf("}, [clearNonce]);");
    expect(effectEnd).toBeGreaterThan(0);
    expect(src.slice(effectEnd - 200, effectEnd)).toContain("clearLocalFocus()");
    const clearLocal = src.slice(
      src.indexOf("const clearLocalFocus = React.useCallback"),
      src.indexOf("const rows = React.useMemo"),
    );
    expect(clearLocal).toContain("treeClearState()");
    expect(clearLocal).toContain("setSelectedDir(reset.selectedDir)");
    expect(clearLocal).toContain("setFocusIndex(reset.focusIndex)");
    expect(clearLocal).toContain("actions.setUploadDir(reset.uploadDir)");
  });

  it("空白点击 / Esc 都调 clearTreeFocus（Esc 先清批量选择）", () => {
    const blank = src.slice(
      src.indexOf("const onListBlankClick ="),
      src.indexOf("// Esc：第一次清选择"),
    );
    expect(blank).toContain("clearTreeFocus()");
    expect(blank).toContain("setMultiSelect(false)");
    const esc = src.slice(src.indexOf("const onRootKeyDown"), src.indexOf("const listNode"));
    expect((esc.match(/clearTreeFocus\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(esc.indexOf("onClearSelection()")).toBeGreaterThan(-1);
    expect(esc.indexOf("onClearSelection()")).toBeLessThan(esc.indexOf("clearTreeFocus()"));
  });

  it("点文件行（activateRow else）清 selectedDir + 上传目标", () => {
    const act = src.slice(
      src.indexOf("const activateRow = React.useCallback("),
      src.indexOf("const onKeyDown = (e: ReactNS.KeyboardEvent"),
    );
    expect(act).toContain('setSelectedDir("")');
    expect(act).toContain('actions.setUploadDir("")');
    // 目录行仍写入选中的目录 + 无尾斜杠上传目标。
    expect(act).toContain("setSelectedDir(row.path)");
    expect(act).toContain('p.replace(/\\/+$/, "")');
    // 点击把键盘焦点挪到本行：不会与旧焦点行同时高亮。
    expect(act).toContain("const at = rows.indexOf(row)");
    expect(act).toContain("setFocusIndex(at)");
  });

  it("键盘首次 ↑ / ↓ 都能落焦（无焦点 -1 时夹到第一行）", () => {
    expect(src).toContain("setFocusIndex(next < 0 ? 0 : next)");
  });

  it("树容器空白点击清本地高亮且不 stopPropagation（根 handler 继续清焦点）", () => {
    const treeBox = src.slice(src.indexOf('role="tree"'), src.indexOf("{rows.map((r, i) => ("));
    expect(treeBox).toContain("isBlankClickTarget(e.target)");
    expect(treeBox).toContain("clearLocalFocus()");
    expect(treeBox.includes("e.stopPropagation(")).toBe(false);
  });

  it("行高亮只在有焦点时点亮（focused 门控 idx >= 0）", () => {
    expect(src).toContain("focused={idx >= 0 && i === idx}");
    // 目录高亮由 selectedDir 单独驱动（与焦点解耦）。
    expect(src).toContain("selected={selectedDir === r.path}");
  });
});
