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
 * 列职责（沿用 ManagePage 四域列模型；16.67 排版 / 去重；
 * 16.69 master-detail 断点——mid 变体单一职责 = 只出列表）：
 * - l1（4 列 L1 列）：视图切换（我的文件 / 回收站）+ 面包屑（目录导航，
 *   根层不渲染——「我的文件」已由 tab 表达）+ compact 列表（回收站行仅选中，
 *   操作在中栏详情）；
 * - mid：  v3（F-V3-1）标题行（页标题「文件管理」+ 紧凑视图切换
 *          （我的文件 / 回收站）+ 递归开关——不占列表上方一整行；回收站
 *          视图无工具条）+ 工具条（仅 files 视图：左 = 配额进度 + 用量
 *          文案；右 = 上传文件 / 同步设置（→ files/SyncSettingsModal 弹窗）/
 *          新建文件夹 / 刷新——页面级动作唯一入口；设置/清除配额在「人员
 *          管理」人员详情，Q）+ 面包屑（仅 files 视图且 dirPath 非空）+
 *          files 视图 = 完整列表（名称 / 大小 / 更新时间 / 操作，行高
 *          ≥44px（#1669 触控），目录大小 = —）/ trash 视图 = 回收站独立
 *          页（files/TrashPanel：原路径 / 大小 / 删除时间 / 操作，自取数
 *          + 独立列头，不与主列表同屏）。详情统一由本 section 的「详情槽」（父层）渲染一次：
 *          4 列（files 4 列无右栏）/ 1 列 = mid 持槽，按容器宽度
 *          （ResizeObserver；禁 window.innerWidth）断点——≥1200 split
 *          （列表 + 右侧详情 400，flex 不压缩列表）/ 768–1199 drawer
 *          （点行 → Drawer 420）/ <768 sheet（点行 → 全屏 Sheet）；
 *          2/3 列 = 右栏持槽（mid 只出列表，防右栏 + mid 双详情）；
 * - right：2/3 列 = 详情槽：选中 → 文件详情（预览 / 下载 / 覆盖 / 删除）/ 回收站
 *          条目详情（恢复 / 彻底删）；未选中 → 空态（图标 + 主文案 + 副文案 +
 *          上传按钮，按钮与工具条同一 actions.onUploadClick）；加载中 →
 *          「加载中…」；空目录 → 「此目录为空」+ 上传按钮（右栏不得空白）。
 *
 * 权限（Controller 终裁；前端门控 best-effort = hasToken）：
 * - 回收站彻底删 = admin only（非 admin 按钮 disabled +
 *   tooltip「仅管理员」）；
 * - restore 409（目标路径已存在）：admin 二次确认 ?overwrite=1；
 *   非 admin 仅显错误。
 * - 删除文件（#1669）：统一确认框（useDeleteConfirm，列表行 / 详情面板
 *   共用）——勾选「移入回收站（可恢复）」（默认）= 软删；未勾选 = 软删
 *   取 trashId 后立即 purgeTrash；不做前端角色门（403 → hfErrorText
 *   「无权限」，不预判角色）。
 *
 * 降级：列表 404 = 「无权限或不存在」（任务书 UI 规则）→ 占位卡。
 *
 * #1669（动作与触控，用户实测三项）：
 *   - 上传入口唯一：全页只有一个 input[type=file] + 一个 onPickFiles（模块级
 *     共享 ref uploadInputRef + requestFilePick 派发 sink）；工具条按钮 / 列表
 *     空态 CTA / 详情面板覆盖上传共用。根修：4 栏 l1+mid 双实例各持 fileRef，
 *     而 input 只挂在 mid 工具条 → l1 实例 ref 恒为 null → l1 空态 CTA（左按钮）
 *     静默 no-op（“在子目录点左边按钮没反应”）。
 *   - 触控：行高 ≥44 / 按钮 ≥40×40 / 图标按钮间距 ≥8 / coarse 指针再放大 10%
 *     （TOUCH / touchCss()）。
 *   - 复用预览：FileDetail 内嵌 components/FilePreview（图 / md / csv / xlsx /
 *     json 内联，其余文本兜底；回收站条目不预览）。
 *   - 上传成功后强制刷新：load(true, {force:true}) → forceList（时间戳 +
 *     cache:"no-store"；humanFiles.ts 零改动，见 forceList 注释）。
 */
import type * as ReactNS from "react";

import {
  deleteFile,
  DirListGuard,
  downloadPresignedUrl,
  downloadViaHost,
  entryDisplayName,
  entryRelPath,
  getQuota,
  getSyncStatus,
  fetchFile,
  HumanFilesError,
  humanFileApiPath,
  isEntryDir,
  isTicketExpired,
  listFiles,
  parseListPayload,
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
  TrashIcon,
} from "../components/icons";
import { ReloadIcon } from "../components/WorkerManageShared";
import { FilePreview, type PreviewFile } from "../components/FilePreview";
import type { ManageNav } from "./useManageNav";
import type { ManageSectionProps } from "./types";
import TrashPanel, {
  fmtBytes,
  fmtTs,
  normTrashPath,
  TOUCH,
  type TrashPanelProps,
} from "./files/TrashPanel";
import SyncSettingsModal from "./files/SyncSettingsModal";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

// v3（F-V3-1）：fmtBytes / TOUCH 自 files/TrashPanel 迁入后重导出——外部面
// 不变（PeopleSection 配额卡经本文件引用 fmtBytes；files-actions-1669 经
// 本文件引用 TOUCH / touchCss）。
export { fmtBytes, TOUCH };

type Tr = (s: string, v?: Record<string, string | number>) => string;

// ── v3（F-V3-1）视图集（纯函数；tests/files-v3-1 断言）────────────────
/** 文件管理页视图：files = 主列表 / trash = 回收站独立页（TrashPanel）。
 * 容器持 view（标题行小视图切换；两视图不同屏、列头独立）。 */
export type FileView = "files" | "trash";
/** 默认视图（挂载即主列表）。 */
export const FILE_VIEW_DEFAULT: FileView = "files";
/** 视图集（渲染顺序 = 标题行分段顺序；tests/files-v3-1 断言）。 */
export function fileViews(): FileView[] {
  return ["files", "trash"];
}
/** v3：页内同步设置长条（SyncCard）已移除——同步设置改 SyncSettingsModal
 * 弹窗（工具条按钮打开）；SyncCard 声明保留 = 测试区间锚点，无视图渲染。 */
export const hasInlineSyncCard = false;

/** 文件域自持状态（tabs / 列表 / 详情 / 配额卡共享）。 */
interface FilesState {
  humanName: string;
  /** L1 惯例：hasToken = 已配置 Controller 管理员 token（best-effort 门控）。 */
  isAdmin: boolean;
  view: FileView;
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
  onSwitchView: (v: FileView) => void;
  onEnterDir: (p: string) => void;
  onToggleRecursive: (on: boolean) => void;
  /** #1669：opts.force = 强制刷新（时间戳 + cache:"no-store"，见 forceList）。 */
  load: (silent: boolean, opts?: { force?: boolean }) => void;
  loadMore: () => void;
}

type SubProps = {
  t: ThemeColors;
  tr: Tr;
  nav: ManageNav;
  fs: FilesState;
};

// fmtBytes / fmtTs（文件域共享纯函数）v3 起在 files/TrashPanel.tsx
//（TrashPanel / SyncSettingsModal 共用；本文件 import + 重导出，外部面不变）。

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

/** 16.69 master-detail 断点（纯函数；tests/files-layout-1669.test.ts 断言）：
 * 按文件 section 容器宽度判定（组件内 ResizeObserver；禁 window.innerWidth）——
 * ≥1200 split（列表 + 右侧详情并排）/ 768–1199 drawer（点行 → Drawer 420）/
 * <768 sheet（点行 → 全屏 Sheet）。 */
export type FilesLayoutMode = "split" | "drawer" | "sheet";

export function layoutMode(width: number): FilesLayoutMode {
  if (width >= 1200) return "split";
  if (width >= 768) return "drawer";
  return "sheet";
}

/** 16.69 栏位划分（纯函数）：任一 (mode, hasSelection) 组合的「详情」槽至多
 * 一处 → FileDetail 渲染次数 = 选中 1 / 未选中 0（任何宽度，不重复渲染）。
 * split → 右侧内联详情栏（未选中 = 空态，右栏不空白）；
 * drawer / sheet → 仅列表 + 点行弹对应浮层（未选中 = 无浮层）。 */
export interface FilesPanes {
  list: "list";
  /** split 右侧内联详情槽：「detail」= 详情 /「empty-state」= 空态 /
   * null = 无内联详情栏（drawer/sheet 模式）。 */
  detail: "detail" | "empty-state" | null;
  /** drawer/sheet 模式：点行打开的浮层（null = 未选中）。 */
  overlay: "drawer" | "sheet" | null;
}

export function panesFor(mode: FilesLayoutMode, hasSelection: boolean): FilesPanes {
  if (mode === "split") {
    return { list: "list", detail: hasSelection ? "detail" : "empty-state", overlay: null };
  }
  return { list: "list", detail: null, overlay: hasSelection ? mode : null };
}

/** 16.69 详情渲染次数（纯函数）：panesFor 结构保证 ≤1；
 * 测试断言 detailRenderCount(panesFor(mode, true)) === 1。 */
export function detailRenderCount(p: FilesPanes): number {
  return (p.detail === "detail" ? 1 : 0) + (p.overlay !== null ? 1 : 0);
}

/** 16.69 详情栏状态（纯函数；「右栏不得空白」四态）：
 * 选中 → detail（详情；条目过期由详情组件自显降级文案）；
 * 加载中 → loading（「加载中…」）；
 * files 视图 + 无错误 + 0 条目 → empty-dir（「此目录为空」+ 上传按钮）；
 * 其余 → pick（图标 + 主文案 + 副文案 + 上传按钮）。 */
export type FilesDetailState = "detail" | "loading" | "empty-dir" | "pick";

export function detailState(o: {
  hasSelection: boolean;
  loading: boolean;
  status: "" | "404" | "err";
  view: "files" | "trash";
  entryCount: number;
}): FilesDetailState {
  if (o.hasSelection) return "detail";
  if (o.loading) return "loading";
  if (o.view === "files" && o.status === "" && o.entryCount === 0) return "empty-dir";
  return "pick";
}

/** 16.67 列表列模板（表头行与数据行共用 → 列宽稳定）：
 * 名称（伸缩）/ 大小 / 时间（更新·删除）/ 操作（定宽）。
 * #1669：操作列 64→96px（2×40px 图标按钮 + 8px 间距，适配 40px 触控目标）。 */
const LIST_GRID = "minmax(0, 1fr) 72px 120px 96px";

// ── #1669 触控目标（用户实测：按钮太小、触屏难点）──
// TOUCH 常量 v3 起在 files/TrashPanel.tsx（本文件 import + 重导出）。

/** 触控 CSS 变量（各 FilesSection 根 <style> 注入；:root 作用域全列共享——
 * 4 栏 l1+mid 双实例重复注入无害）。行高与按钮统一引用这两个变量。 */
export function touchCss(): string {
  const rowC = Math.ceil(TOUCH.rowMinHeight * TOUCH.coarseScale);
  const btnC = Math.ceil(TOUCH.btnMinSize * TOUCH.coarseScale);
  return (
    `:root{--hf-row-min:${TOUCH.rowMinHeight}px;--hf-btn-min:${TOUCH.btnMinSize}px}` +
    `@media (pointer: coarse){:root{--hf-row-min:${rowC}px;--hf-btn-min:${btnC}px}}`
  );
}

/** #1669：antd.Button 最小触控目标（antd small=24 / middle=32 均 <40 →
 * inline minHeight 覆盖其类高；coarse 指针下变量自动放大 10%）。 */
const btnTouch: ReactNS.CSSProperties = { minHeight: "var(--hf-btn-min, 40px)" };

/** 行内小图标按钮（裸 <button> + title tooltip，同 PeopleSection 入口行风格）。
 * #1669：30×30 → ≥40×40 触控盒（16px 图标居中 → 有效留白 12px ≥ 8）。 */
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

/** 条目完整相对路径（文件行选中键 / API 路径）。 */
function fullPath(dirPath: string, name: string): string {
  return dirPath ? `${dirPath}/${name}` : name;
}

// normTrashPath（回收站路径归一）v3 起在 files/TrashPanel.tsx（本文件 import）。

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

// ── #1669 强制刷新（上传成功后）──
// 列表走 legacy GET（humanFiles.legacyListFull——尾斜杠端点），浏览器/宿主
// HTTP 缓存可能回旧响应（端点无 ETag / 缓存控制约定），新上传文件可能不出
// 现在列表。humanFiles.ts 的请求/回退逻辑禁改（任务书约束），其内部 URL
// 构造也未导出 → 这里从**导出**的 humanFileApiPath（唯一寻址入口，零规则
// 漂移）重建 force URL：同形态（尾斜杠）+ 时间戳 + no-store。
/** 强制刷新 URL（纯函数，可测）：与 legacy 端点同形态（尾斜杠）+
 * `?_ts={ts}` 时间戳（每次请求唯一 URL → 缓存必然 miss）。 */
export function forceListUrl(humanName: string, dir: string, now = Date.now()): string {
  const base = humanFileApiPath(humanName, "x").replace(/\/x$/, "");
  const enc = dir
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `${base}${enc ? `/${enc}` : ""}/?_ts=${now}`;
}

/** 强制取列表：时间戳 + cache:"no-store"（init 透传 host.fetch / 裸 fetch）。
 * 返回 HumanFileListResponse（parseListPayload 归一，与 listFiles 分支同形态
 * → load 的 fulfilled 处理零改动）。非 2xx 抛 HumanFilesError（load 错误分支）。 */
export async function forceList(
  humanName: string,
  dir: string,
): Promise<HumanFileListResponse> {
  const url = forceListUrl(humanName, dir);
  const resp = await fetchFile(url, url, { cache: "no-store" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let msg = "";
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      msg = String(j.message ?? j.detail ?? j.error ?? "");
    } catch {
      /* 非 JSON 正文 */
    }
    throw new HumanFilesError(resp.status, msg || `HTTP ${resp.status}`);
  }
  const payload: unknown = await resp.json();
  return parseListPayload((payload as Record<string, unknown>) ?? null, dir);
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
        // #1669 角色无关：权限由服务端裁决，前端不预判角色（原「仅管理员」
        // 为角色门文案，删除流需要的是通用错误语义）。
        return tr("无权限");
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

/** #1669 删除调用计划（纯函数；tests/files-delete-1669.test.ts 断言）：
 * 勾选（recycle=true）= 仅软删（deleteFile → 回收站，可恢复）；
 * 未勾选 = 先软删取 trashId、立即彻底删（purgeTrash，不可恢复）。
 * 计划不含任何角色判断——权限由服务端终裁（403 → hfErrorText 普通错误）。 */
export function deletePlan(opts: { recycle: boolean }): string[] {
  return opts.recycle ? ["soft"] : ["soft", "purge"];
}

/** #1669 按计划顺序执行删除（soft 的 trashId 供 purge 使用）。 */
async function runDeletePlan(
  humanName: string,
  path: string,
  plan: string[],
): Promise<{ trashId: string; purged: boolean }> {
  let trashId = "";
  let purged = false;
  for (const step of plan) {
    if (step === "soft") {
      trashId = (await deleteFile(humanName, path)).trashId;
    } else if (step === "purge") {
      await purgeTrash(humanName, trashId);
      purged = true;
    }
  }
  return { trashId, purged };
}

/** #1669 删除确认（列表行 + 详情面板共用，不各写一份 Modal）：
 * 标题「删除文件？」+ 文件名 + 勾选「移入回收站（可恢复）」（默认勾选；
 * 未勾选显「⚠ 将彻底删除，不可恢复」）；按钮 [取消] [删除]。
 * 不做前端角色门（无「仅管理员可彻底删除」禁用/提示）；成功文案区分
 * 「已移入回收站」/「已彻底删除」；失败 = hfErrorText（403 →「无权限」）。 */
function useDeleteConfirm(inp: {
  t: ThemeColors;
  tr: Tr;
  humanName: string;
  /** 删除成功（purged = 是否彻底删除）→ 调用方清选中 + 刷新。 */
  onDone: (purged: boolean) => void;
}): {
  open: boolean;
  busy: boolean;
  request: (path: string, name: string) => void;
  node: ReactNS.ReactElement;
} {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState("");
  const [name, setName] = React.useState("");
  const [recycle, setRecycle] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const request = (p: string, n: string) => {
    setPath(p);
    setName(n);
    setRecycle(true); // 每次打开默认勾选「移入回收站（可恢复）」
    setOpen(true);
  };
  const close = () => {
    if (!busy) setOpen(false);
  };
  const onOk = async () => {
    setBusy(true);
    try {
      const r = await runDeletePlan(inp.humanName, path, deletePlan({ recycle }));
      antd.message.success(inp.tr(r.purged ? "已彻底删除" : "已移入回收站"));
      setOpen(false);
      inp.onDone(r.purged);
    } catch (err) {
      antd.message.error(hfErrorText(err, inp.tr));
    } finally {
      setBusy(false);
    }
  };

  const node = (
    <antd.Modal
      open={open}
      title={inp.tr("删除文件？")}
      okText={inp.tr("删除")}
      cancelText={inp.tr("取消")}
      confirmLoading={busy}
      onOk={() => void onOk()}
      onCancel={close}
      destroyOnClose
    >
      <div style={{ display: "grid", gap: 8, padding: "4px 0" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: inp.t.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        <antd.Checkbox
          checked={recycle}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setRecycle(e.target.checked)
          }
        >
          {inp.tr("移入回收站（可恢复）")}
        </antd.Checkbox>
        {!recycle ? (
          <div style={{ fontSize: 12, color: inp.t.text }}>
            ⚠ {inp.tr("将彻底删除，不可恢复")}
          </div>
        ) : null}
      </div>
    </antd.Modal>
  );
  return { open, busy, request, node };
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

/** 16.69 详情栏（唯一详情槽的渲染器；split 右侧内联 / right 变体 / 4·1 列
 * mid 持槽共用——任何宽度下 FileDetail 渲染次数 = 1，见 panesFor/
 * detailRenderCount）。右栏不得空白（detailState 四态）：选中 → 详情 /
 * 加载中 → 「加载中…」/ files 空目录 → 「此目录为空」+ 上传按钮 / 未选中 →
 * 图标 + 主副文案 + 「上传文件」按钮（与工具条同一 actions.onUploadClick）。 */
function DetailPane({ t, tr, nav, fs, actions }: SubProps & { actions: FilesActions }) {
  const st = detailState({
    hasSelection: nav.selectedFile != null,
    loading: fs.loading,
    status: fs.status,
    view: fs.view,
    entryCount: fs.view === "files" ? fs.files.length : fs.trash.length,
  });
  if (st === "detail") {
    return fs.view === "files" ? (
      <FileDetail t={t} tr={tr} nav={nav} fs={fs} />
    ) : (
      <TrashDetail t={t} tr={tr} nav={nav} fs={fs} />
    );
  }
  if (st === "loading") {
    return (
      <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: t.textSecondary }}>
        {tr("加载中…")}
      </div>
    );
  }
  const emptyDir = st === "empty-dir";
  return (
    <div style={{ padding: 12, textAlign: "center" }}>
      <PageIcon size={20} style={{ color: t.textSecondary, margin: "0 auto 6px" }} />
      <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
        {emptyDir
          ? tr("此目录为空")
          : fs.view === "files"
            ? tr("选择文件查看详情")
            : tr("选择回收站条目")}
      </div>
      <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 4 }}>
        {emptyDir
          ? tr("上传或新建文件夹后开始管理")
          : fs.view === "files"
            ? tr("点列表文件行查看下载 / 覆盖 / 删除")
            : tr("点列表行查看恢复 / 彻底删除")}
      </div>
      {fs.view === "files" ? (
        <antd.Button
          style={{ marginTop: 8, ...btnTouch }}
          onClick={actions.onUploadClick}
        >
          {tr("上传文件")}
        </antd.Button>
      ) : null}
    </div>
  );
}

/** 16.69 断点浮层（drawer/sheet 模式点行弹出；该模式下详情只此一处渲染）：
 * 768–1199 → 右侧 Drawer(420)；<768 → 底部全屏 Sheet。 */
function DetailOverlay({ t, tr, nav, fs, overlay }: SubProps & { overlay: "drawer" | "sheet" }) {
  const title = fs.view === "files" ? tr("文件详情") : tr("回收站条目");
  const close = () => nav.selectFile(null);
  const body = fs.view === "files" ? (
    <FileDetail t={t} tr={tr} nav={nav} fs={fs} />
  ) : (
    <TrashDetail t={t} tr={tr} nav={nav} fs={fs} />
  );
  if (overlay === "sheet") {
    return (
      <antd.Drawer
        open
        onClose={close}
        placement="bottom"
        height="100%"
        title={title}
        styles={{ body: { padding: 14, background: t.bg } }}
      >
        {body}
      </antd.Drawer>
    );
  }
  return (
    <antd.Drawer
      open
      onClose={close}
      width={420}
      title={title}
      styles={{ body: { padding: 14, background: t.bg } }}
    >
      {body}
    </antd.Drawer>
  );
}

/** 视图切换（我的文件 / 回收站）。v3：small = 标题行内紧凑分段（去
 * flex:1 通栏，不占列表上方一整行）；l1 栏沿用通栏形态。 */
function ViewTabs({ t, tr, fs, small = false }: SubProps & { small?: boolean }) {
  const label: Record<FileView, string> = {
    files: tr("我的文件"),
    trash: tr("回收站"),
  };
  const btn = (v: FileView) => {
    const active = fs.view === v;
    return (
      <button
        type="button"
        onClick={() => fs.onSwitchView(v)}
        style={{
          ...(small ? {} : { flex: 1 }),
          // #1669：触控目标（minHeight ≥40 + 垂直居中）。
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "var(--hf-btn-min, 40px)",
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
        {label[v]}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {fileViews().map((v) => btn(v))}
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
        // #1669：触控目标（minHeight ≥40 + 垂直居中）。
        display: "inline-flex",
        alignItems: "center",
        minHeight: "var(--hf-btn-min, 40px)",
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

/** 列表块（v3：files-only——回收站独立页 = files/TrashPanel，不同屏）：
 * 出错+重试 / 加载中 / 空态（居中一句 + 主 CTA 文字链接，指向工具条同一
 * 处理函数）/ 表头行 + 文件行列表（compact = l1 列紧凑行）。 */
function ListArea({
  t,
  tr,
  nav,
  fs,
  actions,
  compact = false,
}: SubProps & { actions: FilesActions; compact?: boolean }) {
  const count = fs.files.length;
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
          <antd.Button style={btnTouch} onClick={() => fs.load(false)}>
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
            {tr("暂无文件")}
          </div>
          {/* 16.67：空态 CTA = 文字链接（type="link"，非按钮），
           * 指向工具条「上传文件」的同一处理函数（actions 共享）。
           * #1669：minHeight 触控目标（文字链接同样要求 ≥40 可点区）。 */}
          <antd.Button
            type="link"
            style={{ padding: 0, ...btnTouch }}
            onClick={actions.onUploadClick}
          >
            {tr("上传一个文件")}
          </antd.Button>
        </div>
      ) : null}
      {/* 16.67 列表表头行：名称 / 大小 / 更新时间 / 操作——
       * 与数据行共用 LIST_GRID 模板（列宽稳定）。回收站列头独立于
       * files/TrashPanel（原路径 / 大小 / 删除时间 / 操作）。 */}
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
          <span>{tr("更新时间")}</span>
          <span>{tr("操作")}</span>
        </div>
      ) : null}
      {fs.files.map((e) => (
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
      {!compact && typeof fs.nextKey === "string" ? (
        <antd.Button block loading={fs.loadingMore} style={btnTouch} onClick={() => fs.loadMore()}>
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
  // #1669 统一删除确认（与详情面板共用 useDeleteConfirm，不各写一份 Modal）：
  // 勾选「移入回收站（可恢复）」（默认）= 软删；未勾选 = 软删后立即彻底删。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: () => {
      if (nav.selectedFile === path) nav.selectFile(null);
      fs.load(true);
    },
  });
  const onDelete = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    del.request(path, name);
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
    // #1669 目录不可删（服务端不支持目录删除）：禁用删除按钮 + tooltip 提示。
    <span style={{ display: "flex", alignItems: "center", gap: TOUCH.iconGap }}>
      <antd.Tooltip title={tr("目录删除暂不支持（请逐个删除文件）")}>
        <span style={{ display: "inline-flex" }}>
          <button
            type="button"
            disabled
            aria-label={tr("删除")}
            style={{ ...iconBtnStyle(t), opacity: 0.4, cursor: "not-allowed" }}
          >
            <TrashIcon size={16} />
          </button>
        </span>
      </antd.Tooltip>
    </span>
  ) : (
    <span style={{ display: "flex", alignItems: "center", gap: TOUCH.iconGap }}>
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
          minHeight: "var(--hf-row-min, 44px)",
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
        {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
        {del.node}
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
        minHeight: "var(--hf-row-min, 44px)",
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
      {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
      {del.node}
    </div>
  );
}

/** l1 栏回收站紧凑行（v3）：单行（图标 + 原路径），仅选中——恢复 /
 * 彻底删操作在回收站独立页（files/TrashPanel）行内（见 l1 提示行）。
 * 完整行（四列 grid + 行内操作）已随回收站独立页迁出本文件。 */
function TrashRailRow({
  entry,
  t,
  nav,
}: SubProps & { entry: HumanTrashEntry }) {
  const p = normTrashPath(entry.path);
  const sel = nav.selectedFile === p;
  const select = () => nav.selectFile(sel ? null : p);
  const rowSkin = sel
    ? { border: `1px solid ${t.border}`, background: t.hoverBg }
    : { border: "1px solid transparent", background: "transparent" };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={(e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        }
      }}
      onMouseEnter={(e: ReactNS.MouseEvent<HTMLDivElement>) => {
        if (!sel) e.currentTarget.style.background = t.hoverBg;
      }}
      onMouseLeave={(e: ReactNS.MouseEvent<HTMLDivElement>) => {
        if (!sel) e.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
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
    </div>
  );
}

/** l1 栏回收站紧凑列表（v3）：四态（错误+重试 / 加载中 / 空 / 行列表）——
 * 与 files/TrashPanel 独立页同四态语义；数据 = 容器 fs.trash（l1 与 mid
 * 共享同一取数，不重复请求）。 */
function TrashRailList({ t, tr, nav, fs }: SubProps) {
  const count = fs.trash.length;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {fs.status === "err" && count === 0 ? (
        <>
          <antd.Alert
            type="warning"
            showIcon
            message={tr("加载失败")}
            description={fs.error}
          />
          <antd.Button style={btnTouch} onClick={() => fs.load(false)}>
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
            {tr("回收站为空")}
          </div>
        </div>
      ) : null}
      {fs.trash.map((e) => (
        <TrashRailRow key={e.id} entry={e} t={t} tr={tr} nav={nav} fs={fs} />
      ))}
    </div>
  );
}

/** 16.69 容器宽度（ResizeObserver 观察根 div；禁 window.innerWidth——
 * 断点按文件 section 实际宽度而非视口）。静态渲染（测试）首帧 = 0 →
 * sheet 语义（仅列表），挂载后 RO 回报真实宽度。 */
function useContainerWidth(): [ReactNS.MutableRefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [w, setW] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const nw = Math.round(entries[0]?.contentRect.width ?? 0);
      setW((prev) => (nw === prev ? prev : nw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── #1669 统一上传入口（全页唯一）──
// 根因（用户实测「在子目录点左边上传按钮没反应」）：4 栏布局同时挂载两个
// FilesSection 实例（l1 + mid，ManagePage renderSection），每实例各持
// useFilesActions → 各自 fileRef；而隐藏的 file 选择 input 只由工具条
// （仅 mid/full variant 渲染）挂载 → l1 实例的 fileRef 恒为 null → l1 空态
// CTA 的 onUploadClick() 静默 no-op。CTA 只在目录为空时出现，故表现为
// 「进子目录后点左边按钮没反应」，只有右上工具条按钮可用。
// 修法：input ref + pick 派发上提模块级——全页只有一个隐藏的 file input
// （仍由工具条宿主渲染，见 FilesToolbar）与一个 onPickFiles；点击方注册
// 自己的 sink（自己的 humanName / dirPath / load），上传必然落在被点击
// 实例的当前目录。详情面板的覆盖上传经同一入口（自己的 sink）——不再
// 存在第二个 input。
type UploadPickSink = (file: File) => void | Promise<void>;
const uploadInputRef: { current: HTMLInputElement | null } = { current: null };
let uploadPickSink: UploadPickSink | null = null;

/** 唯一 onPickFiles（#1669）：全页唯一 input[type=file] 的 pick 处理器。
 * 消费点击时注册的 sink（被点击实例的上传方）；取消（无文件）= 消费后
 * 什么都不做。 */
export async function onPickFiles(e: ReactNS.ChangeEvent<HTMLInputElement>): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = ""; // 允许重选同一文件
  const sink = uploadPickSink;
  uploadPickSink = null;
  if (file && sink) await sink(file);
}

/** 请求文件选择：注册被点击实例的 sink → 点全页唯一隐藏 input
 * （工具条宿主必挂载：凡渲染上传按钮的 variant 都渲染工具条）。 */
export function requestFilePick(sink: UploadPickSink): void {
  uploadPickSink = sink;
  uploadInputRef.current?.click();
}

/** #1669 上传入口声明（纯函数；测试断言 count = 1）：全页只有这一个入口
 * ——一个隐藏 input + 一个 onPickFiles；各上传表面（工具条按钮 / 列表空态
 * CTA / 详情面板覆盖上传）均经 requestFilePick 绑定到它。 */
export interface UploadEntryPoint {
  id: string;
  /** 页面内隐藏 file input 数（必须 1）。 */
  inputCount: number;
  /** 唯一 pick 处理器。 */
  pickHandler: string;
  /** 绑定到此入口的上传表面。 */
  surfaces: string[];
}
export function uploadEntryPoints(): UploadEntryPoint[] {
  return [
    {
      id: "files-page-upload",
      inputCount: 1,
      pickHandler: "onPickFiles",
      surfaces: ["toolbar", "list-empty-cta", "detail-overwrite"],
    },
  ];
}

/** 16.67 页面级动作按钮（上传文件/新建文件夹）的唯一入口状态 + 处理器：
 * 工具条按钮与列表空态 CTA 文字链接共享同一 handlers——同一动作在页面上
 * 只出现一处按钮（设置/清除配额仍在「人员管理」人员详情，Q）。
 * 由根组件调用（早于早退 return，hooks 顺序稳定），handlers 闭包持有
 * 最新 humanName/dirPath/load。#1669：上传点击 = requestFilePick 派发到
 * 模块级唯一 input（见上方「统一上传入口」块）。 */
interface FilesActions {
  upBusy: boolean;
  /** 打开系统文件选择（工具条「上传文件」按钮 + 空态 CTA 共用）。 */
  onUploadClick: () => void;
  folderOpen: boolean;
  folderName: string;
  folderBusy: boolean;
  setFolderName: (v: string) => void;
  openFolderModal: () => void;
  closeFolderModal: () => void;
  createFolder: () => void;
}

function useFilesActions(
  inp: {
    humanName: string;
    dirPath: string;
    load: (silent: boolean, opts?: { force?: boolean }) => void;
  },
  tr: Tr,
): FilesActions {
  const [upBusy, setUpBusy] = React.useState(false);
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderBusy, setFolderBusy] = React.useState(false);

  /** 上传到当前目录（被点击实例的 sink，#1669）：成功后强制刷新列表
   * （时间戳 + no-store，见 forceList）。 */
  const doUpload = async (file: File): Promise<void> => {
    setUpBusy(true);
    try {
      // #1519 预签名上传（500/501 → 内部自动回落直传；commit 成功才算成功）。
      await uploadFile(inp.humanName, fullPath(inp.dirPath, file.name), file);
      antd.message.success(tr("上传成功"));
      inp.load(true, { force: true });
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
    onUploadClick: () => requestFilePick((f) => doUpload(f)),
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
 * （上传文件 / 同步设置（v3 弹窗入口）/ 新建文件夹 / 刷新——页面级
 * 动作唯一入口）；窄栏（<720px）自动换行不重叠。 */
function FilesToolbar({
  t,
  tr,
  fs,
  actions,
  onOpenSyncSettings,
}: SubProps & { actions: FilesActions; onOpenSyncSettings: () => void }) {
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
        <antd.Button loading={actions.upBusy} style={btnTouch} onClick={actions.onUploadClick}>
          {tr("上传文件")}
        </antd.Button>
        {/* v3（F-V3-1）：同步设置弹窗入口（替代原页内 SyncCard 长条）。 */}
        <antd.Button style={btnTouch} onClick={onOpenSyncSettings}>
          {tr("同步设置")}
        </antd.Button>
        <antd.Button style={btnTouch} onClick={actions.openFolderModal}>
          {tr("新建文件夹")}
        </antd.Button>
        <antd.Button
          type="text"
          icon={<ReloadIcon />}
          title={tr("刷新")}
          aria-label={tr("刷新")}
          style={btnTouch}
          onClick={() => fs.load(false)}
        />
      </div>
      {/* #1669：全页唯一 file input（模块级共享 ref——l1/mid 双实例死按钮
       * 根修，见「统一上传入口」块）。所有上传入口（工具条 / 列表空态 CTA /
       * 详情面板覆盖上传）经 requestFilePick → 本 input → onPickFiles。 */}
      <input
        ref={uploadInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => void onPickFiles(e)}
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

/** #1669：是否可预览（与 components/FilePreview 支持的类型集一致：
 * 图片 / 文本类（含 md / csv / tsv / json）/ xlsx）。入参可为扩展名或
 * 文件名；其余类型详情面板只给「下载」。纯函数（测试断言）。 */
export function previewable(nameOrExt: string): boolean {
  const s = nameOrExt.trim().toLowerCase();
  const i = s.lastIndexOf(".");
  const ext = i >= 0 ? s.slice(i + 1) : s;
  return (
    ext === "xlsx" ||
    new Set([
      // IMAGE_EXT ∪ TEXT_PREVIEW_EXT（与 FilePreview 保持同步）。
      "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp",
      "md", "markdown", "txt", "log", "json", "csv", "tsv",
      "yaml", "yml", "xml", "sql", "html", "htm",
      "py", "ts", "js", "tsx", "jsx", "go", "rs", "sh",
    ]).has(ext)
  );
}

/** 选中文件详情：meta + 预览 / 下载 / 覆盖上传 / 删除(→回收站，#1669 统一
 * 确认框)。#1669：预览 = 复用 components/FilePreview（不新写预览）；覆盖上传
 * 走统一上传入口（模块级唯一 input）；删除 = useDeleteConfirm 共用（与列表
 * 行同一确认框）。回收站条目不预览（TrashDetail 无预览）。 */
function FileDetail({ t, tr, nav, fs }: SubProps) {
  const [busy, setBusy] = React.useState<"" | "download" | "overwrite">("");
  const [preview, setPreview] = React.useState<PreviewFile | null>(null); // #1669
  const sel = nav.selectedFile;
  const entry = sel
    ? fs.files.find((e) => !isEntryDir(e) && rowPath(e, fs.dirPath) === sel)
    : undefined;
  // #1669 hook 必须在早退 return 之前（entry 消失 = 切占位，hook 数须稳定）。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: () => {
      nav.selectFile(null);
      fs.load(true);
    },
  });

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
  // #1669：预览（复用 components/FilePreview；fetch 走 humanFileApiPath）。
  const apiPath = humanFileApiPath(fs.humanName, path);
  const onPreviewClick = () => {
    setPreview({ name, url: apiPath, apiPath, size: entry.size, rawUrl: apiPath });
  };
  // #1669：覆盖上传走统一上传入口（模块级唯一 input——不再自持 owRef）；
  // 本 sink 落当前文件路径，成功后强制刷新（时间戳 + no-store）。
  const onOverwriteClick = () => {
    void requestFilePick(async (file) => {
      setBusy("overwrite");
      try {
        // #1519 预签名覆盖上传（500/501 → 内部回落直传；commit 成功才算成功）。
        await uploadFile(fs.humanName, path, file);
        antd.message.success(tr("上传成功"));
        fs.load(true, { force: true });
      } catch (err) {
        antd.message.error(hfErrorText(err, tr));
      } finally {
        setBusy("");
      }
    });
  };
  const onDelete = () => del.request(path, name);

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
        {previewable(name) ? (
          <antd.Button type="primary" style={btnTouch} onClick={onPreviewClick}>
            {tr("预览")}
          </antd.Button>
        ) : null}
        <antd.Button
          type={previewable(name) ? "default" : "primary"}
          loading={busy === "download"}
          style={btnTouch}
          onClick={() => void onDownload()}
        >
          {tr("下载")}
        </antd.Button>
        <antd.Button
          loading={busy === "overwrite"}
          style={btnTouch}
          onClick={onOverwriteClick}
        >
          {tr("覆盖上传")}
        </antd.Button>
        <antd.Button danger style={btnTouch} onClick={onDelete}>
          {tr("删除")}
        </antd.Button>
      </div>
      {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
      {del.node}
      {/* #1669：复用 components/FilePreview（Modal：图 / md / csv / xlsx /
       * json 内联，其余文本兜底）。file = null → 渲染 null，不占版面。 */}
      <FilePreview file={preview} onClose={() => setPreview(null)} />
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
          type="primary"
          loading={busy === "restore"}
          style={btnTouch}
          onClick={() => void onRestore()}
        >
          {tr("恢复文件")}
        </antd.Button>
        <antd.Button
          danger
          disabled={!fs.isAdmin}
          title={fs.isAdmin ? undefined : tr("仅管理员")}
          style={btnTouch}
          onClick={onPurge}
        >
          {tr("彻底删除")}
        </antd.Button>
      </div>
    </div>
  );
}

/** v3（F-V3-1）锚点桩——页内同步设置长条已移除（同步状态 / 立即同步 /
 * 导出清单原文 / 镜像目录说明全部迁入 files/SyncSettingsModal 弹窗，
 * 工具条「同步设置」按钮打开；st 由容器取数共享，syncOk = 下方容器的
 * syncCardVisible 接线）。声明保留 = files-actions-1669 ③ 区间断言锚点
 *（TrashDetail → 本声明 区间 = TrashDetail 函数体，断言回收站条目不
 * 预览）；noUnusedLocals 要求 export；无任何视图渲染本桩。 */
export function SyncCard(): null {
  return null;
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
  const [view, setView] = React.useState<FileView>(FILE_VIEW_DEFAULT);
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

  // 16.69 容器宽度断点（mid 持槽时的 split / drawer / sheet 判定）。
  // 必须在下方早退 return 之前调用（hooks 顺序稳定）。
  const [widthRef, containerW] = useContainerWidth();

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
    async (silent: boolean, opts?: { force?: boolean }) => {
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
          : opts?.force
            // #1669 上传成功后强制刷新：时间戳 + cache:"no-store"（见 forceList）。
            ? forceList(humanName, askedDir)
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

  // v3（F-V3-1）同步状态：页内长条已移除 → 容器取数共享给
  // files/SyncSettingsModal 弹窗（st = null → 「加载中…」；syncOk =
  // 计数行 vs 原因行的门，16.67 同款判定）。
  const [st, setSt] = React.useState<SyncStatus | null>(null);
  const [syncModalOpen, setSyncModalOpen] = React.useState(false);
  const loadSync = React.useCallback(() => {
    if (!humanName) return;
    setSt(null);
    void getSyncStatus(humanName).then(setSt);
  }, [humanName]);
  React.useEffect(() => {
    loadSync();
  }, [loadSync]);
  const syncOk = st ? syncCardVisible(st.state) : false;

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
    load: (silent, opts) => void load(silent, opts),
    loadMore: () => void loadMore(),
  };
  const sub: SubProps = { t, tr, nav, fs };

  if (variant === "l1") {
    return (
      <div style={{ display: "grid", gap: 8, padding: 8 }}>
        {/* #1669 触控 CSS 变量（:root 作用域；双实例重复注入无害）。 */}
        <style>{touchCss()}</style>
        <ViewTabs {...sub} />
        {view === "files" ? (
          <Breadcrumbs {...sub} />
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("恢复 / 彻底删除在中栏行操作")}
          </span>
        )}
        {view === "files" ? (
          <ListArea {...sub} actions={actions} compact />
        ) : (
          <TrashRailList {...sub} />
        )}
      </div>
    );
  }

  if (variant === "mid" || variant === "full") {
    // 16.69 mid 单一职责 = 恒渲染列表。详情槽归属：无右栏兄弟时（full /
    // 4 列 / 1 列）由本实例持有，按容器宽度断点——≥1200 split（列表 +
    // 右侧内联详情 400，flex 不压缩列表）/ 768–1199 drawer（点行 Drawer 420）/
    // <768 sheet（点行全屏 Sheet）；2/3 列 = 右栏实例持槽（mid 纯列表），
    // 任何宽度 FileDetail 渲染次数 = 1（panesFor/detailRenderCount）。
    const ownsDetail = variant === "full" || cols === 4 || cols === 1;
    const mode = layoutMode(containerW);
    const hasSelection = nav.selectedFile != null;
    const panes = ownsDetail ? panesFor(mode, hasSelection) : null;
    // v3（F-V3-1）回收站独立页（files/TrashPanel）：自取数 + 独立列头
    //（原路径 / 大小 / 删除时间 / 操作）；列宽模板与主列表同一 LIST_GRID
    //（四列对齐），列头行独立——两视图不再同屏 / 共用列头。
    const trashPanelProps: TrashPanelProps = {
      t,
      tr,
      humanName,
      isAdmin: !!data.hasToken,
      nav,
      gridTemplateColumns: LIST_GRID,
      onChanged: () => load(true),
    };
    const listNode =
      view === "trash" ? (
        <TrashPanel {...trashPanelProps} />
      ) : (
        <ListArea {...sub} actions={actions} />
      );
    return (
      <div ref={widthRef} style={{ display: "grid", gap: 10, padding: 4 }}>
        {/* #1669 触控 CSS 变量（:root 作用域；双实例重复注入无害）。 */}
        <style>{touchCss()}</style>
        {/* v3：工具条仅 files 视图（回收站无页面级文件动作 / 同步设置入口）。 */}
        {view === "files" ? (
          <FilesToolbar
            {...sub}
            actions={actions}
            onOpenSyncSettings={() => setSyncModalOpen(true)}
          />
        ) : null}
        {/* v3（F-V3-1）标题行：页标题 + 视图切换（紧凑分段，不占列表上方
         * 一整行）+ 递归开关（仅 files 视图）——替代旧「列表头行」。 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: "var(--hf-row-min, 44px)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: t.text, flexShrink: 0 }}>
            {tr("文件管理")}
          </span>
          <ViewTabs {...sub} small />
          <span style={{ flex: 1 }} />
          {view === "files" ? <RecursiveToggle {...sub} /> : null}
        </div>
        {view === "files" ? <Breadcrumbs {...sub} /> : null}
        {panes && panes.detail !== null ? (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 auto", minWidth: 0, display: "grid", gap: 4 }}>
              {listNode}
            </div>
            <div
              style={{
                width: 400,
                flexShrink: 0,
                borderLeft: `1px solid ${t.border}`,
                paddingLeft: 10,
                display: "grid",
                gap: 8,
              }}
            >
              <DetailPane {...sub} actions={actions} />
            </div>
          </div>
        ) : (
          listNode
        )}
        {panes && panes.overlay ? (
          <DetailOverlay {...sub} overlay={panes.overlay} />
        ) : null}
        {/* v3（F-V3-1）同步设置弹窗（关闭不占页面空间）。 */}
        <SyncSettingsModal
          t={t}
          tr={tr}
          humanName={humanName}
          open={syncModalOpen}
          st={st}
          syncOk={syncOk}
          onClose={() => setSyncModalOpen(false)}
          onSynced={() => {
            loadSync();
            load(true);
          }}
        />
      </div>
    );
  }

  // right（2/3 列 = 详情槽；4 栏 files 无右栏——详情由 mid 持槽，
  // 见 ManagePage sectionNoRight）。
  return <DetailPane {...sub} actions={actions} />;
}
