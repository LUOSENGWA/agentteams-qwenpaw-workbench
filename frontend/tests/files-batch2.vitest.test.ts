// 文件管理第二批：重命名/移动、配额编辑（十进制 MB/GB）、文本在线编辑。
//
// 纯逻辑单测（vitest）：pathMove / textEdit / quotaEdit 三个模块 + 关键接线
// 断言（FilesSection 的 admin 门与 runMove 调用顺序）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectFilesUnder,
  dirChildrenPlan,
  findExistingEntry,
  isSubPath,
  movePath,
  renamePath,
  runMove,
  validateFileName,
  validateRelPath,
  type MoveDeps,
  type MoveListFn,
} from "../src/manage/files/pathMove";
import {
  canEditQuota,
  bytesToQuotaInput,
  formatQuotaValue,
  quotaExactText,
  quotaFormToPayload,
  quotaFormValid,
  quotaToForm,
  quotaValueToBytes,
  QUOTA_UNIT_BYTES,
} from "../src/manage/files/quotaEdit";
import {
  isEditableText,
  needsUnsavedConfirm,
  saveText,
  TEXT_EDIT_MAX_BYTES,
} from "../src/manage/files/textEdit";

const SRC = join(process.cwd(), "src");

describe("movePath / renamePath — 路径校验与子目录保护", () => {
  it("validateRelPath：绝对路径 / .. / 反斜杠拒绝，空段折叠", () => {
    expect(validateRelPath("/a/b")).toEqual({ ok: false, issue: "absolute" });
    expect(validateRelPath("a/../b")).toEqual({ ok: false, issue: "dotdot" });
    expect(validateRelPath("a\\b")).toEqual({ ok: false, issue: "badchar" });
    expect(validateRelPath("a//b/")).toEqual({ ok: true, path: "a/b" });
    expect(validateRelPath("")).toEqual({ ok: true, path: "" });
  });

  it("validateFileName：空 / . / .. 拒绝，含 / 拒绝", () => {
    expect(validateFileName("")).toEqual({ ok: false, issue: "dotdot" });
    expect(validateFileName("..")).toEqual({ ok: false, issue: "dotdot" });
    expect(validateFileName("a/b")).toEqual({ ok: false, issue: "badchar" });
    expect(validateFileName(".hidden")).toEqual({ ok: true, path: ".hidden" });
  });

  it("renamePath：同目录换名；未改名 → same_name", () => {
    expect(renamePath("docs/a.txt", "b.txt")).toEqual({
      ok: true,
      plan: { from: "docs/a.txt", to: "docs/b.txt", name: "b.txt" },
    });
    expect(renamePath("a.txt", "a.txt")).toEqual({ ok: false, issue: "same_name" });
    expect(renamePath("a.txt", "bad/name")).toEqual({ ok: false, issue: "invalid_name" });
  });

  it("movePath：目标目录 / 同目录 / 目录移入自身或子目录", () => {
    expect(movePath("docs/a.txt", "archive")).toEqual({
      ok: true,
      plan: { from: "docs/a.txt", to: "archive/a.txt", name: "a.txt" },
    });
    expect(movePath("docs/a.txt", "docs")).toEqual({ ok: false, issue: "same_dir" });
    expect(movePath("docs", "docs/sub", { isDir: true })).toEqual({
      ok: false,
      issue: "into_self",
    });
    expect(movePath("docs", "docs", { isDir: true })).toEqual({
      ok: false,
      issue: "into_self",
    });
    expect(movePath("docs/a.txt", "/abs")).toEqual({ ok: false, issue: "invalid_target" });
  });

  it("isSubPath / findExistingEntry：冲突判定基于加载列表", () => {
    expect(isSubPath("a", "a/b")).toBe(true);
    expect(isSubPath("a", "ab")).toBe(false);
    const entries = [{ path: "files/a.txt", size: 1 }, { path: "files/docs/", type: "directory" }];
    expect(findExistingEntry(entries, "", "a.txt")).toBeTruthy();
    expect(findExistingEntry(entries, "", "missing.txt")).toBeUndefined();
  });
});

describe("runMove — 先写后删 / 失败保留原文件 / 回滚", () => {
  function deps(events: string[], failAt?: "write" | "delete"): MoveDeps {
    return {
      read: async (p) => {
        events.push(`read:${p}`);
        return new Blob(["x"]);
      },
      write: async (p) => {
        events.push(`write:${p}`);
        if (failAt === "write") throw new Error("write failed");
        return { etag: "e2" };
      },
      remove: async (p) => {
        events.push(`remove:${p}`);
        if (failAt === "delete" && p === "a.txt") throw new Error("delete failed");
      },
    };
  }

  it("成功顺序 = read → write → delete", async () => {
    const events: string[] = [];
    const r = await runMove(deps(events), { from: "a.txt", to: "b.txt" });
    expect(r).toEqual({ ok: true, etag: "e2" });
    expect(events).toEqual(["read:a.txt", "write:b.txt", "remove:a.txt"]);
  });

  it("写失败：原文件未动（不删）", async () => {
    const events: string[] = [];
    const r = await runMove(deps(events, "write"), { from: "a.txt", to: "b.txt" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.step).toBe("write");
    expect(events).toEqual(["read:a.txt", "write:b.txt"]);
  });

  it("删旧失败：回滚删除新文件（原文件保留）", async () => {
    const events: string[] = [];
    const r = await runMove(deps(events, "delete"), { from: "a.txt", to: "b.txt" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("delete");
      expect(r.rolledBack).toBe(true);
    }
    expect(events).toEqual([
      "read:a.txt",
      "write:b.txt",
      "remove:a.txt",
      "remove:b.txt",
    ]);
  });

  it("onStep：copying → renaming(deleting) → done", async () => {
    const steps: string[] = [];
    await runMove(deps([]), { from: "a.txt", to: "b.txt" }, {
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(["copying", "deleting", "done"]);
  });
});

describe("目录移动：递归枚举与目标映射", () => {
  it("collectFilesUnder：递归分页 + 目录条目不产出", async () => {
    const list: MoveListFn = async () => ({
      entries: [
        { path: "files/docs/", type: "directory" },
        { path: "files/docs/a.txt", size: 1, etag: "e" },
        { path: "files/docs/sub/", type: "directory" },
        { path: "files/docs/sub/b.md", size: 2, etag: "e" },
      ],
      nextKey: null,
      paginated: true,
    });
    expect(await collectFilesUnder(list, "docs")).toEqual([
      "docs/a.txt",
      "docs/sub/b.md",
    ]);
  });

  it("collectFilesUnder：空目录 → []（任务书：空目录跳过）", async () => {
    const list: MoveListFn = async () => ({ entries: [], nextKey: null, paginated: true });
    expect(await collectFilesUnder(list, "empty")).toEqual([]);
  });

  it("dirChildrenPlan：保留相对子树", () => {
    expect(
      dirChildrenPlan("docs", "archive", ["docs/a.txt", "docs/sub/b.md"]),
    ).toEqual([
      { from: "docs/a.txt", to: "archive/a.txt" },
      { from: "docs/sub/b.md", to: "archive/sub/b.md" },
    ]);
  });
});

describe("isEditableText / saveText — 文本编辑与 412 冲突", () => {
  it("文本扩展 + ≤1 MiB 才可编辑", () => {
    for (const n of ["a.md", "a.txt", "a.json", "a.yaml", "a.yml", "a.csv", "a.log"]) {
      expect(isEditableText(n, 100)).toBe(true);
    }
    expect(isEditableText("a.png", 100)).toBe(false);
    expect(isEditableText("noext", 100)).toBe(false);
    expect(isEditableText("a.md", TEXT_EDIT_MAX_BYTES + 1)).toBe(false);
    expect(isEditableText("a.md", TEXT_EDIT_MAX_BYTES)).toBe(true);
  });

  it("saveText：200 / 412 / 413 / 其它错误映射", async () => {
    const ok = await saveText(
      { write: async () => ({ etag: "e9" }) },
      "a.md",
      "x",
      "e1",
    );
    expect(ok).toEqual({ kind: "saved", etag: "e9" });

    const conflict = await saveText(
      {
        write: async () => {
          throw { status: 412, message: "conflict" };
        },
      },
      "a.md",
      "x",
      "e1",
    );
    expect(conflict).toEqual({ kind: "conflict" });

    const tooLarge = await saveText(
      {
        write: async () => {
          throw { status: 413, message: "too large" };
        },
      },
      "a.md",
      "x",
      "e1",
    );
    expect(tooLarge).toEqual({ kind: "too_large" });

    const other = await saveText(
      {
        write: async () => {
          throw { status: 403, message: "denied" };
        },
      },
      "a.md",
      "x",
      "e1",
    );
    expect(other.kind).toBe("error");
    if (other.kind === "error") expect(other.status).toBe(403);
  });

  it("needsUnsavedConfirm：内容变化才需二次确认", () => {
    expect(needsUnsavedConfirm("a", "a")).toBe(false);
    expect(needsUnsavedConfirm("a", "b")).toBe(true);
  });
});

describe("配额换算 — 十进制 MB/GB（1 MB = 1,000,000 bytes）", () => {
  it("单位基数：MB = 10^6，GB = 10^9（非 1024 进制）", () => {
    expect(QUOTA_UNIT_BYTES.MB).toBe(1_000_000);
    expect(QUOTA_UNIT_BYTES.GB).toBe(1_000_000_000);
  });

  it("quotaValueToBytes：1.5 GB = 1,500,000,000；800 MB = 800,000,000；null/0", () => {
    expect(quotaValueToBytes(1.5, "GB")).toBe(1_500_000_000);
    expect(quotaValueToBytes(800, "MB")).toBe(800_000_000);
    expect(quotaValueToBytes(null, "GB")).toBeNull();
    expect(quotaValueToBytes(0, "MB")).toBe(0);
  });

  it("bytesToQuotaInput：按最大适用单位回显（1.5 GB / 800 MB）", () => {
    expect(bytesToQuotaInput(1_500_000_000)).toEqual({ value: 1.5, unit: "GB" });
    expect(bytesToQuotaInput(800_000_000)).toEqual({ value: 800, unit: "MB" });
    expect(bytesToQuotaInput(null)).toEqual({ value: null, unit: "MB" });
    expect(bytesToQuotaInput(0)).toEqual({ value: 0, unit: "MB" });
  });

  it("formatQuotaValue：展示层十进制，未知旧值回落 bytes", () => {
    expect(formatQuotaValue(1_500_000_000)).toBe("1.5 GB");
    expect(formatQuotaValue(800_000_000)).toBe("800 MB");
    expect(formatQuotaValue(1_048_576)).toBe("1 MB");
    expect(formatQuotaValue(512)).toBe("512 B");
    expect(formatQuotaValue(null)).toBe("—");
  });

  it("quotaExactText：实时精确换算（千分位）", () => {
    expect(quotaExactText(1.5, "GB")).toBe("1.5 GB = 1,500,000,000 bytes");
    expect(quotaExactText(800, "MB")).toBe("800 MB = 800,000,000 bytes");
  });

  it("quotaToForm / quotaFormToPayload：留空 = null；0 = 零额度", () => {
    expect(quotaToForm(null)).toEqual({ value: null, unit: "MB", files: null });
    expect(quotaToForm({ quotaBytes: 1_500_000_000, quotaFiles: 5 })).toEqual({
      value: 1.5,
      unit: "GB",
      files: 5,
    });
    expect(quotaToForm({ quotaBytes: 0, quotaFiles: 0 })).toEqual({
      value: 0,
      unit: "MB",
      files: 0,
    });
    expect(quotaFormToPayload({ value: null, unit: "GB", files: null })).toEqual({
      bytes: null,
      files: null,
    });
    expect(quotaFormToPayload({ value: 1.5, unit: "GB", files: 0 })).toEqual({
      bytes: 1_500_000_000,
      files: 0,
    });
  });

  it("quotaFormValid：负数 / 非整数文件数非法", () => {
    expect(quotaFormValid({ value: -1, unit: "MB", files: null })).toBe(false);
    expect(quotaFormValid({ value: null, unit: "MB", files: 1.5 })).toBe(false);
    expect(quotaFormValid({ value: 0, unit: "MB", files: 0 })).toBe(true);
  });

  it("canEditQuota：仅 admin", () => {
    expect(canEditQuota(false)).toBe(false);
    expect(canEditQuota(true)).toBe(true);
  });
});

describe("FilesSection 接线 — admin 门与行操作入口", () => {
  it("配额编辑按钮由 fs.canAdmin 门控（非 admin 不渲染）", () => {
    const src = readFileSync(join(SRC, "manage", "FilesSection.tsx"), "utf8");
    expect(src).toMatch(/\{fs\.canAdmin \? \([\s\S]*?编辑配额/);
    expect(src).toMatch(/canAdmin = canControlResources\(/);
    expect(src).toMatch(/const canAdmin = canControlResources\(/);
  });

  it("三类弹窗已接线 + 行入口调用 onRename/onMove/onEditText", () => {
    const src = readFileSync(join(SRC, "manage", "FilesSection.tsx"), "utf8");
    for (const tag of ["RenameMoveDialog", "QuotaEditDialog", "TextEditorDialog"]) {
      expect(src).toContain(`<${tag}`);
    }
    expect(src).toContain("fs.onRename(opTarget)");
    expect(src).toContain("fs.onMove(opTarget)");
    expect(src).toContain("fs.onEditText(opTarget)");
  });
});
