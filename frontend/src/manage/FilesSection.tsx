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
 * 列职责（沿用 ManagePage 四域列模型；16.67 排版 / 去重）：
 * - l1（4 列 L1 列）：视图切换（我的文件 / 回收站）+ 面包屑（目录导航，
 *   根层不渲染——「我的文件」已由 tab 表达）+ compact 列表（回收站行仅选中，
 *   操作在中栏详情）；
 * - mid：  工具条（左 = 配额进度 + 用量文案；右 = 上传文件 / 新建文件夹 / 刷新——
 *          页面级动作按钮唯一入口；设置/清除配额在「人员管理」人员详情，Q）+
 *          同步状态紧凑条（仅 ok 渲染，单行：条目·墓碑·代 + 导出/复制放行尾）+
 *          列表头（视图切换 + 递归开关同行）+ 面包屑（仅 dirPath 非空）+
 *          2/3/1 列 = 完整列表（名称 / 大小 / 更新时间(删除时间) / 操作，
 *          行高 36px，目录大小 = —）；4 列 = tabs + 选中项详情；
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
  DirListGuard,
  downloadPresignedUrl,
  downloadTextFile,
  downloadViaHost,
  entryDisplayName,
  entryRelPath,
  getQuota,
  getSyncManifest,
  getSyncStatus,
  HumanFilesError,
  humanFileApiPath,
  isEntryDir,
  isTicketExpired,
  listFiles,
  listTrash,
  presignDownload,
  purgeTrash,
  restoreTrash,
  shouldFallbackToDirect,
  uploadFile,
  writeFileSync,
  type HumanFileEntry,
  type HumanFileListResponse,
  type HumanTrashEntry,
  type QuotaResponse,
  type SyncStatus,
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
  /** #1518 递归平铺（仅新控制器；老控制器探测后 toggle 禁用）。 */
  recursive: boolean;
  /** 老控制器探测结果（一次性）：false = 递归/游标不可用 → toggle 禁用。 */
  canRecursive: boolean;
  /** #1518 游标：string = 有下一页（显「加载更多」）；null = 到底；
   * undefined = 老控制器（无分页）。 */
  nextKey: string | null | undefined;
  loadingMore: boolean;
  onSwitchView: (v: "files" | "trash") => void;
  onEnterDir: (p: string) => void;
  onToggleRecursive: (on: boolean) => void;
  load: (silent: boolean) => void;
  loadMore: () => void;
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

/** 16.67 面包屑决策（纯函数；tests/files-ui-1667.test.ts 断言）：
 * 根层（dirPath = ""）→ 整行不渲染（visible=false；「我的文件」已由
 * 视图切换 tab 表达，根部段不再出现）；非根 → 仅路径段（不含「我的文件」
 * 根段；↑ 上级按钮由组件单独渲染）。 */
export function breadcrumbParts(dirPath: string): {
  visible: boolean;
  segments: string[];
} {
  const segments = dirPath.split("/").filter(Boolean);
  return { visible: segments.length > 0, segments };
}

/** 16.67 同步卡收敛（纯函数；tests/files-ui-1667.test.ts 断言）：
 * 仅 state = ok 渲染（单行紧凑条）；empty / denied / unsupported / 未取 →
 * 不渲染（不占版面）。 */
export function syncCardVisible(
  state: SyncStatus["state"] | null | undefined,
): boolean {
  return state === "ok";
}

/** 16.67 大小列（纯函数）：目录 → 「—」（不显 0 / 0 B）；
 * 文件 → fmtBytes（缺失/非法 → 「—」）。 */
export function sizeCell(entry: HumanFileEntry): string {
  return isEntryDir(entry) ? "—" : fmtBytes(entry.size);
}

/** 16.67 列表列模板（表头行与数据行共用 → 列宽稳定）：
 * 名称（伸缩）/ 大小 / 时间（更新·删除）/ 操作（定宽）。 */
const LIST_GRID = "minmax(0, 1fr) 72px 120px 64px";

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

/** 行 → 文件相对路径（双形态）：新形态 = entry.path 剥 files/ 前缀；
 * 老形态 = dirPath/name。选中键 / 下载 / 删除 / 上传全走此值。 */
function rowPath(e: HumanFileEntry, dirPath: string): string {
  return e.path ? entryRelPath(e) : fullPath(dirPath, e.name ?? "");
}

/** 大文件阈值（#1501 建议值 8 MiB）：≥ 走预签名 URL（免代理长流）；
 * 以下保持现有直下（零行为变化）。 */
const LARGE_FILE_BYTES = 8 * 1024 * 1024;

/** 统一下载入口（#1501）：
 * - size ≥ 8MiB → presignDownload 取票；expiresAt 过期（UI 判）→ 重取一次；
 *   预签名不可用（shouldFallbackToDirect：404/405/5xx）→ 回落现有直下；
 *   其余错误 → 报文案不下载；票取到但 URL 拉取失败 → 回落直下。
 * - size < 8MiB / 未知 → 现有 downloadViaHost 直下（零变化）。
 * 返回是否成功（失败 UI 已自报文案或返回 false 由调用方报「下载失败」）。 */
async function doDownload(
  humanName: string,
  path: string,
  name: string,
  size: number | undefined,
  tr: Tr,
): Promise<boolean> {
  if (typeof size === "number" && size >= LARGE_FILE_BYTES) {
    let r = await presignDownload(humanName, path);
    if (r.ok && isTicketExpired(r.value.expiresAt)) {
      // 过期重取一次；重取仍失败且非回落集合 → 报错。
      const r2 = await presignDownload(humanName, path);
      if (r2.ok) r = r2;
      else if (!shouldFallbackToDirect(r2.status)) {
        antd.message.error(hfErrorText(new HumanFilesError(r2.status, r2.message, r2.code), tr));
        return false;
      }
    }
    if (!r.ok) {
      if (shouldFallbackToDirect(r.status)) {
        // 预签名不可用 → 下方回落直下。
      } else {
        antd.message.error(hfErrorText(new HumanFilesError(r.status, r.message, r.code), tr));
        return false;
      }
    } else {
      const ok = await downloadPresignedUrl(r.value.url, name);
      if (ok) return true;
      // URL 拉取失败 → 下方回落直下。
    }
  }
  return downloadViaHost(humanFileApiPath(humanName, path), name);
}

/** 统一错误 → i18n 文案（按 status/code 分支；413 区分 size vs quota）。
 * 导出：PeopleSection 配额保存/清除 403 提示同源复用（Q）。 */
export function hfErrorText(e: unknown, tr: Tr): string {
  if (e instanceof HumanFilesError) {
    // #1519 前端拦截：file.size > presign maxBytes（status=0，message=上限字节）。
    if (e.code === "max_bytes") {
      return tr("文件超过预签名上传上限（最大 {a}）", { a: fmtBytes(Number(e.message) || 0) });
    }
    switch (e.status) {
      case 400:
        return tr("路径非法");
      case 403:
        return tr("仅管理员");
      case 404:
        // #1519 commit：对象已被服务端删 → 「需重新上传」。
        if (e.code === "object_missing") return tr("上传失败（对象不存在）——请重新上传");
        return tr("无权限或不存在");
      case 409:
        // #1519 commit：checksum 不匹配（对象已被服务端删）→ 「需重新上传」；
        // 其余 409 = restore 目标路径已存在（旧语义不变）。
        if (e.code === "checksum_mismatch")
          return tr("上传校验失败（checksum 不匹配）——请重新上传");
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

/** 面包屑目录导航（16.67：根层不渲染整行——「我的文件」已由视图切换
 * tab 表达，根部段不再出现；非根 = 仅路径段 + ↑ 上级目录）。 */
function Breadcrumbs({ t, tr, fs }: SubProps) {
  const { visible, segments } = breadcrumbParts(fs.dirPath);
  if (!visible) return null;
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
      {segments.map((s, i) => {
        const p = segments.slice(0, i + 1).join("/");
        const last = i === segments.length - 1;
        return (
          <React.Fragment key={p}>
            {i > 0 ? (
              <span style={{ fontSize: 12, color: t.textSecondary }}>/</span>
            ) : null}
            {crumb(s, last, last ? undefined : () => fs.onEnterDir(p))}
          </React.Fragment>
        );
      })}
      <button
        type="button"
        title={tr("上级目录")}
        aria-label={tr("上级目录")}
        style={iconBtnStyle(t)}
        onClick={() => fs.onEnterDir(segments.slice(0, -1).join("/"))}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>↑</span>
      </button>
    </div>
  );
}

/** 列表块：出错+重试 / 加载中 / 空态（居中一句 + 主 CTA 文字链接，指向
 * 工具条同一处理函数）/ 表头行 + 行列表（compact = l1 列紧凑行）。 */
function ListArea({
  t,
  tr,
  nav,
  fs,
  actions,
  compact = false,
}: SubProps & { actions: FilesActions; compact?: boolean }) {
  const count = fs.view === "trash" ? fs.trash.length : fs.files.length;
  const filesView = fs.view === "files";
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
        <div style={{ padding: "18px 8px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {filesView ? tr("暂无文件") : tr("回收站为空")}
          </div>
          {/* 16.67：空态 CTA = 文字链接（type="link"，非按钮），
           * 指向工具条「上传文件」的同一处理函数（actions 共享）。 */}
          {filesView ? (
            <antd.Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              onClick={actions.onUploadClick}
            >
              {tr("上传一个文件")}
            </antd.Button>
          ) : null}
        </div>
      ) : null}
      {/* 16.67 列表表头行：名称 / 大小 / 更新时间(删除时间) / 操作——
       * 与数据行共用 LIST_GRID 模板（列宽稳定）。 */}
      {!compact && fs.status !== "err" && !fs.loading && count > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: LIST_GRID,
            gap: 8,
            alignItems: "center",
            padding: "0 8px",
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          <span>{tr("名称")}</span>
          <span style={{ textAlign: "right" }}>{tr("大小")}</span>
          <span>{filesView ? tr("更新时间") : tr("删除时间")}</span>
          <span>{tr("操作")}</span>
        </div>
      ) : null}
      {fs.view === "trash"
        ? fs.trash.map((e) => (
            <TrashRow key={e.id} entry={e} t={t} tr={tr} nav={nav} fs={fs} compact={compact} />
          ))
        : fs.files.map((e) => (
            <FileRow
              key={rowPath(e, fs.dirPath) || entryDisplayName(e)}
              entry={e}
              t={t}
              tr={tr}
              nav={nav}
              fs={fs}
              compact={compact}
            />
          ))}
      {/* #1518：仅 nextKey 为 string（满页还有下一页）时显「加载更多」；
       * null = 到底、undefined = 老控制器无分页。 */}
      {!compact && fs.view === "files" && typeof fs.nextKey === "string" ? (
        <antd.Button size="small" block loading={fs.loadingMore} onClick={() => fs.loadMore()}>
          {tr("加载更多")}
        </antd.Button>
      ) : null}
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
  const isDir = isEntryDir(entry);
  const name = entryDisplayName(entry);
  const path = rowPath(entry, fs.dirPath);
  const sel = !isDir && nav.selectedFile === path;
  // 递归平铺模式下目录行不导航（避免模式切换丢游标）——非交互行。
  const dirInteractive = isDir && !fs.recursive;

  const activate = () => {
    if (isDir) {
      if (dirInteractive) fs.onEnterDir(path);
      return;
    }
    nav.selectFile(sel ? null : path);
  };
  const onDownload = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    void doDownload(fs.humanName, path, name, entry.size, tr).then((ok) => {
      if (!ok) antd.message.error(tr("下载失败"));
    });
  };
  const onDelete = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    antd.Modal.confirm({
      title: tr("移入回收站？"),
      content: name,
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

  const nameCell = (
    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      {isDir ? (
        <FolderIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
      ) : (
        <PageIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
      )}
      <span
        // 新形态（递归平铺）hover 显相对全路径，便于区分同名条目。
        title={entry.path ? path : undefined}
        style={{
          fontWeight: 600,
          fontSize: 12,
          color: t.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
        {isDir ? " ›" : ""}
      </span>
    </span>
  );
  const actionsCell = isDir ? (
    <span />
  ) : (
    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        onClick={onDownload}
        title={tr("下载")}
        aria-label={tr("下载")}
        style={iconBtnStyle(t)}
      >
        <DownloadIcon size={16} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        title={tr("删除")}
        aria-label={tr("删除")}
        style={iconBtnStyle(t)}
      >
        <TrashIcon size={16} />
      </button>
    </span>
  );
  const rowSkin = sel
    ? { border: `1px solid ${t.border}`, background: t.hoverBg }
    : { border: "1px solid transparent", background: "transparent" };

  if (compact) {
    // l1 列紧凑行：单行（图标 + 名称 + 文件大小），无时间/操作列。
    return (
      <div
        role="button"
        tabIndex={0}
        title={dirInteractive ? tr("进入目录") : undefined}
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
          minHeight: 36,
          padding: "0 8px",
          borderRadius: 6,
          cursor: dirInteractive || !isDir ? "pointer" : "default",
          width: "100%",
          ...rowSkin,
        }}
      >
        {nameCell}
        {isDir ? null : (
          <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
            {sizeCell(entry)}
          </span>
        )}
      </div>
    );
  }

  // 16.67 列表行（非 compact）：四列 grid（名称/大小/更新时间/操作），
  // 行高 36px；目录行整行点击进入，文件行整行选中，行内按钮
  // stopPropagation；etag 不在行内展示（详情面板保留，避免第五列）。
  return (
    <div
      role="button"
      tabIndex={0}
      title={dirInteractive ? tr("进入目录") : undefined}
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
        display: "grid",
        gridTemplateColumns: LIST_GRID,
        gap: 8,
        alignItems: "center",
        height: 36,
        padding: "0 8px",
        borderRadius: 6,
        cursor: dirInteractive || !isDir ? "pointer" : "default",
        width: "100%",
        ...rowSkin,
      }}
    >
      {nameCell}
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
        {sizeCell(entry)}
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
        {fmtTs(entry.updatedAt)}
      </span>
      {actionsCell}
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

  const select = () => nav.selectFile(sel ? null : p);
  const nameCell = (
    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <TrashIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
      <span
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
  );
  const rowSkin = sel
    ? { border: `1px solid ${t.border}`, background: t.hoverBg }
    : { border: "1px solid transparent", background: "transparent" };
  const rowHandlers = {
    onClick: select,
    onKeyDown: (e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    },
    onMouseEnter: (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      if (!sel) e.currentTarget.style.background = t.hoverBg;
    },
    onMouseLeave: (e: ReactNS.MouseEvent<HTMLDivElement>) => {
      if (!sel) e.currentTarget.style.background = "transparent";
    },
  };

  if (compact) {
    // l1 列紧凑行：单行（图标 + 路径），仅选中（操作在中栏详情）。
    return (
      <div
        role="button"
        tabIndex={0}
        {...rowHandlers}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          padding: "0 8px",
          borderRadius: 6,
          cursor: "pointer",
          width: "100%",
          ...rowSkin,
        }}
      >
        {nameCell}
      </div>
    );
  }

  // 16.67 回收站行（非 compact）：四列 grid（名称/大小/删除时间/操作），
  // 行高 36px；行内 恢复/彻底删 stopPropagation（彻底删 admin 门控）。
  return (
    <div
      role="button"
      tabIndex={0}
      {...rowHandlers}
      style={{
        display: "grid",
        gridTemplateColumns: LIST_GRID,
        gap: 8,
        alignItems: "center",
        height: 36,
        padding: "0 8px",
        borderRadius: 6,
        cursor: "pointer",
        width: "100%",
        ...rowSkin,
      }}
    >
      {nameCell}
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
        {fmtBytes(entry.size)}
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
        {fmtTs(entry.deletedAt)}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
        <button
          type="button"
          onClick={onRestore}
          title={tr("恢复文件")}
          aria-label={tr("恢复文件")}
          style={iconBtnStyle(t)}
        >
          <RefreshIcon size={16} />
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
          <TrashIcon size={16} />
        </button>
      </span>
    </div>
  );
}

/** 16.67 页面级动作按钮（上传文件/新建文件夹）的唯一入口状态 + 处理器：
 * 工具条按钮与列表空态 CTA 文字链接共享同一 handlers——同一动作在页面上
 * 只出现一处按钮（设置/清除配额仍在「人员管理」人员详情，Q）。
 * 由根组件调用（早于早退 return，hooks 顺序稳定），handlers 闭包持有
 * 最新 humanName/dirPath/load。 */
interface FilesActions {
  upBusy: boolean;
  fileRef: ReactNS.MutableRefObject<HTMLInputElement | null>;
  /** 打开系统文件选择（工具条「上传文件」按钮 + 空态 CTA 共用）。 */
  onUploadClick: () => void;
  onUploadPick: (e: ReactNS.ChangeEvent<HTMLInputElement>) => void;
  folderOpen: boolean;
  folderName: string;
  folderBusy: boolean;
  setFolderName: (v: string) => void;
  openFolderModal: () => void;
  closeFolderModal: () => void;
  createFolder: () => void;
}

function useFilesActions(
  inp: { humanName: string; dirPath: string; load: (silent: boolean) => void },
  tr: Tr,
): FilesActions {
  const [upBusy, setUpBusy] = React.useState(false);
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderBusy, setFolderBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const onUploadPick = async (e: ReactNS.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUpBusy(true);
    try {
      // #1519 预签名上传（500/501 → 内部自动回落直传；commit 成功才算成功）。
      await uploadFile(inp.humanName, fullPath(inp.dirPath, f.name), f);
      antd.message.success(tr("上传成功"));
      inp.load(true);
    } catch (err) {
      antd.message.error(hfErrorText(err, tr));
    } finally {
      setUpBusy(false);
    }
  };
  const createFolderInner = async () => {
    const name = folderName.trim();
    if (!name) {
      antd.message.warning(tr("请输入文件夹名"));
      return;
    }
    setFolderBusy(true);
    try {
      await writeFileSync(inp.humanName, `${fullPath(inp.dirPath, name)}/.keep`, "");
      antd.message.success(tr("文件夹已创建"));
      setFolderOpen(false);
      setFolderName("");
      inp.load(true);
    } catch (err) {
      antd.message.error(hfErrorText(err, tr));
    } finally {
      setFolderBusy(false);
    }
  };

  return {
    upBusy,
    fileRef,
    onUploadClick: () => fileRef.current?.click(),
    onUploadPick: (e) => void onUploadPick(e),
    folderOpen,
    folderName,
    folderBusy,
    setFolderName,
    openFolderModal: () => {
      setFolderName("");
      setFolderOpen(true);
    },
    closeFolderModal: () => setFolderOpen(false),
    createFolder: () => void createFolderInner(),
  };
}

/** 16.67 工具条（取代旧配额卡）：一行——左 = 配额进度 + 用量文案
 * （hover 显「容量配额在『人员管理』中设置」）；右 = 操作按钮组
 * （上传文件 / 新建文件夹 / 刷新——页面级动作唯一入口）；
 * 窄栏（<720px）自动换行不重叠。 */
function FilesToolbar({ t, tr, fs, actions }: SubProps & { actions: FilesActions }) {
  const q = fs.quota;
  const hasLimit = q !== null && typeof q.quotaBytes === "number" && (q.quotaBytes ?? 0) > 0;
  const percent =
    hasLimit && q
      ? Math.min(100, Math.round(((q.usedBytes ?? 0) / (q.quotaBytes as number)) * 100))
      : 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: "8px 10px",
        background: t.cardBg,
      }}
    >
      <div
        title={tr("容量配额在「人员管理」中设置")}
        style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 240px", minWidth: 0 }}
      >
        <FolderIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
        {fs.quotaFailed ? (
          <span style={{ fontSize: 12, color: t.textSecondary, whiteSpace: "nowrap" }}>
            {tr("配额获取失败")}
          </span>
        ) : q ? (
          hasLimit ? (
            <>
              <antd.Progress
                percent={percent}
                size="small"
                style={{ width: 120, margin: 0, flexShrink: 0 }}
              />
              <span style={{ fontSize: 12, color: t.textSecondary, whiteSpace: "nowrap" }}>
                {tr("已用 {a} / 共 {b}", {
                  a: fmtBytes(q.usedBytes),
                  b: fmtBytes(q.quotaBytes ?? undefined),
                })}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: t.textSecondary, whiteSpace: "nowrap" }}>
              {tr("配额")}: {tr("无限制")} · {tr("已用 {a}", { a: fmtBytes(q.usedBytes) })}
            </span>
          )
        ) : (
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("加载中…")}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <antd.Button size="small" loading={actions.upBusy} onClick={actions.onUploadClick}>
          {tr("上传文件")}
        </antd.Button>
        <antd.Button size="small" onClick={actions.openFolderModal}>
          {tr("新建文件夹")}
        </antd.Button>
        <antd.Button
          type="text"
          size="small"
          icon={<ReloadIcon />}
          title={tr("刷新")}
          aria-label={tr("刷新")}
          onClick={() => fs.load(false)}
        />
      </div>
      <input
        ref={actions.fileRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => actions.onUploadPick(e)}
        aria-hidden="true"
        tabIndex={-1}
      />
      <antd.Modal
        open={actions.folderOpen}
        title={tr("新建文件夹")}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={actions.folderBusy}
        onOk={actions.createFolder}
        onCancel={actions.closeFolderModal}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
          <antd.Input
            value={actions.folderName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              actions.setFolderName(e.target.value)
            }
            onPressEnter={actions.createFolder}
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
    ? fs.files.find((e) => !isEntryDir(e) && rowPath(e, fs.dirPath) === sel)
    : undefined;

  if (!entry) {
    return (
      <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: t.textSecondary }}>
        {tr("所选文件已不在最新数据中")}
      </div>
    );
  }
  const name = entryDisplayName(entry);
  const path = rowPath(entry, fs.dirPath);

  const onDownload = async () => {
    setBusy("download");
    // #1501：大文件（≥8MiB）走预签名票，500/501/失败 → 内部回落直下。
    const ok = await doDownload(fs.humanName, path, name, entry.size, tr);
    setBusy("");
    if (!ok) antd.message.error(tr("下载失败"));
  };
  const onOverwritePick = async (e: ReactNS.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("overwrite");
    try {
      // #1519 预签名覆盖上传（500/501 → 内部回落直传；commit 成功才算成功）。
      await uploadFile(fs.humanName, path, file);
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
      content: name,
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
            {name}
          </span>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("大小 {a} · 更新 {b}", {
              a: fmtBytes(entry.size),
              b: fmtTs(entry.updatedAt),
            })}
          </span>
          <span
            title={path}
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
          {entry.etag ? (
            <span
              title={entry.etag}
              style={{
                fontSize: 11,
                color: t.textSecondary,
                fontFamily: "monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {entry.etag}
            </span>
          ) : null}
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

/** #1499 同步状态（自持取数：挂载即取 status）——16.67 收敛：
 * 仅 state = ok 渲染（单行紧凑条：条目 N · 墓碑 M · 代 G + 导出/复制
 * 清单原文放行尾，不换行；更新于… 收进条 title tooltip）；
 * empty / denied / unsupported / 未取 → 不渲染（不占版面）。
 * ok 且计数级漂移时条下显黄条（保留）。
 *
 * **产品语义（不要越界）**：服务端只存清单、永不合并；清单条目是客户端
 * 语义（map[string]json.RawMessage）服务端原样存——本卡**不逐条渲染/
 * 解析条目**、**不替用户写清单**，只读计数字段 + 原文导出。 */
function SyncCard({ t, tr, fs }: SubProps) {
  const [st, setSt] = React.useState<SyncStatus | null>(null);
  const [fileCount, setFileCount] = React.useState<number | null>(null);
  const [manifest, setManifest] = React.useState<{ text: string; etag?: string } | null>(null);
  const [manifestBusy, setManifestBusy] = React.useState(false);

  const loadSync = React.useCallback(() => {
    setSt(null);
    void getSyncStatus(fs.humanName).then((s) => {
      setSt(s);
      // 漂移对比仅在有清单时做：后台全树递归计数（limit 封顶 10000；
      // 老控制器 301 回落老形态 → paginated=false → 无计数 → 跳过漂移）。
      if (s.state === "ok") {
        void listFiles(fs.humanName, "", { recursive: true, limit: 10000 })
          .then((r) => {
            if (r.paginated && r.nextKey === null) {
              setFileCount(r.entries.filter((e) => !isEntryDir(e)).length);
            } else {
              setFileCount(null);
            }
          })
          .catch(() => setFileCount(null));
      } else {
        setFileCount(null);
      }
    });
  }, [fs.humanName]);

  React.useEffect(() => {
    loadSync();
  }, [loadSync]);

  // 16.67：仅 ok 渲染（empty / denied / unsupported / 未取 → 不占版面）。
  if (!st || !syncCardVisible(st.state)) return null;

  const ensureManifest = async (): Promise<string | null> => {
    if (manifest?.text != null) return manifest.text;
    setManifestBusy(true);
    try {
      const r = await getSyncManifest(fs.humanName);
      if (r.ok && r.text != null) {
        setManifest({ text: r.text, etag: r.etag });
        return r.text;
      }
      antd.message.error(tr("清单获取失败"));
      return null;
    } finally {
      setManifestBusy(false);
    }
  };
  const doExport = async () => {
    const text = await ensureManifest();
    if (text == null) return;
    if (downloadTextFile(text, `files-manifest-${fs.humanName}.json`)) {
      antd.message.success(tr("清单原文已导出"));
    } else {
      antd.message.error(tr("导出失败"));
    }
  };
  const doCopy = async () => {
    const text = await ensureManifest();
    if (text == null) return;
    try {
      await navigator.clipboard.writeText(text);
      antd.message.success(tr("已复制清单原文"));
    } catch {
      antd.message.error(tr("复制失败（浏览器未授权剪贴板）"));
    }
  };

  const drift =
    st.state === "ok" &&
    fileCount !== null &&
    typeof st.entries === "number" &&
    fileCount !== st.entries;

  // 16.67：「更新于…」行收进条 tooltip（条本身 = 计数 + 放行尾两按钮）。
  const updatedTip = st.updatedBy
    ? tr("更新于 {t}（{by}）", { t: fmtTs(st.updatedAt), by: st.updatedBy })
    : tr("更新于 {t}", { t: fmtTs(st.updatedAt) });

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div
        title={updatedTip}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          whiteSpace: "nowrap",
          overflow: "hidden",
          border: `1px solid ${t.border}`,
          borderRadius: 6,
          padding: "4px 8px",
          background: t.cardBg,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
        >
          {tr("条目")} {st.entries ?? 0} · {tr("墓碑")} {st.tombstones ?? 0} ·{" "}
          {tr("代")} {st.generation ?? "—"}
        </span>
        <span style={{ flex: 1 }} />
        <antd.Button size="small" loading={manifestBusy} onClick={() => void doExport()}>
          {tr("导出清单原文")}
        </antd.Button>
        <antd.Button size="small" disabled={manifestBusy} onClick={() => void doCopy()}>
          {tr("复制清单原文")}
        </antd.Button>
      </div>
      {drift ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("文件区 {n} 个文件，清单 {m} 条。清单由本地同步客户端维护，请在本地运行同步客户端对齐。", {
            n: fileCount as number,
            m: st.entries ?? 0,
          })}
        />
      ) : null}
    </div>
  );
}

/** #1518 递归平铺开关：canRecursive 探测未过（老控制器）→ 禁用 + tooltip；
 * 已开递归时保持可点（可关）。 */
function RecursiveToggle({ t, tr, fs }: SubProps) {
  const enabled = fs.canRecursive || fs.recursive;
  return (
    <antd.Tooltip
      title={enabled ? undefined : tr("当前控制器版本不支持递归列表")}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          opacity: enabled ? 1 : 0.45,
          flexShrink: 0,
        }}
      >
        <antd.Switch
          size="small"
          checked={fs.recursive}
          disabled={!enabled}
          onChange={(v: boolean) => fs.onToggleRecursive(v)}
        />
        <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("递归")}</span>
      </span>
    </antd.Tooltip>
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
  // #1518：递归平铺 + 游标分页（老控制器探测失败 → toggle 禁用，零行为变化）。
  const [recursive, setRecursive] = React.useState(false);
  const [canRecursive, setCanRecursive] = React.useState(false);
  const [nextKey, setNextKey] = React.useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const reqRef = React.useRef(0);
  const recursiveProbedRef = React.useRef(false);
  // #1666c 目录导航守卫：请求时读当前目录（onEnterDir 先更新 ref 再立即 load，
  // 使立即取数瞄准新目录；每渲染同步 = 其余路径读到的仍是最新目录）。
  const dirPathRef = React.useRef(dirPath);
  dirPathRef.current = dirPath;
  // DirListGuard：目录标签（过期响应丢弃）+ 错误清列表决策（纯逻辑，
  // 单测见 tests/h1-files-nav.test.ts）。
  const dirGuardRef = React.useRef<DirListGuard | null>(null);
  if (dirGuardRef.current === null) dirGuardRef.current = new DirListGuard();
  const dirGuard = dirGuardRef.current;

  // 老控制器一次性探测：带 recursive 参数 → 老实现 301 回一层列表（无
  // nextKey）→ paginated=false → 递归不可用。新控制器 → paginated=true。
  const probeRecursive = React.useCallback(() => {
    if (recursiveProbedRef.current || !humanName) return;
    recursiveProbedRef.current = true;
    void listFiles(humanName, "", { recursive: true, limit: 1 })
      .then((r) => setCanRecursive(r.paginated))
      .catch(() => setCanRecursive(false));
  }, [humanName]);

  const load = React.useCallback(
    async (silent: boolean) => {
      if (!humanName) return;
      const req = ++reqRef.current;
      // #1666c 请求打目录标签：请求时记录 askedDir（ref = 请求时刻的当前目录），
      // 响应回来标签仍最新才写状态（防另一目录的并发/晚到响应错配覆盖）。
      const askedDir = dirPathRef.current;
      const tag = dirGuard.begin(askedDir);
      // 静默刷新接管可见 loading（防「可见→静默」交错卡 loading=true）。
      if (silent) setLoading(false);
      else setLoading(true);
      const [ls, qs] = await Promise.allSettled([
        view === "trash"
          ? listTrash(humanName).then((r) => r.entries)
          : listFiles(humanName, askedDir, recursive ? { recursive: true, limit: 1000 } : undefined),
        getQuota(humanName),
      ]);
      if (req !== reqRef.current) return; // 过期响应（视图/目录已切换）
      if (ls.status === "fulfilled") {
        if (view === "trash") {
          setTrash(ls.value as HumanTrashEntry[]);
          setNextKey(undefined); // 回收站无分页
          setStatus("");
          setError("");
        } else {
          const lsValue = ls.value as HumanFileListResponse;
          // 目录标签：已切目录（新请求在途）→ 丢弃，由新请求接管状态。
          const applied = dirGuard.applyResult(tag, lsValue);
          if (!applied) return;
          setFiles(applied.entries);
          setNextKey(applied.nextKey); // string=有下一页 / null=到底 / undefined=老控制器
          setLoadingMore(false);
          if (applied.paginated) setCanRecursive(true);
          else probeRecursive(); // 老形态（含递归被 301 回落）→ 一次性探测
          setStatus("");
          setError("");
        }
      } else {
        const e = ls.reason;
        const is404 = e instanceof HumanFilesError && e.status === 404;
        if (view === "trash") {
          if (is404) {
            // 404 = 无权限或不存在（任务书 UI 规则）→ 占位卡，轮询停重试。
            setStatus("404");
            setError("");
          } else {
            // #1666c 错误可见：清旧数据 + 显错误（不保留上一列表）。
            setTrash([]);
            setStatus("err");
            setError(hfErrorText(e, tr));
          }
        } else {
          const applied = dirGuard.applyError(tag, is404 ? 404 : 0, is404 ? "" : hfErrorText(e, tr));
          if (!applied) return; // 目录标签过期 → 新请求接管状态
          // 404 = 无权限或不存在（任务书 UI 规则）→ 占位卡，轮询停重试；
          // 非 404 = 清空列表（根治「列表停在上一目录」）+ 暴露错误文案。
          setFiles(applied.entries);
          setNextKey(applied.nextKey);
          setStatus(applied.status);
          setError(applied.error);
        }
      }
      if (qs.status === "fulfilled") {
        setQuota(qs.value);
        setQuotaFailed(false);
      } else {
        setQuotaFailed(true);
      }
      if (!silent) setLoading(false);
    },
    // dirPath 不入依赖：请求时经 dirPathRef 读取；切目录由 onEnterDir 的
    // 立即 load 触发（不再依赖 effect 时序），避免同目录双取。
    [humanName, view, recursive, tr, probeRecursive, dirGuard],
  );

  // #1518 加载更多：仅 nextKey 为 string（满页）时可点；复用 reqRef 防
  // 过期响应；追加（不替换）entries，游标随响应推进。
  const loadMore = React.useCallback(async () => {
    if (!humanName || typeof nextKey !== "string" || loadingMore) return;
    const req = ++reqRef.current;
    setLoadingMore(true);
    try {
      const r = await listFiles(humanName, dirPath, {
        recursive: true,
        limit: 1000,
        cursor: nextKey,
      });
      if (req !== reqRef.current) return; // 过期响应（目录/视图已切换）
      setFiles((prev) => [...prev, ...r.entries]);
      setNextKey(r.nextKey);
    } catch (e) {
      antd.message.error(hfErrorText(e, tr));
    } finally {
      if (req === reqRef.current) setLoadingMore(false);
    }
  }, [humanName, dirPath, nextKey, loadingMore, tr]);

  // 16.67 页面级动作（上传/新建文件夹）唯一入口 handlers——工具条按钮与
  // 列表空态 CTA 共享。必须在下方早退 return 之前调用（hooks 顺序稳定）。
  const actions = useFilesActions({ humanName, dirPath, load }, tr);

  // 探测失败（老控制器）且递归已开（探测晚于用户操作）→ 自动回落一层列表。
  React.useEffect(() => {
    if (!canRecursive && recursive) setRecursive(false);
  }, [canRecursive, recursive]);

  // 进入域 / 切视图 / 换目录 / 语言变化 → 取数（load 身份随之变）。
  React.useEffect(() => {
    if (!humanName) return;
    void load(false);
  }, [load, humanName]);

  // 30s 静默轮询：activeRef = 顶层 tab 激活门（稳定 ref，tick 时读）；
  // 404（无权限/不存在）停重试；nextKey 为 string（分页中途）跳过——
  // 静默刷新会重置游标，丢掉「加载更多」进度；
  // #1666c：子目录视图暂停静默轮询（防轮询请求与目录切换交错，
  // 把子目录视图覆盖成别的内容）。
  usePoller({
    fn: () => {
      if (data.activeRef && !data.activeRef.current) return;
      if (!humanName || status === "404") return;
      if (dirPath !== "") return;
      if (typeof nextKey === "string") return;
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
    recursive,
    canRecursive,
    nextKey,
    loadingMore,
    onSwitchView: (v) => {
      if (v === view) return;
      nav.selectFile(null);
      // #1666c 切视图立即清空（加载态，不再保留上一视图的列表）；
      // 取数由 effect 触发（view 在 load 依赖里，身份随之变）。
      setFiles([]);
      setTrash([]);
      setNextKey(undefined);
      setStatus("");
      setError("");
      setLoading(true);
      setView(v);
    },
    onEnterDir: (p) => {
      nav.selectFile(null);
      // #1666c 切目录立即清空：点进去的瞬间看到加载态，而不是旧目录数据。
      setFiles([]);
      setNextKey(undefined);
      setStatus("");
      setError("");
      setLoading(true);
      dirPathRef.current = p; // 请求时读取的 ref 先行更新 → 立即 load 瞄准新目录
      setDirPath(p);
      // 立即取数（不依赖 effect 时序——load 身份已不随目录变化）。
      void load(false);
    },
    onToggleRecursive: (on) => {
      if (on === recursive) return;
      nav.selectFile(null);
      // #1666c 同切目录一类：立即清空，取数由 effect 触发（recursive 在
      // load 依赖里）；不清则平铺/单层两种形态的行键会互相错位。
      setFiles([]);
      setNextKey(undefined);
      setStatus("");
      setError("");
      setLoading(true);
      setRecursive(on);
    },
    load: (silent) => void load(silent),
    loadMore: () => void loadMore(),
  };
  const sub: SubProps = { t, tr, nav, fs };

  const selectedEntry =
    view === "files"
      ? files.find((e) => !isEntryDir(e) && rowPath(e, dirPath) === nav.selectedFile)
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
        <ListArea {...sub} actions={actions} compact />
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
        <ListArea {...sub} actions={actions} />
      );
    return (
      <div style={{ display: "grid", gap: 10, padding: 4 }}>
        <FilesToolbar {...sub} actions={actions} />
        <SyncCard {...sub} />
        {/* 16.67 列表头：视图切换 + 递归开关同一行（工具条独占动作入口）。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ViewTabs {...sub} />
          </div>
          {view === "files" ? <RecursiveToggle {...sub} /> : null}
        </div>
        <Breadcrumbs {...sub} />
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
