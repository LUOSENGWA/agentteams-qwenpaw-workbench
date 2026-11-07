// files-dnd：拖拽上传收集（含目录递归 / 限额）、上传队列相对路径、
// 详情抽屉字段渲染、回收站搜索/排序纯函数。
//
// 契约：
// ① snapshotDrop 同步拍快照（文件 + webkitGetAsEntry 条目）；
// ② collectDrop 目录递归 relPath = "dir/sub/file"；超 200 文件 / 200 MB 截断；
// ③ uniqueParentDirs 浅层在前（"a/b/c.txt" → ["a", "a/b"]）；
// ④ makeUploadItems 带 relPath → path = dir/relPath（name = 末段）；
// ⑤ TrashDialog trashFilter 按原路径 / 操作人（caller）过滤；
// ⑥ trashSortRows 删除时间 / 大小 / 名称，缺失排尾、不可变；
// ⑦ FileDetailDrawer 字段渲染（路径 / 大小 / 类型 / 修改 / ETag 前 12 位；
//    目录 = 子项数 + 同步设置）；不额外发请求（host.fetch 零调用）；
// ⑧ maskEtag / loadedChildCount 纯函数。
import { beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  collectDrop,
  dragHasFiles,
  snapshotDrop,
  uniqueParentDirs,
  type DataTransferLike,
  type DropEntryLike,
} from "../src/manage/files/fileDrop";
import { makeUploadItems } from "../src/manage/files/uploadQueue";

const fetchSpy = vi.fn(async () => ({ status: 200, ok: true, text: async () => "" }));

// 宿主 shim（模块顶层读 window.QwenPaw.host；动态 import 前必须先就位）。
const E = React.createElement;
const antdShim = {
  Button: (p: Record<string, unknown>) =>
    E("button", { type: "button", "data-btn": String(p.type ?? "default") }, p.children),
  Tooltip: (p: Record<string, unknown>) => E("span", null, p.children),
  Drawer: (p: Record<string, unknown>) =>
    p.open
      ? E(
          "div",
          { "data-drawer": String(p.placement ?? "right") },
          E("div", { "data-drawer-title": "1" }, p.title),
          p.children,
        )
      : null,
  Modal: Object.assign(
    (p: Record<string, unknown>) =>
      p.open ? E("div", { "data-modal": "1" }, p.title, p.children) : null,
    { confirm: () => undefined },
  ),
  Checkbox: (p: Record<string, unknown>) => E("label", null, p.children),
  Progress: () => E("span", null),
  Alert: (p: Record<string, unknown>) => E("div", null, p.message),
  Input: (p: Record<string, unknown>) =>
    E("input", { "aria-label": p["aria-label"], placeholder: p.placeholder }),
  Switch: (p: Record<string, unknown>) =>
    E("input", { type: "checkbox", "data-switch": "1", checked: p.checked ? "true" : undefined }),
  Select: (p: Record<string, unknown>) => E("div", { "data-select": String(p.value ?? "") }),
  message: { success: () => undefined, error: () => undefined, warning: () => undefined },
};

(globalThis as Record<string, unknown>).window = {
  QwenPaw: {
    host: {
      React,
      antd: antdShim,
      fetch: fetchSpy,
      useLocale: () => "zh",
      useTheme: () => "light",
      getApiUrl: (p: string) => p,
      getApiToken: () => "",
    },
  },
};
// usePoller 渲染期读 document.hidden（静态渲染不跑 effect，但读发生在 render）。
(globalThis as Record<string, unknown>).document = { hidden: false };

const tr = (s: string, v?: Record<string, string | number>): string => {
  for (const [k, val] of Object.entries(v ?? {})) s = s.split(`{${k}}`).join(String(val));
  return s;
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

type Mod = {
  default: (props: Record<string, unknown>) => React.ReactElement;
  FileDetailDrawer: (props: Record<string, unknown>) => React.ReactElement;
  maskEtag: (etag?: string | null) => string;
  loadedChildCount: (entries: unknown[], dirPath: string) => number;
  trashFilter: (rows: unknown[], q: string) => { id: string }[];
  trashSortRows: (
    rows: unknown[],
    key: "deletedAt" | "size" | "name",
    dir: "desc" | "asc",
  ) => { id: string }[];
  trashRowsSort: (rows: unknown[], dir: "desc" | "asc") => { id: string }[];
};
let mod: Mod;

beforeAll(async () => {
  const filesMod = (await import("../src/manage/FilesSection")) as unknown as Mod;
  const trashMod = (await import("../src/manage/files/TrashDialog")) as unknown as Pick<
    Mod,
    "trashFilter" | "trashSortRows" | "trashRowsSort"
  >;
  mod = {
    ...filesMod,
    trashFilter: trashMod.trashFilter,
    trashSortRows: trashMod.trashSortRows,
    trashRowsSort: trashMod.trashRowsSort,
  };
});

// ── ① 快照 + 扁平文件 ────────────────────────────────────────────────
describe("snapshotDrop / dragHasFiles", () => {
  it("types 含 Files → 视为文件拖拽", () => {
    expect(dragHasFiles({ types: ["Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });

  it("扁平文件（无 entry）→ relPath = 文件名，顺序保持", async () => {
    const dt: DataTransferLike = {
      types: ["Files"],
      files: [
        { name: "a.txt", size: 10 },
        { name: "b.txt", size: 20 },
      ],
    };
    const r = await collectDrop(snapshotDrop(dt));
    expect(r.files.map((f) => f.relPath)).toEqual(["a.txt", "b.txt"]);
    expect(r.truncated).toBe(false);
  });
});

// ── ② 目录递归 + 限额 ────────────────────────────────────────────────
function fileEntry(name: string, size = 1): DropEntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok({ name, size }),
  };
}

function dirEntry(name: string, kids: DropEntryLike[]): DropEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let sent = false;
      return {
        readEntries: (ok) => {
          if (sent) ok([]);
          else {
            sent = true;
            ok(kids);
          }
        },
      };
    },
  };
}

describe("collectDrop — 目录递归", () => {
  it("webkitGetAsEntry 目录树 → 相对路径含子目录前缀", async () => {
    const tree = dirEntry("docs", [
      fileEntry("a.txt", 5),
      dirEntry("sub", [fileEntry("b.txt", 7)]),
    ]);
    const dt: DataTransferLike = {
      types: ["Files"],
      items: [{ webkitGetAsEntry: () => tree }],
      files: [],
    };
    const r = await collectDrop(snapshotDrop(dt));
    expect(r.files.map((f) => f.relPath)).toEqual(["docs/a.txt", "docs/sub/b.txt"]);
    expect(r.files.map((f) => f.file.size)).toEqual([5, 7]);
    expect(r.truncated).toBe(false);
  });

  it("文件数超限 → 截断（保留前 N 个）", async () => {
    const tree = dirEntry("many", [fileEntry("a"), fileEntry("b"), fileEntry("c")]);
    const dt: DataTransferLike = {
      types: ["Files"],
      items: [{ webkitGetAsEntry: () => tree }],
    };
    const r = await collectDrop(snapshotDrop(dt), { maxFiles: 2, maxBytes: 1024 });
    expect(r.files.map((f) => f.relPath)).toEqual(["many/a", "many/b"]);
    expect(r.truncated).toBe(true);
  });

  it("字节数超限 → 截断（超限项丢弃）", async () => {
    const tree = dirEntry("big", [fileEntry("a", 6), fileEntry("b", 6)]);
    const dt: DataTransferLike = {
      types: ["Files"],
      items: [{ webkitGetAsEntry: () => tree }],
    };
    const r = await collectDrop(snapshotDrop(dt), { maxFiles: 200, maxBytes: 10 });
    expect(r.files.map((f) => f.relPath)).toEqual(["big/a"]);
    expect(r.truncated).toBe(true);
  });

  it("uniqueParentDirs：浅层在前，无目录 = 空", () => {
    expect(uniqueParentDirs(["a/b/c.txt", "a/d.txt", "e.txt"])).toEqual(["a", "a/b"]);
    expect(uniqueParentDirs(["e.txt"])).toEqual([]);
  });
});

// ── ③ 上传队列相对路径 ──────────────────────────────────────────────
describe("makeUploadItems — relPath", () => {
  it("path = dir/relPath；name = 末段；id 含 relPath", () => {
    const items = makeUploadItems(
      [{ name: "b.txt", size: 7, relPath: "docs/sub/b.txt" }],
      "inbox",
      "q0-",
    );
    expect(items[0].path).toBe("inbox/docs/sub/b.txt");
    expect(items[0].name).toBe("b.txt");
    expect(items[0].id).toBe("q0-0-docs/sub/b.txt");
  });

  it("缺省 relPath 保持原行为（dir/文件名）", () => {
    const items = makeUploadItems([{ name: "a.txt", size: 1 }], "docs");
    expect(items[0].path).toBe("docs/a.txt");
    expect(items[0].name).toBe("a.txt");
  });
});

// ── ④ 回收站过滤 / 排序 ─────────────────────────────────────────────
const TRASH_ROWS = [
  {
    id: "a",
    path: "files/zeta.txt",
    size: 100,
    deletedAt: "2026-11-06T10:00:00Z",
    caller: "alice",
    role: "user",
  },
  {
    id: "b",
    path: "files/alpha.txt",
    size: 300,
    deletedAt: "2026-11-06T12:00:00Z",
    caller: "bob",
    role: "admin",
  },
  {
    id: "c",
    path: "files/mid.txt",
    size: 200,
    deletedAt: undefined,
    caller: "Alice",
    role: "user",
  },
];

describe("TrashDialog — 搜索 / 排序纯函数", () => {
  it("按原路径过滤（去 files/ 前缀、大小写不敏感）", () => {
    expect(mod.trashFilter(TRASH_ROWS, "ALPHA").map((r) => r.id)).toEqual(["b"]);
    expect(mod.trashFilter(TRASH_ROWS, "").length).toBe(3);
  });

  it("按操作人（caller）过滤", () => {
    expect(mod.trashFilter(TRASH_ROWS, "alice").map((r) => r.id)).toEqual(["a", "c"]);
    expect(mod.trashFilter(TRASH_ROWS, "bob").map((r) => r.id)).toEqual(["b"]);
    expect(mod.trashFilter(TRASH_ROWS, "zzz")).toEqual([]);
  });

  it("排序：删除时间（缺失排尾）/ 大小 / 名称", () => {
    expect(mod.trashSortRows(TRASH_ROWS, "deletedAt", "desc").map((r) => r.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(mod.trashSortRows(TRASH_ROWS, "deletedAt", "asc").map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(mod.trashSortRows(TRASH_ROWS, "size", "desc").map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(mod.trashSortRows(TRASH_ROWS, "size", "asc").map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(mod.trashSortRows(TRASH_ROWS, "name", "asc").map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("兼容入口 trashRowsSort = 删除时间排序；不改原数组", () => {
    const before = JSON.stringify(TRASH_ROWS);
    expect(mod.trashRowsSort(TRASH_ROWS, "desc").map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(JSON.stringify(TRASH_ROWS)).toBe(before);
  });
});

// ── ⑤ 详情抽屉字段渲染 ──────────────────────────────────────────────
describe("FileDetailDrawer — 字段渲染", () => {
  const fileEntry = {
    path: "files/docs/report.md",
    type: "file" as const,
    size: 1536,
    updatedAt: "2026-11-06T12:34:00Z",
    etag: "abcdef0123456789abcdef",
  };
  const dirEntry = { path: "files/docs/", type: "directory" as const };
  const fsStub = {
    humanName: "luo",
    dirPath: "",
    view: "files" as const,
    files: [fileEntry, dirEntry],
    trash: [],
    loading: false,
    status: "" as const,
    error: "",
    recursive: false,
    canRecursive: false,
    nextKey: undefined,
    loadingMore: false,
    trashStatus: "" as const,
    trashError: "",
    isAdmin: false,
    selected: new Set<string>(),
    selectablePaths: [],
    selAll: "none" as const,
    quota: null,
    quotaFailed: false,
    undo: null,
    filesView: "list" as const,
    offerUndo: () => undefined,
    reload: () => undefined,
    load: () => undefined,
    loadMore: () => undefined,
    onOpenTrash: () => undefined,
    onUndo: () => undefined,
    onEnterDir: () => undefined,
    onSwitchView: () => undefined,
    onToggleRecursive: () => undefined,
    onFilesViewChange: () => undefined,
    onToggleSelect: () => undefined,
    onTreeBatchChange: () => undefined,
    onSelectAllToggle: () => undefined,
    onClearSelection: () => undefined,
    onOpenDetail: () => undefined,
  };
  const nav = {
    selectedFile: null,
    selectFile: () => undefined,
    section: "files",
    setSection: () => undefined,
  };

  const render = (target: { path: string; isDir: boolean }, narrow = false): string =>
    renderToStaticMarkup(
      E(mod.FileDetailDrawer, {
        t,
        tr,
        nav,
        fs: fsStub,
        target,
        open: true,
        narrow,
        onClose: () => undefined,
        onOpenSyncSettings: () => undefined,
      }),
    );

  it("文件：路径 / 大小 / 类型 / 修改 / ETag 前 12 位 + 操作按钮", () => {
    const html = render({ path: "docs/report.md", isDir: false });
    expect(html).toContain('data-drawer="right"');
    expect(html).toContain("docs/report.md");
    expect(html).toContain("1.5 KB");
    expect(html).toContain("MD"); // fileTypeLabel(.md) = MD
    expect(html).toContain("2026-11-06");
    expect(html).toContain("abcdef012345…"); // 前 12 位 + 省略号
    expect(html).toContain("预览");
    expect(html).toContain("下载");
    expect(html).toContain("删除");
    expect(html).toContain("复制路径");
    expect(fetchSpy).not.toHaveBeenCalled(); // 详情不额外发请求
  });

  it("目录：子项数（已加载）+ 同步设置；窄屏 = 底部 Sheet", () => {
    const html = render({ path: "docs/", isDir: true }, true);
    expect(html).toContain('data-drawer="bottom"');
    expect(html).toContain("子项数（已加载）");
    expect(html).toContain("同步设置");
    expect(html).not.toContain("ETag");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maskEtag：前 12 位 / 短值原样 / 缺失「—」", () => {
    expect(mod.maskEtag("abcdef0123456789")).toBe("abcdef012345…");
    expect(mod.maskEtag("short")).toBe("short");
    expect(mod.maskEtag(undefined)).toBe("—");
  });

  it("loadedChildCount：只数直接子项（已加载数据）", () => {
    const entries = [
      { path: "files/docs/x.txt", type: "file" as const },
      { path: "files/docs/sub/y.txt", type: "file" as const },
      { path: "files/docs/sub/", type: "directory" as const },
      { path: "files/other.txt", type: "file" as const },
    ];
    expect(mod.loadedChildCount(entries, "docs/")).toBe(2);
    expect(mod.loadedChildCount(entries, "docs/sub")).toBe(1);
    expect(mod.loadedChildCount(entries, "")).toBe(0);
  });
});

// ── ⑥ 拖拽外壳接入文件区（三视图共用同一 listNode 槽）───────────────
describe("FilesSection — 拖拽上传外壳接线", () => {
  it("mid 变体渲染恰 1 个 drop 区（列表 / 树 / 网格共用）", () => {
    const html = renderToStaticMarkup(
      E(mod.default, {
        nav: { selectedFile: null, selectFile: () => undefined },
        cols: 2,
        variant: "mid",
        data: {
          teams: [],
          admin: { humans: [{ name: "luo", matrixUserID: "@luo:local" }] },
          myUserId: "@luo:local",
          hasToken: true,
          activeRef: { current: true },
        },
      }),
    );
    const dropZones = html.split('data-file-drop="1"').length - 1;
    expect(dropZones).toBe(1);
    expect(html).toContain("上传文件");
  });
});
