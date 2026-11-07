// WorkerWorkspaceFilesPanel.tsx — Worker「工作区文件」卡面板（QwenPaw ≥ 2.1）。
//
// 知识库文件只读列表（MEMORY.md / memory/** / digest/**，允许列表由
// controller validateKbPath 收口）+ 文本预览/保存；image/pdf/csv 之外
// 的二进制只给下载。
//
// 版本门：入口（ResourceCards）已由 probeWorkspaceFilesSupported 门控；
// 面板内 404 兜底降级为一行提示（同会话内控制器降级/worker 越权时不弹错）。
// 502 = worker 容器不可达（未就绪）→ 提示先拉起 worker。
//
// 写契约（controller worker_workspace_files.go）：现有文件带 If-Match（读回
// 的 ETag），409 = 读后被改 → 提示重读；L2 无 readwrite 权 → 403 原样提示。

import type * as ReactNS from "react";

import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  fetchWorkspaceFileBlob,
  httpErrorStatus,
  httpErrorDetail,
  type WorkspaceFileEntry,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { TreeIcon, BoxIcon } from "./icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

const PAGE_SIZE = 200;

/** 语义色（主题 token 无语义色，mode 分支双主题可用）。 */
function okColor(dark: boolean): string {
  return dark ? "#95de64" : "#389e0d";
}
function errColor(dark: boolean): string {
  return dark ? "#ff7875" : "#d4380d";
}

/** 文本可读/可编辑的 preview_kind（csv 按文本处理）。 */
function isEditableKind(k?: string): boolean {
  return k === "text" || k === "csv" || k === undefined;
}

function fmtSize(n?: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 下载（二进制/不可预览文件）：Blob → object URL → a.click。 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function WorkerWorkspaceFilesPanel({
  worker,
}: {
  worker: { name: string };
  l1?: boolean;
  sheet?: boolean;
  onChanged?: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  // 当前目录（"" = 根：MEMORY.md / memory/ / digest/）。
  const [dir, setDir] = React.useState("");
  const [entries, setEntries] = React.useState<WorkspaceFileEntry[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  // 选中文件（预览/编辑）。
  const [selected, setSelected] = React.useState<WorkspaceFileEntry | null>(null);
  const [content, setContent] = React.useState("");
  const [etag, setEtag] = React.useState("");
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const cancelledRef = React.useRef(false);
  React.useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // 切 worker：渲染期派生复位（React「props 变化时调整 state」模式）——
  // 目录/选中文件属于上一个 worker，不能带进新 worker 的首次加载。
  const [ownerName, setOwnerName] = React.useState(worker.name);
  if (ownerName !== worker.name) {
    setOwnerName(worker.name);
    setDir("");
    setSelected(null);
    setFileError("");
    setMsg(null);
    setEditing(false);
  }

  const loadDir = React.useCallback(
    async (path: string, opts?: { append?: boolean }) => {
      if (opts?.append) {
        setLoading(true);
      } else {
        setLoading(true);
        setLoadError("");
        setEntries([]);
        setHasMore(false);
        setCursor(null);
      }
      try {
        const page = await listWorkspaceFiles(worker.name, path, {
          limit: PAGE_SIZE,
          cursor: opts?.append ? cursor || undefined : undefined,
        });
        if (cancelledRef.current) return;
        setEntries((prev) => (opts?.append ? [...prev, ...(page.entries ?? [])] : page.entries ?? []));
        setHasMore(!!page.has_more);
        setCursor(page.next_cursor ?? null);
      } catch (e) {
        if (cancelledRef.current) return;
        if (httpErrorStatus(e) === 404) {
          // 版本门兜底（入口探测已门控，这里只在会话中途降级时出现）。
          setLoadError(tr("当前 Controller 不支持工作区文件（需 QwenPaw ≥ 2.1）"));
        } else if (httpErrorStatus(e) === 502) {
          setLoadError(tr("Worker 容器不可达（未就绪），请稍后重试"));
        } else {
          setLoadError(httpErrorDetail(e) || String(e));
        }
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    },
    [worker.name, cursor, tr],
  );

  // 目录加载：切 worker（dir 已渲染期复位为 ""）/ 切目录时重拉。
  // loadDir 不入 deps（其 identity 随 cursor 变，入列会导致追加页后重拉）。
  React.useEffect(() => {
    void loadDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker.name, dir]);

  const openFile = React.useCallback(
    async (entry: WorkspaceFileEntry) => {
      setSelected(entry);
      setEditing(false);
      setFileError("");
      setMsg(null);
      if (entry.kind === "directory") {
        setDir(entry.path);
        return;
      }
      if (!isEditableKind(entry.preview_kind)) {
        // 二进制：不读内容，只给下载。
        setContent("");
        setEtag("");
        return;
      }
      setFileLoading(true);
      setContent("");
      setEtag("");
      try {
        const f = await readWorkspaceFile(worker.name, entry.path);
        if (cancelledRef.current) return;
        setContent(f.content ?? "");
        setEtag(f.etag ?? "");
        setDraft(f.content ?? "");
      } catch (e) {
        if (cancelledRef.current) return;
        if (httpErrorStatus(e) === 404) {
          setFileError(tr("文件不存在或已移出允许列表"));
        } else if (httpErrorStatus(e) === 502) {
          setFileError(tr("Worker 容器不可达（未就绪），请稍后重试"));
        } else {
          setFileError(httpErrorDetail(e) || String(e));
        }
      } finally {
        if (!cancelledRef.current) setFileLoading(false);
      }
    },
    [worker.name, tr],
  );

  const saveFile = React.useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await writeWorkspaceFile(worker.name, selected.path, draft, etag || undefined);
      setMsg({ kind: "ok", text: tr("已保存") });
      setEditing(false);
      setContent(draft);
      // 新 ETag 接棒（连续保存用新值，否则必 409）。
      setEtag(r.etag || "");
      void loadDir(dir, { append: false });
    } catch (e) {
      if (httpErrorStatus(e) === 409) {
        setMsg({ kind: "err", text: tr("文件已被修改，请重新读取后再保存") });
      } else if (httpErrorStatus(e) === 403) {
        setMsg({ kind: "err", text: tr("无写权限（L2 需 workspaceFileAccess=readwrite）") });
      } else if (httpErrorStatus(e) === 502) {
        setMsg({ kind: "err", text: tr("Worker 容器不可达（未就绪），请稍后重试") });
      } else {
        setMsg({ kind: "err", text: httpErrorDetail(e) || String(e) });
      }
    } finally {
      setBusy(false);
    }
  }, [worker.name, selected, draft, etag, dir, loadDir, tr]);

  const downloadFile = React.useCallback(
    async (entry: WorkspaceFileEntry) => {
      setMsg(null);
      try {
        const { blob, filename } = await fetchWorkspaceFileBlob(worker.name, entry.path);
        triggerDownload(blob, filename);
        setMsg({ kind: "ok", text: tr("下载已开始") });
      } catch (e) {
        if (httpErrorStatus(e) === 502) {
          setMsg({ kind: "err", text: tr("Worker 容器不可达（未就绪），请稍后重试") });
        } else {
          setMsg({ kind: "err", text: httpErrorDetail(e) || String(e) });
        }
      }
    },
    [worker.name, tr],
  );

  // 面包屑（根 / memory / 2026-11）。
  const crumbs = React.useMemo(() => {
    if (!dir) return [] as string[];
    return dir.split("/").filter(Boolean);
  }, [dir]);

  const rowStyle: ReactNS.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "6px 10px",
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
    textAlign: "left",
  };

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {/* 面包屑 + 刷新 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setDir("")}
          style={{ ...rowStyle, width: "auto", padding: "2px 8px" }}
        >
          {tr("根目录")}
        </button>
        {crumbs.map((c, i) => (
          <React.Fragment key={crumbs.slice(0, i + 1).join("/")}>
            <span style={{ color: t.textSecondary, fontSize: 11 }}>/</span>
            <button
              type="button"
              onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
              style={{ ...rowStyle, width: "auto", padding: "2px 8px" }}
            >
              {c}
            </button>
          </React.Fragment>
        ))}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void loadDir(dir)}
          style={{ ...rowStyle, width: "auto", padding: "2px 8px" }}
        >
          {tr("刷新")}
        </button>
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 6,
            color:
              msg.kind === "ok" ? okColor(t.mode === "dark") : errColor(t.mode === "dark"),
            background: t.hoverBg,
          }}
        >
          {msg.text}
        </div>
      )}

      {loadError ? (
        <div style={{ fontSize: 12.5, color: t.textSecondary }}>{loadError}</div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 2,
            maxHeight: 280,
            overflowY: "auto",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            padding: 4,
          }}
        >
          {loading && entries.length === 0 && (
            <div style={{ fontSize: 12, color: t.textSecondary, padding: 8 }}>
              {tr("加载中…")}
            </div>
          )}
          {entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => void openFile(e)}
              style={{
                ...rowStyle,
                background:
                  selected?.path === e.path ? t.hoverBg : "transparent",
              }}
            >
              {e.kind === "directory" ? (
                <TreeIcon size={13} style={{ color: t.textSecondary, flexShrink: 0 }} />
              ) : (
                <BoxIcon size={13} style={{ color: t.textSecondary, flexShrink: 0 }} />
              )}
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
                {e.name}
                {e.kind === "directory" ? "/" : ""}
              </span>
              <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                {e.kind === "file" ? fmtSize(e.size) : ""}
              </span>
            </button>
          ))}
          {hasMore && !loading && (
            <button
              type="button"
              onClick={() => void loadDir(dir, { append: true })}
              style={{ ...rowStyle, justifyContent: "center", color: t.textSecondary, fontSize: 12 }}
            >
              {tr("加载更多")}
            </button>
          )}
        </div>
      )}

      {/* 选中文件：文本预览/编辑 或 二进制下载。 */}
      {selected && selected.kind === "file" && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selected.path}
            </span>
            {isEditableKind(selected.preview_kind) ? (
              editing ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveFile()}
                    style={{ ...rowStyle, width: "auto", padding: "2px 10px", opacity: busy ? 0.5 : 1 }}
                  >
                    {busy ? tr("保存中…") : tr("保存")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setDraft(content);
                      setMsg(null);
                    }}
                    style={{ ...rowStyle, width: "auto", padding: "2px 10px" }}
                  >
                    {tr("取消")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={fileLoading || !!fileError}
                  onClick={() => {
                    setDraft(content);
                    setEditing(true);
                    setMsg(null);
                  }}
                  style={{ ...rowStyle, width: "auto", padding: "2px 10px", opacity: fileLoading ? 0.5 : 1 }}
                >
                  {tr("编辑")}
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => void downloadFile(selected)}
                style={{ ...rowStyle, width: "auto", padding: "2px 10px" }}
              >
                {tr("下载")}
              </button>
            )}
          </div>
          {fileError && (
            <div style={{ fontSize: 12, color: errColor(t.mode === "dark") }}>{fileError}</div>
          )}
          {isEditableKind(selected.preview_kind) && !fileError && (
            editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={12}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  fontSize: 12,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  padding: 8,
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                  background: t.cardBg,
                  color: t.text,
                  resize: "vertical",
                }}
              />
            ) : (
              fileLoading ? (
                <div style={{ fontSize: 12, color: t.textSecondary }}>{tr("加载中…")}</div>
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    maxHeight: 320,
                    overflow: "auto",
                    fontSize: 12,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    border: `1px solid ${t.border}`,
                    borderRadius: 6,
                    background: t.cardBg,
                    color: t.text,
                  }}
                >
                  {content || tr("（空文件）")}
                </pre>
              )
            )
          )}
        </div>
      )}
    </div>
  );
}
