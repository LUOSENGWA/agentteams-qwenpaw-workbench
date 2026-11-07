// filesSelection 纯函数模型（B2 选择模型）：复选框 toggle（含 shift 区间）/
// 行点击 clickSelection（无修饰单选 / Ctrl 切换 / Shift 区间）/ 文件+目录
// 均可选 / 全选三态 / 刷新剔除 / 汇总（数量+字节）。
import { describe, expect, it } from "vitest";

import {
  clearSelection,
  clickSelection,
  pruneSelection,
  selectAll,
  selectAllState,
  selectedSummary,
  toggleSelection,
} from "../src/lib/filesSelection";

// 新形态 rowPath：文件相对存储根（无尾斜杠），目录以 "/" 结尾。
const F_A = "a.txt";
const F_B = "b.log";
const F_C = "c.png";
const D_X = "x/"; // 目录
const paths = [F_A, D_X, F_B, F_C];

describe("toggleSelection — 复选框单点（只改批量选择）", () => {
  it("空集 + 文件 → 选中该文件", () => {
    const s = toggleSelection(new Set(), F_A);
    expect(s.has(F_A)).toBe(true);
    expect(s.size).toBe(1);
  });

  it("再点同一文件 → 取消（toggle）", () => {
    const s1 = toggleSelection(new Set(), F_A);
    const s2 = toggleSelection(s1, F_A);
    expect(s2.size).toBe(0);
  });

  it("目录（尾斜杠）同样可选（B2：目录参与批量删除）", () => {
    const s = toggleSelection(new Set(), D_X);
    expect(s.has(D_X)).toBe(true);
    expect(toggleSelection(s, D_X).size).toBe(0);
  });

  it("不修改入参 set（恒新 Set 或原样返回）", () => {
    const base = new Set([F_A]);
    const s = toggleSelection(base, F_B);
    expect(s).not.toBe(base);
    expect(base.has(F_B)).toBe(false);
    expect(base.size).toBe(1);
  });
});

describe("toggleSelection — shift 区间（含目录、按可见行顺序）", () => {
  it("anchor 到目标点闭区间并入（含两端与区间内目录）", () => {
    const anchored = toggleSelection(new Set(), F_A);
    const ranged = toggleSelection(anchored, F_C, {
      shiftKey: true,
      anchor: F_A,
      paths,
    });
    expect(ranged.has(F_A)).toBe(true);
    expect(ranged.has(F_B)).toBe(true);
    expect(ranged.has(D_X)).toBe(true); // B2：区间内目录也被选中
    expect(ranged.has(F_C)).toBe(true);
    expect(ranged.size).toBe(4);
  });

  it("区间 = additive：区间外已选项保留", () => {
    const pre = new Set([F_C]);
    const ranged = toggleSelection(pre, F_B, {
      shiftKey: true,
      anchor: F_A,
      paths: [F_A, F_B, F_C],
    });
    expect(ranged.has(F_A)).toBe(true);
    expect(ranged.has(F_B)).toBe(true);
    expect(ranged.has(F_C)).toBe(true);
    expect(ranged.size).toBe(3);
  });

  it("anchor 缺失 → 回落单点 toggle", () => {
    const s = toggleSelection(new Set(), F_B, { shiftKey: true, anchor: null, paths });
    expect(s.size).toBe(1);
    expect(s.has(F_B)).toBe(true);
  });

  it("anchor 不在 paths 中 → 回落单点 toggle", () => {
    const s = toggleSelection(new Set(), F_B, {
      shiftKey: true,
      anchor: "not-here",
      paths,
    });
    expect(s.size).toBe(1);
    expect(s.has(F_B)).toBe(true);
  });

  it("反向区间（anchor 在下标靠后）同样闭区间", () => {
    const ranged = toggleSelection(new Set(), F_A, {
      shiftKey: true,
      anchor: F_C,
      paths: [F_A, F_B, F_C],
    });
    expect(ranged.size).toBe(3);
  });
});

describe("clickSelection — 行点击（焦点与批量选择分离）", () => {
  it("无修饰 → 只选本行（清掉其它已选项），锚点 = 本行", () => {
    const r = clickSelection(new Set([F_B, D_X]), F_A, { paths });
    expect([...r.selected]).toEqual([F_A]);
    expect(r.anchor).toBe(F_A);
  });

  it("Ctrl/Cmd+点击 → 切换本行（保留其它），锚点同步本行", () => {
    const base = new Set([F_B]);
    const add = clickSelection(base, F_A, { toggleKey: true, paths });
    expect(add.selected.has(F_A)).toBe(true);
    expect(add.selected.has(F_B)).toBe(true);
    expect(add.anchor).toBe(F_A);
    const remove = clickSelection(add.selected, F_A, { toggleKey: true, paths });
    expect(remove.selected.has(F_A)).toBe(false);
    expect(remove.anchor).toBe(F_A);
  });

  it("Shift+点击 → 从锚点到本行闭区间（含目录），锚点不变", () => {
    const r = clickSelection(new Set([F_C]), F_C, {
      shiftKey: true,
      anchor: F_A,
      paths,
    });
    expect([...r.selected].sort()).toEqual([D_X, F_A, F_B, F_C].sort());
    expect(r.anchor).toBe(F_A);
  });

  it("Shift 无锚点 / 锚点不可见 → 回落单选本行", () => {
    const noAnchor = clickSelection(new Set([F_B]), F_A, { shiftKey: true, paths });
    expect([...noAnchor.selected]).toEqual([F_A]);
    expect(noAnchor.anchor).toBe(F_A);

    const gone = clickSelection(new Set(), F_A, {
      shiftKey: true,
      anchor: "gone",
      paths,
    });
    expect([...gone.selected]).toEqual([F_A]);
  });
});

describe("selectAll / clearSelection / selectAllState（文件 + 目录三态）", () => {
  it("selectAll 含目录", () => {
    const s = selectAll(paths);
    expect(s.size).toBe(4);
    expect(s.has(D_X)).toBe(true);
  });

  it("clearSelection → 空集", () => {
    expect(clearSelection().size).toBe(0);
  });

  it("三态 none / some / all（目录计入分母）", () => {
    expect(selectAllState(new Set(), paths)).toBe("none");
    expect(selectAllState(new Set([F_A]), paths)).toBe("some");
    expect(selectAllState(new Set([F_A, D_X]), paths)).toBe("some");
    expect(selectAllState(selectAll(paths), paths)).toBe("all");
  });

  it("无可见行 → none", () => {
    expect(selectAllState(new Set([D_X]), [])).toBe("none");
  });
});

describe("pruneSelection — 刷新剔除", () => {
  it("已消失的路径被剔除，现存路径保留", () => {
    const sel = new Set([F_A, F_B, F_C]);
    const pruned = pruneSelection(sel, [F_A, F_C]); // b.log 被删/移走
    expect(pruned.has(F_A)).toBe(true);
    expect(pruned.has(F_B)).toBe(false);
    expect(pruned.has(F_C)).toBe(true);
    expect(pruned.size).toBe(2);
  });

  it("无变化 → 原样返回（避免容器重渲染）", () => {
    const sel = new Set([F_A, F_B]);
    const pruned = pruneSelection(sel, [F_A, F_B, F_C]);
    expect(pruned).toBe(sel);
  });

  it("全部消失 → 空集", () => {
    const pruned = pruneSelection(new Set([F_A, F_B]), []);
    expect(pruned.size).toBe(0);
  });
});

describe("selectedSummary — 汇总数量/字节", () => {
  const entries = [
    { path: F_A, size: 100 },
    { path: F_B, size: 2048 },
    { path: D_X, size: undefined },
    { path: F_C, size: 5000 },
  ];

  it("数量 = entries ∩ set；字节求和（目录按 0）", () => {
    const sum = selectedSummary(entries, new Set([F_A, D_X, F_C]));
    expect(sum.count).toBe(3);
    expect(sum.bytes).toBe(5100);
  });

  it("size 缺失按 0 计", () => {
    const sum = selectedSummary(entries, new Set([F_A]));
    expect(sum.count).toBe(1);
    expect(sum.bytes).toBe(100);
  });

  it("空选择 → 0 / 0", () => {
    const sum = selectedSummary(entries, new Set());
    expect(sum.count).toBe(0);
    expect(sum.bytes).toBe(0);
  });

  it("选中项不在 entries（脏选择）→ 不计", () => {
    const sum = selectedSummary(entries, new Set(["ghost"]));
    expect(sum.count).toBe(0);
    expect(sum.bytes).toBe(0);
  });
});
