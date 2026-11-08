// files-ux-r2：文件管理页「右侧详情栏是本质问题」+ 按需多选 + 空白清焦点。
//
// 契约（任务书 A–D）：
// ① listGrid / treeGrid 轨道数 = 实际子项数（显式列，禁止隐式 auto 轨）；
// ② columnsFor 三档（≥900 全列 / 700–899 收类型·修改 / <700 只留名称 +
//    「更多」），多选开插入 44px 选择轨；
// ③ 任何档位的轨道总宽 ≤ 实测列表现宽（不溢出 → 不会画进详情栏）；
// ④ 默认 multiSelect=false：不渲染选择列 / 复选框；
// ⑤ 行点击意图：无修饰只焦点（不写选择）、Ctrl/Shift 自动进入多选、
//    多选模式普通点击 = 切换、Shift = 区间；
// ⑥ 空白点击判定（行 / 按钮 / 复选框 / 菜单项内不算空白）；
// ⑦ 断点门槛：1319→drawer / 1320→split / 767→sheet；
// ⑧ split 下实测列表宽 <700 → 自动降级 drawer（纯函数）；
// ⑨ 回归：目录双击进入、行操作 stopPropagation；
// ⑩ 详情栏独立层（不透明底 / 裁切 / 层叠）与窄屏适配（源码接线）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { clickSelection } from "../src/lib/filesSelection";

// 宿主 shim：FilesSection 的模块顶层读 window.QwenPaw.host（React / antd），
// 必须在 import 之前就位（宿主 usePoller 渲染期读 document.hidden）。
const E = React.createElement;
const antdShim = {
  Button: (p: Record<string, unknown>) =>
    E("button", { type: "button", "data-type": String(p.type ?? "default") }, p.children),
  Progress: (p: Record<string, unknown>) => E("span", { "data-progress": String(p.percent ?? 0) }),
  Alert: (p: Record<string, unknown>) => E("div", { "data-alert": String(p.type ?? "info") }, p.message),
  Switch: (p: Record<string, unknown>) =>
    E("input", { type: "checkbox", "data-switch": "1", checked: p.checked ? "true" : undefined }),
  Tooltip: (p: Record<string, unknown>) => E("span", null, p.children),
  Input: (p: Record<string, unknown>) => E("input", { "data-input": "1", value: p.value ?? "" }),
  Select: (p: Record<string, unknown>) => E("div", { "data-select": String(p.value ?? "") }),
  Modal: Object.assign(
    (p: Record<string, unknown>) => (p.open ? E("div", { "data-modal": "1" }, p.title, p.children) : null),
    { confirm: () => undefined },
  ),
  Drawer: (p: Record<string, unknown>) =>
    p.open ? E("div", { "data-drawer": String(p.placement ?? "right") }, p.title, p.children) : null,
  message: { success: () => undefined, error: () => undefined, warning: () => undefined },
};
(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      React,
      antd: antdShim,
      antdIcons: {},
      useLocale: () => "zh",
      useTheme: () => "light",
    },
  },
};
(globalThis as Record<string, unknown>).document = { hidden: false };

type Mod = {
  default: (props: Record<string, unknown>) => React.ReactElement;
  listGrid: (c: readonly string[]) => string;
  treeGrid: (c: readonly string[]) => string;
  columnsFor: (
    listWidth: number,
    multiSelect: boolean,
  ) => {
    columns: string[];
    grid: string;
    total: number;
    compactActions: boolean;
    showUpdatedAt: boolean;
    showSize: boolean;
    showMultiSelect: boolean;
  };
  columnsTotal: (c: readonly string[]) => number;
  layoutMode: (w: number) => "split" | "drawer" | "sheet";
  effectiveLayoutMode: (o: {
    containerWidth: number;
    listWidth: number;
    listMeasured: boolean;
  }) => "split" | "drawer" | "sheet";
  estimatedListWidth: (containerWidth: number, mode: "split" | "drawer" | "sheet") => number;
  rowClickIntent: (o: { multiSelect: boolean; shiftKey: boolean; toggleKey: boolean }) => {
    focusOnly: boolean;
    enterMulti: boolean;
    toggle: boolean;
    range: boolean;
  };
  isBlankClickTarget: (t: EventTarget | null) => boolean;
  SPLIT_MIN_WIDTH: number;
  DETAIL_COL_WIDTH: number;
  LIST_MIN_SPLIT_WIDTH: number;
  SPLIT_GAP: number;
  LIST_GAP: number;
  COLUMN_TRACK_PX: Record<string, number>;
};

const mod = (await import("../src/manage/FilesSection")) as unknown as Mod;
const src = readFileSync(join(process.cwd(), "src", "manage", "FilesSection.tsx"), "utf8");

/** grid-template-columns → 轨道数组（伸缩轨含逗号空格，先归一）。 */
const tracks = (grid: string): string[] =>
  grid.replace(/minmax\(0,\s*1fr\)/g, "1fr").split(" ").filter((s) => s !== "");

const ALL: string[] = ["name", "size", "type", "modified", "actions"];
const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];

describe("① 列模板轨道数 = 子项数（显式列）", () => {
  it("listGrid 轨道数 = 列数（不含 / 含选择列）", () => {
    expect(tracks(mod.listGrid(ALL)).length).toBe(5);
    expect(tracks(mod.listGrid(["select", ...ALL])).length).toBe(6);
    expect(tracks(mod.listGrid(["name", "more"])).length).toBe(2);
  });

  it("columnsFor 的 columns 长度 = grid 轨道数（表头 / 行同一来源）", () => {
    for (const w of [500, 680, 760, 900, 950, 1320]) {
      for (const m of [false, true]) {
        const c = mod.columnsFor(w, m);
        expect(tracks(c.grid).length).toBe(c.columns.length);
      }
    }
  });

  it("treeGrid 只多一条 16px 展开三角轨（选择轨之后）", () => {
    expect(tracks(mod.treeGrid(ALL))).toEqual(["16px", "1fr", "72px", "84px", "120px", "152px"]);
    expect(tracks(mod.treeGrid(["select", "name", "actions"]))).toEqual([
      "44px",
      "16px",
      "1fr",
      "152px",
    ]);
  });
});

describe("② columnsFor 三档 + 多选轨", () => {
  it("≥900 且多选关：名称 + 大小 + 类型 + 修改 + 操作", () => {
    expect(mod.columnsFor(950, false).columns).toEqual(ALL);
  });

  it("700–899：名称 + 大小 + 操作（隐藏类型 / 修改）", () => {
    const c = mod.columnsFor(760, false);
    expect(c.columns).toEqual(["name", "size", "actions"]);
    expect(c.columns).not.toContain("type");
    expect(c.columns).not.toContain("modified");
    expect(c.showUpdatedAt).toBe(false);
  });

  it("<700：名称 + 操作收成单个「更多」44px 菜单", () => {
    const c = mod.columnsFor(680, false);
    expect(c.columns).toEqual(["name", "more"]);
    expect(c.compactActions).toBe(true);
    expect(c.grid).toContain("44px");
  });

  it("多选开：首位插入 44px 选择轨（各档一致）", () => {
    for (const w of [680, 760, 950]) {
      const c = mod.columnsFor(w, true);
      expect(c.columns[0]).toBe("select");
      expect(c.showMultiSelect).toBe(true);
      expect(tracks(c.grid)[0]).toBe("44px");
    }
  });
});

describe("③ 任何档位轨道总宽 ≤ 列表现宽", () => {
  it("columnsFor(width).total ≤ width（含多选）", () => {
    for (const w of [380, 420, 500, 660, 699, 700, 760, 899, 900, 950, 1000, 1320, 1600]) {
      for (const m of [false, true]) {
        const c = mod.columnsFor(w, m);
        expect(c.total).toBeLessThanOrEqual(w);
      }
    }
  });

  it("columnsTotal = 定宽轨之和 + gap（伸缩轨按最小可用宽）", () => {
    expect(mod.columnsTotal(ALL)).toBe(120 + 72 + 84 + 120 + 152 + 4 * mod.LIST_GAP);
  });
});

describe("④ 默认不多选（复选框按需渲染）", () => {
  const nav = { selectedFile: null, selectFile: () => undefined };
  const data = {
    teams: [],
    admin: { humans: [{ name: "luo", matrixUserID: "@luo:local" }] },
    myUserId: "@luo:local",
    hasToken: true,
  };

  it("columnsFor(·, false) 无选择列（默认不显示复选框）", () => {
    expect(mod.columnsFor(950, false).showMultiSelect).toBe(false);
    expect(mod.columnsFor(950, false).columns).not.toContain("select");
  });

  it("工具栏「多选」按钮存在且默认 aria-pressed=false", () => {
    const html = renderToStaticMarkup(
      E(mod.default as never, { nav, cols: 2, data, variant: "mid" }),
    );
    expect(html).toContain('aria-label="多选"');
    expect(html).toContain('aria-pressed="false"');
    // 空列表（静态渲染不跑 effect）→ 无角色复选框。
    expect(html.includes('role="checkbox"')).toBe(false);
  });

  it("三视图复选框全部由 multiSelect / showMultiSelect 门控（源码接线）", () => {
    // 列表 / 树：showMultiSelect 门控选择轨；网格：fs.multiSelect 门控角标。
    expect(src).toContain("{cols.showMultiSelect ?");
    expect(src).toContain("{fs.multiSelect ?");
    // 列表表头的选择列来自 columnsFor 的 "select" 轨（不是无条件首列）。
    expect(src).toContain('if (c === "select") {');
    expect(src).toContain("cols.columns.map(");
  });
});

describe("⑤ 行点击意图（焦点与批量选择分离）", () => {
  it("未进多选 + 无修饰 → 只设焦点（不写 selected）", () => {
    const intent = mod.rowClickIntent({ multiSelect: false, shiftKey: false, toggleKey: false });
    expect(intent).toEqual({ focusOnly: true, enterMulti: false, toggle: false, range: false });
  });

  it("Ctrl/Cmd → 自动进入多选 + 选中该行", () => {
    const intent = mod.rowClickIntent({ multiSelect: false, shiftKey: false, toggleKey: true });
    expect(intent.enterMulti).toBe(true);
    expect(intent.focusOnly).toBe(false);
    expect(intent.toggle).toBe(true);
    const r = clickSelection(new Set<string>(), "b.txt", {
      toggleKey: intent.toggle,
      anchor: null,
      paths,
    });
    expect(r.selected.has("b.txt")).toBe(true);
    expect(r.anchor).toBe("b.txt");
  });

  it("Shift → 自动进入多选 + 区间（无锚点由调用方用当前焦点）", () => {
    const intent = mod.rowClickIntent({ multiSelect: false, shiftKey: true, toggleKey: false });
    expect(intent.enterMulti).toBe(true);
    expect(intent.range).toBe(true);
    expect(intent.toggle).toBe(false);
    const r = clickSelection(new Set<string>(), "d.txt", {
      shiftKey: intent.range,
      anchor: "b.txt",
      paths,
    });
    expect([...r.selected].sort()).toEqual(["b.txt", "c.txt", "d.txt"]);
  });

  it("多选模式：普通点击 = 切换；Shift = 区间", () => {
    const plain = mod.rowClickIntent({ multiSelect: true, shiftKey: false, toggleKey: false });
    expect(plain.toggle).toBe(true);
    expect(plain.range).toBe(false);
    expect(plain.enterMulti).toBe(false);
    const shift = mod.rowClickIntent({ multiSelect: true, shiftKey: true, toggleKey: false });
    expect(shift.toggle).toBe(false);
    expect(shift.range).toBe(true);
    // 切换语义：已选中再点 → 取消
    const on = clickSelection(new Set<string>(), "a.txt", { toggleKey: true, paths });
    const off = clickSelection(on.selected, "a.txt", { toggleKey: true, paths });
    expect(off.selected.has("a.txt")).toBe(false);
  });

  it("Esc / 批量条「取消选择」清选择 + 退出多选（源码接线）", () => {
    expect(src).toContain("onClearSelection");
    expect(src).toContain("setMultiSelect(false)");
    expect(src).toContain('e.key !== "Escape"');
  });
});

describe("⑥ 空白点击清焦点", () => {
  it("行 / 按钮 / 复选框 / 菜单项内 → 不算空白", () => {
    const hit = { closest: () => ({}) } as unknown as EventTarget;
    expect(mod.isBlankClickTarget(hit)).toBe(false);
  });

  it("容器背景（closest 命中不到交互元素）→ 空白", () => {
    const blank = { closest: () => null } as unknown as EventTarget;
    expect(mod.isBlankClickTarget(blank)).toBe(true);
    expect(mod.isBlankClickTarget(null)).toBe(false);
  });

  it("行挂 data-hf-row + 列表列绑定空白点击处理（源码接线）", () => {
    expect(src).toContain('data-hf-row="1"');
    expect(src).toContain("onClick={onListBlankClick}");
    expect(src).toContain("nav.selectFile(null)");
    expect(src).toContain("setFocusedDirHint(false)");
  });
});

describe("⑦ 断点门槛（1319/1320/767）", () => {
  it("1320 起 split，1319 及以下 drawer，<768 sheet", () => {
    expect(mod.SPLIT_MIN_WIDTH).toBe(1320);
    expect(mod.layoutMode(1320)).toBe("split");
    expect(mod.layoutMode(1319)).toBe("drawer");
    expect(mod.layoutMode(768)).toBe("drawer");
    expect(mod.layoutMode(767)).toBe("sheet");
  });

  it("详情栏 380 + 列表最小 700（split 只需容纳二者）", () => {
    expect(mod.DETAIL_COL_WIDTH).toBe(380);
    expect(mod.LIST_MIN_SPLIT_WIDTH).toBe(700);
    expect(mod.estimatedListWidth(1320, "split")).toBe(1320 - 380 - mod.SPLIT_GAP);
    expect(mod.estimatedListWidth(1000, "drawer")).toBe(1000);
  });
});

describe("⑧ split 下列表过窄 → 自动降级 drawer", () => {
  it("实测列表宽 <700 → drawer（不硬挤可溢出的列表）", () => {
    expect(
      mod.effectiveLayoutMode({ containerWidth: 1320, listWidth: 650, listMeasured: true }),
    ).toBe("drawer");
    expect(
      mod.effectiveLayoutMode({ containerWidth: 1320, listWidth: 700, listMeasured: true }),
    ).toBe("split");
  });

  it("未测量 → 按容器宽预估（首帧不抖）", () => {
    expect(
      mod.effectiveLayoutMode({ containerWidth: 1320, listWidth: 0, listMeasured: false }),
    ).toBe("split");
    expect(
      mod.effectiveLayoutMode({ containerWidth: 1200, listWidth: 0, listMeasured: false }),
    ).toBe("drawer");
  });

  it("非 split 基础档不受列表宽影响", () => {
    expect(
      mod.effectiveLayoutMode({ containerWidth: 900, listWidth: 200, listMeasured: true }),
    ).toBe("drawer");
    expect(
      mod.effectiveLayoutMode({ containerWidth: 700, listWidth: 100, listMeasured: true }),
    ).toBe("sheet");
  });
});

describe("⑨ 回归：目录双击进入 / 行操作不冒泡", () => {
  it("列表行双击目录进入（递归平铺下不可交互）", () => {
    expect(src).toMatch(/onDoubleClick=\{\(\) => \{\s*if \(isDir && dirInteractive\) fs\.onEnterDir\(path\);/);
  });

  it("行操作按钮 / 菜单项 stopPropagation（不触发行选中 / 进入）", () => {
    const actions = src.slice(
      src.indexOf("function RowMoreMenu"),
      src.indexOf("function viewSegBtnStyle"),
    );
    expect(actions.match(/e\.stopPropagation\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(actions).toContain('role="menuitem"');
    expect(actions).toContain('aria-haspopup="menu"');
  });
});

describe("⑩ 详情栏独立层 + 窄屏适配（源码接线）", () => {
  it("split 详情栏：380 定宽 + 不透明底 + sticky + 独立层叠 + 纵向滚动", () => {
    const pane = src.slice(src.indexOf("<aside"), src.indexOf("<DetailPane {...sub} />"));
    expect(pane).toContain("width: DETAIL_COL_WIDTH");
    expect(pane).toContain("flexShrink: 0");
    expect(pane).toContain("background: t.bg");
    expect(pane).toContain("borderLeft");
    expect(pane).toContain('position: "sticky"');
    expect(pane).toContain("isolation: \"isolate\"");
    expect(pane).toContain("zIndex: 2");
    expect(pane).toContain("overflowY: \"auto\"");
  });

  it("列表列：minWidth 0 + 裁切 + 自己的 ResizeObserver + 低层", () => {
    const list = src.slice(src.indexOf("ref={setListCol}"), src.indexOf("{dropNode}"));
    expect(list).toContain("minWidth: 0");
    expect(list).toContain('overflow: "hidden"');
    expect(list).toContain("zIndex: 0");
    expect(src).toContain("new ResizeObserver(");
    expect(src).toContain("ref={setListCol}");
    // 有意不用 contain:paint：它会让列表列成为 fixed 后代的 containing block，
    // 把行内「更多」菜单一起裁掉（overflow:hidden 不裁 fixed 后代）。
    const listBox = src.slice(src.indexOf("ref={setListCol}"), src.indexOf("{dropNode}"));
    expect(listBox.includes('contain: "paint"')).toBe(false);
    const menu = src.slice(src.indexOf("function RowMoreMenu"), src.indexOf("function RowActions"));
    expect(menu).toContain('position: "fixed"');
    expect(menu).toContain("root.contains(e.target)");
  });

  it("窄屏：工具条图标按钮 ≥44 + 图标 / 面包屑横滚 / 批量条贴底", () => {
    // 工具条按钮走 ToolBarButton（≥44 触控盒 + aria-label/title）。
    expect(src).toContain('minHeight: "var(--hf-row-min, 44px)"');
    expect(src).toContain("aria-label={label}");
    // 面包屑单行横滚。
    expect(src).toContain('overflowX: "auto"');
    // 批量条窄屏 sticky 贴底。
    expect(src).toContain("position: \"sticky\" as const");
    // 隐藏列时名称第二行补「大小 · 修改时间」。
    expect(src).toContain("nameSecondary");
  });
});
