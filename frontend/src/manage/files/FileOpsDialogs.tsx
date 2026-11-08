/**
 * FileOpsDialogs.tsx — 文件区第二批弹窗：
 *   1) RenameMoveDialog：重命名 / 移动到…（控制器无 move 端点 → 复制-删除；
 *      目录 = 逐文件复制，空目录跳过）；
 *   2) QuotaEditDialog：配额编辑（16.137 起抽到 files/QuotaEditDialog.tsx，
 *      文件管理 / 人员管理共用；本文件只 re-export，外部面不变）；
 *   3) TextEditorDialog：文本在线编辑（If-Match 乐观并发；412 冲突选择）；
 *   4) FileOpProgressBar：单文件复制/重命名进度（复用上传队列的逐项语义，
 *      状态 copying / renaming / error）。
 *
 * 纯编排在 files/pathMove.ts、files/quotaEdit.ts、files/textEdit.ts（可单测）；
 * 本文件只做 UI 与调用顺序。错误文案由调用方注入（errorText），避免与
 * FilesSection 循环依赖。
 */
import type * as ReactNS from "react";

import {
  deleteFile,
  listFiles,
  readFileSync,
  readFileText,
  statFile,
  writeFileSync,
  type HumanFileEntry,
} from "../../api";
import type { ThemeColors } from "../../theme";
import DialogShell from "./DialogShell";
import {
  collectFilesUnder,
  dirChildrenPlan,
  findExistingEntry,
  movePath,
  parentDir,
  renamePath,
  runMove,
  type MoveDeps,
  type MoveListFn,
} from "./pathMove";
import {
  needsUnsavedConfirm,
  saveText,
} from "./textEdit";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

/** 行操作统一目标（列表 / 树 / 网格 / 详情抽屉共用）。 */
export interface FileOpTarget {
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
  etag?: string;
}

/** 单文件操作进度（uploadQueue 同款逐项语义：copying/renaming/error）。 */
export interface FileOpProgress {
  name: string;
  status: "copying" | "renaming" | "error";
  error?: string;
}

export interface FileOpsCommon {
  t: ThemeColors;
  tr: Tr;
  humanName: string;
  /** 统一错误文案（容器注入 hfErrorText，避免循环 import）。 */
  errorText: (e: unknown) => string;
}

// ── 1) 重命名 / 移动到… ────────────────────────────────────────────
export interface RenameMoveDialogProps extends FileOpsCommon {
  open: boolean;
  mode: "rename" | "move";
  target: FileOpTarget | null;
  /** 当前已加载列表（目标冲突判定；未加载目录另发一次列表请求）。 */
  entries: HumanFileEntry[];
  /** 当前目录（重命名/移动的默认父目录）。 */
  dirPath: string;
  onClose: () => void;
  /** 完成（成功移动/重命名后由容器刷新列表）。 */
  onDone: (kind: "renamed" | "moved") => void;
  onProgress: (p: FileOpProgress | null) => void;
}

/** 目标路径是否已存在：当前列表优先；父目录不同则补一次 listFiles
 * （只判已知目录；请求失败按「不存在」放行——服务端最终裁决）。 */
async function targetExists(
  humanName: string,
  entries: HumanFileEntry[],
  dirPath: string,
  targetPath: string,
): Promise<boolean> {
  if (findExistingEntry(entries, dirPath, targetPath)) return true;
  const parent = parentDir(targetPath);
  if (parent === dirPath.replace(/^\/+|\/+$/g, "")) return false;
  try {
    const r = await listFiles(humanName, parent);
    return r.entries.some((e) => {
      const p = e.path
        ? e.path.replace(/^files\//, "").replace(/\/+$/, "")
        : parent
          ? `${parent}/${e.name ?? ""}`
          : (e.name ?? "");
      return p === targetPath;
    });
  } catch {
    return false;
  }
}

function confirmOverwrite(tr: Tr, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    antd.Modal.confirm({
      title: tr("目标已存在"),
      content: tr("「{name}」已存在，覆盖？", { name }),
      okText: tr("覆盖"),
      cancelText: tr("取消"),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function RenameMoveDialog({
  open,
  mode,
  target,
  entries,
  dirPath,
  t,
  tr,
  humanName,
  errorText,
  onClose,
  onDone,
  onProgress,
}: RenameMoveDialogProps): ReactNS.ReactElement | null {
  const [name, setName] = React.useState("");
  const [moveDir, setMoveDir] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // 打开时按目标重置草稿（rename = 原名；move = 目标父目录）。
  React.useEffect(() => {
    if (!open || !target) return;
    setName(target.name);
    setMoveDir(parentDir(target.path));
  }, [open, target?.path, target?.name]);

  // 目录树选择器：只列当前已加载目录（当前目录 + 子目录）；支持手输。
  // hooks 必须在下方 early-return 之前（Rules of Hooks）。
  const dirOptions = React.useMemo(() => {
    const base = dirPath.replace(/^\/+|\/+$/g, "");
    const dirs = entries
      .filter((e) => e.type === "directory" || (e.path ? e.path.endsWith("/") : false))
      .map((e) =>
        e.path
          ? e.path.replace(/^files\//, "").replace(/\/+$/, "")
          : `${base ? `${base}/` : ""}${e.name ?? ""}`,
      )
      .filter(Boolean);
    return [base, ...dirs].filter((v, i, a) => a.indexOf(v) === i);
  }, [entries, dirPath]);

  if (!open || !target) return null;

  const deps: MoveDeps = {
    read: (p) => readFileSync(humanName, p),
    // 覆盖语义：不带 If-Match（任务书明确「覆盖」= 直接写）。
    write: async (p, blob) => writeFileSync(humanName, p, blob),
    remove: async (p) => {
      await deleteFile(humanName, p);
    },
  };
  const list: MoveListFn = (dir, opts) => listFiles(humanName, dir, opts);

  const execPlan = async (from: string, to: string): Promise<void> => {
    const r = await runMove(deps, { from, to }, {
      onStep: (s) => {
        if (s === "copying") onProgress({ name: target.name, status: "copying" });
        else if (s === "deleting") onProgress({ name: target.name, status: "renaming" });
      },
    });
    if (!r.ok) {
      onProgress({ name: target.name, status: "error", error: errorText(r.error) });
      throw r.error;
    }
  };

  const execDir = async (from: string, to: string): Promise<number> => {
    const files = await collectFilesUnder(list, from);
    if (files.length === 0) return 0;
    const plan = dirChildrenPlan(from, to, files);
    let failed = 0;
    for (const item of plan) {
      onProgress({ name: item.from.split("/").pop() || item.from, status: "copying" });
      try {
        await execPlan(item.from, item.to);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      throw new Error(tr("部分文件移动失败（成功 {a} / 失败 {b}）", {
        a: plan.length - failed,
        b: failed,
      }));
    }
    return plan.length;
  };

  const run = async (): Promise<void> => {
    const planned =
      mode === "rename"
        ? renamePath(target.path, name)
        : movePath(target.path, moveDir, { isDir: target.isDir });
    if (!planned.ok) {
      const msg =
        planned.issue === "into_self"
          ? tr("不能移动到自身或子目录")
          : planned.issue === "same_name"
            ? tr("名称未变化")
            : planned.issue === "same_dir"
              ? tr("目标目录与当前目录相同")
              : planned.issue === "invalid_target"
                ? tr("目标目录非法")
                : tr("名称非法");
      antd.message.warning(msg);
      return;
    }
    setBusy(true);
    try {
      const exists = await targetExists(humanName, entries, dirPath, planned.plan.to);
      const exec = async (): Promise<void> => {
        setBusy(true);
        try {
          if (target.isDir) {
            const moved = await execDir(planned.plan.from, planned.plan.to);
            if (moved === 0) {
              antd.message.info(tr("空目录无可移动文件（已跳过）"));
              onClose();
              return;
            }
          } else {
            await execPlan(planned.plan.from, planned.plan.to);
          }
          onProgress(null);
          antd.message.success(mode === "rename" ? tr("已重命名") : tr("已移动"));
          onDone(mode === "rename" ? "renamed" : "moved");
          onClose();
        } catch (e) {
          // 失败项由 onProgress(error) 展示；这里只提示一次。
          antd.message.error(errorText(e));
        } finally {
          setBusy(false);
        }
      };
      if (exists && !(await confirmOverwrite(tr, planned.plan.name))) {
        // 用户取消覆盖 → 不复制；外层 finally 复位 busy。
        return;
      }
      await exec();
    } catch (e) {
      antd.message.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      open={open}
      title={mode === "rename" ? tr("重命名") : tr("移动到…")}
      subtitle={target.path}
      width={520}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={null}
    >
      <div style={{ display: "grid", gap: 10, padding: "6px 0" }}>
        {mode === "rename" ? (
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("新名称")}</span>
            <antd.Input
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onPressEnter={() => void run()}
              disabled={busy}
              aria-label={tr("新名称")}
            />
          </label>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("目标目录")}</span>
            <select
              value={dirOptions.includes(moveDir) ? moveDir : ""}
              disabled={busy}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMoveDir(e.target.value)}
              aria-label={tr("选择目录")}
              style={{
                minHeight: "var(--hf-btn-min, 40px)",
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                background: t.cardBg,
                color: t.text,
                padding: "0 8px",
              }}
            >
              {dirOptions.map((d) => (
                <option key={d || "/"} value={d}>
                  {d || tr("根目录")}
                </option>
              ))}
            </select>
            <antd.Input
              value={moveDir}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMoveDir(e.target.value)}
              disabled={busy}
              placeholder={tr("手输相对路径（留空 = 根目录）")}
              aria-label={tr("目标目录")}
            />
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("只列出已加载目录；可手输其它路径")}
            </span>
          </div>
        )}
        {/* >8 MiB 提示（读→写→删整文件走代理，可能较慢）。 */}
        {!target.isDir && typeof target.size === "number" && target.size > 8 * 1024 * 1024 ? (
          <span style={{ fontSize: 11, color: "#d4380d" }}>
            {tr("文件大于 8 MiB，重命名/移动可能较慢")}
          </span>
        ) : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <antd.Button onClick={onClose} disabled={busy}>
            {tr("取消")}
          </antd.Button>
          <antd.Button type="primary" loading={busy} onClick={() => void run()}>
            {mode === "rename" ? tr("重命名") : tr("移动")}
          </antd.Button>
        </div>
      </div>
    </DialogShell>
  );
}

// ── 2) 配额编辑：16.137 起实现迁到 files/QuotaEditDialog.tsx（文件管理 /
// 人员管理共用同一份 UI 与语义）；此处 re-export 保持既有 import 面不变。
export { QuotaEditDialog } from "./QuotaEditDialog";
export type { QuotaEditDialogProps } from "./QuotaEditDialog";

// ── 3) 文本在线编辑（If-Match 乐观并发）────────────────────────────
export interface TextEditorDialogProps extends FileOpsCommon {
  open: boolean;
  target: FileOpTarget | null;
  onClose: () => void;
  /** 保存成功 → 容器刷新列表（新 etag 由服务端返回）。 */
  onSaved: (etag?: string) => void;
}

export function TextEditorDialog({
  open,
  target,
  t,
  tr,
  humanName,
  errorText,
  onClose,
  onSaved,
}: TextEditorDialogProps): ReactNS.ReactElement | null {
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState("");
  const [content, setContent] = React.useState("");
  const [baseline, setBaseline] = React.useState("");
  const [etag, setEtag] = React.useState<string | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const load = React.useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setLoadError("");
    try {
      // GET 取正文 + 同一次响应的 ETag；HEAD 兜底（statFile），最后回落列表
      // entry.etag 作 If-Match（任务书口径）。
      const [read, stat] = await Promise.all([
        readFileText(humanName, target.path),
        statFile(humanName, target.path),
      ]);
      const tag = read.etag || stat.etag || target.etag;
      setContent(read.text);
      setBaseline(read.text);
      setEtag(tag);
    } catch (e) {
      setLoadError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [target?.path, humanName, errorText]);

  React.useEffect(() => {
    if (!open || !target) return;
    setContent("");
    setBaseline("");
    setEtag(undefined);
    void load();
  }, [open, target?.path]);

  if (!open || !target) return null;

  const dirty = needsUnsavedConfirm(content, baseline);

  const saveWith = async (ifMatch: string | undefined): Promise<boolean> => {
    const r = await saveText(
      {
        write: (p, c, m) => writeFileSync(humanName, p, c, m),
      },
      target.path,
      content,
      ifMatch,
    );
    if (r.kind === "saved") {
      setBaseline(content);
      setEtag(r.etag || etag);
      antd.message.success(tr("已保存"));
      onSaved(r.etag);
      onClose();
      return true;
    }
    if (r.kind === "conflict") {
      antd.Modal.confirm({
        title: tr("内容冲突"),
        content: tr("文件已被其他人修改。重新加载会丢弃本地修改；覆盖保存将强制写入。"),
        okText: tr("覆盖保存"),
        cancelText: tr("重新加载（丢弃本地）"),
        onOk: () => void saveWith(undefined),
        onCancel: () => void load(),
      });
      return false;
    }
    if (r.kind === "too_large") {
      antd.message.error(tr("文件过大，无法在线编辑（≤1 MiB）"));
      return false;
    }
    antd.message.error(r.message || tr("保存失败"));
    return false;
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await saveWith(etag);
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    if (!dirty) {
      onClose();
      return;
    }
    antd.Modal.confirm({
      title: tr("放弃未保存的修改？"),
      okText: tr("放弃"),
      cancelText: tr("继续编辑"),
      onOk: () => onClose(),
    });
  };

  return (
    <DialogShell
      open={open}
      title={tr("编辑文本")}
      subtitle={`${target.path} · ${tr("文本上限 1 MiB")}`}
      width={860}
      onClose={close}
      footer={null}
    >
      <div style={{ display: "grid", gap: 10 }}>
        {loading ? (
          <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("加载中…")}</span>
        ) : loadError ? (
          <antd.Alert type="error" showIcon message={loadError} />
        ) : (
          <textarea
            ref={areaRef}
            value={content}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            onKeyDown={(e: ReactNS.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key !== "Tab") return;
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = `${content.slice(0, start)}  ${content.slice(end)}`;
              setContent(next);
              // 光标落到插入点之后（受控组件下一帧再定位）。
              requestAnimationFrame(() => {
                if (!areaRef.current) return;
                areaRef.current.selectionStart = start + 2;
                areaRef.current.selectionEnd = start + 2;
              });
            }}
            spellCheck={false}
            aria-label={tr("编辑文本")}
            style={{
              width: "100%",
              minHeight: "46vh",
              resize: "vertical",
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
              fontSize: 12,
              lineHeight: 1.5,
              border: `1px solid ${t.border}`,
              borderRadius: 6,
              background: t.cardBg,
              color: t.text,
              padding: 8,
              boxSizing: "border-box",
            }}
          />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: t.textSecondary, minWidth: 0 }}>
            {etag ? `ETag: ${etag.slice(0, 16)}${etag.length > 16 ? "…" : ""}` : tr("（无 ETag，保存不带 If-Match）")}
          </span>
          <span style={{ flex: 1 }} />
          <antd.Button onClick={close} disabled={busy}>
            {tr("取消")}
          </antd.Button>
          <antd.Button
            type="primary"
            loading={busy}
            disabled={loading || !!loadError}
            onClick={() => void save()}
          >
            {tr("保存")}
          </antd.Button>
        </div>
      </div>
    </DialogShell>
  );
}

// ── 4) 操作进度（copying / renaming / error）────────────────────────
export function FileOpProgressBar({
  t,
  tr,
  progress,
  onDismiss,
}: {
  t: ThemeColors;
  tr: Tr;
  progress: FileOpProgress | null;
  onDismiss: () => void;
}): ReactNS.ReactElement | null {
  if (!progress) return null;
  const text =
    progress.status === "copying"
      ? tr("复制中…")
      : progress.status === "renaming"
        ? tr("重命名中…")
        : tr("失败");
  const color = progress.status === "error" ? "#d4380d" : t.textSecondary;
  return (
    <div
      data-file-op-progress="1"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "6px 10px",
        background: t.cardBg,
        fontSize: 12,
        color: t.text,
      }}
    >
      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {progress.name}
      </span>
      <span style={{ color, whiteSpace: "nowrap" }}>{text}</span>
      {progress.error ? (
        <span
          style={{
            color: "#d4380d",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={progress.error}
        >
          {progress.error}
        </span>
      ) : null}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onDismiss}
        aria-label={tr("关闭")}
        title={tr("关闭")}
        style={{
          minWidth: "var(--hf-btn-min, 40px)",
          minHeight: "var(--hf-btn-min, 40px)",
          border: "none",
          background: "transparent",
          color: t.textSecondary,
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>
  );
}
