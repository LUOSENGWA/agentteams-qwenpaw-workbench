// filesSelection 纯函数模型：多选 toggle（含 shift 区间）/ 目录不可选 /
// 全选三态 / 刷新剔除 / 汇总（数量+字节）。
import { describe, expect, it } from "vitest";

import {
  clearSelection,
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
const paths = [F_A, F_B, D_X, F_C];

describe("toggleSelection — 单点", () => {
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

  it("不修改入参 set（恒新 Set 或原样返回）", () => {
    const base = new Set([F_A]);
    const s = toggleSelection(base, F_B);
    expect(s).not.toBe(base);
    expect(base.has(F_B)).toBe(false);
    expect(base.size).toBe(1);
  });
});

describe("toggleSelection — shift 区间（任务书必测 ①）", () => {
  it("anchor 到目标点闭区间并入（含两端、按 paths 顺序；区间内目录被跳过）", () => {
    // 先点 a.txt 设锚点，再 shift+点 c.png → a..c 闭区间（index 0..3）
    const anchored = toggleSelection(new Set(), F_A);
    const ranged = toggleSelection(anchored, F_C, {
      shiftKey: true,
      anchor: F_A,
      paths,
    });
    expect(ranged.has(F_A)).toBe(true);
    expect(ranged.has(F_B)).toBe(true);
    expect(ranged.has(F_C)).toBe(true);
    expect(ranged.has(D_X)).toBe(false); // 区间内的目录行被跳过
    expect(ranged.size).toBe(3);
  });

  it("区间 = additive：区间外已选项保留", () => {
    // 先选中 c.png，再 shift 从 a.txt 选到 b.log（区间 [a,b]）→ c.png 保留
    const pre = new Set([F_C]);
    const ranged = toggleSelection(pre, F_B, {
      shiftKey: true,
      anchor: F_A,
      paths: [F_A, F_B, F_C],
    });
    expect(ranged.has(F_A)).toBe(true);
    expect(ranged.has(F_B)).toBe(true);
    expect(ranged.has(F_C)).toBe(true); // 区间外保留
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
    const anchored = toggleSelection(new Set(), F_C);
    const ranged = toggleSelection(anchored, F_A, {
      shiftKey: true,
      anchor: F_C,
      paths: [F_A, F_B, F_C],
    });
    expect(ranged.has(F_A)).toBe(true);
    expect(ranged.has(F_B)).toBe(true);
    expect(ranged.has(F_C)).toBe(true);
  });
});

describe("toggleSelection — 目录不可选（任务书必测 ②）", () => {
  it("尾斜杠路径 → 原样返回，不被选中", () => {
    const s = toggleSelection(new Set(), D_X);
    expect(s.size).toBe(0);
    expect(s.has(D_X)).toBe(false);
  });

  it("isDir 显式标记（老形态无尾斜杠）→ 不被选中", () => {
    const s = toggleSelection(new Set(), "legacydir", { isDir: true });
    expect(s.size).toBe(0);
    expect(s.has("legacydir")).toBe(false);
  });

  it("目录不可选不影响同集合内已选文件", () => {
    const base = new Set([F_A]);
    const s = toggleSelection(base, D_X);
    expect(s).toBe(base); // 原样返回
    expect(s.has(F_A)).toBe(true);
  });
});

describe("selectAll / clearSelection / selectAllState", () => {
  it("selectAll 过滤目录（尾斜杠）", () => {
    const s = selectAll(paths);
    expect(s.has(F_A)).toBe(true);
    expect(s.has(F_B)).toBe(true);
    expect(s.has(F_C)).toBe(true);
    expect(s.has(D_X)).toBe(false);
  });

  it("clearSelection → 空集", () => {
    expect(clearSelection().size).toBe(0);
  });

  it("三态 none / some / all", () => {
    expect(selectAllState(new Set(), paths)).toBe("none");
    expect(selectAllState(new Set([F_A]), paths)).toBe("some");
    expect(selectAllState(selectAll(paths), paths)).toBe("all");
  });

  it("无可选文件（全目录）→ none", () => {
    expect(selectAllState(new Set([D_X]), [D_X])).toBe("none");
  });
});

describe("pruneSelection — 刷新剔除（任务书必测 ③）", () => {
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

describe("selectedSummary — 汇总数量/字节（任务书必测 ④）", () => {
  const entries = [
    { path: F_A, size: 100 },
    { path: F_B, size: 2048 },
    { path: D_X, size: undefined },
    { path: F_C, size: 5000 },
  ];

  it("数量 = entries ∩ set；字节求和", () => {
    const sum = selectedSummary(entries, new Set([F_A, F_C]));
    expect(sum.count).toBe(2);
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
