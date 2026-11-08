/**
 * WorkspacePathPicker.tsx — 工作区访问规则「浏览…」目录选择弹窗（16.137，
 * #1502 续；16.138 树行/键盘改复用文件管理树）。
 *
 * 交互（参考 Google Drive / Dropbox 文件夹选择、Forgejo/GitLab 路径选择）：
 * - 树根 = 工作区 `files/`；展开才调 listFiles 懒拉子目录（只列目录）；
 * - 多选（复选框）+「包含子目录（**）」开关（默认开）；确认后把生成的
 *   规则路径交给 PathChips.onChange（与手动输入走同一 validateAccess 门）；
 * - 生成形态：`files/<rel>/**` / `files/<rel>`；根目录 `files/**`（裸
 *   `files` 不是合法规则路径）；顶层保留名 .trash/.sync/.control 不展示；
 * - 每规则 ≤16 条（existing 计入；到上限禁用新增并提示）；
 * - 403/404 或拉取失败 = picker 不可用 → 提示手动输入，不报错；
 * - 键盘可达（与文件管理树同一套）：行 role=treeitem + roving tabindex，
 *   ↑/↓ 移行、→ 展开、Space 勾选、Enter 展开/收起、caret 点击切展开。
 *
 * 复用（16.138，不另写一份）：
 * - 行骨架 = manage/files/TreeRowShell（缩进 treeIndent / caret / 44px 行高 /
 *   aria / Space·Enter 基础分发 / hover·focus）；
 * - 可见行 = pickerTreeRows（workspacePathPickerModel.ts，内部复用
 *   treeModel.flattenLazyTree）；键盘 = treeModel.treeKeyNav / isTreeNavKey。
 *
 * 纯逻辑（路径生成 / 去重 / 上限 / 保留名 / 加载状态）在
 * workspacePathPickerModel.ts（无 window 依赖，可单测）。
 */
import type * as ReactNS from "react";

import { listFiles } from "../api";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import DialogShell from "../manage/files/DialogShell";
import TreeRowShell from "../manage/files/TreeRowShell";
import {
  isTreeNavKey,
  treeIndent,
  treeKeyNav,
} from "../manage/files/treeModel";
import {
  PICKER_MAX_PATHS,
  applyDirLoaded,
  applyDirUnavailable,
  beginDirLoad,
  loadDirState,
  pickerTreeRows,
  remainingSlots,
  selectionToRulePaths,
  toggleSelected,
  type DirLoadMap,
} from "./workspacePathPickerModel";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface WorkspacePathPickerProps {
  open: boolean;
  /** 人员名（listFiles 的 humanName）。 */
  humanName: string;
  /** 当前规则已有路径（去重 / 上限基准；picker 不修改）。 */
  existing: string[];
  t: ThemeColors;
  tr: TrFn;
  onClose: () => void;
  /** 选中目录生成的规则路径（去重 / 清点由 PathChips 用 mergeRulePaths 做）。 */
  onConfirm: (paths: string[]) => void;
}

export default function WorkspacePathPicker({
  open,
  humanName,
  existing,
  t,
  tr,
  onClose,
  onConfirm,
}: WorkspacePathPickerProps): ReactNS.ReactElement | null {
  const [dirs, setDirs] = React.useState<DirLoadMap>({});
  const [expanded, setExpanded] = React.useState<string[]>([""]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [includeSubdirs, setIncludeSubdirs] = React.useState(true);
  const [rootUnavailable, setRootUnavailable] = React.useState(false);
  /** roving tabindex：焦点行下标（↑/↓ 移动；行 DOM 引用置于 nodeRefs）。 */
  const [focusIdx, setFocusIdx] = React.useState(0);
  const nodeRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  // 打开代号：切换人员 / 重新打开时丢弃在途响应（懒加载按目录并发）。
  const genRef = React.useRef(0);

  const load = React.useCallback(
    async (rel: string) => {
      const gen = genRef.current;
      setDirs((m) => beginDirLoad(m, rel));
      const next = await loadDirState(rel, (d) =>
        listFiles(humanName, d).then((r) => r.entries),
      );
      if (gen !== genRef.current) return;
      setDirs((m) =>
        next.status === "loaded"
          ? applyDirLoaded(m, rel, next.dirs)
          : applyDirUnavailable(m, rel, next.status === "unavailable" && next.blocked),
      );
      if (rel === "" && next.status === "unavailable") setRootUnavailable(true);
    },
    [humanName],
  );

  React.useEffect(() => {
    if (!open) return;
    genRef.current += 1;
    setDirs({});
    setExpanded([""]);
    setSelected([]);
    setIncludeSubdirs(true);
    setRootUnavailable(false);
    setFocusIdx(0);
    nodeRefs.current = [];
    void load("");
  }, [open, humanName, load]);

  // 可见行（懒加载 + 已展开）：拍平逻辑与文件管理树同一份（flattenLazyTree）。
  const rows = React.useMemo(() => pickerTreeRows(dirs, expanded), [dirs, expanded]);
  const idx = rows.length === 0 ? 0 : Math.min(focusIdx, rows.length - 1);

  const toggleExpand = (rel: string) => {
    setExpanded((prev) => {
      if (prev.includes(rel)) return prev.filter((x) => x !== rel);
      // 首次展开才拉（懒加载；已加载/在途不重复拉）。
      if (dirs[rel] === undefined) void load(rel);
      return [...prev, rel];
    });
  };

  const slots = remainingSlots(existing.length, PICKER_MAX_PATHS);
  const candidates = selectionToRulePaths(selected, includeSubdirs);
  const checkDisabled = (rel: string): boolean =>
    !selected.includes(rel) && selected.length >= slots;
  const toggleCheck = (rel: string): void => {
    if (checkDisabled(rel)) return;
    setSelected((prev) => toggleSelected(prev, rel));
  };

  /** 行按键：Space 勾选（不展开）、Enter 展开、↑/↓ 移焦点、→ 展开。 */
  const onRowKeyDown =
    (i: number) =>
    (e: ReactNS.KeyboardEvent<HTMLDivElement>): void => {
      const row = rows[i];
      if (!row) return;
      if (e.key === " ") {
        e.preventDefault();
        toggleCheck(row.path);
        return;
      }
      if (!isTreeNavKey(e.key)) return;
      e.preventDefault();
      if (e.key === "Enter") {
        toggleExpand(row.path);
        return;
      }
      const next = treeKeyNav({ rows, index: i }, e.key, (p) => {
        // → 只展开（收起由 ← / Enter / 行点击负责），避免方向键误收起。
        if (!expanded.includes(p)) toggleExpand(p);
      });
      if (next !== i) {
        setFocusIdx(next);
        nodeRefs.current[next]?.focus();
      }
    };

  if (!open) return null;

  const canConfirm = !rootUnavailable && selected.length > 0 && slots > 0;

  const confirm = () => {
    if (!canConfirm) return;
    onConfirm(candidates);
    onClose();
  };

  return (
    <DialogShell
      open={open}
      title={tr("选择目录")}
      subtitle={tr("工作区 files/ · 勾选目录生成规则路径")}
      width={640}
      onClose={onClose}
      footer={null}
    >
      <div style={{ display: "grid", gap: 10, padding: "4px 0" }}>
        {rootUnavailable ? (
          <antd.Alert
            type="info"
            showIcon
            message={tr("无法浏览目录——请手动输入路径")}
          />
        ) : (
          <div
            role="tree"
            aria-label={tr("选择目录")}
            style={{ display: "grid", gap: 1, maxHeight: "48vh", overflowY: "auto" }}
          >
            {rows.map((row, i) => {
              const state = dirs[row.path];
              const loading = state?.status === "loading";
              const hasChildren = state?.status === "loaded" && state.dirs.length > 0;
              const checked = selected.includes(row.path);
              // 已加载空目录不给 caret（无子项可展开）；未加载 / 加载中给。
              const caret =
                hasChildren || loading || state === undefined
                  ? loading
                    ? "…"
                    : row.expanded
                      ? "▾"
                      : "▸"
                  : "";
              return (
                <React.Fragment key={row.path || "/"}>
                  <TreeRowShell
                    ref={(el) => {
                      nodeRefs.current[i] = el;
                    }}
                    depth={row.depth}
                    expanded={row.expanded}
                    hasChildren={hasChildren}
                    loading={loading}
                    caret={caret}
                    ariaLevel={row.depth + 1}
                    selected={checked}
                    t={t}
                    tabIndex={i === idx ? 0 : -1}
                    data-dir-rel={row.path}
                    onClick={() => toggleExpand(row.path)}
                    onToggleExpand={() => toggleExpand(row.path)}
                    onKeyDown={onRowKeyDown(i)}
                    onFocus={() => setFocusIdx(i)}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.path === "" ? tr("根目录") : row.path.split("/").pop()}
                      {row.path === "" ? " (files/)" : null}
                    </span>
                    {state?.status === "unavailable" ? (
                      <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                        {tr("不可访问")}
                      </span>
                    ) : null}
                    {loading ? (
                      <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                        {tr("加载中…")}
                      </span>
                    ) : null}
                    <span
                      onClick={(e: ReactNS.MouseEvent<HTMLSpanElement>) => e.stopPropagation()}
                      style={{ display: "inline-flex", alignItems: "center" }}
                    >
                      <antd.Checkbox
                        checked={checked}
                        disabled={checkDisabled(row.path)}
                        onChange={() => toggleCheck(row.path)}
                        aria-label={row.path === "" ? tr("根目录") : row.path}
                      />
                    </span>
                  </TreeRowShell>
                  {row.expanded &&
                  state?.status === "loaded" &&
                  state.dirs.length === 0 ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        // 与子行名称列对齐：行内左距 + 子级缩进 + caret 区。
                        paddingLeft: 8 + treeIndent(row.depth + 1) + 24,
                        paddingTop: 4,
                        paddingBottom: 4,
                      }}
                    >
                      {tr("无子目录")}
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 44,
            cursor: rootUnavailable ? "default" : "pointer",
          }}
        >
          <antd.Switch
            checked={includeSubdirs}
            disabled={rootUnavailable}
            onChange={(v: boolean) => setIncludeSubdirs(v)}
            aria-label={tr("包含子目录（**）")}
          />
          <span style={{ fontSize: 12, color: t.text, minWidth: 0 }}>
            {tr("包含子目录（**）")}
          </span>
        </label>
        <div style={{ display: "grid", gap: 2 }}>
          {slots === 0 ? (
            <span style={{ fontSize: 11, color: "#d4380d" }}>
              {tr("已达路径上限（16 条）")}
            </span>
          ) : null}
          <span style={{ fontSize: 11, color: t.textSecondary, wordBreak: "break-all" }}>
            {selected.length > 0
              ? tr("已选 {n} 个目录", { n: selected.length })
              : tr("勾选目录生成规则路径")}
            {` · ${tr("剩余 {m} 条", { m: slots })}`}
          </span>
          {candidates.length > 0 ? (
            <span
              style={{ fontSize: 11, color: t.textSecondary, wordBreak: "break-all" }}
            >
              {tr("将添加：{p}", {
                p:
                  candidates.slice(0, 3).join("、") +
                  (candidates.length > 3 ? "…" : ""),
              })}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <antd.Button onClick={onClose} style={{ minHeight: 44 }}>
            {tr("取消")}
          </antd.Button>
          <antd.Button
            type="primary"
            disabled={!canConfirm}
            onClick={confirm}
            style={{ minHeight: 44 }}
          >
            {tr("添加")}
          </antd.Button>
        </div>
      </div>
    </DialogShell>
  );
}
