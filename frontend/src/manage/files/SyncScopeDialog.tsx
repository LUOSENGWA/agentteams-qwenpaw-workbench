/**
 * SyncScopeDialog — 「同步范围」目录选择弹窗（同步设置 → 同步范围 → 选择…）。
 *
 * 交互对齐业界选择性同步（Dropbox「Selective sync」/ OneDrive「Choose
 * folders」/ Nextcloud 桌面端）：**只列文件夹**、每个文件夹一个开关，
 * 关掉 = 该文件夹不再同步到本机，云端文件保留；顶上一个「递归同步子
 * 文件夹」总开关（默认开），关掉后只同步所选文件夹内的直接文件（不进
 * 子目录）。
 *
 * 数据源：Controller 递归列表（`files?recursive=1`）推导目录集合；
 * 状态源：`GET /sync/config` 的 `selection` / `recursive`（旧配置无这两个
 * 字段 → 全选 + 递归，行为与改造前一致）。
 *
 * 落盘：保存时把目录开关**导出为 include glob**（权威判定在引擎
 * `should_sync`），同时回写 `selection` / `recursive` 供界面回显：
 *   递归开 → `files/<dir>/**`；递归关 → `files/<dir>/*`；
 *   根目录选中 → `files/**`（递归）或 `files/*`（非递归）。
 */
import type * as ReactNS from "react";

import { listFiles, type HumanFileEntry } from "../../api";
import {
  buildDirTree,
  entriesToDirs,
  flattenTree,
  selectionToInclude,
  type DirNode,
  type SyncScope,
} from "../../lib/syncScopeModel";
import type { ThemeColors } from "../../theme";
import DialogShell from "./DialogShell";

export type { SyncScope } from "../../lib/syncScopeModel";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (s: string, v?: Record<string, string | number>) => string;

export interface SyncScopeDialogProps {
  open: boolean;
  t: ThemeColors;
  tr: Tr;
  humanName: string;
  initial: SyncScope;
  saving?: boolean;
  onClose: () => void;
  /** 保存：目录开关 + 递归 + 导出的 include glob（引擎权威判定用）。 */
  onSave: (next: SyncScope & { include: string[] }) => void;
}

export default function SyncScopeDialog(props: SyncScopeDialogProps): JSX.Element {
  const { open, t, tr, humanName, initial, saving = false, onClose, onSave } = props;
  const [dirs, setDirs] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selection, setSelection] = React.useState<Record<string, boolean>>(
    initial.selection as Record<string, boolean>,
  );
  const [recursive, setRecursive] = React.useState<boolean>(initial.recursive);

  React.useEffect(() => {
    if (!open) return;
    setSelection(initial.selection);
    setRecursive(initial.recursive);
  }, [open, initial]);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    void (async () => {
      const acc: HumanFileEntry[] = [];
      let cursor = "";
      try {
        for (let page = 0; page < 5; page += 1) {
          const r = await listFiles(humanName, "", {
            recursive: true,
            limit: 1000,
            cursor: cursor || undefined,
          });
          acc.push(...r.entries);
          cursor = r.nextKey ?? "";
          if (!cursor) break;
        }
        if (live) setDirs(entriesToDirs(acc));
      } catch {
        if (live) setDirs([]);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [open, humanName]);

  const tree = React.useMemo(() => buildDirTree(dirs), [dirs]);
  const allDirs = React.useMemo(() => flattenTree(tree), [tree]);

  const isOn = (p: string): boolean => selection[p] !== false;
  /** 任一祖先被关 → 本行显示为关且禁改（父级已不同步）。 */
  const ancestorOff = (p: string): boolean => {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      if (!isOn(segs.slice(0, i).join("/"))) return true;
    }
    return false;
  };

  const toggle = (node: DirNode, next: boolean) => {
    setSelection((cur) => {
      const out = { ...cur, [node.path]: next };
      for (const d of flattenTree([node])) out[d] = next;
      return out;
    });
  };

  const onCount = allDirs.filter((d) => isOn(d)).length;

  return (
    <DialogShell
      open={open}
      title={tr("选择同步的文件夹")}
      onClose={onClose}
      footer={
        <>
          <antd.Button style={{ minHeight: 40 }} onClick={onClose}>
            {tr("取消")}
          </antd.Button>
          <antd.Button
            type="primary"
            style={{ minHeight: 40 }}
            loading={saving}
            onClick={() =>
              onSave({
                selection,
                recursive,
                include: selectionToInclude(selection, recursive, allDirs),
              })
            }
          >
            {tr("保存")}
          </antd.Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12, padding: "4px 0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {tr("递归同步子文件夹")}
            </span>
            <span style={{ fontSize: 11.5, color: t.textSecondary }}>
              {recursive
                ? tr("所选文件夹的子目录一并同步（默认）")
                : tr("只同步所选文件夹内的直接文件，不进入子目录")}
            </span>
          </div>
          <antd.Switch
            checked={recursive}
            onChange={(v: boolean) => setRecursive(v)}
            aria-label={tr("递归同步子文件夹")}
          />
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary }}>
          {loading
            ? tr("正在读取文件夹…")
            : tr("共 {n} 个文件夹，已选 {m} 个；关闭开关只停止本机同步，云端文件保留。", {
                n: allDirs.length,
                m: onCount,
              })}
        </div>
        <div
          style={{
            display: "grid",
            gap: 2,
            maxHeight: "52vh",
            overflow: "auto",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            padding: "6px 4px",
          }}
        >
          {!loading && allDirs.length === 0 ? (
            <span style={{ fontSize: 12, color: t.textSecondary, padding: 8 }}>
              {tr("还没有文件夹（先上传文件或同步一次）")}
            </span>
          ) : null}
          {flattenTree(tree).map((p) => {
            const node = (() => {
              const segs = p.split("/");
              let nodes = tree;
              let n: DirNode | undefined;
              for (const s of segs) {
                n = nodes.find((x) => x.name === s);
                if (!n) return undefined;
                nodes = n.children;
              }
              return n;
            })();
            const disabled = ancestorOff(p);
            return (
              <div
                key={p}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  minHeight: 44,
                  paddingLeft: 8 + (node?.depth ?? 0) * 16,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, wordBreak: "break-all" }}>
                  {node?.name ?? p}
                </span>
                <antd.Switch
                  size="small"
                  checked={isOn(p) && !disabled}
                  disabled={disabled}
                  onChange={(v: boolean) => node && toggle(node, v)}
                  aria-label={`${tr("同步")} ${p}`}
                />
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: t.textSecondary }}>
          {tr("新出现在云端的文件夹默认同步；取消勾选随时可重新打开。")}
        </div>
      </div>
    </DialogShell>
  );
}
