// 16.137：工作区访问路径树选择（WorkspacePathPicker + 纯函数）+ 配额弹窗
// 复用对齐（共享 files/QuotaEditDialog）。
// 16.138：树行骨架抽共享（manage/files/TreeRowShell）——文件管理树与路径
// 选择器同一份缩进 / caret / 44px / aria / 键盘；picker 可见行与键盘导航
// 复用 treeModel（flattenLazyTree / treeKeyNav / isTreeNavKey）。
//
// 纯逻辑单测（vitest，node 环境）：
// - workspacePathPicker：路径生成（含/不含子目录、根）、保留名过滤、多选、
//   去重、16 条上限、懒加载状态与 403/404 降级、可见行拍平；
// - treeModel：通用拍平（flattenLazyTree）与键盘导航（treeKeyNav）复用；
// - quotaEdit：MB/GB 十进制换算、留空/0、文件数、payload 双维；
// - hfError：403 →「无权限」（共享弹窗 403 文案单一来源）。
// 接线断言（组件依赖 window.QwenPaw host，node 不渲染）：文件管理 / 人员
// 管理 import 同一 QuotaEditDialog、FileOpsDialogs 只 re-export、
// PeopleSection 内联配额 Modal 已删除、PathChips 出「浏览…」、两处树行
// 都渲染 TreeRowShell。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PICKER_MAX_PATHS,
  applyDirLoaded,
  applyDirUnavailable,
  beginDirLoad,
  childDirRels,
  isPickerUnavailable,
  loadDirState,
  mergeRulePaths,
  pickerTreeRows,
  remainingSlots,
  rulePathFor,
  selectionToRulePaths,
  toggleSelected,
  type DirLoadMap,
} from "../src/components/workspacePathPicker";
import type { HumanFileEntry } from "../src/api/domains/humanFiles";
import { HumanFilesError } from "../src/api/domains/humanFiles";
import { hfErrorText } from "../src/manage/files/hfError";
import {
  quotaExactText,
  quotaFormToPayload,
  quotaFormValid,
  quotaToForm,
  type QuotaView,
} from "../src/manage/files/quotaEdit";
import {
  flattenLazyTree,
  isTreeNavKey,
  treeIndent,
  treeKeyNav,
  type TreeNavRow,
} from "../src/manage/files/treeModel";

const SRC = join(process.cwd(), "src");
const readSrc = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("workspacePathPicker — 路径生成", () => {
  it("含子目录 → files/<rel>/**；仅本目录 → files/<rel>；无尾斜杠", () => {
    expect(rulePathFor("", true)).toBe("files/**");
    expect(rulePathFor("", false)).toBe("files/**");
    expect(rulePathFor("docs", true)).toBe("files/docs/**");
    expect(rulePathFor("docs", false)).toBe("files/docs");
    expect(rulePathFor("a/b", true)).toBe("files/a/b/**");
    expect(rulePathFor("/docs/", false)).toBe("files/docs");
  });

  it("段编码原样（空格 / 中文 / 点号不转义）", () => {
    expect(rulePathFor("报 告/2026.11", true)).toBe("files/报 告/2026.11/**");
  });

  it("多选 → 候选路径保序（去重交给 mergeRulePaths）", () => {
    expect(selectionToRulePaths(["", "docs", "docs"], true)).toEqual([
      "files/**",
      "files/docs/**",
      "files/docs/**",
    ]);
    expect(toggleSelected(["docs"], "docs")).toEqual([]);
    expect(toggleSelected([], "docs")).toEqual(["docs"]);
  });
});

describe("workspacePathPicker — 目录条目解析与保留名", () => {
  const oldForm: HumanFileEntry[] = [
    { name: "docs", type: "directory" },
    { name: "a.txt", type: "file", size: 3 },
    { name: ".trash", type: "directory" },
    { name: ".sync", type: "directory" },
    { name: ".control", type: "directory" },
  ];

  it("老形态（name/type）：只取目录；顶层保留名不展示", () => {
    expect(childDirRels(oldForm, "")).toEqual(["docs"]);
  });

  it("新形态（path 尾 /）：按前缀取一层；非顶层 .trash 段合法", () => {
    const newForm: HumanFileEntry[] = [
      { path: "files/docs/" },
      { path: "files/docs/sub/" },
      { path: "files/docs/sub/x.txt" },
      { path: "files/.trash/" },
      { path: "files/reports/" },
      { path: "files/reports/.trash/" },
    ];
    expect(childDirRels(newForm, "")).toEqual(["docs", "reports"]);
    expect(childDirRels(newForm, "docs")).toEqual(["docs/sub"]);
    expect(childDirRels(newForm, "docs/sub")).toEqual([]);
    // 非顶层 .trash 段与 validateAccessPath 一致：合法、可浏览
    expect(childDirRels(newForm, "reports")).toEqual(["reports/.trash"]);
  });

  it("排序稳定 + 去重", () => {
    expect(
      childDirRels(
        [
          { name: "b", type: "directory" },
          { name: "a", type: "directory" },
          { name: "b", type: "directory" },
        ],
        "",
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("workspacePathPicker — 去重 / 上限 / 剩余", () => {
  it("去重 + 保序：已有 chips 不重复", () => {
    expect(
      mergeRulePaths(["files/docs/**"], ["files/docs/**", "files/a/b"]),
    ).toEqual({
      paths: ["files/docs/**", "files/a/b"],
      added: ["files/a/b"],
      capped: false,
    });
  });

  it("上限 16：超出的候选被截断并标 capped", () => {
    const existing = Array.from({ length: 15 }, (_, i) => `files/p${i}`);
    const r = mergeRulePaths(existing, ["files/x", "files/y", "files/z"]);
    expect(r.paths).toHaveLength(PICKER_MAX_PATHS);
    expect(r.added).toEqual(["files/x"]);
    expect(r.capped).toBe(true);
    expect(remainingSlots(16)).toBe(0);
    expect(remainingSlots(3)).toBe(13);
  });
});

describe("workspacePathPicker — 懒加载 / 403 降级（纯状态转移）", () => {
  it("只在请求的目录上拉取：根 → 展开 docs 才拉 docs（子目录未展开不拉）", async () => {
    const calls: string[] = [];
    const tree: Record<string, HumanFileEntry[]> = {
      "": [
        { name: "docs", type: "directory" },
        { name: "notes", type: "directory" },
      ],
      docs: [{ name: "sub", type: "directory" }],
    };
    const loader = async (rel: string): Promise<HumanFileEntry[]> => {
      calls.push(rel);
      return tree[rel] ?? [];
    };

    let state: DirLoadMap = {};
    state = beginDirLoad(state, "");
    expect(state[""].status).toBe("loading");
    const root = await loadDirState("", loader);
    expect(root).toEqual({ status: "loaded", dirs: ["docs", "notes"] });
    state = applyDirLoaded(state, "", root.status === "loaded" ? root.dirs : []);
    expect(calls).toEqual([""]);

    const docs = await loadDirState("docs", loader);
    expect(docs).toEqual({ status: "loaded", dirs: ["docs/sub"] });
    state = applyDirLoaded(state, "docs", docs.status === "loaded" ? docs.dirs : []);
    expect(calls).toEqual(["", "docs"]);
    // notes 未展开 → 从未拉取（懒加载）
    expect(state["notes"]).toBeUndefined();
  });

  it("403/404 → unavailable + blocked（picker 降级手动输入，不报错）", async () => {
    const r = await loadDirState("", async () => {
      throw new HumanFilesError(403, "forbidden");
    });
    expect(r).toEqual({ status: "unavailable", blocked: true });
    expect(isPickerUnavailable(new HumanFilesError(404, "nope"))).toBe(true);
    const net = await loadDirState("", async () => {
      throw new Error("network");
    });
    expect(net).toEqual({ status: "unavailable", blocked: false });
    const map = applyDirUnavailable({}, "", true);
    expect(map[""]).toEqual({ status: "unavailable", blocked: true });
  });
});

describe("picker 可见行 — 复用 treeModel.flattenLazyTree（16.138）", () => {
  it("根恒在首行；根未展开只出根行，展开出直接子目录", () => {
    const dirs: DirLoadMap = { "": { status: "loaded", dirs: ["docs", "notes"] } };
    expect(pickerTreeRows(dirs, []).map((r) => r.path)).toEqual([""]);
    expect(pickerTreeRows(dirs, [""]).map((r) => r.path)).toEqual(["", "docs", "notes"]);
  });

  it("展开已加载目录 → 子行跟随父行、depth +1；未加载/不可访问不出子行", () => {
    const dirs: DirLoadMap = {
      "": { status: "loaded", dirs: ["docs", "locked"] },
      docs: { status: "loaded", dirs: ["docs/sub"] },
      locked: { status: "unavailable", blocked: true },
    };
    const rows = pickerTreeRows(dirs, ["", "docs", "locked"]);
    expect(rows.map((r) => [r.path, r.depth])).toEqual([
      ["", 0],
      ["docs", 1],
      ["docs/sub", 2],
      ["locked", 1],
    ]);
    expect(rows[1].expanded).toBe(true);
    expect(rows[1].isDir).toBe(true);
  });

  it("加载中（loading）不产生子行；行数变化后 index 由调用方夹住", () => {
    const dirs: DirLoadMap = { "": { status: "loading" } };
    const rows = pickerTreeRows(dirs, [""]);
    expect(rows.map((r) => r.path)).toEqual([""]);
    expect(rows[0].expanded).toBe(true);
  });
});

describe("treeModel — 通用拍平 / 键盘导航复用（16.138）", () => {
  it("flattenLazyTree：keyOf / isDir / children 齐活，父在子前", () => {
    type Node = { id: string; dir: boolean };
    const roots: Node[] = [
      { id: "a", dir: false },
      { id: "b", dir: true },
    ];
    const children = new Map<string, Node[]>([["b", [{ id: "b/1", dir: true }]]]);
    const rows = flattenLazyTree<Node>({
      roots,
      keyOf: (n) => n.id,
      isDir: (n) => n.dir,
      children,
      expanded: new Set(["b"]),
    });
    expect(rows.map((r) => [r.path, r.depth, r.expanded])).toEqual([
      ["a", 0, false],
      ["b", 0, true],
      ["b/1", 1, false],
    ]);
  });

  it("treeKeyNav 接受通用行（LazyTreeRow 结构）+ isTreeNavKey 收窄", () => {
    const rows: TreeNavRow[] = [
      { path: "", isDir: true },
      { path: "docs", isDir: true },
      { path: "notes", isDir: true },
    ];
    expect(treeKeyNav({ rows, index: 0 }, "ArrowDown")).toBe(1);
    expect(treeKeyNav({ rows, index: 2 }, "ArrowDown")).toBe(2);
    expect(treeKeyNav({ rows, index: 1 }, "ArrowUp")).toBe(0);
    let toggled = "";
    expect(
      treeKeyNav({ rows, index: 1 }, "ArrowRight", (p) => {
        toggled = p;
      }),
    ).toBe(1);
    expect(toggled).toBe("docs");
    expect(isTreeNavKey("ArrowLeft")).toBe(true);
    expect(isTreeNavKey("Enter")).toBe(true);
    expect(isTreeNavKey(" ")).toBe(false);
    // 缩进唯一口径：0 / 16 / 32（负数按 0）
    expect([treeIndent(0), treeIndent(1), treeIndent(2), treeIndent(-1)]).toEqual([
      0, 16, 32, 0,
    ]);
  });
});

describe("quotaEdit — MB/GB 十进制 / 留空 / 0 / 文件数（共享弹窗语义）", () => {
  it("回显按最大适用单位；留空 = 不限；0 = 零额度", () => {
    expect(quotaToForm(null)).toEqual({ value: null, unit: "MB", files: null });
    expect(quotaToForm({ usedBytes: 0, quotaBytes: 1_500_000_000, quotaFiles: 10 })).toEqual({
      value: 1.5,
      unit: "GB",
      files: 10,
    });
    expect(quotaToForm({ usedBytes: 0, quotaBytes: 0 })).toEqual({
      value: 0,
      unit: "MB",
      files: null,
    });
  });

  it("payload 双维：null = 不限、0 = 零额度、GB 十进制换算", () => {
    expect(quotaFormToPayload({ value: null, unit: "GB", files: null })).toEqual({
      bytes: null,
      files: null,
    });
    expect(quotaFormToPayload({ value: 0, unit: "MB", files: 0 })).toEqual({
      bytes: 0,
      files: 0,
    });
    expect(quotaFormToPayload({ value: 1.5, unit: "GB", files: 12 })).toEqual({
      bytes: 1_500_000_000,
      files: 12,
    });
    expect(quotaExactText(1.5, "GB")).toBe("1.5 GB = 1,500,000,000 bytes");
  });

  it("quotaFormValid：负数 / 非整数文件数非法", () => {
    expect(quotaFormValid({ value: -1, unit: "MB", files: null })).toBe(false);
    expect(quotaFormValid({ value: null, unit: "MB", files: 1.5 })).toBe(false);
  });

  it("QuotaView：与 getQuota 响应同形（usedBytes + quotaBytes + quotaFiles?）", () => {
    // 文件区 / 人员区 getQuota 均返回 QuotaResponse，结构上直接可作 QuotaView。
    const view: QuotaView = { usedBytes: 10, quotaBytes: 100, quotaFiles: 2 };
    expect(quotaToForm(view)).toEqual({ value: 0.0001, unit: "MB", files: 2 });
  });

  it("403 → 共享弹窗文案「无权限」（hfErrorText 单一来源）", () => {
    const tr = (s: string) => s;
    expect(hfErrorText(new HumanFilesError(403, "forbidden"), tr)).toBe("无权限");
    expect(hfErrorText(new HumanFilesError(404, "missing"), tr)).toBe("无权限或不存在");
  });
});

describe("组件渲染 — picker 行 = TreeRowShell / 共享 QuotaEditDialog", () => {
  const E = React.createElement;
  const tr = (s: string, v?: Record<string, string | number>): string => {
    let out = s;
    for (const [k, val] of Object.entries(v ?? {})) out = out.split(`{${k}}`).join(String(val));
    return out;
  };
  const t = {
    mode: "light",
    bg: "#fff",
    cardBg: "#fff",
    text: "#111",
    textSecondary: "#666",
    border: "#ddd",
    bubbleOther: "#f5f5f5",
    bubbleMine: "#eef",
    hoverBg: "#f5f5f5",
    popoverBg: "#fff",
    toolBg: "#f5f5f5",
    accentBg: "#eef",
  };
  type Comp = (p: Record<string, unknown>) => React.ReactElement | null;
  let Picker: Comp;
  let QuotaDialog: Comp;

  beforeAll(async () => {
    // 宿主 shim：组件模块顶层读 window.QwenPaw.host，动态 import 前须就位。
    const antdShim = {
      Button: (p: Record<string, unknown>) =>
        E("button", { type: "button", "data-btn": String(p.type ?? "default") }, p.children),
      Tooltip: (p: Record<string, unknown>) => E("span", null, p.children),
      Modal: Object.assign(
        (p: Record<string, unknown>) =>
          p.open ? E("div", { "data-modal": "1" }, p.title, p.children) : null,
        { confirm: () => undefined },
      ),
      Checkbox: (p: Record<string, unknown>) =>
        E("input", { type: "checkbox", "aria-label": p["aria-label"] }),
      Switch: (p: Record<string, unknown>) =>
        E("input", { type: "checkbox", "data-switch": "1", "aria-label": p["aria-label"] }),
      Alert: (p: Record<string, unknown>) => E("div", null, p.message),
      InputNumber: (p: Record<string, unknown>) =>
        E("input", { "data-input-number": String(p.value ?? ""), "aria-label": p["aria-label"] }),
      Select: (p: Record<string, unknown>) => E("div", { "data-select": String(p.value ?? "") }),
      message: { success: () => undefined, error: () => undefined, warning: () => undefined },
    };
    (globalThis as Record<string, unknown>).window = {
      QwenPaw: {
        host: {
          React,
          antd: antdShim,
          fetch: async () => ({ status: 404, ok: false, text: async () => "" }),
          useLocale: () => "zh",
          useTheme: () => "light",
          getApiUrl: (p: string) => p,
          getApiToken: () => "",
        },
      },
    };
    Picker = (await import("../src/components/WorkspacePathPicker"))
      .default as unknown as Comp;
    QuotaDialog = (await import("../src/manage/files/QuotaEditDialog")).default as unknown as Comp;
  });

  it("picker 根行由 TreeRowShell 出骨架（treeitem / aria-level / 44px / caret）", () => {
    const html = renderToStaticMarkup(
      E(Picker, {
        open: true,
        humanName: "alice",
        existing: [],
        t,
        tr,
        onClose: () => undefined,
        onConfirm: () => undefined,
      }),
    );
    expect(html).toContain('role="tree"');
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('data-dir-rel=""');
    expect(html).toContain("根目录");
    expect(html).toContain("var(--hf-row-min, 44px)");
    // 静态渲染不跑 effect → 只出根行（未展开子目录）。
    expect(html.split('role="treeitem"').length - 1).toBe(1);
  });

  it("共享 QuotaEditDialog：标题 / 十进制说明 / 当前已用 / 清除配额", () => {
    const html = renderToStaticMarkup(
      E(QuotaDialog, {
        open: true,
        humanName: "alice",
        quota: { usedBytes: 1_000_000, quotaBytes: 2_000_000_000, quotaFiles: 5 },
        t,
        tr,
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    );
    expect(html).toContain("编辑配额");
    expect(html).toContain("十进制：1 MB = 1,000,000 bytes");
    expect(html).toContain("当前已用 1 MB");
    expect(html).toContain("清除配额");
    // 2 GB 回显（最大适用单位）+ 文件数 5。
    expect(html).toContain('data-input-number="2"');
    expect(html).toContain("5 个文件");
  });
});

describe("接线 — 共享 QuotaEditDialog / PathPicker", () => {
  const peopleSrc = readSrc(join("manage", "PeopleSection.tsx"));
  const filesSrc = readSrc(join("manage", "FilesSection.tsx"));
  const fileOpsSrc = readSrc(join("manage", "files", "FileOpsDialogs.tsx"));
  const dialogSrc = readSrc(join("manage", "files", "QuotaEditDialog.tsx"));
  const editorSrc = readSrc(join("components", "WorkspaceAccessEditor.tsx"));
  const pickerSrc = readSrc(join("components", "WorkspacePathPicker.tsx"));
  const shellSrc = readSrc(join("manage", "files", "TreeRowShell.tsx"));
  const modelSrc = readSrc(join("manage", "files", "treeModel.ts"));

  it("文件管理 / 人员管理 import 同一组件（同一模块路径）", () => {
    expect(filesSrc).toContain('import QuotaEditDialog from "./files/QuotaEditDialog"');
    expect(peopleSrc).toContain('import QuotaEditDialog from "./files/QuotaEditDialog"');
    expect(filesSrc).toContain("<QuotaEditDialog");
    expect(peopleSrc).toContain("<QuotaEditDialog");
  });

  it("两处配额弹窗接口一致（humanName / quota / onSaved 各自刷新）", () => {
    for (const src of [filesSrc, peopleSrc]) {
      expect(src).toContain("humanName={");
      expect(src).toContain("quota={quota}");
      expect(src).toContain("onSaved={");
    }
    // 保存后各自刷新：文件区 reload、人员区 refreshQuota。
    expect(filesSrc).toContain("onSaved={() => void load(true)}");
    expect(peopleSrc).toContain("onSaved={() => void refreshQuota()}");
  });

  it("PeopleSection 内联配额 Modal 与重复 state/imports 已删除", () => {
    expect(peopleSrc).not.toContain('tr("设置配额")');
    expect(peopleSrc).not.toContain("quotaFormToPayload");
    expect(peopleSrc).not.toContain("quotaInputNumber");
    expect(peopleSrc).not.toContain("quotaForm");
    expect(peopleSrc).toContain("onSaved={() => void refreshQuota()}");
  });

  it("FileOpsDialogs 只 re-export（无第二份实现）；保存/清除/403 全在共享 Dialog", () => {
    expect(fileOpsSrc).toContain('export { QuotaEditDialog } from "./QuotaEditDialog"');
    expect(fileOpsSrc).not.toMatch(/export function QuotaEditDialog/);
    expect(dialogSrc).toContain("quotaFormToPayload(form)");
    expect(dialogSrc).toContain("setQuota(humanName, null)");
    expect(dialogSrc).toContain("hfErrorText(e, tr)");
    expect(dialogSrc).toContain("quotaExactText(value, unit)");
  });

  it("树行骨架：TreeRowShell 独占缩进 / caret / 44px / treeitem / 键盘分发", () => {
    expect(shellSrc).toContain("treeIndent(depth)");
    expect(shellSrc).toContain('role = "treeitem"');
    expect(shellSrc).toContain("var(--hf-row-min, 44px)");
    expect(shellSrc).toContain("aria-expanded={hasChildren ? expanded : undefined}");
    expect(shellSrc).toContain("aria-busy={loading ? true : undefined}");
    expect(shellSrc).toContain("aria-selected={selected === undefined ? undefined : selected}");
    expect(shellSrc).toContain('if (e.key === " " || e.key === "Enter")');
    // 缩进口径只有 treeModel 一处（depth * 16）；骨架不另写。
    expect(modelSrc).toContain("return depth < 0 ? 0 : depth * 16;");
    expect(shellSrc).not.toContain("depth * 16");
  });

  it("文件管理树行 / 路径选择器都渲染 TreeRowShell（无第二份自写行）", () => {
    expect(filesSrc).toContain('import TreeRowShell from "./files/TreeRowShell"');
    expect(filesSrc).toContain("<TreeRowShell");
    // 文件树不再自带缩进计算（缩进只在 TreeRowShell / treeModel）。
    expect(filesSrc).not.toContain("treeIndent(");
    expect(pickerSrc).toContain('import TreeRowShell from "../manage/files/TreeRowShell"');
    expect(pickerSrc).toContain("<TreeRowShell");
    expect(pickerSrc).not.toContain("function DirRow");
    expect(pickerSrc).not.toContain("depth * 16");
    // picker 的可见行与键盘导航复用 treeModel。
    expect(pickerSrc).toContain("pickerTreeRows(dirs, expanded)");
    expect(pickerSrc).toContain("treeKeyNav({ rows, index: i }, e.key");
    expect(readSrc(join("components", "workspacePathPicker.ts"))).toContain(
      "flattenLazyTree<string>({",
    );
  });

  it("hfErrorText 单一来源：FilesSection re-export、实现只在 files/hfError.ts", () => {
    expect(filesSrc).toContain("export { hfErrorText };");
    expect(filesSrc).not.toMatch(/export function hfErrorText/);
    expect(readSrc(join("manage", "files", "hfError.ts"))).toContain("case 403:");
  });

  it("PathChips：「浏览…」按钮（44px）+ humanName 线程 + picker 对话框 640", () => {
    expect(editorSrc).toContain('tr("浏览…")');
    expect(editorSrc).toContain("minHeight: 44");
    expect(editorSrc).toContain("<WorkspacePathPicker");
    expect(editorSrc).toContain("humanName?: string");
    expect(editorSrc).toContain("mergeRulePaths(paths, candidates)");
    expect(peopleSrc).toContain("humanName={human.name}");
    expect(pickerSrc).toContain("width={640}");
    expect(shellSrc).toContain('role = "treeitem"');
    expect(pickerSrc).toContain('tr("包含子目录（**）")');
    expect(pickerSrc).toContain("listFiles(humanName, d)");
    expect(pickerSrc).toContain('tr("无法浏览目录——请手动输入路径")');
  });
});
