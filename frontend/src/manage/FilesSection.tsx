/**
 * FilesSection.tsx — 「管理」页文件管理域（#1426 Human Files，nested API 版）。
 *
 * 数据（组件自持；files 域进入 = 组件挂载取数，切域卸载即停）：
 * - load 三腿（allSettled 并行）：listFiles/forceList(humanName, dirPath) +
 *   getQuota(humanName) + listTrash(humanName)——trash 腿独立状态
 *   （trashStatus/trashError；不走 dirGuard；配额 / 回收站失败不挡文件列表）；
 * - 统一刷新入口 reload({silent?, force?})（F-V3-3）：force 默认 true
 *   （forceList 时间戳 + no-store）；in-flight 去重（同 dirPath+view 复用
 *   在跑请求，makeReloadDedup）；工具条 ↻ / 列表重试 / 回收站弹窗重试 /
 *   删除 / 恢复 / 彻底删 / 新建文件夹 / 撤销 全走它（上传 / 覆盖成功保留
 *   load(true,{force:true}) 字面调用——测试锚定调用形态，行为同 force 刷新）；
 * - 新鲜度（F-V3-3）：30s 静默轮询（usePoller；子目录同样轮询——dirGuard
 *   目录标签防过期覆盖；门控 = 顶层 tab 激活 && 非 404 && 非分页中途，
 *   抽纯函数 shouldPoll；刻意 force:false 保持现有请求形态，递归平铺不被
 *   forceList 打平）+ 焦点感知（visibilitychange / window.focus：可见且
 *   距上次成功 load >10s → 静默刷新，see shouldRefetchOnFocus；404 保持禁用）；
 * - humanName = admin.humans find(matrixUserID === myUserId).name，fallback
 *   localpart(myUserId)（L2 模式 admin=null，humans 列表不可用；
 *   MyScopeCard 同款推导）；空 → 「无法识别当前用户」占位。
 *
 * 列职责（沿用 ManagePage 四域列模型；16.67 排版 / 去重；
 * 16.69 master-detail 断点——mid 变体单一职责 = 只出列表）：
 * - l1（4 列 L1 列；F-V3-3：files 域不占 L1 列——ManagePage showL1(section,
 *   cols) = cols===4 && section!=="files"；files 4 栏 = rail + 列表 + 内联
 *   详情，列表只出现一次）：面包屑（目录导航，根层不渲染）+ compact 列表
 *   （视图切换 tab 已移除——回收站改弹窗，见下）；
 * - mid：  标题行（页标题「文件管理」+ 递归开关；F-V3-3：视图切换移除，
 *          fs.view 内部保持存在但恒为 "files"）+ 工具条（左 = 配额进度 +
 *          用量文案；右 = 上传文件 / 同步设置（→ files/SyncSettingsModal
 *          弹窗）/ 新建文件夹 / 回收站（→ files/TrashDialog 弹窗，徽标 =
 *          条目数，0 不显示；点击 +1 次静默刷新）/ 刷新（reload force）——
 *          页面级动作唯一入口；设置/清除配额在「人员管理」人员详情，Q）+
 *          面包屑（dirPath 非空）+ 撤销条（F-V3-3：Alert + 「撤销」，
 *          8s 自动消失，见「撤销」节）+ 完整列表（名称 / 大小 / 更新时间 /
 *          操作，行高 ≥44px（#1669 触控），目录大小 = —；F-V3-3 列自适应：
 *          整批无 updatedAt → 不渲染「更新时间」列，见 columnsFor）+
 *          回收站弹窗（files/TrashDialog：只消费容器数据，不自取数——
 *          修旧 TrashPanel 双请求）。详情统一由本 section 的「详情槽」（父层）
 *          渲染一次：4 列（files 4 列无右栏）/ 1 列 = mid 持槽，按容器宽度
 *          （ResizeObserver；禁 window.innerWidth）断点——≥1200 split
 *          （列表 + 右侧详情 400，flex 不压缩列表）/ 768–1199 drawer
 *          （点行 → Drawer 420）/ <768 sheet（点行 → 全屏 Sheet）；
 *          2/3 列 = 右栏持槽（mid 只出列表，防右栏 + mid 双详情）；
 * - right：2/3 列 = 详情槽：选中 → 文件详情（预览 / 下载 / 覆盖 / 删除）/
 *          回收站条目详情（恢复 / 彻底删）；未选中 → 空态（图标 + 主文案 +
 *          副文案；F-V3-3：「上传文件」大按钮删除，改一行次要文字「上传
 *          请使用上方工具条」——工具条是唯一主 CTA；列表空态 CTA「上传一个
 *          文件」type="link" 保留）；加载中 → 「加载中…」；空目录 →
 *          「此目录为空」+ 次要文字（右栏不得空白）。
 *
 * 回收站（F-V3-3：弹窗化，替代旧 TrashPanel 独立页 + 视图切换 tab）：
 * - 工具条「回收站」按钮打开 files/TrashDialog（统一外壳 DialogShell；
 *   副标题「共 N 项 · 恢复后回到原路径」；搜索（原路径即时过滤）/ 排序
 *   （删除时间倒序默认）/ 全部恢复（>1 项，二次确认，循环 restoreTrash，
 *   逐条失败计数汇总）/ 单条恢复 / 彻底删除（二次确认含原路径 +「不可
 *   恢复」，admin only）；状态 = 骨架 / 空态 / 错误+重试；409 =「同名文件
 *   已存在」（admin「覆盖恢复」= restoreTrash 第三位置参 true；非 admin
 *   只提示）；关闭不刷新）；
 * - 数据 = load 第三腿（fs.trash/trashStatus/trashError）；弹窗**不调**
 *   listTrash；变更成功后 → onReload（= 容器 reload，in-flight 去重）。
 *
 * 撤销（F-V3-3）：
 * - 软删成功（deleteFile 返回 trashId；确认框勾选「移入回收站（可恢复）」
 *   默认）→ 列表顶部撤销条（Alert，8s 自动消失）「已移入回收站 · {name}」
 *   + 「撤销」按钮；只保留最近一条（新覆盖旧）；trashId 空不出条
 *   （undoEligible 纯函数）；点撤销 → restoreTrash 成功 → message.success +
 *   reload({silent,force:true})，失败 → 提示原因（条保留可再点）。
 *
 * 权限（Controller 终裁；前端门控 best-effort = hasToken）：
 * - 回收站彻底删 = admin only（非 admin 按钮 disabled +
 *   tooltip「仅管理员」）；
 * - restore 409（同名文件已存在）：admin 二次确认 ?overwrite=1；
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
 *
 * files-dnd（拖拽上传 + 详情抽屉 + 回收站搜索排序）：
 *   - 拖拽上传：列表 / 树 / 网格共用 files/FileDropTarget（覆盖层 + window
 *     drop 兜底），收集逻辑在 files/fileDrop（目录递归；200 文件 / 200 MB
 *     截断）；drop → 现有 useUploadQueue 队列（不另写上传）；相对路径子目录
 *     先建（.keep 占位，同「新建文件夹」）。树视图目录行 drop = 该目录为
 *     上传目标（行高亮、不透传区域遮罩）。
 *   - 详情抽屉：FileDetailDrawer（右 Drawer；<768 底部全屏 Sheet），行 /
 *     网格卡 / 树行「详情」按钮打开；只读列表已有字段（不额外请求）。
 *   - 回收站：TrashDialog 搜索（原路径 / 操作人）+ 排序下拉（删除时间 /
 *     大小 / 名称）。
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
  FolderOpenIcon,
  GridIcon,
  ListIcon,
  PageIcon,
  PictureIcon,
  TrashIcon,
  TreeIcon,
} from "../components/icons";
import { ReloadIcon } from "../components/WorkerManageShared";
import { FilePreview, type PreviewFile } from "../components/FilePreview";
import { useMediaObjectUrl } from "../useMediaObjectUrl";
import type { ManageNav } from "./useManageNav";
import type { ManageSectionProps } from "./types";
import {
  BTN_TOUCH,
  filesErrorText,
  fmtBytes,
  fmtTs,
  normTrashPath,
  TOUCH,
} from "./files/format";
import {
  DEFAULT_FILE_SORT,
  FILE_SORT_STORAGE_KEY,
  nextFileSort,
  parseFileSort,
  serializeFileSort,
  sortFileEntries,
  sortTreeLevels,
  type FileSort,
  type FileSortKey,
} from "./files/sortModel";
import {
  collectTreeEntries,
  flattenTree,
  gridMinCols,
  isTreeNavKey,
  parseFilesView,
  treeKeyNav,
  type FilesView,
  type TreeRow,
} from "./files/treeModel";
// 16.138：树行骨架与工作区路径选择器共用（缩进 / caret / 44px / aria / 键盘）。
import TreeRowShell from "./files/TreeRowShell";
import {
  UPLOAD_CONCURRENCY,
  makeUploadItems,
  markUploadStatus,
  retryUpload,
  startableIds,
  type UploadItem,
} from "./files/uploadQueue";
import {
  clearSelection,
  clickSelection,
  pruneSelection,
  selectAllState,
  selectedSummary,
  toggleSelection,
  type BatchOpResult,
  type SelectionSet,
  type SelectAllState,
} from "../lib/filesSelection";
import { resolveTargetDir, targetDirLabel } from "./files/targetDir";
import SyncSettingsModal from "./files/SyncSettingsModal";
import TrashDialog from "./files/TrashDialog";
import UploadQueuePanel from "./files/UploadQueuePanel";
import FileDropTarget from "./files/FileDropTarget";
import {
  FileOpProgressBar,
  RenameMoveDialog,
  TextEditorDialog,
  type FileOpProgress,
  type FileOpTarget,
} from "./files/FileOpsDialogs";
import QuotaEditDialog from "./files/QuotaEditDialog";
import { hfErrorText } from "./files/hfError";
import { formatQuotaValue } from "./files/quotaEdit";
import { isEditableText } from "./files/textEdit";
import { useCallerLevel } from "../hooks/useCallerLevel";
import { canControlResources } from "../lib/resourceControl";
import {
  collectDrop,
  snapshotDrop,
  uniqueParentDirs,
  DROP_MAX_BYTES,
  DROP_MAX_FILES,
  type DataTransferLike,
  type DropSnapshot,
} from "./files/fileDrop";
import { copyText } from "../util";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

// F-V3-3：fmtBytes / TOUCH 自 files/format 迁入后重导出——外部面不变
//（PeopleSection 配额卡经本文件引用 fmtBytes；files-actions-1669 经本文件
// 引用 TOUCH / touchCss）。
export { fmtBytes, TOUCH };

type Tr = (s: string, v?: Record<string, string | number>) => string;

// ── v3（F-V3-1）视图集（纯函数；tests/files-v3-1 断言）────────────────
/** 文件管理页视图：files = 主列表 / trash = 回收站。F-V3-3：视图切换 UI
 * 移除（回收站改工具条按钮 → TrashDialog 弹窗）——容器 view 恒为 "files"，
 * 类型保留 "trash" 以维持旧详情分支（TrashDetail/TrashRailList）的编译
 * 活性与测试锚点。 */
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

/** 树视图批量上下文（TreeArea 上报 → 容器）：可见行按树顺序（shift
 *  区间用，含目录）+ 已知条目（根 + 已加载子层，含折叠缓存——汇总 /
 *  批量 / 剔除基准）。折叠后可见行收窄，但已知条目不变 → 选择保留。 */
export interface TreeBatchInfo {
  visiblePaths: string[];
  entries: { path: string; name: string; size?: number; isDir?: boolean }[];
}

/** 文件域自持状态（tabs / 列表 / 详情 / 配额卡共享）。 */
interface FilesState {
  humanName: string;
  /** L1 惯例：hasToken = 已配置 Controller 管理员 token（best-effort 门控）。 */
  isAdmin: boolean;
  /** RBAC level 判定的 admin 门（canControlResources：L1）——配额编辑入口
   * 仅 admin 显示（任务书「仅 canAdmin」）。 */
  canAdmin: boolean;
  /** 行操作入口（容器挂 重命名/移动/文本编辑 弹窗）。 */
  onRename: (target: FileOpTarget) => void;
  onMove: (target: FileOpTarget) => void;
  onEditText: (target: FileOpTarget) => void;
  /** 打开配额编辑弹窗（admin only；入口已按 canAdmin 隐藏）。 */
  onEditQuota: () => void;
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
  /** F-V3-3：回收站取数状态（load 独立腿；"" = 正常 / "err" = 取数失败）。 */
  trashStatus: "" | "err";
  trashError: string;
  /** F-V3-3：统一刷新入口（in-flight 去重；force 默认 true、silent 默认 false）。 */
  reload: (opts?: { silent?: boolean; force?: boolean }) => void;
  /** F-V3-3：打开回收站弹窗（+1 次静默刷新；关闭不刷新）。 */
  onOpenTrash: () => void;
  /** F-V3-4：列表/树/网格视图模式（localStorage "manage.filesView" 持久化）。 */
  filesView: FilesView;
  /** F-V3-4：切视图（写回 localStorage；不可用静默回落）。 */
  onFilesViewChange: (v: FilesView) => void;
  /** 批量选择（列表/树/网格共用）：键 = rowPath；文件与目录均可选；
   * 视图切换保留（容器层 state），刷新/切目录由 pruneSelection 剔除。 */
  selected: SelectionSet;
  /** 当前目录可见行路径序列（列表顺序；**含目录**）——shift 区间定位 /
   * 全选 / 剔除基准。 */
  visiblePaths: string[];
  /** 「全选」三态（按当前视图可见行判定；文件 + 目录都计入）。 */
  selAll: SelectAllState;
  /** 当前焦点行是目录（详情槽据此不渲染 FileDetail / 浮层）。 */
  focusedIsDir: boolean;
  /** 复选框切换：只改批量选择，不改焦点 / 目标、不触发展开。
   *  opts.paths = 区间定位顺序（树视图传可见行顺序；缺省 = 当前目录）。 */
  onToggleSelect: (
    path: string,
    opts: { shiftKey: boolean; paths?: readonly string[] },
  ) => void;
  /** 行点击（焦点与批量选择分离）：无修饰 → 只选本行；Ctrl/Cmd → 切换；
   *  Shift → 从锚点到本行的可见行区间（文件 + 目录）。 */
  onRowClick: (
    path: string,
    opts: {
      isDir: boolean;
      shiftKey: boolean;
      toggleKey: boolean;
      paths?: readonly string[];
    },
  ) => void;
  /** 树视图批量上下文上报（可见行 + 已知条目）；null = 离开树视图。 */
  onTreeBatchChange: (info: TreeBatchInfo | null) => void;
  /** 表头/网格工具条「全选」三态切换（all → 清空；否则并入全部可见行）。 */
  onSelectAll: (paths: readonly string[]) => void;
  /** 批量操作条「取消选择」。 */
  onClearSelection: () => void;
  /** F-V3-3：当前撤销条（null = 无；只保留最近一条）。 */
  undo: { trashId: string; name: string } | null;
  /** F-V3-3：软删成功登记撤销（trashId 空 → 不出条，见 undoEligible）。 */
  offerUndo: (u: { trashId: string; name: string }) => void;
  /** F-V3-3：点「撤销」→ restoreTrash（成功 message + reload force；失败提示原因）。 */
  onUndo: () => void;
  /** 打开文件/目录详情抽屉（行 / 网格卡 / 树行的「详情」按钮；不额外发请求）。 */
  onOpenDetail: (path: string, isDir: boolean) => void;
}

type SubProps = {
  t: ThemeColors;
  tr: Tr;
  nav: ManageNav;
  fs: FilesState;
};

// fmtBytes / fmtTs（文件域共享纯函数）F-V3-3 起在 files/format.ts
//（TrashDialog / SyncSettingsModal 共用；本文件 import + 重导出，外部面不变）。

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
 * #1669：操作列 64→96px（2×40px 图标按钮 + 8px 间距，适配 40px 触控目标）。
 * files-dnd：操作列 96→136px（3×40px：详情 / 下载 / 删除；同样 8px 间距）。 */
/** 列模板按可见列拼（名称 / 大小 / 类型 / 修改 / 创建 / 操作）。 */
export function listGrid(o: { modified: boolean; created: boolean }): string {
  const cols = ["minmax(0, 1fr)", "72px", "84px"];
  if (o.modified) cols.push("120px");
  if (o.created) cols.push("120px");
  cols.push("136px");
  return cols.join(" ");
}
/** 兼容导出（历史测试引用；默认 = 三列 + 操作）。 */
export const LIST_GRID = listGrid({ modified: true, created: false });
export const LIST_GRID_NO_TIME = listGrid({ modified: false, created: false });

/** 扩展名（小写，无扩展名 → ""）。 */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
}

/** 类型列：文件夹 / 扩展名大写 / 文件（对齐 Finder 的 Kind 列）。 */
export function fileTypeLabel(e: HumanFileEntry): string {
  if (isEntryDir(e)) return "文件夹";
  const ext = extOf(entryDisplayName(e));
  return ext ? ext.toUpperCase() : "文件";
}

/** F-V3-3 列自适应（纯函数；tests/files-v3-3 断言）：整批条目都没有
 * updatedAt → 不渲染「更新时间」列（表头 / 行 / grid 模板同步）。 */
export function columnsFor(entries: HumanFileEntry[]): {
  showUpdatedAt: boolean;
  showCreated: boolean;
  grid: string;
} {
  const showUpdatedAt = entries.some(
    (e) => typeof e.updatedAt === "string" && e.updatedAt !== "",
  );
  // 创建时间：当前控制器（S3 / embedded）不返回，只有后端提供时才成列。
  const showCreated = entries.some(
    (e) => typeof (e as { createdAt?: string }).createdAt === "string" &&
      (e as { createdAt?: string }).createdAt !== "",
  );
  return {
    showUpdatedAt,
    showCreated,
    grid: listGrid({ modified: showUpdatedAt, created: showCreated }),
  };
}

/** 详情抽屉 ETag 脱敏（任务书：展示前 12 位；超长补省略号）。纯函数。 */
export function maskEtag(etag: string | undefined | null): string {
  if (!etag) return "—";
  return etag.length > 12 ? `${etag.slice(0, 12)}…` : etag;
}

/** 目录详情「子项数」：只统计已加载条目（列表/递归平铺里的直接子项）。
 *  当前目录本身不在列表里 → 0；不做额外请求。纯函数。 */
export function loadedChildCount(
  entries: readonly HumanFileEntry[],
  dirPath: string,
): number {
  const base = dirPath.replace(/\/+$/, "");
  if (!base) return 0;
  const prefix = `${base}/`;
  let n = 0;
  for (const e of entries) {
    if (!e.path) continue; // 老形态无全路径 → 无法判定归属
    const p = entryRelPath(e).replace(/\/+$/, "");
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest.length > 0 && !rest.includes("/")) n += 1;
  }
  return n;
}

/** F-V3-3 静默轮询门控（纯函数；tests/files-v3-3 断言）：顶层 tab 激活 &&
 * 非 404 && 非分页中途（nextKey 为 string = 还有下一页，静默刷新会重置
 * 游标）。子目录不再豁免（dirGuard 目录标签防过期覆盖）。 */
export function shouldPoll(o: {
  active: boolean;
  status: "" | "404" | "err";
  dirPath: string;
  nextKey: string | null | undefined;
}): boolean {
  if (!o.active) return false;
  if (o.status === "404") return false;
  if (typeof o.nextKey === "string") return false;
  return true;
}

/** F-V3-3 焦点感知刷新阈值（ms）：可见且距上次成功 load 超过它 → 静默刷新。 */
export const FOCUS_REFETCH_MS = 10000;

/** F-V3-3 焦点感知判定（纯函数；tests/files-v3-3 断言）：
 * 距上次成功 load > 10s → 刷新（恰好 10s 不刷）。 */
export function shouldRefetchOnFocus(last: number, now: number): boolean {
  return now - last > FOCUS_REFETCH_MS;
}

/** F-V3-3 撤销条资格（纯函数；tests/files-v3-3 断言）：trashId 非空才出条。 */
export function undoEligible(trashId: string): boolean {
  return typeof trashId === "string" && trashId.length > 0;
}

/** F-V3-3 reload in-flight 去重（纯工厂；tests/files-v3-3 断言）：
 * 同 key 已有请求在跑 → 复用同一 Promise（不新发）；settle 后清槽可重发；
 * 异 key 互不干扰。容器用它包装 load（key = dirPath + view）。 */
export function makeReloadDedup(): (
  key: string,
  run: () => Promise<void>,
) => Promise<void> {
  let cur: { key: string; p: Promise<void> } | null = null;
  // A click that lands while a request for the same key is already running
  // must not be dropped: it would look like the refresh button did nothing.
  // Remember the latest request and replay it once the flight settles.
  let queued: { key: string; run: () => Promise<void> } | null = null;
  const start = (key: string, run: () => Promise<void>): Promise<void> => {
    const p = run().finally(() => {
      if (cur && cur.p === p) cur = null;
      const next = queued;
      queued = null;
      if (next) void start(next.key, next.run);
    });
    cur = { key, p };
    return p;
  };
  return (key, run) => {
    if (cur && cur.key === key) {
      queued = { key, run };
      return cur.p;
    }
    return start(key, run);
  };
}

// ── F-V3-4 视图模式（列表/树/网格）持久化 ─────────────────────────────
/** localStorage 键（视图选择跨会话保留）。 */
const FILES_VIEW_STORAGE_KEY = "manage.filesView";
/** 读持久化视图（localStorage 不可用——隐私模式/受限宿主 → null 回落 list）。 */
function readStoredFilesView(): string | null {
  try {
    return localStorage.getItem(FILES_VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}
/** 写回持久化视图（失败静默——视图选择属可失数据，不打断交互）。 */
function writeStoredFilesView(v: FilesView): void {
  try {
    localStorage.setItem(FILES_VIEW_STORAGE_KEY, v);
  } catch {
    /* 静默回落（内存态仍生效） */
  }
}
/** 视图切换窄屏规则（≤600px 分段按钮只显图标，文字隐藏）。 */
const VIEW_SEG_CSS =
  "@media (max-width: 600px){.hf-view-seg .hf-view-seg-label{display:none}}";

// 树形键盘导航键判别 16.138 起在 files/treeModel（isTreeNavKey，本文件与
// 工作区路径选择器共用）。

// ── #1669 触控目标（用户实测：按钮太小、触屏难点）──
// TOUCH 常量 F-V3-3 起在 files/format.ts（本文件 import + 重导出）。

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

/** #1669：antd.Button 最小触控目标——唯一实现在 files/format（BTN_TOUCH）。 */
const btnTouch: ReactNS.CSSProperties = BTN_TOUCH;

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

/** 行内「详情」图标（icons.tsx 无 info 形态；files 域自持，防跨域耦合）。 */
function InfoIcon({ size = 16 }: { size?: number }): ReactNS.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 7.2v4M8 4.9v.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 行内「重命名」图标（铅笔；icons.tsx 无此形态，files 域自持）。 */
function RenameIcon({ size = 16 }: { size?: number }): ReactNS.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10.8 2.7l2.5 2.5L5.6 12.9l-3.1.6.6-3.1 7.7-7.7z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 行内「移动到…」图标（文件夹 + 右箭头）。 */
function MoveIcon({ size = 16 }: { size?: number }): ReactNS.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.8 4.2h4l1.4 1.6h7v6.4H1.8V4.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M7.2 9.4h4.2M9.8 7.8l1.6 1.6-1.6 1.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 行内「编辑文本」图标（文档 + 笔）。 */
function EditTextIcon({ size = 16 }: { size?: number }): ReactNS.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.2 1.8h6.4l3.2 3.2v4.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M5.2 6.2h4.4M5.2 8.6h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M12.4 9.2l1.5 1.5-3.9 3.9-1.9.4.4-1.9 3.9-3.9z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** F-V3-4 视图分段按钮（裸 <button>；≥44px 触控盒 = --hf-row-min；
 * 激活 = accentBg 底 + text 色）。 */
function viewSegBtnStyle(t: ThemeColors, active: boolean): ReactNS.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: "var(--hf-row-min, 44px)",
    minWidth: "var(--hf-row-min, 44px)",
    padding: "0 10px",
    border: `1px solid ${t.border}`,
    borderRadius: 6,
    background: active ? t.accentBg : "transparent",
    color: active ? t.text : t.textSecondary,
    fontWeight: active ? 700 : 400,
    cursor: "pointer",
  };
}

/** 条目完整相对路径（文件行选中键 / API 路径）。 */
function fullPath(dirPath: string, name: string): string {
  return dirPath ? `${dirPath}/${name}` : name;
}

/** 行操作弹窗用的条目名（目录新形态 path 带尾斜杠 → 取末段，避免把
 * "files/docs/" 整串当名称回显）。 */
function opNameOf(path: string, fallback: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.split("/").pop() || fallback;
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

/** 批量操作结果汇总（任务 C）：全部成功 →「{n} 项{noun}成功」；
 * 部分失败不中断后 →「{a} 成功 / {b} 失败（首个错误原因）」（warning 级）。 */
function reportBatchResult(tr: Tr, noun: string, r: BatchOpResult): void {
  if (r.failed === 0) {
    antd.message.success(tr("{n} 项{noun}成功", { n: r.ok, noun }));
    return;
  }
  antd.message.warning(tr("{a} 成功 / {b} 失败（{why}）", {
    a: r.ok,
    b: r.failed,
    why: r.firstError ?? tr("未知错误"),
  }));
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
 * 16.137 起实现迁到 files/hfError.ts（QuotaEditDialog 共用，避免回环），
 * 此处 re-export 保持外部 import 面（PeopleSection 等）不变。 */
export { hfErrorText };

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

/** #1669 删除确认（列表行 + 详情面板 + 网格卡 + 容器批量共用，不各写一份
 * Modal）：单文件模式标题「删除文件？」+ 文件名 + 勾选「移入回收站（可恢复）」
 * （默认勾选；未勾选显「⚠ 将彻底删除，不可恢复」）；按钮 [取消] [删除]。
 * 批量模式（requestBatch）：标题「删除 {n} 个文件？」，恒软删进回收站
 * （无彻底删除选项——服务端不支持目录/批量彻底删），串行执行、部分失败
 * 不中断，结果（成功 N / 失败 M / 首个错误原因 + 已删清单）交 onBatchDone，
 * 由调用方汇总提示。不做前端角色门（无「仅管理员可彻底删除」禁用/提示）；
 * 单文件成功文案区分「已移入回收站」/「已彻底删除」；失败 = hfErrorText
 * （403 →「无权限」）。 */
function useDeleteConfirm(inp: {
  t: ThemeColors;
  tr: Tr;
  humanName: string;
  /** 单文件删除成功 → 调用方清选中 + 刷新 +（软删时）登记撤销条。
   * F-V3-3：trashId 供 undo（restoreTrash 目标），name 供撤销条文案。 */
  onDone: (r: { trashId: string; purged: boolean; name: string }) => void;
  /** 批量模式完成回调（仅 requestBatch 触发）：软删结果汇总（部分失败
   * 不中断；deleted = 删除成功项，供清详情选中）；调用方负责提示 + 刷新。 */
  onBatchDone?: (
    r: BatchOpResult & { deleted: { path: string; name: string }[] },
  ) => void;
}): {
  open: boolean;
  busy: boolean;
  request: (path: string, name: string) => void;
  requestBatch: (items: { path: string; name: string }[]) => void;
  node: ReactNS.ReactElement;
} {
  const [open, setOpen] = React.useState(false);
  const [path, setPath] = React.useState("");
  const [name, setName] = React.useState("");
  const [batch, setBatch] = React.useState<{ path: string; name: string }[] | null>(null);
  const [recycle, setRecycle] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  const request = (p: string, n: string) => {
    setPath(p);
    setName(n);
    setBatch(null);
    setRecycle(true); // 每次打开默认勾选「移入回收站（可恢复）」
    setOpen(true);
  };
  const requestBatch = (items: { path: string; name: string }[]) => {
    setPath("");
    setName("");
    setBatch(items);
    setOpen(true);
  };
  const close = () => {
    if (!busy) setOpen(false);
  };
  const onOk = async () => {
    setBusy(true);
    try {
      if (batch) {
        // 批量：串行软删（恒进回收站，无彻底删选项）；部分失败不中断，
        // 单项错误仅计入汇总（首个错误原因），不逐项弹 toast。
        let ok = 0;
        let failed = 0;
        let firstError: string | undefined;
        const deleted: { path: string; name: string }[] = [];
        for (const it of batch) {
          try {
            await deleteFile(inp.humanName, it.path);
            ok += 1;
            deleted.push(it);
          } catch (err) {
            failed += 1;
            if (firstError === undefined) firstError = hfErrorText(err, inp.tr);
          }
        }
        setOpen(false);
        inp.onBatchDone?.({ ok, failed, firstError, deleted });
        return;
      }
      const r = await runDeletePlan(inp.humanName, path, deletePlan({ recycle }));
      antd.message.success(inp.tr(r.purged ? "已彻底删除" : "已移入回收站"));
      setOpen(false);
      inp.onDone({ trashId: r.trashId, purged: r.purged, name });
    } catch (err) {
      antd.message.error(hfErrorText(err, inp.tr));
    } finally {
      setBusy(false);
    }
  };

  const node = batch ? (
    <antd.Modal
      open={open}
      title={inp.tr("删除 {n} 个文件？", { n: batch.length })}
      okText={inp.tr("删除")}
      cancelText={inp.tr("取消")}
      confirmLoading={busy}
      onOk={() => void onOk()}
      onCancel={close}
      destroyOnClose
    >
      <div style={{ display: "grid", gap: 8, padding: "4px 0" }}>
        <div style={{ fontSize: 13, color: inp.t.text }}>
          {inp.tr("将移入回收站（可在回收站恢复）")}
        </div>
        <div style={{ display: "grid", gap: 2, fontSize: 12, color: inp.t.textSecondary }}>
          {batch.slice(0, 5).map((it) => (
            <span
              key={it.path}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {it.name}
            </span>
          ))}
          {batch.length > 5 ? (
            <span>{inp.tr("等 {n} 个文件", { n: batch.length })}</span>
          ) : null}
        </div>
      </div>
    </antd.Modal>
  ) : (
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
  return { open, busy, request, requestBatch, node };
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
 * 加载中 → 「加载中…」/ files 空目录 → 「此目录为空」+ 次要文字 / 未选中 →
 * 图标 + 主副文案 + 次要文字（F-V3-3：「上传文件」大按钮删除——工具条是
 * 唯一主 CTA；列表空态 CTA「上传一个文件」link 保留）。 */
function DetailPane({ t, tr, nav, fs }: SubProps) {
  const st = detailState({
    hasSelection: nav.selectedFile != null && !fs.focusedIsDir,
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
        // F-V3-3：主 CTA 收敛到工具条「上传文件」（列表空态 CTA link 同指向）。
        <div style={{ marginTop: 6, fontSize: 12, color: t.textSecondary }}>
          {tr("上传请使用上方工具条")}
        </div>
      ) : null}
    </div>
  );
}

/** 16.69 详情浮层外壳（DetailOverlay / FileDetailDrawer 共用）：右 Drawer
 *  (420) / 底部全屏 Sheet 两种形态——同一套 antd.Drawer 配置，不各写一份。 */
function DetailDrawerShell({
  t,
  title,
  overlay,
  onClose,
  children,
}: {
  t: ThemeColors;
  title: string;
  overlay: "drawer" | "sheet";
  onClose: () => void;
  children: ReactNS.ReactNode;
}) {
  const bodyStyle = { padding: 14, background: t.bg };
  if (overlay === "sheet") {
    return (
      <antd.Drawer
        open
        onClose={onClose}
        placement="bottom"
        height="100%"
        title={title}
        styles={{ body: bodyStyle }}
      >
        {children}
      </antd.Drawer>
    );
  }
  return (
    <antd.Drawer
      open
      onClose={onClose}
      width={420}
      title={title}
      styles={{ body: bodyStyle }}
    >
      {children}
    </antd.Drawer>
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
  return (
    <DetailDrawerShell t={t} title={title} overlay={overlay} onClose={close}>
      {body}
    </DetailDrawerShell>
  );
}

/** files-dnd 详情抽屉目标（行 / 网格卡 / 树行「详情」按钮传入）。 */
export interface FileDetailTarget {
  path: string;
  isDir: boolean;
}

/** 文件 / 目录详情抽屉（files-dnd）：右侧 Drawer（<768 容器宽度 → 底部
 * 全屏 Sheet，与 DetailOverlay 同口径）。只读列表已有字段——**不额外发
 * 请求**；updatedAt / ETag 缺失显示「—」。文件：路径（可复制）/ 大小 /
 * 类型 / 修改 / ETag（前 12 位）+ 预览 / 下载 / 删除（进回收站）；目录：
 * 路径 + 已加载子项数 + 同步设置快捷入口。 */
export function FileDetailDrawer({
  t,
  tr,
  fs,
  target,
  narrow,
  onClose,
  onOpenSyncSettings,
}: SubProps & {
  target: FileDetailTarget | null;
  narrow: boolean;
  onClose: () => void;
  onOpenSyncSettings: () => void;
}) {
  const [busy, setBusy] = React.useState<"" | "download">("");
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  const targetPath = target?.path ?? "";
  const targetIsDir = target?.isDir ?? false;
  const entry = target
    ? fs.files.find(
        (e) => rowPath(e, fs.dirPath) === target.path && isEntryDir(e) === target.isDir,
      )
    : undefined;
  const name = entry
    ? entryDisplayName(entry)
    : targetPath.split("/").filter(Boolean).pop() ?? "";
  const opName = opNameOf(targetPath, name);
  // #1669 统一删除确认（与列表行 / 详情面板共用，不另写 Modal）。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: (r) => {
      onClose();
      if (!r.purged) fs.offerUndo({ trashId: r.trashId, name });
      fs.reload({ silent: true });
    },
  });

  const apiPath = humanFileApiPath(fs.humanName, targetPath);
  const onDownload = async (): Promise<void> => {
    if (!entry) return;
    setBusy("download");
    const ok = await doDownload(fs.humanName, targetPath, name, entry.size, tr);
    setBusy("");
    if (!ok) antd.message.error(tr("下载失败"));
  };
  const onPreview = (): void => {
    if (!entry) return;
    setPreview({
      name,
      url: apiPath,
      apiPath,
      size: entry.size,
      rawUrl: apiPath,
    });
  };
  const onCopyPath = (): void => {
    copyText(targetPath, (ok) => {
      if (ok) antd.message.success(tr("已复制"));
      else antd.message.error(tr("复制失败（浏览器未授权剪贴板）"));
    });
  };

  const field = (label: string, value: ReactNS.ReactNode): ReactNS.ReactElement => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "88px minmax(0, 1fr)",
        gap: 8,
        alignItems: "start",
        fontSize: 12,
      }}
    >
      <span style={{ color: t.textSecondary }}>{label}</span>
      <span style={{ color: t.text, wordBreak: "break-all", minWidth: 0 }}>{value}</span>
    </div>
  );

  const body = !target || !entry ? (
    <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: t.textSecondary }}>
      {tr("所选文件已不在最新数据中")}
    </div>
  ) : (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 6 }}>
        {field(
          tr("路径"),
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span
              title={targetPath}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {targetPath}
            </span>
            <button
              type="button"
              onClick={onCopyPath}
              title={tr("复制路径")}
              aria-label={tr("复制路径")}
              style={{
                minHeight: 44,
                minWidth: 44,
                border: "none",
                background: "transparent",
                color: t.textSecondary,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {tr("复制")}
            </button>
          </span>,
        )}
        {field(tr("大小"), targetIsDir ? "—" : fmtBytes(entry.size))}
        {field(tr("类型"), tr(fileTypeLabel(entry)))}
        {field(tr("修改"), fmtTs(entry.updatedAt) || "—")}
        {targetIsDir
          ? field(tr("子项数（已加载）"), String(loadedChildCount(fs.files, targetPath)))
          : field(
              "ETag",
              <span style={{ fontFamily: "monospace" }}>{maskEtag(entry.etag)}</span>,
            )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {targetIsDir ? (
          <>
            <antd.Button
              style={{ minHeight: 44 }}
              onClick={() => {
                onClose();
                fs.onRename({ path: targetPath, name: opName, isDir: true, etag: entry.etag });
              }}
            >
              {tr("重命名")}
            </antd.Button>
            <antd.Button
              style={{ minHeight: 44 }}
              onClick={() => {
                onClose();
                fs.onMove({ path: targetPath, name: opName, isDir: true, etag: entry.etag });
              }}
            >
              {tr("移动到…")}
            </antd.Button>
            <antd.Button style={{ minHeight: 44 }} onClick={onOpenSyncSettings}>
              {tr("同步设置")}
            </antd.Button>
          </>
        ) : (
          <>
            {isEditableText(name, entry.size) ? (
              <antd.Button
                style={{ minHeight: 44 }}
                onClick={() => {
                  onClose();
                  fs.onEditText({
                    path: targetPath,
                    name: opName,
                    isDir: false,
                    size: entry.size,
                    etag: entry.etag,
                  });
                }}
              >
                {tr("编辑")}
              </antd.Button>
            ) : null}
            <antd.Button
              style={{ minHeight: 44 }}
              onClick={() => {
                onClose();
                fs.onRename({
                  path: targetPath,
                  name,
                  isDir: false,
                  size: entry.size,
                  etag: entry.etag,
                });
              }}
            >
              {tr("重命名")}
            </antd.Button>
            <antd.Button
              style={{ minHeight: 44 }}
              onClick={() => {
                onClose();
                fs.onMove({
                  path: targetPath,
                  name,
                  isDir: false,
                  size: entry.size,
                  etag: entry.etag,
                });
              }}
            >
              {tr("移动到…")}
            </antd.Button>
            {previewable(name) ? (
              <antd.Button type="primary" style={{ minHeight: 44 }} onClick={onPreview}>
                {tr("预览")}
              </antd.Button>
            ) : null}
            <antd.Button
              loading={busy === "download"}
              style={{ minHeight: 44 }}
              onClick={() => void onDownload()}
            >
              {tr("下载")}
            </antd.Button>
            <antd.Button danger style={{ minHeight: 44 }} onClick={() => del.request(targetPath, name)}>
              {tr("删除")}
            </antd.Button>
          </>
        )}
      </div>
      {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
      {del.node}
      {/* #1669：复用 components/FilePreview（图 / md / csv / xlsx / json 内联）。 */}
      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );

  return (
    <DetailDrawerShell
      t={t}
      title={targetIsDir ? tr("目录详情") : tr("文件详情")}
      overlay={narrow ? "sheet" : "drawer"}
      onClose={onClose}
    >
      {body}
    </DetailDrawerShell>
  );
}

/** 面包屑目录导航（16.67：根层不渲染整行——「我的文件」已由视图切换
 * tab 表达；非根 = 仅路径段 + ↑ 上级目录）。 */
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

/** 批量选择 checkbox（裸 `<button role="checkbox">`——静态渲染测试的
 * antd 桩无 Checkbox，不引入新 antd 组件进任何渲染路径）：44×44 触控
 * 命中区（--hf-row-min，coarse 指针 +10%），18px 内框（≥18px 本体）；
 * ✓ = 选中，– = 半选（全选三态 indeterminate）。配色全走 theme token。 */
function SelCheck({
  t,
  checked,
  indeterminate = false,
  onToggle,
  label,
}: {
  t: ThemeColors;
  checked: boolean;
  /** 半选（全选三态 = some）。 */
  indeterminate?: boolean;
  /** 省略 = 纯展示（disabled 语义）。 */
  onToggle?: (shiftKey: boolean) => void;
  label: string;
}) {
  const on = checked || indeterminate;
  const interactive = onToggle !== undefined;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation(); // 不触发行/卡片的点击语义（目录进入/详情选中）
        if (interactive) onToggle(e.shiftKey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          if (interactive) onToggle(false);
        }
      }}
      style={{
        width: "var(--hf-row-min, 44px)",
        height: "var(--hf-row-min, 44px)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: interactive ? "pointer" : "default",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          // token 无实色 accent（accentBg 仅 10% tint 底），选中实色走宿主主色变量。
          border: `1.5px solid ${on ? "var(--app-accent, #FF7F16)" : t.border}`,
          background: on ? "var(--app-accent, #FF7F16)" : "transparent",
          color: "#fff",
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {checked ? "✓" : indeterminate ? "–" : ""}
      </span>
    </button>
  );
}

/** 批量操作条（选中 >0 且列表/树/网格视图均渲染）：
 * 「已选 {n} 项 · {字节}」+ 下载（串行 + 进度「下载中（a/b）」）/ 删除
 *（复用 useDeleteConfirm 批量模式，进回收站）/ 取消选择。
 * 三视图同源：选中集合 = 容器 selected，批量项 = 容器 batchEntries（树 =
 * 根 + 已加载子层，折叠保留选择）。B2：目录也计入选择 → 下载跳过并显式
 * 提示「目录不支持下载」，删除跳过并提示（服务端不支持目录删除）。 */
function BatchBar({
  t,
  tr,
  count,
  bytes,
  dirCount,
  dlProgress,
  busy,
  onDownload,
  onDelete,
  onCancel,
}: {
  t: ThemeColors;
  tr: Tr;
  count: number;
  bytes: number;
  /** 选中项中的目录数（下载跳过；删除需显式提示不支持）。 */
  dirCount: number;
  /** {done,total} | null（null = 未在批量下载）。 */
  dlProgress: { done: number; total: number } | null;
  /** 批量删除确认进行中（禁用操作防重入）。 */
  busy: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const dl = dlProgress;
  const fileCount = count - dirCount;
  return (
    <div
      role="toolbar"
      aria-label={tr("批量操作")}
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 8,
        background: t.accentBg,
        border: `1px solid ${t.border}`,
        fontSize: 12,
        color: t.text,
      }}
    >
      <span style={{ fontWeight: 700 }}>
        {tr("已选 {n} 项", { n: count })}
        <span style={{ fontWeight: 400, color: t.textSecondary }}>
          {" · "}
          {fmtBytes(bytes)}
        </span>
      </span>
      <span style={{ flex: "1 1 100%" }} />
      {dirCount > 0 ? (
        <span style={{ fontSize: 11, color: t.textSecondary, flexBasis: "100%" }}>
          {tr("目录不支持下载，已跳过 {n} 个", { n: dirCount })}
        </span>
      ) : null}
      <antd.Button
        size="small"
        loading={dl !== null}
        disabled={busy || fileCount === 0}
        style={btnTouch}
        onClick={onDownload}
      >
        {dl
          ? tr("下载中（{a}/{b}）", { a: dl.done, b: dl.total })
          : tr("下载")}
      </antd.Button>
      <antd.Button
        size="small"
        danger
        disabled={busy}
        style={btnTouch}
        onClick={onDelete}
      >
        {tr("删除")}
      </antd.Button>
      <antd.Button size="small" disabled={busy} style={btnTouch} onClick={onCancel}>
        {tr("取消选择")}
      </antd.Button>
    </div>
  );
}

/** 列表块（F-V3-3：files-only——回收站改工具条按钮 → TrashDialog 弹窗，
 * 不再同屏）：出错+重试（reload force）/ 加载中 / 空态（居中一句 + 主 CTA
 * 文字链接，指向工具条同一处理函数）/ 表头行 + 文件行列表（列自适应
 * columnsFor：整批无 updatedAt → 不渲染「更新时间」列；compact = l1 列
 * 紧凑行）。 */
/** 可排序表头（列表与树共用）：
 * - 列名点击 = 同列翻转 / 换列升序；
 * - 右侧**两个三角形**（▲ 升序 / ▼ 降序）可分别点击直达方向；
 * - aria-sort 供读屏；触控热区 ≥44px。 */
function SortHeader({
  label,
  k,
  sort,
  onSort,
  onSetSort,
  align,
}: {
  label: string;
  k: FileSortKey;
  sort: FileSort;
  onSort: (k: FileSortKey) => void;
  onSetSort: (s: FileSort) => void;
  align?: "right";
}) {
  const active = sort.key === k;
  const triangle = (dir: "asc" | "desc") => {
    const on = active && sort.dir === dir;
    return (
      <button
        type="button"
        aria-label={`${label} ${dir === "asc" ? "升序" : "降序"}`}
        onClick={(e) => {
          e.stopPropagation();
          onSetSort({ key: k, dir });
        }}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "0 1px",
          lineHeight: "6px",
          fontSize: 7,
          opacity: on ? 0.95 : 0.32,
          color: on ? "var(--app-accent, inherit)" : "inherit",
        }}
      >
        {dir === "asc" ? "▲" : "▼"}
      </button>
    );
  };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        minHeight: 44,
        justifyContent: align === "right" ? "flex-end" : "flex-start",
      }}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        style={{
          all: "unset",
          cursor: "pointer",
          color: active ? "var(--app-accent, inherit)" : "inherit",
          fontWeight: active ? 600 : 400,
        }}
      >
        {label}
      </button>
      <span style={{ display: "inline-flex", flexDirection: "column", marginLeft: 1 }}>
        {triangle("asc")}
        {triangle("desc")}
      </span>
    </span>
  );
}

function ListArea({
  t,
  tr,
  nav,
  fs,
  actions,
  compact = false,
  files,
  sort,
  onSort,
  onSetSort,
}: SubProps & {
  actions: FilesActions;
  compact?: boolean;
  files: HumanFileEntry[];
  sort: FileSort;
  onSort: (k: FileSortKey) => void;
  onSetSort: (s: FileSort) => void;
}) {
  const count = files.length;
  // F-V3-3 列自适应：表头 / 行 / grid 模板同一决策（纯函数 columnsFor）。
  const cols = columnsFor(fs.files);
  // 可见行顺序（列表顺序，含目录）：shift 区间 / 全选三态 / 行点击共用。
  const viewPaths = React.useMemo(
    () => files.map((e) => rowPath(e, fs.dirPath)).filter((p) => p !== ""),
    [files, fs.dirPath],
  );
  const selState = selectAllState(fs.selected, viewPaths);
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
            description={tr(filesErrorText(fs.error))}
          />
          <antd.Button style={btnTouch} onClick={() => fs.reload({ force: true })}>
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
       * 与数据行共用同一 grid 模板（列宽稳定）。F-V3-3：整批无 updatedAt
       * → 「更新时间」列不渲染（cols.showUpdatedAt 门控）。回收站列头在
       * files/TrashDialog（原路径 / 大小 / 删除时间 / 操作）。 */}
      {!compact && fs.status !== "err" && !fs.loading && count > 0 ? (
        <div
          style={{
            display: "grid",
            // 44px 首列 = 批量全选 checkbox（与 FileRow 行模板同宽，列宽稳定）。
            gridTemplateColumns: `44px ${cols.grid}`,
            gap: 8,
            alignItems: "center",
            padding: "0 8px",
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          <SelCheck
            t={t}
            checked={selState === "all"}
            indeterminate={selState === "some"}
            onToggle={() => fs.onSelectAll(viewPaths)}
            label={tr("全选")}
          />
          <SortHeader label={tr("名称")} k="name" sort={sort} onSort={onSort} onSetSort={onSetSort} />
          <span style={{ textAlign: "right" }}>
            <SortHeader
              label={tr("大小")}
              k="size"
              sort={sort}
              onSort={onSort} onSetSort={onSetSort}
              align="right"
            />
          </span>
          <SortHeader label={tr("类型")} k="type" sort={sort} onSort={onSort} onSetSort={onSetSort} />
          {cols.showUpdatedAt ? (
            <SortHeader
              label={tr("修改")}
              k="updatedAt"
              sort={sort}
              onSort={onSort} onSetSort={onSetSort}
            />
          ) : null}
          {cols.showCreated ? (
            <SortHeader
              label={tr("创建")}
              k="createdAt"
              sort={sort}
              onSort={onSort} onSetSort={onSetSort}
            />
          ) : null}
          <span>{tr("操作")}</span>
        </div>
      ) : null}
      {files.map((e) => (
        <FileRow
          key={rowPath(e, fs.dirPath) || entryDisplayName(e)}
          entry={e}
          t={t}
          tr={tr}
          nav={nav}
          fs={fs}
          compact={compact}
          paths={viewPaths}
          grid={cols.grid}
          showUpdatedAt={cols.showUpdatedAt}
          showCreated={cols.showCreated}
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

/** 文件行：目录行 = 点击进入；文件行 = 点击选中 + 行内 下载 / 删除(→回收站)。
 * F-V3-3：grid / showUpdatedAt 由 ListArea 的 columnsFor 决策传入（表头/行
 * 同步）；软删成功登记撤销条（fs.offerUndo）+ reload 静默刷新。 */
function FileRow({
  entry,
  t,
  tr,
  nav,
  fs,
  compact = false,
  paths,
  grid = LIST_GRID,
  showUpdatedAt = true,
  showCreated = false,
}: SubProps & {
  entry: HumanFileEntry;
  compact?: boolean;
  /** 可见行顺序（含目录）：shift 区间 / 行点击区间共用。 */
  paths: readonly string[];
  grid: string;
  showUpdatedAt: boolean;
  showCreated: boolean;
}) {
  const isDir = isEntryDir(entry);
  const name = entryDisplayName(entry);
  const path = rowPath(entry, fs.dirPath);
  // 焦点行与批量选择都高亮（目录也可选，B2 选择模型）。
  const sel = nav.selectedFile === path || fs.selected.has(path);
  // 递归平铺模式下目录行不导航（避免模式切换丢游标）——非交互行。
  const dirInteractive = isDir && !fs.recursive;

  /** 行点击 = 焦点 + 批量选择（无修饰只选本行 / Ctrl 切换 / Shift 区间）。 */
  const rowClick = (e: ReactNS.MouseEvent) =>
    fs.onRowClick(path, {
      isDir,
      shiftKey: e.shiftKey,
      toggleKey: e.ctrlKey || e.metaKey,
      paths,
    });
  /** Enter 激活：目录进入；文件聚焦（行点击同义）。 */
  const activate = () => {
    if (isDir) {
      if (dirInteractive) fs.onEnterDir(path);
      return;
    }
    fs.onRowClick(path, { isDir: false, shiftKey: false, toggleKey: false, paths });
  };
  const toggleSel = (shiftKey: boolean) =>
    fs.onToggleSelect(path, { shiftKey, paths });
  const onDownload = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    void doDownload(fs.humanName, path, name, entry.size, tr).then((ok) => {
      if (!ok) antd.message.error(tr("下载失败"));
    });
  };
  // #1669 统一删除确认（与详情面板共用 useDeleteConfirm，不各写一份 Modal）：
  // 勾选「移入回收站（可恢复）」（默认）= 软删；未勾选 = 软删后立即彻底删。
  // F-V3-3：软删成功（trashId 非空）登记撤销条；刷新走统一 reload。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: (r) => {
      if (nav.selectedFile === path) nav.selectFile(null);
      if (!r.purged) fs.offerUndo({ trashId: r.trashId, name });
      fs.reload({ silent: true });
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
  const onDetail = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    fs.onOpenDetail(path, isDir);
  };
  const detailBtn = (
    <button
      type="button"
      onClick={onDetail}
      title={tr("详情")}
      aria-label={tr("详情")}
      style={iconBtnStyle(t)}
    >
      <InfoIcon size={16} />
    </button>
  );
  // 第二批行操作：重命名 / 移动到…（目录同样支持）；文本文件额外给「编辑」。
  const opTarget: FileOpTarget = {
    path,
    name: opNameOf(path, name),
    isDir,
    size: entry.size,
    etag: entry.etag,
  };
  const renameBtn = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        fs.onRename(opTarget);
      }}
      title={tr("重命名")}
      aria-label={tr("重命名")}
      style={iconBtnStyle(t)}
    >
      <RenameIcon size={16} />
    </button>
  );
  const moveBtn = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        fs.onMove(opTarget);
      }}
      title={tr("移动到…")}
      aria-label={tr("移动到…")}
      style={iconBtnStyle(t)}
    >
      <MoveIcon size={16} />
    </button>
  );
  const editBtn =
    !isDir && isEditableText(name, entry.size) ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          fs.onEditText(opTarget);
        }}
        title={tr("编辑")}
        aria-label={tr("编辑")}
        style={iconBtnStyle(t)}
      >
        <EditTextIcon size={16} />
      </button>
    ) : null;
  const actionsCell = isDir ? (
    // #1669 目录不可删（服务端不支持目录删除）：禁用删除按钮 + tooltip 提示。
    <span style={{ display: "flex", alignItems: "center", gap: TOUCH.iconGap }}>
      {detailBtn}
      {renameBtn}
      {moveBtn}
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
      {detailBtn}
      {editBtn}
      {renameBtn}
      {moveBtn}
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
          if (e.key === "Enter") {
            e.preventDefault();
            activate();
          } else if (e.key === " ") {
            // Space = 切换批量选择（行焦点不变）。
            e.preventDefault();
            toggleSel(e.shiftKey);
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

  // 16.67 列表行（非 compact）：grid（名称/大小/更新时间/操作；F-V3-3
  // 整批无 updatedAt → 三列，grid/showUpdatedAt 由 columnsFor 传入）；
  // B2 选择模型：单击行 = 焦点 + 批量选择（无修饰只选本行 / Ctrl 切换 /
  // Shift 区间），双击目录进入；复选框只切批量选择（stopPropagation）。
  return (
    <div
      role="button"
      tabIndex={0}
      title={dirInteractive ? tr("双击进入目录") : undefined}
      onClick={rowClick}
      onDoubleClick={() => {
        if (isDir && dirInteractive) fs.onEnterDir(path);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate();
        } else if (e.key === " ") {
          e.preventDefault();
          toggleSel(e.shiftKey);
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
        // 44px 首列 = 批量选择 checkbox（与表头同宽，列宽稳定；目录行空占位）。
        gridTemplateColumns: `44px ${grid}`,
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
      {/* 批量选择列：文件 + 目录都可选（B2）；shift 点击 = 可见行区间；
       * 复选框独立于行焦点 / 树目标（stopPropagation 不触发展开）。 */}
      <span onDoubleClick={(e) => e.stopPropagation()}>
        <SelCheck
          t={t}
          checked={fs.selected.has(path)}
          onToggle={toggleSel}
          label={tr("选择 {name}", { name })}
        />
      </span>
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
        {tr(fileTypeLabel(entry))}
      </span>
      {showUpdatedAt ? (
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
      ) : null}
      {showCreated ? (
        <span
          style={{
            fontSize: 12,
            color: t.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fmtTs((entry as { createdAt?: string }).createdAt)}
        </span>
      ) : null}
      {actionsCell}
      {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
      {del.node}
    </div>
  );
}

/** F-V3-4 树行：目录行 = 点击设为上传 / 新建目标 + 焦点（展开只由 chevron
 * ▸/▾ 控制）；文件行 = 点击焦点 + 批量选择；行内 下载/删除（复刻 FileRow
 * 的 doDownload / useDeleteConfirm 接线，不新写逻辑）。骨架（缩进 / caret /
 * 行高 / aria / 键盘 / hover）= files/TreeRowShell，本组件只出各列内容。 */
function TreeRowView({
  row,
  focused,
  pending,
  failed,
  t,
  tr,
  nav,
  fs,
  onActivate,
  onToggle,
  onRetry,
  onDropToDir,
  onToggleSelect,
  selected,
  grid,
  showUpdatedAt,
  showCreated,
}: SubProps & {
  row: TreeRow;
  focused: boolean;
  pending: boolean;
  failed: boolean;
  onActivate: (
    row: TreeRow,
    mods?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  ) => void;
  onToggle: (row: TreeRow) => void;
  onRetry: (row: TreeRow) => void;
  /** 拖拽上传目标 = 本目录行（树视图目录行高亮 + 拦截 drop）。 */
  onDropToDir: (snap: DropSnapshot, dir: string) => void;
  /** 批量选择（文件 + 目录；shift = 按可见行区间）。 */
  onToggleSelect: (path: string, shiftKey: boolean) => void;
  /** 目录行是否为当前上传 / 新建目标。 */
  selected?: boolean;
  grid: string;
  showUpdatedAt: boolean;
  showCreated: boolean;
}) {
  // flattenTree 恒透传 entry；?? 兜底仅防 name-only 老形态条目。
  const entry = row.entry ?? { name: row.name };
  const isDir = row.isDir;
  const name = row.name;
  const path = rowPath(entry, fs.dirPath);
  const sel =
    fs.selected.has(path) ||
    (isDir ? !!selected : nav.selectedFile === path);
  const onDownload = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    void doDownload(fs.humanName, path, name, entry.size, tr).then((ok) => {
      if (!ok) antd.message.error(tr("下载失败"));
    });
  };
  // #1669 统一删除确认（与 FileRow / 详情面板共用 useDeleteConfirm）。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: (r) => {
      if (nav.selectedFile === path) nav.selectFile(null);
      if (!r.purged) fs.offerUndo({ trashId: r.trashId, name });
      fs.reload({ silent: true });
    },
  });
  const onDelete = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    del.request(path, name);
  };
  const onDetail = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    fs.onOpenDetail(path, isDir);
  };
  // 第二批行操作（与 FileRow 同源）：重命名 / 移动到… / 文本编辑。
  const opTarget: FileOpTarget = {
    path,
    name: opNameOf(path, name),
    isDir,
    size: entry.size,
    etag: entry.etag,
  };
  const renameBtn = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        fs.onRename(opTarget);
      }}
      title={tr("重命名")}
      aria-label={tr("重命名")}
      style={iconBtnStyle(t)}
    >
      <RenameIcon size={16} />
    </button>
  );
  const moveBtn = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        fs.onMove(opTarget);
      }}
      title={tr("移动到…")}
      aria-label={tr("移动到…")}
      style={iconBtnStyle(t)}
    >
      <MoveIcon size={16} />
    </button>
  );
  const editBtn =
    !isDir && isEditableText(name, entry.size) ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          fs.onEditText(opTarget);
        }}
        title={tr("编辑")}
        aria-label={tr("编辑")}
        style={iconBtnStyle(t)}
      >
        <EditTextIcon size={16} />
      </button>
    ) : null;
  // 拖拽上传目标（目录行）：拦截内部 drag 事件 → 高亮本行 + drop 落此目录；
  // stopPropagation 同时阻止区域遮罩盖住行高亮（遮罩 pointerEvents:none，
  // 但仍会视觉覆盖，故不激活）。
  const [dropOver, setDropOver] = React.useState(false);
  const dropDepth = React.useRef(0);
  const dirDropProps = isDir
    ? {
        onDragEnter: (e: ReactNS.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          dropDepth.current += 1;
          if (!dropOver) setDropOver(true);
        },
        onDragOver: (e: ReactNS.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (e: ReactNS.DragEvent<HTMLDivElement>) => {
          e.stopPropagation();
          dropDepth.current = Math.max(0, dropDepth.current - 1);
          if (dropDepth.current === 0) setDropOver(false);
        },
        onDrop: (e: ReactNS.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          dropDepth.current = 0;
          setDropOver(false);
          const snap = snapshotDrop(
            e.dataTransfer as unknown as DataTransferLike,
          );
          if (snap.entries.length === 0 && snap.files.length === 0) return;
          onDropToDir(snap, path);
        },
      }
    : {};
  const rowSkin = dropOver
    ? {
        border: "1px dashed var(--app-accent, #FF7F16)",
        background: t.accentBg,
      }
    : sel || focused
      ? { border: `1px solid ${t.border}`, background: t.hoverBg }
      : { border: "1px solid transparent", background: "transparent" };

  return (
    /* 树行 = roving tabindex：键盘由容器（tabIndex=0 + onKeyDown 方向键 /
       Space / Enter）统一接管；行骨架（缩进 / caret / 44px / aria）见
       files/TreeRowShell（与工作区路径选择器同一份）。 */
    <TreeRowShell
      depth={row.depth}
      expanded={row.expanded}
      hasChildren={isDir}
      caret={isDir ? (row.expanded ? "▾" : "▸") : ""}
      selected={sel || focused}
      t={t}
      tabIndex={-1}
      // 键盘（方向键 / Space / Enter）由 TreeArea 容器统一接管。
      dispatchKeys={false}
      {...dirDropProps}
      onClick={(e) =>
        onActivate(row, {
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        })
      }
      onDoubleClick={() => {
        if (isDir) fs.onEnterDir(path);
      }}
      onToggleExpand={isDir ? () => onToggle(row) : undefined}
      leading={
        /* 批量选择列：文件 + 目录都可选（B2）；复选框独立于行焦点 /
         * 上传目标（不触发展开）。 */
        <span
          onDoubleClick={(e) => e.stopPropagation()}
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <SelCheck
            t={t}
            checked={fs.selected.has(path)}
            onToggle={(shiftKey) => onToggleSelect(path, shiftKey)}
            label={tr("选择 {name}", { name })}
          />
        </span>
      }
      style={{
        display: "grid",
        // 44px 首列 = 批量选择 checkbox（文件 + 目录都可选；与表头同宽）；
        // 16px = 展开三角（TreeRowShell caret 区）。
        gridTemplateColumns: `44px 16px ${grid}`,
        alignItems: "center",
        width: "100%",
        ...rowSkin,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {isDir ? (
          row.expanded ? (
            <FolderOpenIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
          ) : (
            <FolderIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
          )
        ) : (
          <PageIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
        )}
        <span
          // 新形态（带 path）hover 显相对全路径，便于区分同名条目。
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
        {tr(fileTypeLabel(entry))}
      </span>
      {showUpdatedAt ? (
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
      ) : null}
      {showCreated ? (
        <span
          style={{
            fontSize: 12,
            color: t.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fmtTs((entry as { createdAt?: string }).createdAt)}
        </span>
      ) : null}
      <span
        style={{ display: "flex", alignItems: "center", gap: TOUCH.iconGap, flexShrink: 0 }}
      >
        {/* 懒加载指示：加载中「…」；失败「重试」（点击重拉，不触发行展开）。 */}
        {pending ? (
          <span style={{ fontSize: 12, color: t.textSecondary, padding: "0 2px" }}>…</span>
        ) : null}
        {failed ? (
          <span onClick={(e) => e.stopPropagation()}>
            <antd.Button size="small" style={btnTouch} onClick={() => onRetry(row)}>
              {tr("重试")}
            </antd.Button>
          </span>
        ) : null}
        <button
          type="button"
          onClick={onDetail}
          title={tr("详情")}
          aria-label={tr("详情")}
          style={iconBtnStyle(t)}
        >
          <InfoIcon size={16} />
        </button>
        {renameBtn}
        {moveBtn}
        {isDir ? (
          // 目录不可删（服务端不支持目录删除）：禁用删除按钮 + tooltip（同 FileRow）。
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
        ) : (
          <>
            {editBtn}
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
          </>
        )}
      </span>
      {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
      {del.node}
    </TreeRowShell>
  );
}

/** F-V3-4 树视图块（mid/full 列表槽，fs.filesView === "tree" 时替换
 * ListArea；l1 紧凑列不走树）：四态镜像 ListArea（出错 + 重试 / 加载中 /
 * 空态 + 链接 CTA / 行列表）；children / expanded 用 ref 持有（ref 写 +
 * rev 自增触发重渲）；目录首次展开懒加载 listFiles 写 children Map
 *（gen 代数防切目录后在途响应污染新缓存）；键盘导航 = 容器 tabIndex=0 +
 * treeKeyNav（focusIndex 高亮；Enter = 行激活）。
 * 批量选择（B2：文件 + 目录都可选）：复选框只切批量选择（不改上传目标 /
 * 焦点），行点击 = 焦点 + 选择（无修饰只选本行 / Ctrl 切换 / Shift 可见行
 * 区间）；折叠只收窄可见行 → 选择集合保留（容器剔除基准用本组件上报的
 * 「已知条目」，含折叠缓存）。已知条目/可见路径经 fs.onTreeBatchChange
 * 上报，批量操作条与列表/网格同源（容器 batchEntries + 同一 BatchBar /
 * useDeleteConfirm 批量模式）。 */
function TreeArea({
  t,
  tr,
  nav,
  fs,
  actions,
  sort,
  onSort,
  onSetSort,
  onDropToDir,
}: SubProps & {
  actions: FilesActions;
  sort: FileSort;
  onSort: (k: FileSortKey) => void;
  onSetSort: (s: FileSort) => void;
  /** 目录行 drop = 该目录为上传目标（空白区由 FileDropTarget 接管）。 */
  onDropToDir: (snap: DropSnapshot, dir: string) => void;
}) {
  const childrenRef = React.useRef<Map<string, HumanFileEntry[]>>(new Map());
  const expandedRef = React.useRef<Set<string>>(new Set());
  const genRef = React.useRef(0);
  const [rev, setRev] = React.useState(0);
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [failed, setFailed] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [focusIndex, setFocusIndex] = React.useState(0);
  /** 树里选中的目录（上传目标；单击目录行选择、chevron 只切展开）。 */
  const [selectedDir, setSelectedDir] = React.useState("");

  // 切目录 → 代数 +1：重置缓存/展开/焦点；在途懒加载响应经 genRef 校验丢弃。
  React.useEffect(() => {
    genRef.current += 1;
    childrenRef.current = new Map();
    expandedRef.current = new Set();
    setPending(new Set<string>());
    setFailed(new Set<string>());
    setFocusIndex(0);
    setSelectedDir("");
    actions.setUploadDir("");
  }, [fs.dirPath]);

  const rows = React.useMemo(() => {
    // 每一层子项都按当前列排序（目录恒在前），树结构不变。
    const { roots, children } = sortTreeLevels(fs.files, childrenRef.current, sort);
    return flattenTree({ roots, children, expanded: expandedRef.current });
  }, [fs.files, rev, sort]);
  const idx = rows.length === 0 ? 0 : Math.min(focusIndex, rows.length - 1);

  // 可见行路径（树拍平顺序，**含目录**）——shift 区间定位 / 全选三态 /
  // 行点击区间（B2：文件 + 目录都可选）。
  const visiblePaths = React.useMemo(() => {
    const out: string[] = [];
    for (const r of rows) {
      const p = rowPath(r.entry ?? { name: r.name }, fs.dirPath);
      if (p !== "") out.push(p);
    }
    return out;
  }, [rows, fs.dirPath]);
  // 已知条目（根 + 已加载子层，含折叠缓存中的子项；文件 + 目录）——批量
  // 汇总 / 下载 / 删除 / 选择剔除基准：折叠只收窄可见行，已选子项不丢。
  const knownEntries = React.useMemo(() => {
    const out: { path: string; name: string; size?: number; isDir?: boolean }[] = [];
    for (const e of collectTreeEntries(fs.files, childrenRef.current)) {
      const p = rowPath(e, fs.dirPath);
      if (p === "") continue;
      out.push({ path: p, name: entryDisplayName(e), size: e.size, isDir: isEntryDir(e) });
    }
    return out;
  }, [fs.files, rev, fs.dirPath]);
  // 上报容器（批量条 / 剔除）。引用稳定 → 上报引发的重渲染不会再次触发
  // 本 effect（否则 setState ↔ effect 循环）。
  const treeBatch = React.useMemo(
    () => ({ visiblePaths, entries: knownEntries }),
    [visiblePaths, knownEntries],
  );
  React.useEffect(() => {
    fs.onTreeBatchChange(treeBatch);
  }, [fs.onTreeBatchChange, treeBatch]);

  /** 懒加载目录子项（首次展开 / 失败重试）：listFiles 入参 = rowPath
   * （新形态 = entry.path 剥 files/ 前缀，尾斜杠由 encPath 归一；
   * 老形态 = dirPath/name）。 */
  const loadChildren = React.useCallback(
    (row: TreeRow): void => {
      const entry = row.entry ?? { name: row.name };
      const gen = genRef.current;
      setPending((prev) => {
        const next = new Set(prev);
        next.add(row.path);
        return next;
      });
      setFailed((prev) => {
        if (!prev.has(row.path)) return prev;
        const next = new Set(prev);
        next.delete(row.path);
        return next;
      });
      void listFiles(fs.humanName, rowPath(entry, fs.dirPath)).then(
        (r) => {
          if (gen !== genRef.current) return; // 代数过期（已切目录）→ 丢弃
          childrenRef.current.set(row.path, r.entries);
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(row.path);
            return next;
          });
          setRev((v) => v + 1);
        },
        () => {
          if (gen !== genRef.current) return;
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(row.path);
            return next;
          });
          setFailed((prev) => {
            const next = new Set(prev);
            next.add(row.path);
            return next;
          });
        },
      );
    },
    [fs.humanName, fs.dirPath],
  );

  const toggleRow = React.useCallback(
    (row: TreeRow): void => {
      if (!row.isDir) return;
      const expanded = expandedRef.current;
      if (expanded.has(row.path)) {
        expanded.delete(row.path);
      } else {
        expanded.add(row.path);
        // 首次展开且未缓存 → 懒加载（加载中行尾「…」，失败「重试」）。
        if (!childrenRef.current.has(row.path)) loadChildren(row);
      }
      setRev((v) => v + 1);
    },
    [loadChildren],
  );

  const activateRow = React.useCallback(
    (
      row: TreeRow,
      mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
    ): void => {
      const entry = row.entry ?? { name: row.name };
      const p = rowPath(entry, fs.dirPath);
      if (row.isDir) {
        // 目录行点击 = 上传 / 新建目标 + 焦点（展开仍只由 chevron 控制）；
        // 目标用无尾斜杠形态，避免拼出 "docs//file"。
        const target = p.replace(/\/+$/, "");
        setSelectedDir(row.path);
        actions.setUploadDir(target);
      }
      // 焦点 + 批量选择：无修饰只选本行 / Ctrl 切换 / Shift 可见行区间。
      fs.onRowClick(p, {
        isDir: row.isDir,
        shiftKey: mods.shiftKey === true,
        toggleKey: mods.ctrlKey === true || mods.metaKey === true,
        paths: visiblePaths,
      });
    },
    [fs, fs.dirPath, visiblePaths, actions],
  );

  const onKeyDown = (e: ReactNS.KeyboardEvent<HTMLDivElement>): void => {
    // Space = 切换批量选择（行焦点不变；Shift+Space 从锚点扩区间）。
    if (e.key === " ") {
      e.preventDefault();
      const r = rows[idx];
      if (!r) return;
      const p = rowPath(r.entry ?? { name: r.name }, fs.dirPath);
      if (p === "") return;
      fs.onToggleSelect(p, { shiftKey: e.shiftKey, paths: visiblePaths });
      return;
    }
    if (!isTreeNavKey(e.key)) return;
    e.preventDefault();
    const next = treeKeyNav({ rows, index: idx }, e.key, (p) => {
      const r = rows.find((x) => x.path === p);
      if (r) toggleRow(r);
    });
    setFocusIndex(next);
    if (e.key === "Enter") {
      const r = rows[next];
      if (r) activateRow(r);
    }
  };

  const count = fs.files.length;
  const cols = columnsFor(fs.files);
  const selState = selectAllState(fs.selected, visiblePaths);
  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ display: "grid", gap: 4, outline: "none" }}
    >
      {fs.status !== "err" ? (
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
            description={tr(filesErrorText(fs.error))}
          />
          <antd.Button style={btnTouch} onClick={() => fs.reload({ force: true })}>
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
          {/* 空态 CTA = 文字链接（同 ListArea，指向工具条同一处理函数）。 */}
          <antd.Button
            type="link"
            style={{ padding: 0, ...btnTouch }}
            onClick={actions.onUploadClick}
          >
            {tr("上传一个文件")}
          </antd.Button>
        </div>
      ) : null}
      {/* 行 key = index（老形态嵌套可重名 → path 键会碰撞；行序由
       * flattenTree 深度优先稳定给出）。 */}
      {fs.status !== "err" && count > 0 ? (
        <div
          style={{
            display: "grid",
            // 44px 选择列 + 16px 三角列（与行模板同宽，列宽稳定）；
            // B2：表头复选框 = 当前可见行（文件 + 目录）三态全选。
            gridTemplateColumns: `44px 16px ${cols.grid}`,
            gap: 8,
            alignItems: "center",
            padding: "0 8px",
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          <SelCheck
            t={t}
            checked={selState === "all"}
            indeterminate={selState === "some"}
            onToggle={() => fs.onSelectAll(visiblePaths)}
            label={tr("全选")}
          />
          <span />
          <SortHeader label={tr("名称")} k="name" sort={sort} onSort={onSort} onSetSort={onSetSort} />
          <span style={{ textAlign: "right" }}>
            <SortHeader label={tr("大小")} k="size" sort={sort} onSort={onSort} onSetSort={onSetSort} align="right" />
          </span>
          <SortHeader label={tr("类型")} k="type" sort={sort} onSort={onSort} onSetSort={onSetSort} />
          {cols.showUpdatedAt ? (
            <SortHeader label={tr("修改")} k="updatedAt" sort={sort} onSort={onSort} onSetSort={onSetSort} />
          ) : null}
          {cols.showCreated ? (
            <SortHeader label={tr("创建")} k="createdAt" sort={sort} onSort={onSort} onSetSort={onSetSort} />
          ) : null}
          <span>{tr("操作")}</span>
        </div>
      ) : null}
      {fs.status !== "err" && count > 0 ? (
        <div role="tree" style={{ display: "grid", gap: 4 }}>
          {rows.map((r, i) => (
            <TreeRowView
              key={i}
              row={r}
              focused={i === idx}
              pending={pending.has(r.path)}
              failed={failed.has(r.path)}
              t={t}
              tr={tr}
              nav={nav}
              fs={fs}
              onActivate={activateRow}
              onToggle={toggleRow}
              onRetry={loadChildren}
              onDropToDir={onDropToDir}
              onToggleSelect={(p, shiftKey) =>
                fs.onToggleSelect(p, { shiftKey, paths: visiblePaths })
              }
              selected={selectedDir === r.path}
              grid={cols.grid}
              showUpdatedAt={cols.showUpdatedAt}
              showCreated={cols.showCreated}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── F-V3-4 网格视图（fs.filesView === "grid" 时替换列表槽；l1 紧凑列不走）──
/** 网格列模板（任务书字面形态）：最小格 180px，auto-fill 尽量多列。
 * 容器极窄（不足两列）时按 gridMinCols 档收窄 min 边（见 GridArea）。 */
const GRID_TEMPLATE = "repeat(auto-fill, minmax(180px, 1fr))";
const GRID_CELL_MIN = 180;
const GRID_GAP = 10;
/** 缩略图懒加载配额（任务书：最多前 60 个）——递归平铺下 fs.files 可达
 * 数百条，objectURL 取数只给前 60 个图片条目，其余出图标。 */
const GRID_THUMB_CAP = 60;

/** 网格卡片缩略区（高 120px）：图片文件 = useMediaObjectUrl 懒加载
 *（卡片经 IntersectionObserver 进入视口才取 blob；IO 不可用 → 不出图
 * 只出图标）；目录 = 文件夹图标；其它文件（含图片取数前/失败）= 图标。 */
function GridThumb({
  entry,
  apiPath,
  t,
  allowThumb,
}: {
  entry: HumanFileEntry;
  apiPath: string;
  t: ThemeColors;
  /** 本卡是否有缩略图配额（前 GRID_THUMB_CAP 个图片文件）。 */
  allowThumb: boolean;
}) {
  const isDir = isEntryDir(entry);
  const isImg = !isDir && isImageName(entryDisplayName(entry));
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = React.useState(false);
  // IntersectionObserver 不可用（旧 webview 兜底）→ 不取图只出图标。
  const ioOk = typeof IntersectionObserver !== "undefined";
  React.useEffect(() => {
    if (!isImg || !allowThumb || !ioOk) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [isImg, allowThumb, ioOk]);
  const src = useMediaObjectUrl(
    isImg && allowThumb && ioOk && visible ? apiPath : undefined,
    "",
  );
  const icon = isDir ? (
    <FolderIcon size={40} style={{ color: t.textSecondary }} />
  ) : isImg ? (
    <PictureIcon size={40} style={{ color: t.textSecondary }} />
  ) : (
    <PageIcon size={40} style={{ color: t.textSecondary }} />
  );
  return (
    <div
      ref={ref}
      style={{
        height: 120,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: 6,
        background: t.hoverBg,
      }}
    >
      {src !== "" ? (
        <img src={src} alt="" style={{ width: "100%", height: 120, objectFit: "cover" }} />
      ) : (
        icon
      )}
    </div>
  );
}

/** 网格卡片：缩略区（高 120px）+ 名称（两行截断）+ 大小 + 行内下载/删除
 *（沿用 FileRow 的 doDownload / useDeleteConfirm 接线，不另写一套）。
 * 交互：单击 = 选中（再点取消，目录/文件同——任务书语义）；双击 = 目录
 * 进入（导航；递归平铺模式目录不可交互，同 FileRow）/ 文件选中（无条件
 * set，抵消 click-click 的 toggle）。键盘 Enter/Space = 单击语义。 */
function GridCard({
  entry,
  apiPath,
  allowThumb,
  paths,
  t,
  tr,
  nav,
  fs,
}: SubProps & {
  entry: HumanFileEntry;
  apiPath: string;
  allowThumb: boolean;
  /** 可见行顺序（含目录）：shift 区间 / 行点击区间共用。 */
  paths: readonly string[];
}) {
  const isDir = isEntryDir(entry);
  const name = entryDisplayName(entry);
  const path = rowPath(entry, fs.dirPath);
  const sel = nav.selectedFile === path || fs.selected.has(path);
  const dirInteractive = isDir && !fs.recursive;

  /** 单击 = 焦点 + 批量选择（无修饰只选本行 / Ctrl 切换 / Shift 区间）。 */
  const select = (e: ReactNS.MouseEvent) =>
    fs.onRowClick(path, {
      isDir,
      shiftKey: e.shiftKey,
      toggleKey: e.ctrlKey || e.metaKey,
      paths,
    });
  const onDbl = () => {
    if (isDir) {
      if (dirInteractive) fs.onEnterDir(path);
      return;
    }
    fs.onRowClick(path, { isDir: false, shiftKey: false, toggleKey: false, paths });
  };
  const onDownload = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    void doDownload(fs.humanName, path, name, entry.size, tr).then((ok) => {
      if (!ok) antd.message.error(tr("下载失败"));
    });
  };
  // 统一删除确认（与 FileRow / 详情面板共用 useDeleteConfirm，不各写 Modal）：
  // 勾选「移入回收站（可恢复）」（默认）= 软删；未勾选 = 软删后立即彻底删。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: (r) => {
      if (nav.selectedFile === path) nav.selectFile(null);
      if (!r.purged) fs.offerUndo({ trashId: r.trashId, name });
      fs.reload({ silent: true });
    },
  });
  const onDelete = (e: ReactNS.MouseEvent) => {
    e.stopPropagation();
    del.request(path, name);
  };
  // 第二批行操作（与 FileRow / 树行同源）：重命名 / 移动到… / 文本编辑。
  const opTarget: FileOpTarget = {
    path,
    name: opNameOf(path, name),
    isDir,
    size: entry.size,
    etag: entry.etag,
  };
  const renameBtn = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        fs.onRename(opTarget);
      }}
      title={tr("重命名")}
      aria-label={tr("重命名")}
      style={iconBtnStyle(t)}
    >
      <RenameIcon size={16} />
    </button>
  );
  const moveBtn = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        fs.onMove(opTarget);
      }}
      title={tr("移动到…")}
      aria-label={tr("移动到…")}
      style={iconBtnStyle(t)}
    >
      <MoveIcon size={16} />
    </button>
  );
  const editBtn =
    !isDir && isEditableText(name, entry.size) ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          fs.onEditText(opTarget);
        }}
        title={tr("编辑")}
        aria-label={tr("编辑")}
        style={iconBtnStyle(t)}
      >
        <EditTextIcon size={16} />
      </button>
    ) : null;

  const skin = sel
    ? { border: `1px solid ${t.border}`, background: t.hoverBg }
    : { border: `1px solid ${t.border}`, background: t.cardBg };
  return (
    <div
      role="button"
      tabIndex={0}
      title={dirInteractive ? tr("双击进入目录") : undefined}
      onClick={select}
      onDoubleClick={onDbl}
      onKeyDown={(e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (isDir) {
            if (dirInteractive) fs.onEnterDir(path);
          } else {
            fs.onRowClick(path, { isDir: false, shiftKey: false, toggleKey: false, paths });
          }
        } else if (e.key === " ") {
          e.preventDefault();
          fs.onToggleSelect(path, { shiftKey: e.shiftKey, paths });
        }
      }}
      onMouseEnter={(e: ReactNS.MouseEvent<HTMLDivElement>) => {
        if (!sel) e.currentTarget.style.background = t.hoverBg;
      }}
      onMouseLeave={(e: ReactNS.MouseEvent<HTMLDivElement>) => {
        if (!sel) e.currentTarget.style.background = t.cardBg;
      }}
      style={{
        display: "grid",
        gap: 6,
        padding: 8,
        borderRadius: 8,
        cursor: "pointer",
        minWidth: 0,
        ...skin,
      }}
    >
      {/* 缩略区 + 批量选择 checkbox（文件与目录都可选；B2）：checkbox 叠在
       * 缩略区左上角，44×44 命中区（coarse 指针随 --hf-row-min 放大）。
       * 只切批量选择，不改变焦点 / 上传目标、不触发进入。 */}
      <div style={{ position: "relative" }}>
        <GridThumb entry={entry} apiPath={apiPath} t={t} allowThumb={allowThumb} />
        <span
          style={{ position: "absolute", top: 4, left: 4, zIndex: 1 }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <SelCheck
            t={t}
            checked={fs.selected.has(path)}
            onToggle={(shiftKey) =>
              fs.onToggleSelect(path, { shiftKey, paths })
            }
            label={tr("选择 {name}", { name })}
          />
        </span>
      </div>
      <span
        title={name}
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          fontWeight: 600,
          fontSize: 12,
          color: t.text,
          wordBreak: "break-all",
        }}
      >
        {name}
      </span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <span
          style={{
            fontSize: 11,
            color: t.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sizeCell(entry)}
        </span>
        {isDir ? (
          // #1669 目录不可删（服务端不支持目录删除）：禁用删除按钮 + tooltip
          // 提示（同 FileRow）。
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fs.onOpenDetail(path, true);
              }}
              title={tr("详情")}
              aria-label={tr("详情")}
              style={iconBtnStyle(t)}
            >
              <InfoIcon size={16} />
            </button>
            {renameBtn}
            {moveBtn}
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
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fs.onOpenDetail(path, false);
              }}
              title={tr("详情")}
              aria-label={tr("详情")}
              style={iconBtnStyle(t)}
            >
              <InfoIcon size={16} />
            </button>
            {editBtn}
            {renameBtn}
            {moveBtn}
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
        )}
      </div>
      {/* #1669 共用删除确认（关闭态不渲染；antd Modal 走 portal 挂载）。 */}
      {del.node}
    </div>
  );
}

/** F-V3-4 网格视图块（mid/full 列表槽，fs.filesView === "grid" 时替换
 * ListArea；l1 紧凑列不走网格）：四态镜像 ListArea（出错 + 重试 / 加载中 /
 * 空态 + 链接 CTA / 卡片网格）；列模板 = 任务书 repeat(auto-fill,
 * minmax(180px, 1fr))，容器极窄时按 gridMinCols 档收窄 min 边防 auto-fill
 * 塌成单列；缩略图配额 = fs.files 顺序前 GRID_THUMB_CAP 个图片文件。 */
function GridArea({
  t,
  tr,
  nav,
  fs,
  actions,
  files,
  sort,
  onSetSort,
}: SubProps & {
  actions: FilesActions;
  files: HumanFileEntry[];
  sort: FileSort;
  onSetSort: (s: FileSort) => void;
}) {
  const [gridRef, gridW] = useContainerWidth();
  const count = files.length;
  // 可见行顺序（网格顺序，含目录）：shift 区间 / 全选三态 / 行点击共用。
  const viewPaths = React.useMemo(
    () => files.map((e) => rowPath(e, fs.dirPath)).filter((p) => p !== ""),
    [files, fs.dirPath],
  );
  const selState = selectAllState(fs.selected, viewPaths);
  // 容器宽度已知且不足两列（gridW < 2×180+gap）→ min 边按 gridMinCols 档
  // 收窄（≤600 → 2 列），auto-fill 不再塌成单列；否则保持任务书模板。
  const gridTemplate = React.useMemo(() => {
    if (gridW <= 0) return GRID_TEMPLATE;
    const cols = gridMinCols(gridW);
    const minCell = Math.floor((gridW - (cols - 1) * GRID_GAP) / cols);
    return minCell >= GRID_CELL_MIN
      ? GRID_TEMPLATE
      : `repeat(auto-fill, minmax(${minCell}px, 1fr)`;
  }, [gridW]);
  // 缩略图配额：fs.files 顺序前 GRID_THUMB_CAP 个图片文件（任务书：最多前 60）。
  const thumbPaths = React.useMemo(() => {
    const s = new Set<string>();
    for (const e of files) {
      if (s.size >= GRID_THUMB_CAP) break;
      if (!isEntryDir(e) && isImageName(entryDisplayName(e))) {
        s.add(rowPath(e, fs.dirPath));
      }
    }
    return s;
  }, [files, fs.dirPath]);

  return (
    <div ref={gridRef} style={{ display: "grid", gap: 8 }}>
      {fs.status !== "err" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* 网格无表头 → 用紧凑排序选择器暴露同一组列（列表用表头点击）。 */}
          <antd.Select
            size="small"
            aria-label={tr("排序方式")}
            style={{ minWidth: 170 }}
            value={`${sort.key}:${sort.dir}`}
            options={[
              { value: "name:asc", label: tr("名称 ↑") },
              { value: "name:desc", label: tr("名称 ↓") },
              { value: "size:asc", label: tr("大小 ↑") },
              { value: "size:desc", label: tr("大小 ↓") },
              { value: "type:asc", label: tr("类型 ↑") },
              { value: "type:desc", label: tr("类型 ↓") },
              { value: "updatedAt:asc", label: tr("修改 ↑") },
              { value: "updatedAt:desc", label: tr("修改 ↓") },
              { value: "createdAt:asc", label: tr("创建 ↑") },
              { value: "createdAt:desc", label: tr("创建 ↓") },
            ]}
            onChange={(v: string) => {
              const [k, dir] = v.split(":");
              onSetSort({ key: k as FileSortKey, dir: dir === "desc" ? "desc" : "asc" });
            }}
          />
        </div>
      ) : null}
      {/* 网格工具条（count>0）：「全选」三态 checkbox + 计数（有列表时
       * 计数并入此行，避免与独立计数行重复）。 */}
      {fs.status !== "err" && !fs.loading && count > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <SelCheck
            t={t}
            checked={selState === "all"}
            indeterminate={selState === "some"}
            onToggle={() => fs.onSelectAll(viewPaths)}
            label={tr("全选")}
          />
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("共 {n} 个条目", { n: count })}
          </span>
        </div>
      ) : null}
      {fs.status === "err" && count === 0 ? (
        <>
          <antd.Alert
            type="warning"
            showIcon
            message={tr("加载失败")}
            description={fs.error}
          />
          <antd.Button style={btnTouch} onClick={() => fs.reload({ force: true })}>
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
          {/* 空态 CTA = 文字链接（同 ListArea，指向工具条同一处理函数）。 */}
          <antd.Button
            type="link"
            style={{ padding: 0, ...btnTouch }}
            onClick={actions.onUploadClick}
          >
            {tr("上传一个文件")}
          </antd.Button>
        </div>
      ) : null}
      {fs.status !== "err" && count > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: gridTemplate, gap: GRID_GAP }}>
          {files.map((e) => {
            const p = rowPath(e, fs.dirPath);
            return (
              <GridCard
                key={p || entryDisplayName(e)}
                entry={e}
                apiPath={humanFileApiPath(fs.humanName, p)}
                allowThumb={thumbPaths.has(p)}
                paths={viewPaths}
                t={t}
                tr={tr}
                nav={nav}
                fs={fs}
              />
            );
          })}
        </div>
      ) : null}
      {/* #1518：仅 nextKey 为 string（满页还有下一页）时显「加载更多」；
       * null = 到底、undefined = 老控制器无分页。 */}
      {typeof fs.nextKey === "string" ? (
        <antd.Button block loading={fs.loadingMore} style={btnTouch} onClick={() => fs.loadMore()}>
          {tr("加载更多")}
        </antd.Button>
      ) : null}
    </div>
  );
}

/** l1 栏回收站紧凑行（v3；F-V3-3 后为保活死分支——files 域 4 栏不再渲染
 * l1，view 恒 "files" 不进入本分支）：单行（图标 + 原路径）。 */
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

/** l1 栏回收站紧凑列表（v3；F-V3-3 后为保活死分支）：四态（错误+重试 /
 * 加载中 / 空 / 行列表）；数据 = 容器 fs.trash（与弹窗共享同一取数）。 */
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
            description={tr(filesErrorText(fs.error))}
          />
          <antd.Button style={btnTouch} onClick={() => fs.reload({ force: true })}>
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
function useContainerWidth(): [
  ReactNS.MutableRefObject<HTMLDivElement | null>,
  number,
  boolean,
] {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [w, setW] = React.useState(0);
  // 首帧 / SSR 没有 ResizeObserver 报告 → measured=false（按 0 处理，但
  // 不能当成「隐藏 tab」）；只有量到 0 才算隐藏。
  const [measured, setMeasured] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const nw = Math.round(entries[0]?.contentRect.width ?? 0);
      setMeasured(true);
      setW((prev) => (nw === prev ? prev : nw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w, measured];
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
/** 多选 sink（上传队列）：一次 pick 的全部文件。 */
type UploadPickManySink = (files: File[]) => void | Promise<void>;
const uploadInputRef: { current: HTMLInputElement | null } = { current: null };
let uploadPickSink: UploadPickSink | null = null;
let uploadPickManySink: UploadPickManySink | null = null;

/** 唯一 onPickFiles（#1669）：全页唯一 input[type=file] 的 pick 处理器。
 * 消费点击时注册的 sink（被点击实例的上传方）；取消（无文件）= 消费后
 * 什么都不做。单文件 sink（详情面板覆盖上传）收 files[0]；多选 sink
 *（工具条上传队列）收全部文件。 */
export async function onPickFiles(e: ReactNS.ChangeEvent<HTMLInputElement>): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ""; // 允许重选同一文件
  const many = uploadPickManySink;
  const one = uploadPickSink;
  uploadPickManySink = null;
  uploadPickSink = null;
  if (files.length === 0) return;
  if (many) await many(files);
  else if (one) await one(files[0]);
}

/** 请求文件选择（单文件）：注册被点击实例的 sink → 点全页唯一隐藏 input
 * （工具条宿主必挂载：凡渲染上传按钮的 variant 都渲染工具条）。 */
export function requestFilePick(sink: UploadPickSink): void {
  uploadPickSink = sink;
  uploadPickManySink = null;
  if (uploadInputRef.current) uploadInputRef.current.multiple = false;
  uploadInputRef.current?.click();
}

/** 请求文件选择（多选 → 上传队列）：同一 input，multiple=true；取消不派发。 */
export function requestFilesPick(sink: UploadPickManySink): void {
  uploadPickManySink = sink;
  uploadPickSink = null;
  if (uploadInputRef.current) uploadInputRef.current.multiple = true;
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
  /** 打开系统文件选择（工具条「上传文件」按钮 + 空态 CTA 共用；多选入队）。 */
  onUploadClick: () => void;
  folderOpen: boolean;
  folderName: string;
  folderBusy: boolean;
  setFolderName: (v: string) => void;
  openFolderModal: () => void;
  closeFolderModal: () => void;
  createFolder: () => void;
  /** 树视图选中的上传目标目录（相对 dirPath；"" = 当前目录）。 */
  setUploadDir: (dir: string) => void;
  /** 当前上传 / 新建目标（树选中目录优先；"" = 当前目录）。弹窗标题 /
   *  上传入队共用同一解析（B1 实测：新建曾忽略树目标）。 */
  folderTarget: string;
  /** 目标展示标签（根 =「我的文件」，其余带尾斜杠）。 */
  folderTargetLabel: string;
  /** 上传队列（多选并发 ≤2；状态机见 files/uploadQueue.ts）。 */
  uploadItems: UploadItem[];
  onRetryUpload: (id: string) => void;
  onClearFinishedUploads: () => void;
  /** 拖拽上传：收集结果（文件 + 相对路径）入同一上传队列；dir 空 = 当前目录。
   *  相对路径含子目录时先建目录（.keep 占位，与「新建文件夹」同法）。 */
  onDropFiles: (
    dropped: readonly { file: File; relPath: string }[],
    dir?: string,
  ) => void;
}

/** 上传队列编排：入队 → 并发 ≤2 启动（startableIds 仲裁）→ 逐项
 *  uploadFile（#1519 预签名，500/501 内部回落直传；后端零改动）→ 状态
 *  回写；失败项 retryUpload 回 waiting 重新入泵。成功即强制刷新列表
 *（load(true,{force:true})——files-actions-1669 源码断言锚定该调用形态）。 */
function useUploadQueue(inp: {
  humanName: string;
  load: (silent: boolean, opts?: { force?: boolean }) => void;
  tr: Tr;
}): {
  items: UploadItem[];
  enqueue: (
    files: File[],
    dir: string,
    relPaths?: readonly (string | undefined)[],
  ) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
} {
  const [items, setItems] = React.useState<UploadItem[]>([]);
  // ref 为真源（泵在异步回调里读最新队列，避免闭包快照）；state 供渲染。
  const itemsRef = React.useRef<UploadItem[]>([]);
  const filesRef = React.useRef<Map<string, File>>(new Map());
  const seqRef = React.useRef(0);
  const inpRef = React.useRef(inp);
  inpRef.current = inp;

  const apply = (next: UploadItem[]): void => {
    itemsRef.current = next;
    setItems(next);
  };
  const mark = (id: string, status: UploadItem["status"], error?: string): void => {
    const next = markUploadStatus(itemsRef.current, id, status, error);
    if (next !== itemsRef.current) apply(next);
  };
  function startItem(item: UploadItem): void {
    const file = filesRef.current.get(item.id);
    if (!file) {
      mark(item.id, "failed", inpRef.current.tr("未知错误"));
      return;
    }
    mark(item.id, "uploading");
    void uploadFile(inpRef.current.humanName, item.path, file)
      .then(
        () => {
          mark(item.id, "success");
          inpRef.current.load(true, { force: true });
        },
        (err) => {
          mark(item.id, "failed", hfErrorText(err, inpRef.current.tr));
        },
      )
      .finally(() => {
        pump();
      });
  }
  /** 并发仲裁：startableIds 已按「limit − 在途 uploading」算出空位，
   *  一次启动即填满；每项终态再入泵（失败重试也走这里）。 */
  function pump(): void {
    const ids = startableIds(itemsRef.current, UPLOAD_CONCURRENCY);
    for (const id of ids) {
      const item = itemsRef.current.find((it) => it.id === id);
      if (item) startItem(item);
    }
  }

  const enqueue = (
    files: File[],
    dir: string,
    relPaths?: readonly (string | undefined)[],
  ): void => {
    if (files.length === 0) return;
    const prefix = `q${seqRef.current++}-`;
    const created = makeUploadItems(
      files.map((f, i) => ({ name: f.name, size: f.size, relPath: relPaths?.[i] })),
      dir,
      prefix,
    );
    created.forEach((it, i) => filesRef.current.set(it.id, files[i]));
    apply([...itemsRef.current, ...created]);
    pump();
  };
  const retry = (id: string): void => {
    const next = retryUpload(itemsRef.current, id);
    if (next !== itemsRef.current) apply(next);
    pump();
  };
  const clearFinished = (): void => {
    const keep: UploadItem[] = [];
    const removed: string[] = [];
    for (const it of itemsRef.current) {
      if (it.status === "success") removed.push(it.id);
      else keep.push(it);
    }
    if (removed.length === 0) return;
    for (const id of removed) filesRef.current.delete(id); // 释放 File 引用
    apply(keep);
  };
  return { items, enqueue, retry, clearFinished };
}

function useFilesActions(
  inp: {
    humanName: string;
    dirPath: string;
    load: (silent: boolean, opts?: { force?: boolean }) => void;
    /** F-V3-3：统一刷新入口（新建文件夹成功走它；上传成功在队列 hook 内
     * 以 load(true,{force:true}) 字面调用，行为同 force 刷新）。 */
    reload: (opts?: { silent?: boolean; force?: boolean }) => void;
    /** 树视图选中的上传目标（相对当前目录）；空 = 当前目录。 */
    uploadDirRef: { current: string };
    /** 目标变化回调（容器据此重渲染弹窗标题；ref 本身不触发渲染）。 */
    onUploadDirChange: (dir: string) => void;
  },
  tr: Tr,
): FilesActions {
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [folderName, setFolderName] = React.useState("");
  const [folderBusy, setFolderBusy] = React.useState(false);
  const queue = useUploadQueue({ humanName: inp.humanName, load: inp.load, tr });
  // B1：目标目录单一解析（树选中目录优先；空 = 当前目录），新建 / 上传共用。
  const targetDir = resolveTargetDir(inp.uploadDirRef.current, inp.dirPath);

  const createFolderInner = async () => {
    const name = folderName.trim();
    if (!name) {
      antd.message.warning(tr("请输入文件夹名"));
      return;
    }
    setFolderBusy(true);
    try {
      await writeFileSync(inp.humanName, `${fullPath(targetDir, name)}/.keep`, "");
      antd.message.success(tr("文件夹已创建"));
      setFolderOpen(false);
      setFolderName("");
      // 成功后保留目标选择（uploadDirRef 不清空），仅刷新列表。
      inp.reload({ silent: true });
    } catch (err) {
      antd.message.error(hfErrorText(err, tr));
    } finally {
      setFolderBusy(false);
    }
  };

  /** 拖拽上传：先按相对路径建子目录（"docs/sub/a.txt" → docs、docs/sub），
   *  再整批入同一上传队列（复用 useUploadQueue / UploadQueuePanel）。
   *  目录创建失败不阻断上传（父路径缺失时由服务端报错，队列逐项显失败）。 */
  const dropFiles = async (
    dropped: readonly { file: File; relPath: string }[],
    dir?: string,
  ): Promise<void> => {
    if (dropped.length === 0) return;
    // 树目录行的 rowPath 带尾斜杠（新形态 path 以 "/" 结尾）→ 归一，避免
    // 拼出 "a/b//file"（与 fullPath / 队列 path 共用同一口径）。
    const targetDir = (dir || inp.dirPath).replace(/\/+$/, "");
    const parents = uniqueParentDirs(dropped.map((d) => d.relPath));
    let dirFailed = 0;
    for (const p of parents) {
      try {
        await writeFileSync(inp.humanName, `${fullPath(targetDir, p)}/.keep`, "");
      } catch {
        dirFailed += 1;
      }
    }
    if (dirFailed > 0) antd.message.warning(tr("部分目录创建失败（上传仍会尝试）"));
    queue.enqueue(
      dropped.map((d) => d.file),
      targetDir,
      dropped.map((d) => d.relPath),
    );
  };

  return {
    // 多选入队：目标目录在点击时刻拍平（树视图选中的上传目标优先）。
    onUploadClick: () =>
      requestFilesPick((files) =>
        queue.enqueue(files, resolveTargetDir(inp.uploadDirRef.current, inp.dirPath)),
      ),
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
    setUploadDir: (dir: string) => {
      inp.uploadDirRef.current = dir;
      inp.onUploadDirChange(dir);
    },
    folderTarget: targetDir,
    folderTargetLabel: targetDirLabel(targetDir, tr("我的文件")),
    uploadItems: queue.items,
    onRetryUpload: queue.retry,
    onClearFinishedUploads: queue.clearFinished,
    onDropFiles: (dropped, dir) => void dropFiles(dropped, dir),
  };
}

/** 16.67 工具条（取代旧配额卡）：一行——左 = 配额进度 + 用量文案
 * （hover 显「容量配额在『人员管理』中设置」）；右 = 操作按钮组
 * （上传文件 / 同步设置（v3 弹窗入口）/ 新建文件夹 / 回收站（F-V3-3 弹窗
 * 入口 + 条目数徽标，0 不显示）/ 刷新（F-V3-3 reload force）——页面级
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
      {/* F-V3-4 视图分段按钮（最左）：列表 / 树 / 网格——aria-label + title；
       * ≥44px（--hf-row-min）；≤600px 只显图标（VIEW_SEG_CSS 隐藏 label）。
       * 裸 <button>（非 antd）——既有渲染锚点按 antd 形态计数。 */}
      <style>{VIEW_SEG_CSS}</style>
      <div
        role="group"
        aria-label={tr("视图切换")}
        style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}
      >
        <button
          type="button"
          className="hf-view-seg"
          aria-label={tr("列表视图")}
          title={tr("列表视图")}
          aria-pressed={fs.filesView === "list"}
          onClick={() => fs.onFilesViewChange("list")}
          style={viewSegBtnStyle(t, fs.filesView === "list")}
        >
          <ListIcon size={16} />
          <span className="hf-view-seg-label">{tr("列表")}</span>
        </button>
        <button
          type="button"
          className="hf-view-seg"
          aria-label={tr("树视图")}
          title={tr("树视图")}
          aria-pressed={fs.filesView === "tree"}
          onClick={() => fs.onFilesViewChange("tree")}
          style={viewSegBtnStyle(t, fs.filesView === "tree")}
        >
          <TreeIcon size={16} />
          <span className="hf-view-seg-label">{tr("树")}</span>
        </button>
        <button
          type="button"
          className="hf-view-seg"
          aria-label={tr("网格视图")}
          title={tr("网格视图")}
          aria-pressed={fs.filesView === "grid"}
          onClick={() => fs.onFilesViewChange("grid")}
          style={viewSegBtnStyle(t, fs.filesView === "grid")}
        >
          <GridIcon size={16} />
          <span className="hf-view-seg-label">{tr("网格")}</span>
        </button>
      </div>
      <div
        title={tr("配额")}
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
                  a: formatQuotaValue(q.usedBytes),
                  b: formatQuotaValue(q.quotaBytes ?? undefined),
                })}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: t.textSecondary, whiteSpace: "nowrap" }}>
              {tr("配额")}: {tr("无限制")} · {tr("已用 {a}", { a: formatQuotaValue(q.usedBytes) })}
            </span>
          )
        ) : (
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("加载中…")}
          </span>
        )}
        {/* 配额编辑入口：仅 canAdmin（RBAC L1）显示；非 admin 隐藏。 */}
        {fs.canAdmin ? (
          <antd.Button
            size="small"
            style={{ minHeight: "var(--hf-btn-min, 40px)", flexShrink: 0 }}
            onClick={() => fs.onEditQuota()}
          >
            {tr("编辑配额")}
          </antd.Button>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <antd.Button style={btnTouch} onClick={actions.onUploadClick}>
          {tr("上传文件")}
        </antd.Button>
        {/* v3（F-V3-1）：同步设置弹窗入口（替代原页内 SyncCard 长条）。 */}
        <antd.Button style={btnTouch} onClick={onOpenSyncSettings}>
          {tr("同步设置")}
        </antd.Button>
        <antd.Button style={btnTouch} onClick={actions.openFolderModal}>
          {tr("新建文件夹")}
        </antd.Button>
        {/* F-V3-3：回收站弹窗入口（替代视图切换 tab；徽标 = 条目数，0 不显示；
         * 点击 = 打开弹窗 + 1 次静默刷新）。 */}
        <antd.Button style={btnTouch} onClick={() => fs.onOpenTrash()}>
          <TrashIcon size={15} />
          {tr("回收站")}
          {fs.trash.length > 0 ? (
            <span
              style={{
                marginLeft: 6,
                padding: "0 6px",
                borderRadius: 9,
                fontSize: 11,
                lineHeight: "18px",
                background: t.accentBg,
                color: t.text,
              }}
            >
              {fs.trash.length}
            </span>
          ) : null}
        </antd.Button>
        <antd.Button
          type="text"
          icon={<ReloadIcon />}
          title={tr("刷新")}
          aria-label={tr("刷新")}
          style={btnTouch}
          onClick={() => fs.reload({ force: true })}
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
        title={tr("在 {dir} 下新建", { dir: actions.folderTargetLabel })}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={actions.folderBusy}
        onOk={actions.createFolder}
        onCancel={actions.closeFolderModal}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("在 {dir} 下新建", { dir: actions.folderTargetLabel })}
          </div>
          <antd.Input
            value={actions.folderName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              actions.setFolderName(e.target.value)
            }
            onPressEnter={actions.createFolder}
            placeholder={tr("在 {dir} 下新建", { dir: actions.folderTargetLabel })}
            aria-label={tr("请输入文件夹名")}
          />
        </div>
      </antd.Modal>
    </div>
  );
}

/** 图片扩展集（与 components/FilePreview 的 IMAGE_EXT 同源——网格缩略图
 * 与详情预览用同一判定，不各写一套）。 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

/** #1669：是否可预览（与 components/FilePreview 支持的类型集一致：
 * 图片 / 文本类（含 md / csv / tsv / json）/ xlsx）。入参可为扩展名或
 * 文件名；其余类型详情面板只给「下载」。纯函数（测试断言）。 */
export function previewable(nameOrExt: string): boolean {
  const s = nameOrExt.trim().toLowerCase();
  const i = s.lastIndexOf(".");
  const ext = i >= 0 ? s.slice(i + 1) : s;
  return (
    ext === "xlsx" ||
    IMAGE_EXT.has(ext) ||
    new Set([
      // TEXT_PREVIEW_EXT（与 FilePreview 保持同步）。
      "md", "markdown", "txt", "log", "json", "csv", "tsv",
      "yaml", "yml", "xml", "sql", "html", "htm",
      "py", "ts", "js", "tsx", "jsx", "go", "rs", "sh",
    ]).has(ext)
  );
}

/** F-V3-4 网格缩略图：按文件名判图片（HumanFileEntry 无 MIME 字段，
 * 扩展集与 previewable 的 IMAGE_EXT 同源；无扩展 → 非图片）。 */
function isImageName(name: string): boolean {
  const s = name.trim().toLowerCase();
  const i = s.lastIndexOf(".");
  return i >= 0 && IMAGE_EXT.has(s.slice(i + 1));
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
  // F-V3-3：软删成功登记撤销条（onDone 闭包晚于渲染执行，name 已初始化）；
  // 刷新走统一 reload。
  const del = useDeleteConfirm({
    t,
    tr,
    humanName: fs.humanName,
    onDone: (r) => {
      nav.selectFile(null);
      if (!r.purged) fs.offerUndo({ trashId: r.trashId, name });
      fs.reload({ silent: true });
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
      () => {
        nav.selectFile(null);
        fs.reload({ silent: true });
      },
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
          fs.reload({ silent: true });
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
          aria-label={tr("递归")}
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
  // F-V3-4：视图模式（列表/树）——localStorage 持久化（不可用 → 静默回落
  // list，见 readStoredFilesView / writeStoredFilesView）。
  const [filesView, setFilesViewState] = React.useState<FilesView>(() =>
    parseFilesView(readStoredFilesView()),
  );
  const setFilesView = React.useCallback((v: FilesView) => {
    setFilesViewState(v);
    writeStoredFilesView(v);
  }, []);
  const [dirPath, setDirPath] = React.useState("");
  const [files, setFiles] = React.useState<HumanFileEntry[]>([]);
  const [trash, setTrash] = React.useState<HumanTrashEntry[]>([]);
  const [quota, setQuota] = React.useState<QuotaResponse | null>(null);
  const [quotaFailed, setQuotaFailed] = React.useState(false);
  // ── 第二批：重命名/移动、配额编辑、文本在线编辑 ──
  // RBAC level 判定（canControlResources = L1）——配额编辑入口仅 admin 显示。
  const canAdmin = canControlResources(
    useCallerLevel({ admin: data.admin, myUserId: data.myUserId, hasToken: data.hasToken }),
  );
  const [opDialog, setOpDialog] = React.useState<{
    mode: "rename" | "move";
    target: FileOpTarget;
  } | null>(null);
  const [editorTarget, setEditorTarget] = React.useState<FileOpTarget | null>(null);
  const [quotaDialogOpen, setQuotaDialogOpen] = React.useState(false);
  const [opProgress, setOpProgress] = React.useState<FileOpProgress | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [status, setStatus] = React.useState<"" | "404" | "err">("");
  const [error, setError] = React.useState("");
  // #1518：递归平铺 + 游标分页（老控制器探测失败 → toggle 禁用，零行为变化）。
  const [recursive, setRecursive] = React.useState(false);
  const [canRecursive, setCanRecursive] = React.useState(false);
  const [nextKey, setNextKey] = React.useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // F-V3-3：trash 腿状态（与 files 腿独立——一腿失败不拖垮另一腿；
  // 回收站弹窗消费）。
  const [trashStatus, setTrashStatus] = React.useState<"" | "err">("");
  const [trashError, setTrashError] = React.useState("");
  // F-V3-3：回收站弹窗（工具条按钮打开；关闭不刷新——数据由容器统一管）。
  const [trashDialogOpen, setTrashDialogOpen] = React.useState(false);
  // files-dnd：详情抽屉目标（行 / 网格卡 / 树行「详情」；只读列表已有字段）。
  const [detailTarget, setDetailTarget] = React.useState<FileDetailTarget | null>(null);
  // F-V3-3：撤销条（软删成功且 trashId 非空；只保留最近一条；8s 自动消失）。
  const [undo, setUndo] = React.useState<{ trashId: string; name: string } | null>(null);
  // 批量选择（列表/树/网格共用；文件 + 目录都可选）：键 = rowPath。选择态
  // 在容器层 → 视图切换天然保留；刷新/切目录后 pruneSelection 剔除已消失
  // 的路径（effect，幂等）。
  const [selected, setSelected] = React.useState<SelectionSet>(new Set<string>());
  // shift 区间锚点 = 最近一次行点击点（shift 点击不改锚点）。
  const [selAnchor, setSelAnchor] = React.useState<string | null>(null);
  // 焦点行是否目录（行点击时明确记录；详情槽据此不渲染 FileDetail）。
  const [focusedDirHint, setFocusedDirHint] = React.useState(false);
  // 上传目标镜像（ref 供闭包读取；state 让工具条弹窗标题随树选择重渲染）。
  const [uploadTarget, setUploadTarget] = React.useState("");
  // 批量下载进度（{done,total} | null = 未在批量下载）。
  const [batchDl, setBatchDl] = React.useState<{ done: number; total: number } | null>(null);
  // F-V3-3：新鲜度——最近一次 files 腿成功时间（焦点/可见性重取判定）。
  const lastSuccessRef = React.useRef(0);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  // F-V3-3：reload 去重实例（makeReloadDedup 纯工厂；ref 持有跨渲染复用）。
  const dedupRef = React.useRef<ReturnType<typeof makeReloadDedup> | null>(null);
  if (dedupRef.current === null) dedupRef.current = makeReloadDedup();
  const dedup = dedupRef.current;
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
  const [widthRef, containerW, widthMeasured] = useContainerWidth();

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
      // F-V3-3：固定三腿——files 腿（dirGuard 目录标签；force → forceList
      // 时间戳 + no-store）+ 配额 + trash 腿（独立 setState，不走 dirGuard）。
      // view 不再影响取数形态（fs.view 恒 "files"；trash 列表供弹窗/徽标）。
      const [ls, qs, ts] = await Promise.allSettled([
        opts?.force
          // #1669 上传成功后强制刷新：时间戳 + cache:"no-store"（见 forceList）。
          ? forceList(humanName, askedDir)
          : listFiles(humanName, askedDir, recursive ? { recursive: true, limit: 1000 } : undefined),
        getQuota(humanName),
        listTrash(humanName).then((r) => r.entries),
      ]);
      if (req !== reqRef.current) return; // 过期响应（目录/身份已切换）
      if (ts.status === "fulfilled") {
        setTrash(ts.value as HumanTrashEntry[]);
        setTrashStatus("");
        setTrashError("");
      } else {
        // trash 腿独立失败（files 腿不受影响；弹窗显错误 + 重试）。
        setTrashStatus("err");
        setTrashError(hfErrorText(ts.reason, tr));
      }
      if (ls.status === "fulfilled") {
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
        lastSuccessRef.current = Date.now(); // F-V3-3 新鲜度基准
      } else {
        const e = ls.reason;
        const is404 = e instanceof HumanFilesError && e.status === 404;
        const applied = dirGuard.applyError(tag, is404 ? 404 : 0, is404 ? "" : hfErrorText(e, tr));
        if (!applied) return; // 目录标签过期 → 新请求接管状态
        // 404 = 无权限或不存在（任务书 UI 规则）→ 占位卡，轮询停重试；
        // 非 404 = 清空列表（根治「列表停在上一目录」）+ 暴露错误文案。
        setFiles(applied.entries);
        setNextKey(applied.nextKey);
        setStatus(applied.status);
        setError(applied.error);
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
    // view 已移出依赖（F-V3-3 取数形态恒三腿）。
    [humanName, recursive, tr, probeRecursive, dirGuard],
  );

  // F-V3-3：reload = load 的 in-flight 去重包装——同一 dirPath 有请求在跑
  // → 复用其 Promise（多次入口点击不叠发）；force 默认 true；完成后释放。
  const reload = React.useCallback(
    (opts?: { silent?: boolean; force?: boolean }) =>
      dedup(`${dirPathRef.current}\u0000files`, () =>
        load(opts?.silent ?? false, { force: opts?.force ?? true }),
      ),
    [dedup, load],
  );

  // 批量选择派生：当前目录**可见行**路径序列（列表顺序，含目录）——
  // shift 区间定位 / 全选三态 / 剔除基准（B2：文件 + 目录都可选）。
  const visiblePaths = React.useMemo(
    () =>
      files
        .map((e) => rowPath(e, dirPath))
        .filter((p) => p !== ""),
    [files, dirPath],
  );
  // 树视图批量上下文（TreeArea 上报：可见行顺序 + 已知条目）。
  // 离开树视图 → 清空（回落列表/网格语义）。
  const [treeBatch, setTreeBatch] = React.useState<TreeBatchInfo | null>(null);
  const onTreeBatchChange = React.useCallback((info: TreeBatchInfo | null) => {
    setTreeBatch(info);
  }, []);
  React.useEffect(() => {
    if (filesView !== "tree") setTreeBatch(null);
  }, [filesView]);
  // 批量条目与列表/网格同源：列表/网格 = 当前目录条目；树 = 已加载全部
  // 条目（含折叠缓存——折叠后的已选项仍参与汇总与批量操作）。
  const topEntries = React.useMemo(
    () =>
      files
        .map((e) => ({
          path: rowPath(e, dirPath),
          name: entryDisplayName(e),
          size: e.size,
          isDir: isEntryDir(e),
        }))
        .filter((x) => x.path !== ""),
    [files, dirPath],
  );
  const batchEntries =
    filesView === "tree" ? treeBatch?.entries ?? topEntries : topEntries;
  const batchTargets = React.useMemo(
    () => batchEntries.filter((e) => selected.has(e.path)),
    [batchEntries, selected],
  );
  const selAll: SelectAllState = selectAllState(selected, visiblePaths);
  // 选中汇总（批量操作条：数量 + 字节；目录 size 缺失按 0 计）。
  const selSummary = React.useMemo(
    () => selectedSummary(batchEntries, selected),
    [batchEntries, selected],
  );
  // 焦点行是否目录：明细槽据此不渲染 FileDetail（目录详情走「详情」按钮）。
  const focusedIsDir = React.useMemo(() => {
    const p = nav.selectedFile;
    if (!p) return false;
    if (p.endsWith("/")) return true;
    const e = files.find((x) => rowPath(x, dirPath) === p);
    if (e) return isEntryDir(e);
    return focusedDirHint;
  }, [nav.selectedFile, files, dirPath, focusedDirHint]);
  React.useEffect(() => {
    if (nav.selectedFile === null) setFocusedDirHint(false);
  }, [nav.selectedFile]);

  // 刷新 / 切目录 / 加载更多 → 剔除已消失的路径（pruneSelection 幂等：
  // 无变化时原样返回，setState 同引用 → React 跳过重渲染）。
  // 树视图基准 = 已知条目（含折叠缓存）；首帧 treeBatch 未上报 → 回落
  // 当前目录路径，避免切换视图瞬间清空选择。
  const prunePaths = React.useMemo(
    () =>
      filesView === "tree" && treeBatch !== null
        ? batchEntries.map((e) => e.path)
        : visiblePaths,
    [filesView, treeBatch, batchEntries, visiblePaths],
  );
  React.useEffect(() => {
    setSelected((prev) => pruneSelection(prev, prunePaths));
  }, [prunePaths]);

  // 复选框切换：只改批量选择，不改焦点 / 上传目标、不触发展开。
  // paths = 区间定位顺序：树视图传可见行顺序，列表/网格缺省 = 当前目录。
  const onToggleSelect = React.useCallback(
    (
      p: string,
      opts: { shiftKey: boolean; paths?: readonly string[] },
    ) => {
      if (p === "") return;
      const paths = opts.paths ?? visiblePaths;
      setSelected((prev) =>
        toggleSelection(prev, p, {
          shiftKey: opts.shiftKey,
          anchor: selAnchor,
          paths,
        }),
      );
    },
    [selAnchor, visiblePaths],
  );
  // 行点击：焦点 + 批量选择分离模型（无修饰只选本行 / Ctrl 切换 / Shift 区间）。
  const onRowClick = React.useCallback(
    (
      p: string,
      opts: {
        isDir: boolean;
        shiftKey: boolean;
        toggleKey: boolean;
        paths?: readonly string[];
      },
    ) => {
      if (p === "") return;
      const paths = opts.paths ?? visiblePaths;
      const r = clickSelection(selected, p, {
        shiftKey: opts.shiftKey,
        toggleKey: opts.toggleKey,
        anchor: selAnchor,
        paths,
      });
      setSelected(r.selected);
      setSelAnchor(r.anchor);
      setFocusedDirHint(opts.isDir);
      nav.selectFile(p);
    },
    [selected, selAnchor, visiblePaths, nav],
  );
  // 「全选」三态切换：all → 清空；some/none → 并入全部可见行（文件 + 目录）。
  const onSelectAll = React.useCallback(
    (paths: readonly string[]) => {
      if (selectAllState(selected, paths) === "all") {
        setSelected(clearSelection());
      } else {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const p of paths) next.add(p);
          return next;
        });
      }
      setSelAnchor(null);
    },
    [selected],
  );
  const onClearSelection = React.useCallback(() => {
    setSelected(clearSelection());
    setSelAnchor(null);
  }, []);

  // 批量删除：容器层单一 useDeleteConfirm 实例（与列表行/网格卡/详情面板
  // 共用同一组件，不另写 Modal）；批量 = 恒软删进回收站（无彻底删选项），
  // 完成后汇总提示 + 清选择 + 静默刷新。
  const batchDelete = useDeleteConfirm({
    t,
    tr,
    humanName,
    onDone: () => {
      /* 本实例仅走 requestBatch（批量模式）；单文件模式不使用。 */
    },
    onBatchDone: (r) => {
      reportBatchResult(tr, "删除", r);
      setSelected(clearSelection());
      setSelAnchor(null);
      if (nav.selectedFile && r.deleted.some((d) => d.path === nav.selectedFile)) {
        nav.selectFile(null);
      }
      void reload({ silent: true });
    },
  });

  // 批量下载：逐个走现有 doDownload handler（预签名/直下语义不变），
  // 串行 + batchDl 进度；部分失败不中断，结束 reportBatchResult 汇总。
  // items = batchTargets 中的文件（目录不支持下载 → 显式提示跳过 N 个）。
  const batchDownload = React.useCallback(async () => {
    const items = batchTargets.filter((it) => !it.isDir);
    const skippedDirs = batchTargets.length - items.length;
    if (skippedDirs > 0) {
      antd.message.warning(
        tr("目录不支持下载，已跳过 {n} 个", { n: skippedDirs }),
      );
    }
    if (items.length === 0) return;
    setBatchDl({ done: 0, total: items.length });
    let ok = 0;
    let failed = 0;
    let firstError: string | undefined;
    for (const it of items) {
      try {
        const good = await doDownload(humanName, it.path, it.name, it.size, tr);
        if (good) ok += 1;
        else {
          failed += 1;
          if (firstError === undefined) firstError = tr("下载失败");
        }
      } catch (err) {
        failed += 1;
        if (firstError === undefined) firstError = hfErrorText(err, tr);
      }
      setBatchDl({ done: ok + failed, total: items.length });
    }
    setBatchDl(null);
    reportBatchResult(tr, "下载", { ok, failed, firstError });
  }, [batchTargets, humanName, tr]);

  // F-V3-3：撤销条 8s 自动消失（新撤销覆盖旧——setUndo 换引用重启计时）。
  React.useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(id);
  }, [undo]);

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
  // F-V3-3：新建文件夹成功 → reload({silent:true})（统一刷新入口）。
  // 树视图的上传目标（相对当前目录）；切目录/切视图时由树自己清空。
  const uploadDirRef = React.useRef("");
  const actions = useFilesActions(
    {
      humanName,
      dirPath,
      load,
      reload,
      uploadDirRef,
      onUploadDirChange: setUploadTarget,
    },
    tr,
  );
  // uploadTarget 仅用于工具条 / 拖拽层重渲染（标题与目标标签跟随树选择）；
  // 值本身由 uploadDirRef 供闭包读取（避免闭包过期）。

  /** 拖拽上传：同步快照（浏览器 entry 生命周期）→ 异步递归收集（200 文件 /
   *  200 MB，超限提示截断）→ 复用上传队列入队。dir 空 = 当前目录；
   *  树视图目录行 drop 传该目录相对路径。 */
  const onDropSnapshot = React.useCallback(
    (snap: DropSnapshot, dir?: string) => {
      void (async () => {
        const r = await collectDrop(snap);
        if (r.truncated) {
          antd.message.warning(
            tr("拖入内容超出上限（{n} 个文件 / {size}），已截断", {
              n: DROP_MAX_FILES,
              size: fmtBytes(DROP_MAX_BYTES),
            }),
          );
        }
        if (r.files.length === 0) return;
        actions.onDropFiles(
          r.files.map((d) => ({ file: d.file as File, relPath: d.relPath })),
          // 树目录行 drop = 该目录；空白区 / 文件行 drop = 当前树上选中的
          // 上传目标（B1：与工具条上传同一口径），否则当前目录。
          dir !== undefined
            ? dir
            : resolveTargetDir(uploadDirRef.current, dirPath),
        );
      })();
    },
    [actions, tr, dirPath],
  );

  // 探测失败（老控制器）且递归已开（探测晚于用户操作）→ 自动回落一层列表。
  React.useEffect(() => {
    if (!canRecursive && recursive) setRecursive(false);
  }, [canRecursive, recursive]);

  // 进入域 / 换目录 / 语言变化 → 取数（load 身份随之变）。
  React.useEffect(() => {
    if (!humanName) return;
    void load(false);
  }, [load, humanName]);

  // 30s 静默轮询（F-V3-3：删掉「仅根目录」门控——子目录也轮询，
  // dirGuard 目录标签保证子目录视图不会被别的内容错配覆盖；
  // 门控收敛为 shouldPoll：activeRef / 404 停重试 / 分页中途跳过）。
  usePoller({
    fn: () => {
      if (
        !shouldPoll({
          active: !data.activeRef || data.activeRef.current,
          status,
          dirPath,
          nextKey,
        })
      )
        return;
      if (!humanName) return;
      // 保持原请求形态（force:false）：递归平铺不被 forceList 打平成一层。
      void reload({ silent: true, force: false });
    },
    intervalMs: 30000,
  });

  // F-V3-3 新鲜度：焦点感知——文档可见且距上次成功 load >10s → 静默重取
  // （切回标签页 / 窗口重新聚焦；404 占位不重取）。
  React.useEffect(() => {
    const onVis = (): void => {
      if (document.hidden || !humanName) return;
      if (statusRef.current === "404") return;
      if (shouldRefetchOnFocus(lastSuccessRef.current, Date.now())) void reload({ silent: true });
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [humanName, reload]);

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
    canAdmin,
    onRename: (target) => setOpDialog({ mode: "rename", target }),
    onMove: (target) => setOpDialog({ mode: "move", target }),
    onEditText: (target) => setEditorTarget(target),
    onEditQuota: () => {
      setQuotaDialogOpen(true);
      // 打开前重取一次配额（与人员详情 openQuota 同口径）。
      void load(true);
    },
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
    trashStatus,
    trashError,
    undo,
    reload: (opts) => reload(opts),
    onOpenTrash: () => {
      setTrashDialogOpen(true);
      void reload({ silent: true });
    },
    filesView,
    onFilesViewChange: (v) => setFilesView(v),
    selected,
    visiblePaths,
    selAll,
    focusedIsDir,
    onToggleSelect,
    onRowClick,
    onTreeBatchChange,
    onSelectAll,
    onClearSelection,
    offerUndo: (u) => {
      if (undoEligible(u.trashId)) setUndo({ trashId: u.trashId, name: u.name });
    },
    onUndo: () => {
      if (!undo) return;
      void (async () => {
        try {
          await restoreTrash(humanName, undo.trashId);
          setUndo(null);
          antd.message.success(tr("已恢复"));
          void reload({ silent: true, force: true });
        } catch (err) {
          // 失败：条保留（可再点）+ 提示原因。
          antd.message.error(hfErrorText(err, tr));
        }
      })();
    },
    onOpenDetail: (path, isDir) => setDetailTarget({ path, isDir }),
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
  /** 列排序（列表/网格共用；localStorage 持久化）。目录恒在前由 sortModel 保证。 */
  const [fileSort, setFileSort] = React.useState<FileSort>(() => {
    try {
      return parseFileSort(window.localStorage.getItem(FILE_SORT_STORAGE_KEY));
    } catch {
      return DEFAULT_FILE_SORT;
    }
  });
  const applyFileSort = React.useCallback((next: FileSort) => {
    setFileSort(next);
    try {
      window.localStorage.setItem(FILE_SORT_STORAGE_KEY, serializeFileSort(next));
    } catch {
      /* 隐私模式/配额满：仅本次会话生效 */
    }
  }, []);
  const onFileSort = React.useCallback(
    (k: FileSortKey) => applyFileSort(nextFileSort(fileSort, k)),
    [applyFileSort, fileSort],
  );
  const sortedFiles = React.useMemo(
    () => sortFileEntries(fs.files, fileSort),
    [fs.files, fileSort],
  );

  if (variant === "l1") {
    // F-V3-3：视图切换 tab 移除（回收站改弹窗；view 恒 "files"——
    // trash 分支保留为类型死路，保活 TrashRailRow/TrashRailList）。
    return (
      <div style={{ display: "grid", gap: 8, padding: 8 }}>
        {/* #1669 触控 CSS 变量（:root 作用域；双实例重复注入无害）。 */}
        <style>{touchCss()}</style>
        {view === "files" ? (
          <Breadcrumbs {...sub} />
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("恢复 / 彻底删除在中栏行操作")}
          </span>
        )}
        {view === "files" ? (
          <ListArea
            {...sub}
            actions={actions}
            compact
            files={sortedFiles}
            sort={fileSort}
            onSort={onFileSort}
            onSetSort={applyFileSort}
          />
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
    // 目录焦点不占详情槽（目录详情走行内「详情」按钮的抽屉）。
    const hasSelection = nav.selectedFile != null && !fs.focusedIsDir;
    // 宽度 0 = 该 section 处于隐藏 tab（切到知识库等）或首帧：此时不能按
    // sheet/drawer 渲染，否则详情会以全屏 Sheet 盖住当前页面。
    // 量到 0 = 该 section 处于隐藏 tab（切到知识库等）→ 不渲染 sheet/drawer，
    // 否则详情会以全屏 Sheet 盖住当前页面；首帧未测量（measured=false）仍按
    // 旧语义渲染，保持静态渲染/测试行为。
    const hiddenTab = widthMeasured && containerW === 0;
    const panes = ownsDetail && !hiddenTab ? panesFor(mode, hasSelection) : null;
    // F-V3-3：回收站独立页（TrashPanel）移除——改工具条按钮打开的
    // files/TrashDialog 弹窗（数据 = 容器 load 的 trash 腿，弹窗不自取数）。
    // F-V3-4：tree 模式列表槽渲染树、grid 模式渲染 GridArea（详情槽不变——
    // 右/内联详情仍只渲染一次）。
    const listNode =
      filesView === "tree" ? (
        <TreeArea
          {...sub}
          actions={actions}
          sort={fileSort}
          onSort={onFileSort}
          onSetSort={applyFileSort}
          onDropToDir={(snap, dir) => onDropSnapshot(snap, dir)}
        />
      ) : filesView === "grid" ? (
        <GridArea
          {...sub}
          actions={actions}
          files={sortedFiles}
          sort={fileSort}
          onSetSort={applyFileSort}
        />
      ) : (
        <ListArea
          {...sub}
          actions={actions}
          files={sortedFiles}
          sort={fileSort}
          onSort={onFileSort}
          onSetSort={applyFileSort}
        />
      );
    // files-dnd：列表 / 树 / 网格三视图共用拖拽上传外壳（空白/文件行 drop =
    // 当前目录；树目录行自己的 drop 在 TreeRowView 内 stopPropagation）。
    const dropNode = (
      <FileDropTarget
        t={t}
        tr={tr}
        dirLabel={resolveTargetDir(uploadTarget, fs.dirPath) || tr("我的文件")}
        onDrop={(snap) => onDropSnapshot(snap)}
      >
        {listNode}
      </FileDropTarget>
    );
    return (
      <div ref={widthRef} style={{ display: "grid", gap: 10, padding: 4 }}>
        {/* #1669 触控 CSS 变量（:root 作用域；双实例重复注入无害）。 */}
        <style>{touchCss()}</style>
        {/* F-V3-3：工具条恒渲染（回收站入口常驻；打开同步弹窗先取一次
         * 最新状态，打开后再「立即同步」成功 → 容器重取状态 + 列表）。 */}
        <FilesToolbar
          {...sub}
          actions={actions}
          onOpenSyncSettings={() => {
            loadSync();
            setSyncModalOpen(true);
          }}
        />
        {/* 上传队列面板（工具条下方）：多选并发 ≤2、逐项状态 + 总进度 +
         * 失败重试；空队列不占版面，移动端（sheet 断点）默认折叠。 */}
        <UploadQueuePanel
          t={t}
          tr={tr}
          items={actions.uploadItems}
          compact={widthMeasured && layoutMode(containerW) === "sheet"}
          onRetry={actions.onRetryUpload}
          onClearFinished={actions.onClearFinishedUploads}
        />
        {/* 第二批：重命名/移动进度（copying / renaming / error，逐文件）。 */}
        <FileOpProgressBar
          t={t}
          tr={tr}
          progress={opProgress}
          onDismiss={() => setOpProgress(null)}
        />
        {/* 标题行：页标题 + 递归开关（F-V3-3 视图切换已移除）。 */}
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
          <span style={{ flex: 1 }} />
          <RecursiveToggle {...sub} />
        </div>
        <Breadcrumbs {...sub} />
        {/* F-V3-3 撤销条：软删成功（trashId 非空）→ 8s 自动消失；「撤销」
         * 裸 button（触控计数 btn-var 之一）。 */}
        {undo ? (
          <antd.Alert
            type="success"
            showIcon
            message={tr("已移入回收站 · {name}", { name: undo.name })}
            action={
              <button
                type="button"
                style={{
                  minHeight: "var(--hf-btn-min, 40px)",
                  padding: "0 12px",
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                  background: t.cardBg,
                  color: t.text,
                  cursor: "pointer",
                }}
                onClick={() => fs.onUndo()}
              >
                {tr("撤销")}
              </button>
            }
          />
        ) : null}
        {/* 批量操作条：选中 >0（列表 / 树 / 网格三视图同源）：下载（串行 +
         * 进度）/ 删除（useDeleteConfirm 批量模式 → 进回收站）/ 取消选择。
         * 批量项 = batchTargets（树含已加载子层，折叠保选）。窄屏换行。 */}
        {selSummary.count > 0 ? (
          <BatchBar
            t={t}
            tr={tr}
            count={selSummary.count}
            bytes={selSummary.bytes}
            dirCount={batchTargets.filter((e) => e.isDir).length}
            dlProgress={batchDl}
            busy={batchDl !== null || batchDelete.busy}
            onDownload={() => void batchDownload()}
            onDelete={() => {
              // 目录删除服务端不支持（与行内禁用按钮同口径）：显式跳过并提示，
              // 不静默失败。
              const filesOnly = batchTargets.filter((e) => !e.isDir);
              const skippedDirs = batchTargets.length - filesOnly.length;
              if (skippedDirs > 0) {
                antd.message.warning(
                  tr("目录删除暂不支持，已跳过 {n} 个（请逐个删除文件）", {
                    n: skippedDirs,
                  }),
                );
              }
              if (filesOnly.length > 0) {
                batchDelete.requestBatch(
                  filesOnly.map((e) => ({ path: e.path, name: e.name })),
                );
              }
            }}
            onCancel={onClearSelection}
          />
        ) : null}
        {panes && panes.detail !== null ? (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 auto", minWidth: 0, display: "grid", gap: 4 }}>
              {dropNode}
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
              <DetailPane {...sub} />
            </div>
          </div>
        ) : (
          dropNode
        )}
        {panes && panes.overlay ? (
          <DetailOverlay {...sub} overlay={panes.overlay} />
        ) : null}
        {/* files-dnd：文件 / 目录详情抽屉（行 / 网格卡 / 树行「详情」按钮打开；
         * 与选中详情槽互不影响，窄屏（<768）改底部 Sheet）。关闭态不挂载
         * Drawer——静态渲染 / 无详情时零结构负担（同 DetailOverlay 口径）。 */}
        {detailTarget ? (
          <FileDetailDrawer
            {...sub}
            target={detailTarget}
            narrow={layoutMode(containerW) === "sheet"}
            onClose={() => setDetailTarget(null)}
            onOpenSyncSettings={() => {
              setDetailTarget(null);
              loadSync();
              setSyncModalOpen(true);
            }}
          />
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
            void reload({ silent: true });
          }}
        />
        {/* F-V3-3 回收站弹窗（替代 TrashPanel 独立页；数据 = 容器 trash 腿）。 */}
        <TrashDialog
          t={t}
          tr={tr}
          open={trashDialogOpen}
          onClose={() => setTrashDialogOpen(false)}
          humanName={humanName}
          isAdmin={!!data.hasToken}
          entries={trash}
          loading={loading}
          trashStatus={trashStatus}
          trashError={trashError}
          onReload={(opts) => reload(opts)}
        />
        {/* 第二批弹窗：重命名 / 移动到…（复制-删除；目录逐文件）。 */}
        {opDialog ? (
          <RenameMoveDialog
            open
            mode={opDialog.mode}
            target={opDialog.target}
            entries={files}
            dirPath={dirPath}
            t={t}
            tr={tr}
            humanName={humanName}
            errorText={(e) => hfErrorText(e, tr)}
            onClose={() => setOpDialog(null)}
            onDone={() => void reload({ silent: true, force: true })}
            onProgress={setOpProgress}
          />
        ) : null}
        {/* 第二批弹窗：文本在线编辑（If-Match；412 冲突选择）。 */}
        {editorTarget ? (
          <TextEditorDialog
            open
            target={editorTarget}
            t={t}
            tr={tr}
            humanName={humanName}
            errorText={(e) => hfErrorText(e, tr)}
            onClose={() => setEditorTarget(null)}
            onSaved={() => void reload({ silent: true, force: true })}
          />
        ) : null}
        {/* 第二批弹窗：配额编辑（共享 QuotaEditDialog；入口仅 canAdmin）。 */}
        {quotaDialogOpen && canAdmin ? (
          <QuotaEditDialog
            open
            humanName={humanName}
            quota={quota}
            t={t}
            tr={tr}
            onClose={() => setQuotaDialogOpen(false)}
            onSaved={() => void load(true)}
          />
        ) : null}
      </div>
    );
  }

  // right（2/3 列 = 详情槽；4 栏 files 无右栏——详情由 mid 持槽，
  // 见 ManagePage sectionNoRight）。
  return <DetailPane {...sub} />;
}
