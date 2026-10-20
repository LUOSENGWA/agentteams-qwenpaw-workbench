/** SkillCenter 子模块——自 SkillCenter.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { CloseIcon } from "./icons";
import {
  type WorkerInfo,
  type McpServerInfo,
} from "../api";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function McpCard({
  l2,
  narrow,
  workers,
  loading,
  mcpMap,
  mcpVisible,
  mcpWithCount,
  onlyWorker,
  showAllMcp,
  onToggleShowAll,
  onEdit,
}: {
  l2: boolean;
  narrow: boolean;
  workers: WorkerInfo[];
  loading: boolean;
  mcpMap: Record<string, McpServerInfo[]>;
  mcpVisible: WorkerInfo[];
  mcpWithCount: number;
  onlyWorker: string | undefined;
  showAllMcp: boolean;
  onToggleShowAll: () => void;
  onEdit: (w: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
      <antd.Card
        size="small"
        title={
          l2
            ? tr("③ MCP Servers（L2 只读 · 写权限待上游 elevated capability 设计）")
            : tr("③ MCP Servers（L1 可写 · PUT 合并语义 · mcpServers 整字段替换）")
        }
      >
        {workers.length ? (
          <div style={{ display: "grid", gap: 8 }}>
            {mcpVisible.map((w) => {
              const list = mcpMap[w.name] || [];
              // 竖屏修复（376 点名「编辑按钮超出容器」）：行 wrap +
              // 名称可收缩 + tag 组 flex:1 换行（长 url 不再把编辑钮
              // 顶出容器）+ 编辑钮 flexShrink:0。
              return (
                <div
                  key={w.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "6px 10px",
                    padding: "8px 10px",
                    border: `1px solid ${t.border}`,
                    borderRadius: 6,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      minWidth: narrow ? 0 : 180,
                      maxWidth: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {w.name}
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minWidth: 0, flex: 1 }}>
                    {list.length ? (
                      list.map((m, i) => (
                        <antd.Tag
                          key={`${m.name}-${i}`}
                          color="cyan"
                          style={{
                            marginInlineEnd: 0,
                            maxWidth: "100%",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.name}
                          {m.url ? ` · ${m.url}` : ""}
                          {m.transport ? ` · ${m.transport}` : ""}
                        </antd.Tag>
                      ))
                    ) : (
                      <span style={{ color: t.textSecondary, fontSize: 12 }}>{tr("无 MCP")}</span>
                    )}
                  </div>
                  {!l2 ? (
                    <antd.Button
                      size="small"
                      style={{ flexShrink: 0 }}
                      onClick={() => onEdit(w.name)}
                    >
                      {tr("编辑")}
                    </antd.Button>
                  ) : null}
                </div>
              );
            })}
            {!onlyWorker && mcpWithCount ? (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                <antd.Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={onToggleShowAll}
                >
                  {showAllMcp
                    ? tr("显示 {n} 个无 MCP 的 Worker", { n: workers.length - mcpWithCount })
                    : tr("已隐藏 {n} 个无 MCP 的 Worker", { n: workers.length - mcpWithCount })}
                </antd.Button>
              </div>
            ) : null}
          </div>
        ) : (
          <antd.Empty description={loading ? tr("加载中…") : tr("无 Worker")} />
        )}
      </antd.Card>
  );
}

export function McpEditDrawer({
  editWorker,
  setEditWorker,
  draft,
  setDraft,
  saving,
  onSave,
}: {
  editWorker: string;
  setEditWorker: (v: string) => void;
  draft: McpServerInfo[];
  setDraft: ReactNS.Dispatch<ReactNS.SetStateAction<McpServerInfo[]>>;
  saving: boolean;
  onSave: () => void;
}) {
  const tr = useT();
  return (
      <antd.Drawer
        title={editWorker ? tr("编辑 MCP Servers：{w}", { w: editWorker }) : ""}
        open={Boolean(editWorker)}
        onClose={() => setEditWorker("")}
        width={520}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10 }}>
          {draft.map((m, i) => (
            <div key={i} style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1.4fr 0.8fr 36px" }}>
              <antd.Input
                size="small"
                value={String(m.name ?? "")}
                placeholder={tr("name（必填）")}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setDraft((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))
                }
              />
              <antd.Input
                size="small"
                value={String(m.url ?? "")}
                placeholder="url"
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setDraft((prev) => prev.map((p, j) => (j === i ? { ...p, url: e.target.value } : p)))
                }
              />
              <antd.Input
                size="small"
                value={String(m.transport ?? "")}
                placeholder={tr("transport（http/sse）")}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setDraft((prev) => prev.map((p, j) => (j === i ? { ...p, transport: e.target.value } : p)))
                }
              />
              <antd.Button
                size="small"
                danger
                type="text"
                onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
              >
                <CloseIcon size={12} />
              </antd.Button>
            </div>
          ))}
          <antd.Button
            size="small"
            onClick={() => setDraft((prev) => [...prev, { name: "", url: "" }])}
          >
            {tr("添加 MCP")}
          </antd.Button>
          <antd.Space>
            <antd.Button type="primary" loading={saving} onClick={() => void onSave()}>
              {tr("保存")}
            </antd.Button>
            <antd.Button onClick={() => setEditWorker("")}>{tr("取消")}</antd.Button>
          </antd.Space>
        </div>
      </antd.Drawer>
  );
}
