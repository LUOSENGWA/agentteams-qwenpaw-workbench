/**
 * FilesSection.tsx — 「管理」页文件管理域（#1426 Human Files，nested API 版）。
 *
 * 数据（组件自持；files 域进入 = 组件挂载取数，切域卸载即停）：
 * - listFiles(humanName, dirPath) + getQuota(humanName) 并行（allSettled——
 *   配额失败不挡文件列表，仅配额条降级）；
 * - 30s 静默轮询（usePoller；门控 = data.activeRef 顶层 tab 激活 &&
 *   404 停重试）；
 * - humanName = admin.humans find(matrixUserID === myUserId).name，fallback
 *   localpart(myUserId)（L2 模式 admin=null，humans 列表不可用；
 *   MyScopeCard 同款推导）；空 → 「无法识别当前用户」占位。
 *
 * 列职责（沿用 ManagePage 四域列模型）：
 * - l1（4 列 L1 列）：视图切换（我的文件 / 回收站）+ 面包屑（目录导航）
 *   + compact 列表（回收站行仅选中，操作在中栏详情）；
 * - mid：  配额卡（进度条 / 上传 / 新建文件夹；仅用量展示——设置/清除配额
 *          入口已迁「人员管理」人员详情，Q）+
 *          2/3/1 列 = tabs + 面包屑 + 完整列表；4 列 = tabs + 选中项详情；
 * - right：2/3 列 = 选中文件详情（下载 / 覆盖 / 删除）或回收站条目
 *          详情（恢复 / 彻底删）或提示。
 *
 * 权限（Controller 终裁；前端门控 best-effort = hasToken）：
 * - 回收站彻底删 = admin only（非 admin 按钮 disabled +
 *   tooltip「仅管理员」）；
 * - restore 409（目标路径已存在）：admin 二次确认 ?overwrite=1；
 *   非 admin 仅显错误。
 *
 * 降级：列表 404 = 「无权限或不存在」（任务书 UI 规则）→ 占位卡。
 */
import type * as ReactNS from "react";

import {
  deleteFile,
  downloadViaHost,
  getQuota,
  HumanFilesError,
  humanFileApiPath,
  listFiles,
  listTrash,
  purgeTrash,
  restoreTrash,
  writeFileSync,
  type HumanFileEntry,
  type HumanTrashEntry,
  type QuotaResponse,
} from "../api";
import { useThemeColors, type ThemeColors } from "../theme";
import { useT } from "../i18n";
import { usePoller } from "../usePoller";
import {
  DownloadIcon,
  FolderIcon,
  PageIcon,
  RefreshIcon,
  TrashIcon,
} from "../components/icons";
import { ReloadIcon } from "../components/WorkerManageShared";
import type { ManageNav } from "./useManageNav";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

/** 文件域自持状态（tabs / 列表 / 详情 / 配额卡共享）。 */
interface FilesState {
  humanName: string;
  /** L1 惯例：hasToken = 已配置 Controller 管理员 token（best-effort 门控）。 */
  isAdmin: boolean;
  view: "files" | "trash";
  /** 当前目录相对路径（空 = 根目录）。 */
  dirPath: string;
  files: HumanFileEntry[];
  trash: HumanTrashEntry[];
  quota: QuotaResponse | null;
  quotaFailed: boolean;
  loading: boolean;
  status: "" | "404" | "err";
  error: string;
  onSwitchView: (v: "files" | "trash") => void;
  onEnterDir: (p: string) => void;
  load: (silent: boolean) => void;
}

type SubProps = {
  t: ThemeColors;
  tr: Tr;
  nav: ManageNav;
  fs: FilesState;
};

/** 字节数 → 可读文本（— = 缺失/非法，诚实不造 0）。
 * 导出：PeopleSection 配额卡用量展示同源复用（Q）。 */
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
function fmtTs(s: string | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 行内小图标按钮（裸 <button> + title tooltip，同 PeopleSection 入口行风格）。 */
function iconBtnStyle(t: ThemeColors): ReactNS.CSSProperties {
  return {
    width: 30,
    height: 30,
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

/** 条目完整相对路径（文件行选中键 / API 路径）。 */
function fullPath(dirPath: string, name: string): string {
  return dirPath ? `${dirPath}/${name}` : name;
}

/** 回收站条目路径归一（Go 返回 "files/a.txt" → 相对路径 "a.txt"）。 */
function normTrashPath(p: string): string {
  return p.replace(/^files\//, "");
}

/** 统一错误 → i18n 文案（按 status/code 分支；413 区分 size vs quota）。
 * 导出：PeopleSection 配额保存/清除 403 提示同源复用（Q）。 */
export function hfErrorText(e: unknown, tr: Tr): string {
  if (e instanceof HumanFilesError) {
    switch (e.status) {
      case 400:
        return tr("路径非法");
      case 403:
        return tr("仅管理员");
      case 404:
        return tr("无权限或不存在");
      case 409:
        return tr("目标路径已存在");
      case 412:
        return tr("内容冲突（etag 不匹配）——刷新后重试");
      case 413:
        if (e.code === "size_exceeded") return tr("大小超限（单文件 ≤ 64MiB）");
        if (e.code === "quota_exceeded") return tr("配额已满");
        return tr("上传失败（大小超限或配额已满）");
      default:
        return e.message || `HTTP ${e.status}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** 恢复回收站条目（409 = 目标已存在：admin 二次确认 overwrite=1；非 admin 仅显错）。 */
async function doRestore(
  humanName: string,
  id: string,
  isAdmin: boolean,
  onDone: () => void,
  tr: Tr,
): Promise<void> {
  try {
    await restoreTrash(humanName, id);
    antd.message.success(tr("已恢复"));
    onDone();
  } catch (e) {
    if (e instanceof HumanFilesError && e.status === 409) {
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
            await restoreTrash(humanName, id, true);
            antd.message.success(tr("已恢复"));
            onDone();
          } catch (e2) {
            antd.message.error(hfErrorText(e2, tr));
          }
        },
      });
      return;
    }
    antd.message.error(hfErrorText(e, tr));
  }
}

/** 空/提示占位（right 列未选中、4 列 mid 未选中）。 */
function EmptyPick({
  t,
  title,
  sub,
}: {
  t: ThemeColors;
  title: string;
  sub?: string;
}) {
  return (
    <div style={{ padding: 12, textAlign: "center" }}>
      <PageIcon size={20} style={{ color: t.textSecondary, margin: "0 auto 6px" }} />
      <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{title}</div>
      {sub ? (
        <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>{sub}</div>
      ) : null}
    </div>
  );
}

/** 视图切换（我的文件 / 回收站）。 */
function ViewTabs({ t, tr, fs }: SubProps) {
  const btn = (v: "files" | "trash", label: string) => {
    const active = fs.view === v;
    return (
      <button
        type="button"
        onClick={() => fs.onSwitchView(v)}
        style={{
          flex: 1,
          padding: "5px 10px",
          fontSize: 12,
          fontWeight: 600,
          color: active ? t.text : t.textSecondary,
          background: active ? t.hoverBg : "transparent",
          border: `1px solid ${active ? t.border : "transparent"}`,
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {btn("files", tr("我的文件"))}
      {btn("trash", tr("回收站"))}
    </div>
  );
}

/** 面包屑目录导航（根 = 我的文件；点段进该层；↑ = 上级目录）。 */
function Breadcrumbs({ t, tr, fs }: SubProps) {
  const segs = fs.dirPath ? fs.dirPath.split("/").filter(Boolean) : [];
  const crumb = (label: string, active: boolean, onClick?: () => void) => (
    <button
      type="button"
      disabled={active}
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        fontSize: 12,
        fontWeight: active ? 700 : 600,
        color: active ? t.text : t.textSecondary,
        cursor: active ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2 }}>
      {crumb(tr("我的文件"), segs.length === 0, () => fs.onEnterDir(""))}
      {segs.map((s, i) => {
        const p = segs.slice(0, i + 1).join("/");
        const last = i === segs.length - 1;
        return (
          <React.Fragment key={p}>
            <span style={{ fontSize: 12, color: t.textSecondary }}>/</span>
            {crumb(s, last, last ? undefined : () => fs.onEnterDir(p))}
          </React.Fragment>
        );
      })}
      {segs.length > 0 ? (
        <button
          type="button"
          title={tr("上级目录")}
          aria-label={tr("上级目录")}
          style={iconBtnStyle(t)}
          onClick={() => fs.onEnterDir(segs.slice(0, -1).join(""))}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>↑</span>
        </button>
      ) : null}
    </div>
  );
}

/** 列表块：出错+重试 / 加载中 / 空态 / 行列表（compact = l1 列紧凑行）。 */
function ListArea({ t, tr, nav, fs, compact = false }: SubProps & { compact?: boolean }) {
  const count = fs.view === "trash" ? fs.trash.length : fs.files.length;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {!compact && fs.status !== "err" ? (
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("共 {n} 个条目", { n: count })}
        </span>
      ) : null}
      {fs.status === "err" && count === 0 ? (
        <>
          <antd.Alert
            type="warning"
            showIcon
            message={tr("加载失败")}
            description={fs.error}
          />
          <antd.Button size="small" onClick={() => fs.load(false)}>
            {tr("重试")}
          </antd.Button>
        </>
      ) : null}
      {fs.status !== "err" && fs.loading && count === 0 ? (
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
      {fs.status !== "err" && !fs.loading && count === 0 ? (
        <div
          style={{
            padding: "18px 8px",
            textAlign: "center",
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          {fs.view === "trash" ? tr("回收站为空") : tr("暂无文件")}
        </div>
      ) : null}
      {fs.view === "trash"
        ? fs.trash.map((e) => (
            <TrashRow key={e.id} entry={e} t={t} tr={tr} nav={nav} fs={fs} compact={compact} />
          ))
        : fs.files.map((e) => (
            <FileRow key={e.name} entry={e} t={t} tr={tr} nav={nav} fs={fs} compact={compact} />
          ))}
    </div>
  );
}

/** 文件行：目录行 = 点击进入；文件行 = 点击选中 + 行内 下载 / 删除(→回收站)。 */
function FileRow({
  entry,
  t,
  tr,
  nav,
  fs,
  compact = false,
}: SubProps & { entry: HumanFileEntry; compact?: boolean }) {
  const isDir = entry.type === "directory";
  const path = fullPath(fs.dirPath, entry.name);
  const sel = !isDir && nav.selectedFile === path;

  const activate = () => {
    if (isDir) fs.onEnterDir(path);
    else nav.selectFile(sel ? null : path);
  };
  const onDownload = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    void downloadViaHost(humanFileApiPath(fs.humanName, path), entry.name).then((ok) => {
      if (!ok) antd.message.error(tr("下载失败"));
    });
  };
  const onDelete = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    antd.Modal.confirm({
      title: tr("移入回收站？"),
      content: entry.name,
      okText: tr("删除"),
      cancelText: tr("取消"),
      onOk: async () => {
        try {
          await deleteFile(fs.humanName, path);
          antd.message.success(tr("已移入回收站"));
          if (nav.selectedFile === path) nav.selectFile(null);
          fs.load(true);
        } catch (err) {
          antd.message.error(hfErrorText(err, tr));
        }
      },
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      title={isDir ? tr("进入目录") : undefined}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      onMouseEnter={(e) => {
        if (!sel) e.currentTarget.style.background = t.hoverBg;
      }}
      onMouseLeave={(e) => {
        if (!sel) e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: compact ? 36 : 44,
        padding: "6px 8px",
        border: sel ? `1px solid ${t.border}` : "1px solid transparent",
        borderRadius: 8,
        cursor: "pointer",
        background: sel ? t.hoverBg : "transparent",
        width: "100%",
      }}
    >
      {isDir ? (
        <FolderIcon size={14} style={{ color: t.textSecondary, flexShrink: 0 }} />
      ) : (
        <PageIcon size={14} style={{ color: t.textSecondary, flexShrink: 0 }} />
      )}
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 12.5,
            color: t.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.name}
        </span>
        {compact ? null : isDir ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("目录")}
            {entry.updatedAt ? ` · ${fmtTs(entry.updatedAt)}` : ""}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("大小 {a} · 更新 {b}", {
              a: fmtBytes(entry.size),
              b: fmtTs(entry.updatedAt),
            })}
          </span>
        )}
      </span>
      {compact && !isDir ? (
        <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
          {fmtBytes(entry.size)}
        </span>
      ) : null}
      {!isDir ? (
        <>
          <button
            type="button"
            onClick={onDownload}
            title={tr("下载")}
            aria-label={tr("下载")}
            style={iconBtnStyle(t)}
          >
            <DownloadIcon size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title={tr("删除")}
            aria-label={tr("删除")}
            style={iconBtnStyle(t)}
          >
            <TrashIcon size={14} />
          </button>
        </>
      ) : null}
    </div>
  );
}

/** 回收站行：点击选中；完整行内联 恢复 / 彻底删（非 admin 彻底删 disabled
 * + 「仅管理员」）；compact 行仅选中（操作在中栏详情，见 l1 提示行）。 */
function TrashRow({
  entry,
  t,
  tr,
  nav,
  fs,
  compact = false,
}: SubProps & { entry: HumanTrashEntry; compact?: boolean }) {
  const p = normTrashPath(entry.path);
  const sel = nav.selectedFile === p;

  const onRestore = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    void doRestore(fs.humanName, entry.id, fs.isAdmin, () => fs.load(true), tr);
  };
  const onPurge = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    if (!fs.isAdmin) return;
    antd.Modal.confirm({
      title: tr("彻底删除此项？"),
      content: tr("此操作不可撤销"),
      okText: tr("彻底删除"),
      cancelText: tr("取消"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await purgeTrash(fs.humanName, entry.id);
          antd.message.success(tr("已彻底删除"));
          if (nav.selectedFile === p) nav.selectFile(null);
          fs.load(true);
        } catch (err) {
          antd.message.error(hfErrorText(err, tr));
        }
      },
    });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => nav.selectFile(sel ? null : p)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          nav.selectFile(sel ? null : p);
        }
      }}
      onMouseEnter={(e) => {
        if (!sel) e.currentTarget.style.background = t.hoverBg;
      }}
      onMouseLeave={(e) => {
        if (!sel) e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: compact ? 36 : 44,
        padding: "6px 8px",
        border: sel ? `1px solid ${t.border}` : "1px solid transparent",
        borderRadius: 8,
        cursor: "pointer",
        background: sel ? t.hoverBg : "transparent",
        width: "100%",
      }}
    >
      <TrashIcon size={14} style={{ color: t.textSecondary, flexShrink: 0 }} />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 12.5,
            color: t.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p}
        </span>
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("大小 {a} · 删除于 {b}", {
            a: fmtBytes(entry.size),
            b: fmtTs(entry.deletedAt),
          })}
        </span>
      </span>
      {compact ? null : (
        <>
          <button
            type="button"
            onClick={onRestore}
            title={tr("恢复文件")}
            aria-label={tr("恢复文件")}
            style={iconBtnStyle(t)}
          >
            <RefreshIcon size={14} />
          </button>
          <button
            type="button"
            onClick={onPurge}
            disabled={!fs.isAdmin}
            title={fs.isAdmin ? tr("彻底删除") : tr("仅管理员")}
            aria-label={tr("彻底删除")}
            style={{
              ...iconBtnStyle(t),
              opacity: fs.isAdmin ? 1 : 0.4,
              cursor: fs.isAdmin ? "pointer" : "not-allowed",
            }}
          >
            <TrashIcon size={14} />
          </button>
        </>
      )}
    </div>
  );
}

/** 配额卡：仅用量展示（进度条（quotaBytes null = 无限制）+ 上传 / 新建文件夹）。
 * 设置/清除配额入口已迁「人员管理」人员详情（Q）——本卡不再提供。 */
function QuotaCard({ t, tr, fs }: SubProps) {
  const [upBusy, setUpBusy] = React.useState(false);
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderBusy, setFolderBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const q = fs.quota;
  const hasLimit = q !== null && typeof q.quotaBytes === "number" && (q.quotaBytes ?? 0) > 0;
  const percent =
    hasLimit && q ? Math.min(100, Math.round(((q.usedBytes ?? 0) / (q.quotaBytes as number)) * 100)) : 0;

  const onUploadPick = async (e: ReactNS.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUpBusy(true);
    try {
      await writeFileSync(fs.humanName, fullPath(fs.dirPath, f.name), f);
      antd.message.success(tr("上传成功"));
      fs.load(true);
    } catch (err) {
      antd.message.error(hfErrorText(err, tr));
    } finally {
      setUpBusy(false);
    }
  };
  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) {
      antd.message.warning(tr("请输入文件夹名"));
      return;
    }
    setFolderBusy(true);
    try {
      await writeFileSync(fs.humanName, `${fullPath(fs.dirPath, name)}/.keep`, "");
      antd.message.success(tr("文件夹已创建"));
      setFolderOpen(false);
      setFolderName("");
      fs.load(true);
    } catch (err) {
      antd.message.error(hfErrorText(err, tr));
    } finally {
      setFolderBusy(false);
    }
  };

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: 10,
        display: "grid",
        gap: 8,
        background: t.cardBg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <FolderIcon size={14} style={{ color: t.textSecondary, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 12.5, color: t.text }}>
          {tr("存储配额")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button
          type="text"
          size="small"
          icon={<ReloadIcon />}
          title={tr("刷新")}
          aria-label={tr("刷新")}
          onClick={() => fs.load(false)}
        />
      </div>
      <span style={{ fontSize: 11, color: t.textSecondary }}>
        {tr("容量配额在「人员管理」中设置")}
      </span>
      {fs.quotaFailed ? (
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("配额获取失败")}
        </span>
      ) : q ? (
        hasLimit ? (
          <>
            <antd.Progress percent={percent} size="small" />
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("已用 {a} / 共 {b}", {
                a: fmtBytes(q.usedBytes),
                b: fmtBytes(q.quotaBytes ?? undefined),
              })}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("配额")}: {tr("无限制")} · {tr("已用 {a}", { a: fmtBytes(q.usedBytes) })}
          </span>
        )
      ) : (
        <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("加载中…")}</span>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <antd.Button size="small" loading={upBusy} onClick={() => fileRef.current?.click()}>
          {tr("上传文件")}
        </antd.Button>
        <input
          ref={fileRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => void onUploadPick(e)}
          aria-hidden="true"
          tabIndex={-1}
        />
        <antd.Button size="small" onClick={() => { setFolderName(""); setFolderOpen(true); }}>
          {tr("新建文件夹")}
        </antd.Button>
      </div>
      <antd.Modal
        open={folderOpen}
        title={tr("新建文件夹")}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={folderBusy}
        onOk={() => void createFolder()}
        onCancel={() => setFolderOpen(false)}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
          <antd.Input
            value={folderName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFolderName(e.target.value)}
            onPressEnter={() => void createFolder()}
            placeholder={tr("请输入文件夹名")}
            aria-label={tr("请输入文件夹名")}
          />
        </div>
      </antd.Modal>
    </div>
  );
}

/** 选中文件详情：meta + 下载 / 覆盖上传 / 删除(→回收站)。 */
function FileDetail({ t, tr, nav, fs }: SubProps) {
  const [busy, setBusy] = React.useState<"" | "download" | "overwrite">("");
  const owRef = React.useRef<HTMLInputElement | null>(null);
  const sel = nav.selectedFile;
  const entry = sel
    ? fs.files.find((e) => e.type === "file" && fullPath(fs.dirPath, e.name) === sel)
    : undefined;

  if (!entry) {
    return (
      <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: t.textSecondary }}>
        {tr("所选文件已不在最新数据中")}
      </div>
    );
  }
  const path = fullPath(fs.dirPath, entry.name);

  const onDownload = async () => {
    setBusy("download");
    const ok = await downloadViaHost(humanFileApiPath(fs.humanName, path), entry.name);
    setBusy("");
    if (!ok) antd.message.error(tr("下载失败"));
  };
  const onOverwritePick = async (e: ReactNS.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("overwrite");
    try {
      await writeFileSync(fs.humanName, path, file);
      antd.message.success(tr("上传成功"));
      fs.load(true);
    } catch (err) {
      antd.message.error(hfErrorText(err, tr));
    } finally {
      setBusy("");
    }
  };
  const onDelete = () => {
    antd.Modal.confirm({
      title: tr("移入回收站？"),
      content: entry.name,
      okText: tr("删除"),
      cancelText: tr("取消"),
      onOk: async () => {
        try {
          await deleteFile(fs.humanName, path);
          antd.message.success(tr("已移入回收站"));
          nav.selectFile(null);
          fs.load(true);
        } catch (err) {
          antd.message.error(hfErrorText(err, tr));
        }
      },
    });
  };

  return (
    <div style={{ display: "grid", gap: 10, padding: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <PageIcon size={20} style={{ color: t.textSecondary, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: t.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.name}
          </span>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("大小 {a} · 更新 {b}", {
              a: fmtBytes(entry.size),
              b: fmtTs(entry.updatedAt),
            })}
          </span>
          <span
            style={{
              fontSize: 11,
              color: t.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {path}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <antd.Button
          size="small"
          type="primary"
          loading={busy === "download"}
          onClick={() => void onDownload()}
        >
          {tr("下载")}
        </antd.Button>
        <antd.Button
          size="small"
          loading={busy === "overwrite"}
          onClick={() => owRef.current?.click()}
        >
          {tr("覆盖上传")}
        </antd.Button>
        <input
          ref={owRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => void onOverwritePick(e)}
          aria-hidden="true"
          tabIndex={-1}
        />
        <antd.Button size="small" danger onClick={onDelete}>
          {tr("删除")}
        </antd.Button>
      </div>
    </div>
  );
}

/** 选中回收站条目详情：meta + 恢复 / 彻底删（admin 门控）。 */
function TrashDetail({ t, tr, nav, fs }: SubProps) {
  const [busy, setBusy] = React.useState<"" | "restore">("");
  const sel = nav.selectedFile;
  const entry = sel ? fs.trash.find((e) => normTrashPath(e.path) === sel) : undefined;

  if (!entry) {
    return (
      <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: t.textSecondary }}>
        {tr("所选文件已不在最新数据中")}
      </div>
    );
  }

  const onRestore = async () => {
    setBusy("restore");
    await doRestore(
      fs.humanName,
      entry.id,
      fs.isAdmin,
      () => nav.selectFile(null),
      tr,
    );
    setBusy("");
  };
  const onPurge = () => {
    antd.Modal.confirm({
      title: tr("彻底删除此项？"),
      content: tr("此操作不可撤销"),
      okText: tr("彻底删除"),
      cancelText: tr("取消"),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await purgeTrash(fs.humanName, entry.id);
          antd.message.success(tr("已彻底删除"));
          nav.selectFile(null);
          fs.load(true);
        } catch (err) {
          antd.message.error(hfErrorText(err, tr));
        }
      },
    });
  };

  return (
    <div style={{ display: "grid", gap: 10, padding: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <TrashIcon size={20} style={{ color: t.textSecondary, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1, display: "grid", gap: 2 }}>
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: t.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {normTrashPath(entry.path)}
          </span>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("大小 {a} · 删除于 {b}", {
              a: fmtBytes(entry.size),
              b: fmtTs(entry.deletedAt),
            })}
          </span>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {entry.caller} · {entry.role}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <antd.Button
          size="small"
          type="primary"
          loading={busy === "restore"}
          onClick={() => void onRestore()}
        >
          {tr("恢复文件")}
        </antd.Button>
        <antd.Button
          size="small"
          danger
          disabled={!fs.isAdmin}
          title={fs.isAdmin ? undefined : tr("仅管理员")}
          onClick={onPurge}
        >
          {tr("彻底删除")}
        </antd.Button>
      </div>
    </div>
  );
}

export default function FilesSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const tr = useT();

  // ── humanName 推导：L1 humans 列表（matrixUserID → name）优先；
  // fallback localpart(myUserId)（L2 模式 admin=null，列表不可用）。
  const myUserId = data.myUserId ?? "";
  const humanName =
    data.admin?.humans.find((h) => h.matrixUserID === myUserId)?.name ??
    myUserId.replace(/^@/, "").split(":")[0];

  // ── 组件自持状态（files 域进入即取数；切域卸载即停）──
  const [view, setView] = React.useState<"files" | "trash">("files");
  const [dirPath, setDirPath] = React.useState("");
  const [files, setFiles] = React.useState<HumanFileEntry[]>([]);
  const [trash, setTrash] = React.useState<HumanTrashEntry[]>([]);
  const [quota, setQuota] = React.useState<QuotaResponse | null>(null);
  const [quotaFailed, setQuotaFailed] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [status, setStatus] = React.useState<"" | "404" | "err">("");
  const [error, setError] = React.useState("");
  const reqRef = React.useRef(0);

  const load = React.useCallback(
    async (silent: boolean) => {
      if (!humanName) return;
      const req = ++reqRef.current;
      // 静默刷新接管可见 loading（防「可见→静默」交错卡 loading=true）。
      if (silent) setLoading(false);
      else setLoading(true);
      const [ls, qs] = await Promise.allSettled([
        view === "trash"
          ? listTrash(humanName).then((r) => r.entries)
          : listFiles(humanName, dirPath).then((r) => r.entries),
        getQuota(humanName),
      ]);
      if (req !== reqRef.current) return; // 过期响应（视图/目录已切换）
      if (ls.status === "fulfilled") {
        if (view === "trash") setTrash(ls.value as HumanTrashEntry[]);
        else setFiles(ls.value as HumanFileEntry[]);
        setStatus("");
        setError("");
      } else if (ls.reason instanceof HumanFilesError && ls.reason.status === 404) {
        // 404 = 无权限或不存在（任务书 UI 规则）→ 占位卡，轮询停重试。
        setStatus("404");
        setError("");
      } else {
        setStatus("err");
        setError(hfErrorText(ls.reason, tr));
      }
      if (qs.status === "fulfilled") {
        setQuota(qs.value);
        setQuotaFailed(false);
      } else {
        setQuotaFailed(true);
      }
      if (!silent) setLoading(false);
    },
    [humanName, view, dirPath, tr],
  );

  // 进入域 / 切视图 / 换目录 / 语言变化 → 取数（load 身份随之变）。
  React.useEffect(() => {
    if (!humanName) return;
    void load(false);
  }, [load, humanName]);

  // 30s 静默轮询：activeRef = 顶层 tab 激活门（稳定 ref，tick 时读）；
  // 404（无权限/不存在）停重试。
  usePoller({
    fn: () => {
      if (data.activeRef && !data.activeRef.current) return;
      if (!humanName || status === "404") return;
      void load(true);
    },
    intervalMs: 30000,
  });

  if (!humanName) {
    return (
      <div style={{ padding: 8 }}>
        <antd.Alert
          type="warning"
          showIcon
          message={tr("无法识别当前用户")}
          description={tr("请通过 Matrix 登录后再使用文件管理。")}
        />
      </div>
    );
  }
  if (status === "404") {
    return (
      <div style={{ padding: 8 }}>
        <antd.Alert
          type="info"
          showIcon
          message={tr("无权限或不存在")}
          description={tr("当前账号无法访问该 Human 的文件，或 Human 不存在。")}
        />
      </div>
    );
  }

  const fs: FilesState = {
    humanName,
    isAdmin: !!data.hasToken,
    view,
    dirPath,
    files,
    trash,
    quota,
    quotaFailed,
    loading,
    status,
    error,
    onSwitchView: (v) => {
      if (v === view) return;
      nav.selectFile(null);
      setView(v);
    },
    onEnterDir: (p) => {
      nav.selectFile(null);
      setDirPath(p);
    },
    load: (silent) => void load(silent),
  };
  const sub: SubProps = { t, tr, nav, fs };

  const selectedEntry =
    view === "files"
      ? files.find((e) => e.type === "file" && fullPath(dirPath, e.name) === nav.selectedFile)
      : trash.find((e) => normTrashPath(e.path) === nav.selectedFile);

  if (variant === "l1") {
    return (
      <div style={{ display: "grid", gap: 8, padding: 8 }}>
        <ViewTabs {...sub} />
        {view === "files" ? (
          <Breadcrumbs {...sub} />
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("恢复 / 彻底删除在中栏行操作")}
          </span>
        )}
        <ListArea {...sub} compact />
      </div>
    );
  }

  if (variant === "mid" || variant === "full") {
    const detail =
      cols === 4 && variant === "mid" ? (
        selectedEntry ? (
          view === "files" ? <FileDetail {...sub} /> : <TrashDetail {...sub} />
        ) : (
          <EmptyPick
            t={t}
            title={view === "files" ? tr("选择文件") : tr("回收站")}
            sub={
              view === "files"
                ? tr("点左侧列表中的文件查看操作")
                : tr("恢复 / 彻底删除在中栏行操作")
            }
          />
        )
      ) : (
        <ListArea {...sub} />
      );
    return (
      <div style={{ display: "grid", gap: 10, padding: 4 }}>
        <QuotaCard {...sub} />
        <ViewTabs {...sub} />
        {view === "files" ? <Breadcrumbs {...sub} /> : null}
        {detail}
      </div>
    );
  }

  // right（仅 2/3 栏——4 栏 files 无右栏，详情在中栏，见 ManagePage sectionNoRight）。
  return selectedEntry ? (
    view === "files" ? <FileDetail {...sub} /> : <TrashDetail {...sub} />
  ) : (
    <EmptyPick
      t={t}
      title={view === "files" ? tr("选择文件") : tr("回收站")}
      sub={
        view === "files"
          ? tr("点中栏文件行查看下载 / 覆盖 / 删除")
          : tr("恢复 / 彻底删除在中栏行操作")
      }
    />
  );
}
