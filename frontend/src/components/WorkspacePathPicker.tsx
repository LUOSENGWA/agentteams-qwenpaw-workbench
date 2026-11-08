/**
 * WorkspacePathPicker.tsx — 工作区访问规则「浏览…」目录选择弹窗（16.137，
 * #1502 续）。
 *
 * 交互（参考 Google Drive / Dropbox 文件夹选择、Forgejo/GitLab 路径选择）：
 * - 树根 = 工作区 `files/`；展开才调 listFiles 懒拉子目录（只列目录）；
 * - 多选（复选框）+「包含子目录（**）」开关（默认开）；确认后把生成的
 *   规则路径交给 PathChips.onChange（与手动输入走同一 validateAccess 门）；
 * - 生成形态：`files/<rel>/**` / `files/<rel>`；根目录 `files/**`（裸
 *   `files` 不是合法规则路径）；顶层保留名 .trash/.sync/.control 不展示；
 * - 每规则 ≤16 条（existing 计入；到上限禁用新增并提示）；
 * - 403/404 或拉取失败 = picker 不可用 → 提示手动输入，不报错；
 * - 键盘可达：行 tabIndex/role=treeitem，Space 勾选、Enter 展开；触屏可点。
 *
 * 纯逻辑（路径生成 / 去重 / 上限 / 保留名 / 加载状态）在
 * workspacePathPicker.ts（无 window 依赖，可单测）。
 */
import type * as ReactNS from "react";

import { listFiles } from "../api";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import DialogShell from "../manage/files/DialogShell";
import {
  PICKER_MAX_PATHS,
  applyDirLoaded,
  applyDirUnavailable,
  beginDirLoad,
  loadDirState,
  remainingSlots,
  selectionToRulePaths,
  toggleSelected,
  type DirLoadMap,
  type DirLoadState,
} from "./workspacePathPicker";

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

interface RowProps {
  rel: string;
  depth: number;
  state: DirLoadState | undefined;
  expanded: boolean;
  checked: boolean;
  checkDisabled: boolean;
  t: ThemeColors;
  tr: TrFn;
  onToggleExpand: () => void;
  onToggleCheck: () => void;
}

/** 一行目录（行点击 = 展开；复选框 = 勾选；键盘 Space/Enter）。 */
function DirRow({
  rel,
  depth,
  state,
  expanded,
  checked,
  checkDisabled,
  t,
  tr,
  onToggleExpand,
  onToggleCheck,
}: RowProps): ReactNS.ReactElement {
  const loading = state?.status === "loading";
  const hasChildren = state?.status === "loaded" && state.dirs.length > 0;
  const caret = loading ? "…" : expanded ? "▾" : "▸";
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={checked}
      aria-checked={checked}
      aria-busy={loading}
      tabIndex={0}
      data-dir-rel={rel}
      onClick={onToggleExpand}
      onKeyDown={(e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === " ") {
          e.preventDefault();
          if (!checkDisabled) onToggleCheck();
        } else if (e.key === "Enter") {
          e.preventDefault();
          onToggleExpand();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        padding: "2px 6px",
        paddingLeft: 6 + depth * 16,
        borderRadius: 6,
        cursor: "pointer",
        outlineOffset: -2,
        color: t.text,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 18,
          textAlign: "center",
          color: t.textSecondary,
          flexShrink: 0,
        }}
      >
        {hasChildren || loading || state === undefined ? caret : ""}
      </span>
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
        {rel === "" ? tr("根目录") : rel.split("/").pop()}
        {rel === "" ? " (files/)" : null}
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
        style={{ display: "inline-flex", alignItems: "center", minHeight: 44 }}
      >
        <antd.Checkbox
          checked={checked}
          disabled={checkDisabled && !checked}
          onChange={onToggleCheck}
          aria-label={rel === "" ? tr("根目录") : rel}
        />
      </span>
    </div>
  );
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
    void load("");
  }, [open, humanName, load]);

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

  if (!open) return null;

  const renderNode = (rel: string, depth: number): ReactNS.ReactNode => {
    const state = dirs[rel];
    const isExpanded = expanded.includes(rel);
    const checked = selected.includes(rel);
    const checkDisabled = !checked && selected.length >= slots;
    const row = (
      <DirRow
        key={rel || "/"}
        rel={rel}
        depth={depth}
        state={state}
        expanded={isExpanded}
        checked={checked}
        checkDisabled={checkDisabled}
        t={t}
        tr={tr}
        onToggleExpand={() => toggleExpand(rel)}
        onToggleCheck={() => setSelected((prev) => toggleSelected(prev, rel))}
      />
    );
    if (!isExpanded) return row;
    const kids =
      state?.status === "loaded"
        ? state.dirs.length > 0
          ? state.dirs.map((child) => renderNode(child, depth + 1))
          : [
              <div
                key={`${rel || "/"}-empty`}
                style={{
                  fontSize: 11,
                  color: t.textSecondary,
                  paddingLeft: 30 + depth * 16,
                  paddingTop: 4,
                  paddingBottom: 4,
                }}
              >
                {tr("无子目录")}
              </div>,
            ]
        : null;
    return (
      <React.Fragment key={rel || "/"}>
        {row}
        {kids}
      </React.Fragment>
    );
  };

  const canConfirm =
    !rootUnavailable && selected.length > 0 && slots > 0;

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
            {renderNode("", 0)}
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
