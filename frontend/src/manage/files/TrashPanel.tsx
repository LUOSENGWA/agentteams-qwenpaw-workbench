/**
 * TrashPanel.tsx — 文件管理 v3（F-V3-1）回收站独立页（view = "trash" 时的中栏渲染）。
 *
 * v3 目标：回收站不再与主列表同屏 / 共用列头——容器（FilesSection）持
 * view: "files"|"trash"（标题行小视图切换），trash 视图 = 本组件独立渲染
 *（自取数、自带列头行、自带空态 / 错误态）；主列表 ListArea 只出 files。
 *
 * 列：原路径 / 大小 / 删除时间 / 操作（恢复、彻底删除）——TRASH_COLUMNS
 *（导出常量，tests/files-v3-1 断言）；列宽模板由容器传入（与主列表
 * LIST_GRID 同一模板 → 两视图四列对齐稳定，列头是两行独立元素）。
 *
 * 数据（自持，调既有 API，零改动）：listTrash(humanName)；404 由容器
 * 拦截（整段「无权限或不存在」占位，不落到本组件），非 404 失败 =
 * Alert「加载失败」+ 服务端 message + 重试；空 = 「回收站为空」；
 * 加载中 = 「加载中…」。
 *
 * 操作（既有 API，零改动）：
 * - 恢复 = restoreTrash；409（目标路径已存在）：非 admin 仅显「目标路径
 *   已存在」；admin 二次确认「覆盖目标路径上的已有文件？（仅管理员）」
 *   → overwrite=1（与主列表详情 TrashDetail 同一 doRestore 语义）。
 * - 彻底删除 = purgeTrash（admin only：非 admin 按钮 disabled +「仅管理员」
 *   tooltip）；确认框「彻底删除此项？」「此操作不可撤销」（okButtonProps
 *   danger）——与主列表删除确认语义一致（不改语义）。
 *
 * 选中：行选中键 = normTrashPath(entry.path)（与详情槽 TrashDetail 共用
 * nav.selectedFile）；点行选中 / 再点取消。
 *
 * 共享帮助函数（fmtBytes / fmtTs / normTrashPath / TOUCH）自 v3 由
 * FilesSection 迁入本文件（TrashPanel / SyncSettingsModal 共用；
 * FilesSection import + 重导出，外部面稳定——PeopleSection 经 FilesSection
 * 引用 fmtBytes，files-actions-1669 经 FilesSection 引用 TOUCH）。
 * iconBtnStyle 在此另存一份（与 FilesSection 同名同形——反向 import 会成
 * FilesSection↔files/ 循环；触控盒引用同一 :root CSS 变量，视觉一致）。
 */
import type * as ReactNS from "react";

import {
  HumanFilesError,
  listTrash,
  purgeTrash,
  restoreTrash,
  type HumanTrashEntry,
} from "../../api";
import { RefreshIcon, TrashIcon } from "../../components/icons";
import type { ThemeColors } from "../../theme";
import type { ManageNav } from "../useManageNav";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

// ── 文件域共享纯函数（自 FilesSection 迁入；说明见文件头）──────────────

/** 字节数 → 可读文本（— = 缺失/非法，诚实不造 0）。
 * FilesSection 重导出：PeopleSection 配额卡用量展示同源复用（Q）。 */
export function fmtBytes(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** ISO 时间戳 → 本地短文本（— = 缺失/非法）。 */
export function fmtTs(s: string | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 回收站条目路径归一（Go 返回 "files/a.txt" → 相对路径 "a.txt"）。 */
export function normTrashPath(p: string): string {
  return p.replace(/^files\//, "");
}

/** 触控常量（纯值，tests/files-actions-1669 断言）：列表行高 ≥44 /
 * 所有按钮 ≥40×40（图标按钮 40 盒内 16px 图标 → 有效留白 12px ≥ 8）/
 * 行内图标按钮间距 ≥8 / coarse 指针（触屏）整体再放大 10%。 */
export const TOUCH = {
  rowMinHeight: 44,
  btnMinSize: 40,
  btnPadding: 8,
  iconGap: 8,
  coarseScale: 1.1,
} as const;

/** 回收站列头（顺序 = 渲染顺序；tests/files-v3-1 断言）。 */
export const TRASH_COLUMNS = ["原路径", "大小", "删除时间", "操作"] as const;

/** 行内小图标按钮（裸 <button> + title tooltip）——同 FilesSection.iconBtnStyle
 * 形态（此处另存防 FilesSection↔files/ 循环；触控盒引用同一 :root 变量）。 */
function iconBtnStyle(t: ThemeColors): ReactNS.CSSProperties {
  return {
    width: "var(--hf-btn-min, 40px)",
    height: "var(--hf-btn-min, 40px)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: t.textSecondary,
    cursor: "pointer",
    flexShrink: 0,
    padding: 0,
  };
}

export interface TrashPanelProps {
  t: ThemeColors;
  tr: Tr;
  humanName: string;
  /** L1 惯例：hasToken = 已配置 Controller 管理员 token（彻底删 best-effort 门控）。 */
  isAdmin: boolean;
  /** 选中态与详情槽共享（TrashDetail 读同一 nav.selectedFile）。 */
  nav: Pick<ManageNav, "selectedFile" | "selectFile">;
  /** 列宽模板由容器传入（与主列表 LIST_GRID 同一模板 → 两视图四列对齐）。 */
  gridTemplateColumns: string;
  /** 恢复 / 彻底删成功 → 容器刷新（fs.trash / 详情槽 / l1 栏数据同步）。 */
  onChanged: () => void;
}

export default function TrashPanel({
  t,
  tr,
  humanName,
  isAdmin,
  nav,
  gridTemplateColumns,
  onChanged,
}: TrashPanelProps) {
  const [entries, setEntries] = React.useState<HumanTrashEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [status, setStatus] = React.useState<"" | "err">("");
  const [error, setError] = React.useState("");

  const loadTrash = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await listTrash(humanName);
      setEntries(r.entries);
      setStatus("");
      setError("");
    } catch (e) {
      // 加载失败 = 显服务端 message（404 由容器拦截，不落到这里）。
      setEntries([]);
      setStatus("err");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [humanName]);

  React.useEffect(() => {
    void loadTrash();
  }, [loadTrash]);

  /** 变更成功后的共同收尾：清选中（若选中该行）+ 自取数 + 通知容器。 */
  const afterMutate = (p: string) => {
    if (nav.selectedFile === p) nav.selectFile(null);
    void loadTrash();
    onChanged();
  };

  /** 恢复（409 = 目标已存在：admin 二次确认 overwrite=1；非 admin 仅显错）。 */
  const doRestore = async (e: HumanTrashEntry) => {
    try {
      await restoreTrash(humanName, e.id);
      antd.message.success(tr("已恢复"));
      afterMutate(normTrashPath(e.path));
    } catch (err) {
      if (err instanceof HumanFilesError && err.status === 409) {
        if (!isAdmin) {
          antd.message.error(tr("目标路径已存在"));
          return;
        }
        antd.Modal.confirm({
          title: tr("目标路径已存在"),
          content: tr("覆盖目标路径上的已有文件？（仅管理员）"),
          okText: tr("覆盖"),
          cancelText: tr("取消"),
          onOk: async () => {
            try {
              await restoreTrash(humanName, e.id, true);
              antd.message.success(tr("已恢复"));
              afterMutate(normTrashPath(e.path));
            } catch (e2) {
              antd.message.error(e2 instanceof Error ? e2.message : String(e2));
            }
          },
        });
        return;
      }
      antd.message.error(err instanceof Error ? err.message : String(err));
    }
  };

  /** 彻底删除（admin only；确认框「彻底删除此项？」/「此操作不可撤销」）。 */
  const doPurge = (e: HumanTrashEntry) => {
    if (!isAdmin) return;
    antd.Modal.confirm({
      title: tr("彻底删除此项？"),
      content: tr("此操作不可撤销"),
      okText: tr("彻底删除"),
      cancelText: tr("取消"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await purgeTrash(humanName, e.id);
          antd.message.success(tr("已彻底删除"));
          afterMutate(normTrashPath(e.path));
        } catch (err) {
          antd.message.error(err instanceof Error ? err.message : String(err));
        }
      },
    });
  };

  return (
    <div style={{ display: "grid", gap: 4 }}>
      {status === "err" && entries.length === 0 ? (
        <>
          <antd.Alert
            type="warning"
            showIcon
            message={tr("加载失败")}
            description={error}
          />
          <antd.Button
            style={{ minHeight: "var(--hf-btn-min, 40px)" }}
            onClick={() => void loadTrash()}
          >
            {tr("重试")}
          </antd.Button>
        </>
      ) : null}
      {status !== "err" && loading && entries.length === 0 ? (
        <div
          style={{
            padding: "18px 8px",
            textAlign: "center",
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          {tr("加载中…")}
        </div>
      ) : null}
      {status !== "err" && !loading && entries.length === 0 ? (
        <div style={{ padding: "18px 8px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("回收站为空")}
          </div>
        </div>
      ) : null}
      {status !== "err" && !loading && entries.length > 0 ? (
        <>
          {/* 回收站列头行（独立于主列表列头：原路径 / 大小 / 删除时间 / 操作）。 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns,
              gap: 8,
              alignItems: "center",
              padding: "0 8px",
              fontSize: 12,
              color: t.textSecondary,
            }}
          >
            {TRASH_COLUMNS.map((c) => (
              <span key={c} style={c === "大小" ? { textAlign: "right" } : undefined}>
                {tr(c)}
              </span>
            ))}
          </div>
          {entries.map((e) => {
            const p = normTrashPath(e.path);
            const sel = nav.selectedFile === p;
            const select = () => nav.selectFile(sel ? null : p);
            const rowSkin = sel
              ? { border: `1px solid ${t.border}`, background: t.hoverBg }
              : { border: "1px solid transparent", background: "transparent" };
            return (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={select}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    select();
                  }
                }}
                onMouseEnter={(ev) => {
                  if (!sel) ev.currentTarget.style.background = t.hoverBg;
                }}
                onMouseLeave={(ev) => {
                  if (!sel) ev.currentTarget.style.background = "transparent";
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns,
                  gap: 8,
                  alignItems: "center",
                  minHeight: "var(--hf-row-min, 44px)",
                  padding: "0 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  width: "100%",
                  ...rowSkin,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <TrashIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
                  <span
                    title={p}
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: t.textSecondary,
                    textAlign: "right",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtBytes(e.size)}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: t.textSecondary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtTs(e.deletedAt)}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: TOUCH.iconGap }}>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void doRestore(e);
                    }}
                    title={tr("恢复文件")}
                    aria-label={tr("恢复文件")}
                    style={iconBtnStyle(t)}
                  >
                    <RefreshIcon size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      doPurge(e);
                    }}
                    disabled={!isAdmin}
                    title={isAdmin ? tr("彻底删除") : tr("仅管理员")}
                    aria-label={tr("彻底删除")}
                    style={{
                      ...iconBtnStyle(t),
                      opacity: isAdmin ? 1 : 0.4,
                      cursor: isAdmin ? "pointer" : "not-allowed",
                    }}
                  >
                    <TrashIcon size={16} />
                  </button>
                </span>
              </div>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
