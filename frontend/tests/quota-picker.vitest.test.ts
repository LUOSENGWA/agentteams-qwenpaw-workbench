// 16.137：工作区访问路径树选择（WorkspacePathPicker + 纯函数）+ 配额弹窗
// 复用对齐（共享 files/QuotaEditDialog）。
//
// 纯逻辑单测（vitest，node 环境）：
// - workspacePathPicker：路径生成（含/不含子目录、根）、保留名过滤、多选、
//   去重、16 条上限、懒加载状态与 403/404 降级；
// - quotaEdit：MB/GB 十进制换算、留空/0、文件数、payload 双维；
// - hfError：403 →「无权限」（共享弹窗 403 文案单一来源）。
// 接线断言（组件依赖 window.QwenPaw host，node 不渲染）：文件管理 / 人员
// 管理 import 同一 QuotaEditDialog、FileOpsDialogs 只 re-export、
// PeopleSection 内联配额 Modal 已删除、PathChips 出「浏览…」。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PICKER_MAX_PATHS,
  applyDirLoaded,
  applyDirUnavailable,
  beginDirLoad,
  childDirRels,
  isPickerUnavailable,
  loadDirState,
  mergeRulePaths,
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

describe("接线 — 共享 QuotaEditDialog / PathPicker", () => {
  const peopleSrc = readSrc(join("manage", "PeopleSection.tsx"));
  const filesSrc = readSrc(join("manage", "FilesSection.tsx"));
  const fileOpsSrc = readSrc(join("manage", "files", "FileOpsDialogs.tsx"));
  const dialogSrc = readSrc(join("manage", "files", "QuotaEditDialog.tsx"));
  const editorSrc = readSrc(join("components", "WorkspaceAccessEditor.tsx"));
  const pickerSrc = readSrc(join("components", "WorkspacePathPicker.tsx"));

  it("文件管理 / 人员管理 import 同一组件（同一模块路径）", () => {
    expect(filesSrc).toContain('import QuotaEditDialog from "./files/QuotaEditDialog"');
    expect(peopleSrc).toContain('import QuotaEditDialog from "./files/QuotaEditDialog"');
    expect(filesSrc).toContain("<QuotaEditDialog");
    expect(peopleSrc).toContain("<QuotaEditDialog");
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
    expect(pickerSrc).toContain('role="treeitem"');
    expect(pickerSrc).toContain('tr("包含子目录（**）")');
    expect(pickerSrc).toContain("listFiles(humanName, d)");
    expect(pickerSrc).toContain('tr("无法浏览目录——请手动输入路径")');
  });
});
