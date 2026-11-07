/**
 * TrashDialog.tsx — 回收站弹窗（F-V3-3，替代 TrashPanel 独立页）。
 *
 * 只消费容器传入的数据（entries/loading/trashStatus/trashError）——**不调
 * listTrash**（修掉旧 TrashPanel 与容器并行的双请求）；列表/变更后的刷新
 * 走 onReload（= 容器 reload，统一 in-flight 去重）。
 *
 * 内容（任务书 B3）：
 * - 标题「回收站」+ 副标题「共 N 项 · 恢复后回到原路径」（DialogShell 统一外壳）；
 * - 工具行：搜索（原路径 / 操作人即时过滤）+ 排序下拉（删除时间倒序默认 /
 *   删除时间正序 / 大小 / 名称）+ 「全部恢复」（>1 项时出现；二次确认；
 *   循环 restoreTrash；逐条失败计数汇总）；过滤无命中显示「无匹配」；
 *   搜索/排序不改变批量范围（批量恢复用过滤后的可见行）；
 * - 列表：原路径 / 大小 / 删除时间 / 操作（行高 ≥44px；表头 sticky；
 *   deletedAt 缺失显示空）；窄屏（≤720px）卡片式（路径行 + 「大小 · 时间」行
 *   + 操作行，按钮 ≥44px）；
 * - 状态：加载骨架 3 行 / 空态（图标 + 「回收站是空的」）/ 错误（Alert +
 *   重试 → onReload({force:true})）；
 * - 彻底删除二次确认（含原路径 + 「不可恢复」）；恢复 409 = 「同名文件已存在」
 *   （管理员可见「覆盖恢复」= restoreTrash 第三位置参 true，非管理员只提示）；
 * - 关闭（Esc / 遮罩 / 右上 X / 底部按钮）不刷新。
 */
import type * as ReactNS from "react";

import {
  purgeTrash,
  restoreTrash,
  HumanFilesError,
  type HumanTrashEntry,
} from "../../api";
// hfErrorText 定义在 manage/FilesSection（导出复用；此处仅运行时引用——
// ESM 循环（FilesSection → TrashDialog → FilesSection）对函数声明安全）。
import { hfErrorText } from "../FilesSection";
import type { ThemeColors } from "../../theme";
import { fmtBytes, fmtTs, normTrashPath } from "./format";
import DialogShell from "./DialogShell";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

/** 列头（F-V3-1 沿用；经 .map 渲染，非硬编码）。 */
export const TRASH_COLUMNS = ["原路径", "大小", "删除时间", "操作"] as const;
/** 列表 grid（与文件列表同款宽度口径：路径自适应 + 72/120/96 三定宽列）。 */
const TRASH_GRID = "minmax(0, 1fr) 72px 120px 96px";

export type TrashSortDir = "desc" | "asc";
/** 排序键：删除时间（默认）/ 大小 / 名称。 */
export type TrashSortKey = "deletedAt" | "size" | "name";

function deletedMs(e: HumanTrashEntry): number | null {
  if (!e.deletedAt) return null;
  const m = Date.parse(e.deletedAt);
  return Number.isNaN(m) ? null : m;
}

function trashName(e: HumanTrashEntry): string {
  const p = normTrashPath(e.path);
  const i = p.lastIndexOf("/");
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
}

/** 可空值比较：缺失恒排尾（与方向无关），方向只翻转有效值。 */
function cmpNullable<T>(
  a: T | null,
  b: T | null,
  dir: TrashSortDir,
  cmp: (x: T, y: T) => number,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const c = cmp(a, b);
  return dir === "desc" ? -c : c;
}

/** 回收站排序（删除时间 / 大小 / 名称；缺失恒排尾；同值按 id 稳定）。
 *  纯函数，不改原数组。 */
export function trashSortRows(
  rows: HumanTrashEntry[],
  key: TrashSortKey,
  dir: TrashSortDir,
): HumanTrashEntry[] {
  return [...rows].sort((a, b) => {
    let c = 0;
    if (key === "deletedAt") {
      c = cmpNullable(deletedMs(a), deletedMs(b), dir, (x, y) => x - y);
    } else if (key === "size") {
      c = cmpNullable(
        typeof a.size === "number" ? a.size : null,
        typeof b.size === "number" ? b.size : null,
        dir,
        (x, y) => x - y,
      );
    } else {
      c = cmpNullable(trashName(a), trashName(b), dir, (x, y) =>
        x < y ? -1 : x > y ? 1 : 0,
      );
    }
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
}

/** 兼容入口（历史测试/调用点）：按删除时间排序。 */
export function trashRowsSort(rows: HumanTrashEntry[], dir: TrashSortDir): HumanTrashEntry[] {
  return trashSortRows(rows, "deletedAt", dir);
}

/** 按原路径 / 操作人（caller）子串过滤（大小写不敏感；空白 = 原样返回）。
 *  纯函数；不改变选择集（本弹窗无选择集，批量恢复用过滤后的可见行）。 */
export function trashFilter(rows: HumanTrashEntry[], q: string): HumanTrashEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter(
    (e) =>
      normTrashPath(e.path).toLowerCase().includes(s) ||
      (e.caller ?? "").toLowerCase().includes(s),
  );
}

/** 窄屏判定（≤720px 卡片式）。shim/无 matchMedia 环境 → false（表格态）。 */
function useNarrow(max = 720): boolean {
  const [narrow, setNarrow] = React.useState<boolean>(
    () => !!window.matchMedia && window.matchMedia(`(max-width: ${max}px)`).matches,
  );
  React.useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${max}px)`);
    const fn = (e: { matches: boolean }): void => setNarrow(e.matches);
    mq.addEventListener?.("change", fn);
    return () => mq.removeEventListener?.("change", fn);
  }, [max]);
  return narrow;
}

export interface TrashDialogProps {
  t: ThemeColors;
  tr: Tr;
  open: boolean;
  onClose: () => void;
  humanName: string;
  isAdmin: boolean;
  /** 容器统一取数（load 三腿之一）。 */
  entries: HumanTrashEntry[];
  loading: boolean;
  trashStatus: "" | "err";
  trashError: string;
  /** = 容器 reload（in-flight 去重；silent 默认 false）。 */
  onReload: (opts?: { silent?: boolean; force?: boolean }) => void;
}

export default function TrashDialog({
  t,
  tr,
  open,
  onClose,
  humanName,
  isAdmin,
  entries,
  loading,
  trashStatus,
  trashError,
  onReload,
}: TrashDialogProps) {
  const [search, setSearch] = React.useState("");
  const [sortKey, setSortKey] = React.useState<TrashSortKey>("deletedAt");
  const [sortDir, setSortDir] = React.useState<TrashSortDir>("desc");
  const narrow = useNarrow(720);

  /** 变更（恢复/彻底删/全部恢复）成功后统一刷新（静默强制，走容器去重）。 */
  const afterMutate = (): void => onReload({ silent: true, force: true });

  const visible = trashFilter(trashSortRows(entries, sortKey, sortDir), search);

  /** 单条恢复（409 = 同名文件已存在：管理员 → 「覆盖恢复」二次确认）。 */
  const doRestore = (e: HumanTrashEntry): void => {
    void (async () => {
      try {
        await restoreTrash(humanName, e.id);
        antd.message.success(tr("已恢复"));
        afterMutate();
      } catch (err) {
        if (err instanceof HumanFilesError && err.status === 409) {
          if (isAdmin) {
            antd.Modal.confirm({
              title: tr("同名文件已存在"),
              content: tr("覆盖恢复？（仅管理员）"),
              okText: tr("覆盖恢复"),
              cancelText: tr("取消"),
              onOk: async () => {
                try {
                  await restoreTrash(humanName, e.id, true);
                  antd.message.success(tr("已恢复"));
                  afterMutate();
                } catch {
                  antd.message.error(tr("恢复失败"));
                }
              },
            });
          } else {
            antd.message.error(tr("同名文件已存在"));
          }
          return;
        }
        antd.message.error(hfErrorText(err, tr));
      }
    })();
  };

  /** 彻底删除（仅管理员；二次确认含原路径 + 「不可恢复」）。 */
  const doPurge = (e: HumanTrashEntry): void => {
    if (!isAdmin) return;
    antd.Modal.confirm({
      title: tr("彻底删除此项？"),
      content: `${normTrashPath(e.path)}（${tr("不可恢复")}）`,
      okText: tr("彻底删除"),
      cancelText: tr("取消"),
      onOk: async () => {
        try {
          await purgeTrash(humanName, e.id);
          antd.message.success(tr("已彻底删除"));
          afterMutate();
        } catch (err) {
          antd.message.error(hfErrorText(err, tr));
        }
      },
    });
  };

  /** 全部恢复（>1 项；二次确认；循环 restoreTrash；逐条失败计数汇总）。 */
  const doRestoreAll = (targets: HumanTrashEntry[]): void => {
    const n = targets.length;
    antd.Modal.confirm({
      title: tr("恢复全部 {n} 项？", { n }),
      content: tr("恢复后回到原路径；同名已存在的条目将跳过并计入失败。"),
      okText: tr("全部恢复"),
      cancelText: tr("取消"),
      onOk: async () => {
        let okN = 0;
        let failN = 0;
        for (const e of targets) {
          try {
            await restoreTrash(humanName, e.id);
            okN += 1;
          } catch {
            failN += 1;
          }
        }
        if (failN > 0) {
          antd.message.warning(tr("已恢复 {a} 项 · {b} 项失败", { a: okN, b: failN }));
        } else {
          antd.message.success(tr("已恢复 {a} 项", { a: okN }));
        }
        afterMutate();
      },
    });
  };

  const iconBtn: ReactNS.CSSProperties = {
    width: "var(--hf-btn-min, 40px)",
    height: "var(--hf-btn-min, 40px)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    background: t.cardBg,
    color: t.text,
    cursor: "pointer",
  };

  const skeleton = (
    <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 44, borderRadius: 8, background: t.hoverBg }} />
      ))}
    </div>
  );

  const emptyState = (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        gap: 8,
        padding: "40px 12px",
        color: t.textSecondary,
      }}
    >
      <TrashIcon size={28} />
      <span style={{ fontSize: 13 }}>{tr("回收站是空的")}</span>
    </div>
  );

  const toolbar = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "12px 0 8px" }}>
      <antd.Input
        style={{ flex: "1 1 200px", minWidth: 160 }}
        placeholder={tr("按原路径/操作人搜索")}
        aria-label={tr("按原路径/操作人搜索")}
        value={search}
        onChange={(e: { target: { value: string } }) => setSearch(e.target.value)}
      />
      <antd.Select
        size="small"
        aria-label={tr("排序方式")}
        style={{ minWidth: 160 }}
        value={`${sortKey}:${sortDir}`}
        options={[
          { value: "deletedAt:desc", label: `${tr("删除时间")} ↓` },
          { value: "deletedAt:asc", label: `${tr("删除时间")} ↑` },
          { value: "size:desc", label: `${tr("大小")} ↓` },
          { value: "size:asc", label: `${tr("大小")} ↑` },
          { value: "name:asc", label: `${tr("名称")} ↑` },
          { value: "name:desc", label: `${tr("名称")} ↓` },
        ]}
        onChange={(v: string) => {
          const [k, dir] = v.split(":");
          if (k === "deletedAt" || k === "size" || k === "name") setSortKey(k);
          setSortDir(dir === "asc" ? "asc" : "desc");
        }}
      />
      {visible.length > 1 ? (
        <antd.Button style={{ minHeight: "var(--hf-btn-min, 40px)" }} onClick={() => doRestoreAll(visible)}>
          {tr("全部恢复")}
        </antd.Button>
      ) : null}
    </div>
  );

  /** 过滤后无命中（回收站非空）→ 「无匹配」，不改数据/选择。 */
  const noMatch = (
    <div style={{ padding: "32px 12px", textAlign: "center", fontSize: 13, color: t.textSecondary }}>
      {tr("无匹配")}
    </div>
  );

  const table = (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: TRASH_GRID,
          gap: 8,
          padding: "6px 0",
          borderBottom: `1px solid ${t.border}`,
          position: "sticky",
          top: 0,
          background: t.cardBg,
          zIndex: 1,
          fontSize: 12,
          color: t.textSecondary,
        }}
      >
        {TRASH_COLUMNS.map((c) => (
          <span key={c}>{tr(c)}</span>
        ))}
      </div>
      {visible.map((e) => (
        <div
          key={e.id}
          style={{
            display: "grid",
            gridTemplateColumns: TRASH_GRID,
            gap: 8,
            alignItems: "center",
            minHeight: "var(--hf-row-min, 44px)",
            padding: "4px 0",
            borderBottom: `1px solid ${t.border}`,
            fontSize: 13,
          }}
        >
          <span title={normTrashPath(e.path)} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {normTrashPath(e.path)}
          </span>
          <span style={{ color: t.textSecondary }}>{fmtBytes(e.size)}</span>
          <span style={{ color: t.textSecondary }}>{fmtTs(e.deletedAt)}</span>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <button type="button" style={iconBtn} title={tr("恢复")} onClick={() => doRestore(e)}>
              <RefreshIcon size={15} />
            </button>
            <button
              type="button"
              style={{ ...iconBtn, cursor: isAdmin ? "pointer" : "not-allowed", opacity: isAdmin ? 1 : 0.45 }}
              title={isAdmin ? tr("彻底删除") : tr("仅管理员")}
              onClick={() => doPurge(e)}
            >
              <TrashIcon size={15} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );

  /** 窄屏卡片式：路径行 + 「大小 · 时间」行 + 操作行（按钮 ≥44px）。 */
  const cards = (
    <div style={{ display: "grid", gap: 10 }}>
      {visible.map((e) => {
        const meta = [fmtBytes(e.size), fmtTs(e.deletedAt)].filter(Boolean).join(" · ");
        return (
          <div
            key={e.id}
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              padding: "10px 12px",
              display: "grid",
              gap: 6,
            }}
          >
            <div style={{ fontSize: 13, wordBreak: "break-all" }}>{normTrashPath(e.path)}</div>
            <div style={{ fontSize: 12, color: t.textSecondary }}>{meta}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                style={{
                  ...iconBtn,
                  minHeight: 44,
                  flex: "1 1 0",
                  display: "inline-flex",
                  gap: 6,
                  fontSize: 13,
                }}
                onClick={() => doRestore(e)}
              >
                <RefreshIcon size={15} />
                {tr("恢复")}
              </button>
              <button
                type="button"
                style={{
                  ...iconBtn,
                  minHeight: 44,
                  flex: "1 1 0",
                  display: "inline-flex",
                  gap: 6,
                  fontSize: 13,
                  cursor: isAdmin ? "pointer" : "not-allowed",
                  opacity: isAdmin ? 1 : 0.45,
                }}
                onClick={() => doPurge(e)}
              >
                <TrashIcon size={15} />
                {tr("彻底删除")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <DialogShell
      open={open}
      title={tr("回收站")}
      subtitle={tr("共 {n} 项 · 恢复后回到原路径", { n: entries.length })}
      onClose={onClose}
      footer={
        <antd.Button style={{ minHeight: "var(--hf-btn-min, 40px)" }} onClick={onClose}>
          {tr("关闭")}
        </antd.Button>
      }
    >
      {trashStatus === "err" && !loading ? (
        <antd.Alert
          type="error"
          showIcon
          message={trashError || tr("回收站加载失败")}
          style={{ marginBottom: 10 }}
          action={
            <antd.Button size="small" onClick={() => onReload({ force: true })}>
              {tr("重试")}
            </antd.Button>
          }
        />
      ) : null}
      {loading && entries.length === 0 ? skeleton : null}
      {!loading && entries.length === 0 ? emptyState : null}
      {entries.length > 0 ? (
        <>
          {toolbar}
          {visible.length === 0 ? noMatch : narrow ? cards : table}
        </>
      ) : null}
    </DialogShell>
  );
}

/* ── 本地图标（FilesSection 的图标是私有组件；files/ 内部自持，防循环依赖）── */
function RefreshIcon({ size = 14 }: { size?: number }): ReactNS.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon({ size = 14 }: { size?: number }): ReactNS.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.3a1 1 0 0 0 1 .7h4.6a1 1 0 0 0 1-.7L12 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
