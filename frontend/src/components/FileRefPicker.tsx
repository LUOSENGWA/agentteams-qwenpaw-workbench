/**
 * 团队共享文件浏览选择器（#87 聊天引用工作区文件）——antd Modal 内
 * 前缀导航：面包屑/进目录/返回上级，dirs+files 分区，多选勾选，
 * 确认回调返回 refs[]（key 为 shared 根相对键）。对标 dashboard
 * FileRefPickerDialog 语义（computeRefPrefix/parentRefPrefix 同款
 * 前缀合成；数据源 = /agentteams-proxy/team-files 端点）。
 */
import type * as ReactNS from "react";
import { fetchTeamFiles, type TeamFileEntry } from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import type { FileRef } from "../lib/file-refs";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const icon = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const FolderOutlined = icon("FolderOutlined");
const FileTextOutlined = icon("FileTextOutlined");
const ArrowUpOutlined = icon("ArrowUpOutlined");

interface FileRefPickerProps {
  open: boolean;
  /** 团队名（房间名 "Team: <name>" 推导；空时调用方不挂载）。 */
  team: string;
  onClose: () => void;
  onConfirm: (refs: FileRef[]) => void;
}

/** 进入目录时的下一 prefix（键为相对当前 prefix，拼接而非替换）。 */
function computeRefPrefix(current: string, relativeKey: string): string {
  const cleanRel = relativeKey.endsWith("/")
    ? relativeKey.slice(0, -1)
    : relativeKey;
  if (!cleanRel || cleanRel.includes("//")) return current;
  return current ? `${current}${cleanRel}/` : `${cleanRel}/`;
}

/** 上级目录 prefix（根为 ''）。 */
function parentRefPrefix(current: string): string {
  const trimmed = current.endsWith("/") ? current.slice(0, -1) : current;
  const parts = trimmed.split("/");
  parts.pop();
  return parts.length > 0 ? `${parts.join("/")}/` : "";
}

function fmtSize(n: number): string {
  return n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function toFileRef(e: TeamFileEntry): FileRef {
  return { name: e.name, key: e.key, size: e.size || undefined };
}

export function FileRefPicker({
  open,
  team,
  onClose,
  onConfirm,
}: FileRefPickerProps) {
  const tr = useT();
  const t = useThemeColors();
  // 首次 open 才渲染内容（afterClose 复位）——与 WorkerManage 弹窗同款。
  const [render, setRender] = React.useState(false);
  React.useEffect(() => {
    if (open) setRender(true);
  }, [open]);

  const [prefix, setPrefix] = React.useState("");
  const [entries, setEntries] = React.useState<TeamFileEntry[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<Map<string, FileRef>>(
    () => new Map(),
  );

  // open 时重置导航与勾选（每次进选择器从团队共享根开始）。
  React.useEffect(() => {
    if (open) {
      setPrefix("");
      setSelected(new Map());
      setError("");
      setEntries(null);
    }
  }, [open]);

  // 列取当前 prefix（open/导航变化触发；竞态以序号守卫）。
  const seqRef = React.useRef(0);
  React.useEffect(() => {
    if (!open) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    fetchTeamFiles(team, prefix)
      .then((list) => {
        if (seq !== seqRef.current) return;
        setEntries(list);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (seq !== seqRef.current) return;
        setEntries([]);
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [open, team, prefix]);

  const safeEntries = React.useMemo(
    () => (entries ?? []).filter((e) => !e.key.includes("//")),
    [entries],
  );
  const dirs = safeEntries.filter((e) => e.isPrefix);
  const files = safeEntries.filter((e) => !e.isPrefix);

  const toggleFile = (e: TeamFileEntry) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(e.key)) next.delete(e.key);
      else next.set(e.key, toFileRef(e));
      return next;
    });
  };

  const handleConfirm = () => {
    onConfirm([...selected.values()]);
    onClose();
  };

  // 面包屑：根 → 逐段（点段回跳到该层 prefix）。
  const segs = prefix
    .split("/")
    .filter(Boolean)
    .map((s, i, arr) => ({
      name: s,
      prefix: `${arr.slice(0, i + 1).join("/")}/`,
    }));

  return (
    <antd.Modal
      open={open}
      afterClose={() => setRender(false)}
      onCancel={onClose}
      title={tr("引用工作区文件")}
      width="min(calc(100vw - 32px), 520px)"
      centered
      footer={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <span
            style={{
              marginRight: "auto",
              fontSize: 12,
              color: t.textSecondary,
            }}
          >
            {tr("已选 {n} 个文件", { n: selected.size })}
          </span>
          <antd.Button size="small" onClick={onClose}>
            {tr("取消")}
          </antd.Button>
          <antd.Button
            size="small"
            type="primary"
            disabled={selected.size === 0}
            onClick={handleConfirm}
          >
            {tr("插入引用")}
          </antd.Button>
        </div>
      }
    >
      {render ? (
        <div style={{ minWidth: 0 }}>
          {/* 面包屑行：根标签/返回上级 + 可点路径段 + 当前 prefix。 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: t.textSecondary,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            {prefix ? (
              <antd.Button
                type="text"
                size="small"
                icon={<ArrowUpOutlined />}
                style={{ padding: "0 4px", fontSize: 12 }}
                onClick={() => setPrefix(parentRefPrefix(prefix))}
              >
                {tr("返回上级")}
              </antd.Button>
            ) : (
              <span>{tr("团队共享根目录")}</span>
            )}
            {segs.map((s, i) => (
              <React.Fragment key={s.prefix}>
                {i > 0 ? (
                  <span style={{ opacity: 0.5 }}>/</span>
                ) : null}
                <span
                  style={{
                    cursor: "pointer",
                    color: i === segs.length - 1 ? undefined : "var(--app-accent, #FF7F16)",
                  }}
                  onClick={() => setPrefix(s.prefix)}
                >
                  {s.name}
                </span>
              </React.Fragment>
            ))}
          </div>

          <div
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              maxHeight: "min(52dvh, 420px)",
              overflowY: "auto",
            }}
          >
            {loading ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "28px 0",
                  color: t.textSecondary,
                  fontSize: 13,
                }}
              >
                {tr("载入中…")}
              </div>
            ) : error ? (
              <div
                style={{
                  padding: "14px 12px",
                  fontSize: 12,
                  color: "#f5222d",
                  wordBreak: "break-all",
                }}
              >
                {error}
              </div>
            ) : safeEntries.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "28px 0",
                  color: t.textSecondary,
                  fontSize: 13,
                }}
              >
                {tr("此目录暂无文件")}
              </div>
            ) : (
              <>
                {dirs.map((d) => (
                  <div
                    key={d.key}
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      setPrefix(computeRefPrefix(prefix, d.key))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        setPrefix(computeRefPrefix(prefix, d.key));
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 12px",
                      cursor: "pointer",
                      fontSize: 13,
                      borderBottom: `1px solid ${t.border}`,
                    }}
                  >
                    <FolderOutlined style={{ color: t.textSecondary }} />
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {d.name}
                    </span>
                  </div>
                ))}
                {files.map((f) => {
                  const checked = selected.has(f.key);
                  return (
                    <label
                      key={f.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 12px",
                        cursor: "pointer",
                        fontSize: 13,
                        borderBottom: `1px solid ${t.border}`,
                      }}
                    >
                      <antd.Checkbox
                        checked={checked}
                        onChange={() => toggleFile(f)}
                      />
                      <FileTextOutlined
                        style={{ color: t.textSecondary }}
                      />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {f.name}
                      </span>
                      {f.size ? (
                        <span
                          style={{
                            fontSize: 12,
                            color: t.textSecondary,
                            flexShrink: 0,
                          }}
                        >
                          {fmtSize(f.size)}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </>
            )}
          </div>
        </div>
      ) : null}
    </antd.Modal>
  );
}
