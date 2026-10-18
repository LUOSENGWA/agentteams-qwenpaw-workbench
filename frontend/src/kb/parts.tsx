// KB 页展示件（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移）：
// 状态芯片 / 目录树节点 / 文件组 / 刷新图标。

import { CloseIcon, DocIcon, FolderIcon, LinkIcon } from "../components/icons";
import type * as ReactNS from "react";

import type { KbDirItem } from "../api";
import { formatDateShort, formatDateTime, formatSize, formatTimeShort } from "../util";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import type { AnyFile, DirChild, SelectedFile } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function StatusChip({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <span style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: ok ? "#52c41a" : "#faad14",
          display: "inline-block",
        }}
      />
      <antd.Typography.Text type="secondary">{label}</antd.Typography.Text>
      <antd.Typography.Text style={{ fontSize: 12 }}>{value}</antd.Typography.Text>
    </span>
  );
}

/** （真机反馈：知识库「只能看见工作区目录，不能点开看；
 * 子目录文件在哪里也看不见」）：目录树节点——原「工作区目录」是
 * 不可点静态 Tag，现改懒加载可展开树：点目录=拉一级（kb/{a}/ls），
 * 点文件=openFile 预览（路径=工作区相对全路径，/file 端点直读）。
 * 深度上限 6 层防失控。 */
export function DirNode(props: {
  dir: KbDirItem;
  depth: number;
  expanded: Record<string, boolean>;
  cache: Record<string, DirChild | "loading">;
  onToggle: (d: KbDirItem) => void;
  onOpenFile: (path: string) => void;
  selected: SelectedFile | null;
}) {
  const { dir, depth, expanded, cache, onToggle, onOpenFile, selected } =
    props;
  const t = useThemeColors();
  const tr = useT();
  const isExp = Boolean(expanded[dir.path]);
  const child = cache[dir.path];
  const indent = depth * 14 + 4;
  const childIndent = depth * 14 + 18;
  return (
    <div style={{ marginBottom: 1 }}>
      <div
        onClick={() => depth < 6 ? onToggle(dir) : undefined}
        style={{
          cursor: depth >= 6 ? "default" : "pointer",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: `2px 4px 2px ${indent}px`,
        }}
      >
        <span style={{ width: 10, color: t.textSecondary, fontSize: 10 }}>
          {isExp ? "▾" : "▸"}
        </span>
        <span style={{ display: "inline-flex" }}>{dir.symlink ? <LinkIcon size={12} /> : <FolderIcon size={12} />}</span>
        <span style={{ color: t.text }} title={dir.symlink ? `${dir.path}（符号链接）` : dir.path}>
          {dir.name}
          {child === "loading" ? " …" : ""}
        </span>
      </div>
      {isExp && child && child !== "loading" ? (
        <div>
          {child.dirs.map((cd) => (
            <DirNode
              key={cd.path}
              dir={cd}
              depth={depth + 1}
              expanded={expanded}
              cache={cache}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              selected={selected}
            />
          ))}
          {child.files.map((f) => {
            const isSel =
              selected?.section === "remote" && selected.filename === f.path;
            const openable = f.openable !== false;
            return (
              <div
                key={f.path}
                onClick={openable ? () => onOpenFile(f.path) : undefined}
                title={openable ? f.path : `${f.path} · 非文本文件（不可在线预览）`}
                style={{
                  cursor: openable ? "pointer" : "default",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: `2px 4px 2px ${childIndent}px`,
                  color: isSel ? "var(--app-accent, #FF7F16)" : t.text,
                  opacity: openable ? undefined : 0.55,
                  background: isSel ? "color-mix(in srgb, var(--app-accent, #FF7F16) 8%, transparent)" : undefined,
                }}
              >
                <span style={{ width: 10, display: "inline-block" }} />
                <span style={{ display: "inline-flex" }}>{openable ? <DocIcon size={12} /> : <CloseIcon size={12} style={{ color: "#f5222d" }} />}</span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.name}
                </span>
              </div>
            );
          })}
          {child.files.length === 0 && child.dirs.length === 0 ? (
            <div
              style={{
                fontSize: 11.5,
                color: t.textSecondary,
                opacity: 0.6,
                padding: `2px 4px 2px ${childIndent}px`,
              }}
            >
              {tr("空目录")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FileGroup({
  title,
  color,
  files,
  selected,
  onSelect,
  limit,
}: {
  title: string;
  color: string;
  files: AnyFile[];
  selected: SelectedFile | null;
  /** 传解析后的相对路径/文件名（非空字符串）。 */
  onSelect: (key: string) => void;
  limit?: number;
}) {
  const t = useThemeColors();
  const keyOf = (f: AnyFile) => f.path || f.filename || "";
  const shown = limit ? files.slice(0, limit) : files;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: t.textSecondary,
          marginBottom: 4,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: color,
            display: "inline-block",
          }}
        />
        {title}
        <span style={{ fontWeight: 400, color: t.textSecondary }}>
          ({files.length})
        </span>
      </div>
      {shown.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: t.textSecondary,
            padding: "2px 0 2px 12px",
            opacity: 0.6,
          }}
        >
          —
        </div>
      ) : (
        <div>
          {shown.map((f) => {
            const key = keyOf(f);
            const name = key.split("/").pop() || key;
            const active = selected?.filename === key;
 // 非文本文件
            // 列出但灰显不可点开（openable=false，后端全量列目录）。
            const openable = f.openable !== false;
            return (
              <div
                key={key}
                onClick={openable ? () => onSelect(key) : undefined}
                title={`${key}${!openable ? " · 非文本文件（不可在线预览）" : ""}${f.mtime ? ` · ${formatDateTime(f.mtime * 1000, "zh-CN")}` : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  padding: "3px 8px 3px 12px",
                  borderRadius: 6,
                  cursor: openable ? "pointer" : "default",
                  color: active ? "#fff" : t.text,
                  opacity: openable ? undefined : 0.55,
                  background: active ? color : "transparent",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {name}
                  {!openable ? (
                    <span style={{ fontSize: 9.5, marginLeft: 6, opacity: 0.8 }}>
                      非文本
                    </span>
                  ) : null}
                </span>
                {f.size != null && f.size > 0 ? (
                  <span style={{ color: active ? "rgba(255,255,255,0.75)" : t.textSecondary, fontSize: 10.5, flexShrink: 0 }}>
                    {formatSize(f.size)}
                  </span>
                ) : null}
                {/* 文件更新时间（tar mtime） */}
                {f.mtime ? (
                  <span style={{ color: active ? "rgba(255,255,255,0.75)" : t.textSecondary, fontSize: 10, flexShrink: 0 }}>
                    {formatDateShort(f.mtime * 1000)}{" "}
                    {formatTimeShort(f.mtime * 1000)}
                  </span>
                ) : null}
              </div>
            );
          })}
          {limit && files.length > limit ? (
            <div style={{ fontSize: 11, color: t.textSecondary, paddingLeft: 12 }}>
              +{files.length - limit}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function RefreshIcon() {
  const icons = window.QwenPaw.host.antdIcons as Record<
    string,
    ReactNS.ComponentType
  >;
  const I = (icons["ReloadOutlined"] || icons["SyncOutlined"]) as ReactNS.ComponentType;
  if (!I) return null;
  return <I />;
}
