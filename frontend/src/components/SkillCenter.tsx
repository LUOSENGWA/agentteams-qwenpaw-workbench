/**
 * 🧩 技能中心（v0.5.0-beta.11，技能中心与 MCP 实施方案 v0.1）。
 *
 * 三节（L1 admin 视角，插件以 admin token 操作 Controller）：
 *   ① 技能目录（P2，#1211 a45d1040 draft）——GET /api/v1/skills，
 *      未合并时 Controller 404 → 占位卡；合并并升级后自动点亮。
 *      契约：{skills:[{name,description?,source,agents?}],total}。
 *   ② Worker 技能分配矩阵（P1，v1.2.3 立即可用）——行=Worker，
 *      列=技能（目录可用=目录 ∪ 已分配；否则=已分配并集）。
 *      勾选 → PUT /workers/{name} {skills:[...]}（整字段替换语义）。
 *      L2 无权限（#1212 未合/已合 L2 白名单外）→ 403 → 明确 toast
 *      （P3 的角色反馈自动生效，前端无需写死角色判断）。
 *   ③ MCP Servers（P1）——行=Worker，行内编辑 mcpServers。
 *      契约 = Go MCPServer {name,url,transport?}（transport: http 默认|sse；
 *      authType 不存在——别加回来）。
 *
 * 频道接入不在本组件：调研 v0.3 定案放「👷 团队管理」→「频道」tab
 * （WorkerChannels.tsx，#1219 ad71f135 契约，404=版本门）。
 *
 * 原「🎯 技能」tab 更名「宿主技能」（host agent 技能管理，本插件
 * 专用，与团队技能矩阵不同维度）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  type WorkerInfo,
  type McpServerInfo,
  type SkillCatalogItem,
  fetchAdminData,
  updateWorker,
  fetchSkillCatalog,
  httpErrorStatus,
} from "../api";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface MatrixState {
  workers: WorkerInfo[];
  loading: boolean;
  catalog: SkillCatalogItem[] | null | undefined; // null=加载中；[]=已加载空；undefined=404 不可用
  catalogNote: string; // 404 时的说明
}

export default function SkillCenter() {
  const t = useThemeColors();
  const tr = useT();
  const [st, setSt] = React.useState<MatrixState>({
    workers: [],
    loading: true,
    catalog: null,
    catalogNote: "",
  });
  const [matrix, setMatrix] = React.useState<Record<string, string[]>>({});
  const [mcpMap, setMcpMap] = React.useState<Record<string, McpServerInfo[]>>({});
  const [savingRow, setSavingRow] = React.useState("");
  const [mcpEditWorker, setMcpEditWorker] = React.useState("");
  const [mcpDraft, setMcpDraft] = React.useState<McpServerInfo[]>([]);
  const [mcpSaving, setMcpSaving] = React.useState(false);
  const [catalogSearch, setCatalogSearch] = React.useState("");
  // v0.5.0-beta.11 再版 2 防刷屏（用户报告「技能中心刷屏」）：空行默认收起，一键展开。
  const [showEmptySkills, setShowEmptySkills] = React.useState(false);
  const [showAllMcp, setShowAllMcp] = React.useState(false);
  const emptySkillCount = React.useMemo(
    () => st.workers.filter((w) => !(w.skills || []).length).length,
    [st.workers],
  );
  const visibleSkillWorkers = React.useMemo(
    () =>
      showEmptySkills
        ? st.workers
        : st.workers.filter((w) => (w.skills || []).length),
    [st.workers, showEmptySkills],
  );
  const mcpWithCount = React.useMemo(
    () => st.workers.filter((w) => (mcpMap[w.name] || []).length).length,
    [st.workers, mcpMap],
  );
  const mcpVisible = React.useMemo(
    () =>
      mcpWithCount === 0 || showAllMcp
        ? st.workers
        : st.workers.filter((w) => (mcpMap[w.name] || []).length),
    [st.workers, mcpMap, mcpWithCount, showAllMcp],
  );


  const load = React.useCallback(async () => {
    try {
      const admin = await fetchAdminData();
      const workers = admin.workers;
      const m: Record<string, string[]> = {};
      const mm: Record<string, McpServerInfo[]> = {};
      for (const w of workers) {
        m[w.name] = [...(w.skills || [])];
        mm[w.name] = [...(w.mcpServers || [])];
      }
      setMatrix(m);
      setMcpMap(mm);
      setSt((prev) => ({ ...prev, workers, loading: false }));
    } catch (e) {
      setSt((prev) => ({
        ...prev,
        loading: false,
        catalogNote: tr("Worker 列表加载失败：{m}", {
          m: e instanceof Error ? e.message : "?",
        }),
      }));
      return;
    }
    // 技能目录（#1211 draft——404 降级占位，不阻塞其余各节）。
    try {
      const cat = await fetchSkillCatalog();
      setSt((prev) => ({ ...prev, catalog: cat }));
    } catch (e) {
      const s = httpErrorStatus(e);
      setSt((prev) => ({
        ...prev,
        catalog: undefined,
        catalogNote:
          s === 404
            ? tr("技能目录 API 待上游合并（PR #1211，draft）——合并并升级后本节自动点亮")
            : tr("技能目录加载失败：{m}", {
                m: e instanceof Error ? e.message : "?",
              }),
      }));
    }
  }, [tr]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // 技能列 = 目录（如可用）∪ 已分配并集（目录不可用时的降级全集）。
  const skillColumns = React.useMemo(() => {
    const set = new Set<string>();
    for (const s of st.catalog || []) set.add(s.name);
    for (const w of st.workers) for (const s of w.skills || []) set.add(s);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [st.catalog, st.workers]);

  const catalogByName = React.useMemo(() => {
    const m = new Map<string, SkillCatalogItem>();
    for (const s of st.catalog || []) m.set(s.name, s);
    return m;
  }, [st.catalog]);

  const toggleSkill = React.useCallback(
    (worker: string, skill: string, on: boolean) => {
      setMatrix((prev) => {
        const cur = new Set(prev[worker] || []);
        if (on) cur.add(skill);
        else cur.delete(skill);
        return { ...prev, [worker]: [...cur].sort() };
      });
    },
    [],
  );

  const saveWorkerSkills = React.useCallback(
    async (worker: string) => {
      setSavingRow(worker);
      try {
        // PUT 合并语义：只发 skills（整字段替换该 Worker 的 skills）。
        await updateWorker(worker, { skills: matrix[worker] || [] });
        antd.message.success(tr("{w} 的技能已保存", { w: worker }));
      } catch (e) {
        const s = httpErrorStatus(e);
        if (s === 403) {
          antd.message.error(
            tr("无权限修改该 Worker 的技能（当前角色被 Controller 拒绝；L2 自服务仅白名单字段，且 #1212 未合时 L2 全部拒绝）"),
          );
        } else {
          antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
        }
      } finally {
        setSavingRow("");
      }
    },
    [matrix, tr],
  );

  const openMcpEdit = React.useCallback(
    (w: string) => {
      setMcpEditWorker(w);
      setMcpDraft((mcpMap[w] || []).map((m) => ({ ...m })));
    },
    [mcpMap],
  );

  const saveMcp = React.useCallback(async () => {
    if (!mcpEditWorker) return;
    setMcpSaving(true);
    try {
      const clean = mcpDraft
        .filter((m) => String(m.name || "").trim())
        .map((m) => ({
          name: String(m.name || "").trim(),
          url: String(m.url || "").trim(),
          ...(m.transport ? { transport: String(m.transport) } : {}),
        }));
      await updateWorker(mcpEditWorker, { mcpServers: clean });
      setMcpMap((prev) => ({ ...prev, [mcpEditWorker]: clean }));
      antd.message.success(tr("{w} 的 MCP 已保存", { w: mcpEditWorker }));
      setMcpEditWorker("");
    } catch (e) {
      const s = httpErrorStatus(e);
      if (s === 403) {
        antd.message.error(tr("无权限修改该 Worker 的 MCP（当前角色被 Controller 拒绝）"));
      } else {
        antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      }
    } finally {
      setMcpSaving(false);
    }
  }, [mcpEditWorker, mcpDraft, tr]);

  const filteredCatalog = (st.catalog || []).filter((s) => {
    if (!catalogSearch.trim()) return true;
    const q = catalogSearch.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q)
    );
  });

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>🧩 {tr("技能中心")}</span>
        <antd.Tooltip
          title={tr(
            "团队技能/MCP 的统一管理面：技能目录（只读）+ Worker 技能分配矩阵 + MCP Servers。L1（admin）可写；L2/Leader 写操作被 Controller 拒绝（403/404）时明确提示。频道接入见「团队管理 → 频道」。",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </antd.Tooltip>
        <div style={{ flex: 1 }} />
        <antd.Button size="small" onClick={() => void load()} loading={st.loading}>
          {tr("刷新")}
        </antd.Button>
      </div>

      {/* ① 技能目录（P2——#1211 draft，404 占位） */}
      <antd.Card
        size="small"
        title={tr("① 技能目录（只读 · 上游 /api/v1/skills）")}
        extra={
          st.catalog !== undefined ? (
            <antd.Input
              size="small"
              style={{ width: 200 }}
              allowClear
              placeholder={tr("搜索名称/描述")}
              value={catalogSearch}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setCatalogSearch(e.target.value)}
            />
          ) : undefined
        }
      >
        {st.catalog === null ? (
          <antd.Spin />
        ) : st.catalog === undefined ? (
          <antd.Alert
            type="info"
            showIcon
            message={st.catalogNote || tr("技能目录 API 待上游合并")}
          />
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {filteredCatalog.map((s) => (
              <div
                key={`${s.source}-${s.name}`}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "baseline",
                  padding: "6px 10px",
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                }}
              >
                <span style={{ fontWeight: 600, minWidth: 180 }}>{s.name}</span>
                <antd.Tag color={s.source === "builtin" ? "blue" : "purple"} style={{ marginInlineEnd: 0 }}>
                  {s.source}
                </antd.Tag>
                <span style={{ color: t.textSecondary, fontSize: 12 }}>
                  {s.description || "—"}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: t.textSecondary, fontSize: 11 }}>
                  {tr("使用方 {n}", { n: (s.agents || []).length })}
                </span>
              </div>
            ))}
            {!filteredCatalog.length && (
              <antd.Empty description={tr("无匹配技能")} />
            )}
          </div>
        )}
      </antd.Card>

      {/* ② Worker 技能分配矩阵（P1，立即可用） */}
      <antd.Card
        size="small"
        title={tr("② Worker 技能分配矩阵（L1 可写 · PUT 合并语义 · skills 整字段替换）")}
      >
        {st.workers.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={thStyle(t)}>{tr("Worker")}</th>
                  {skillColumns.map((s) => (
                    <th key={s} style={{ ...thStyle(t), minWidth: 92 }}>
                      <div title={catalogByName.get(s)?.description || ""} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s}
                      </div>
                    </th>
                  ))}
                  <th style={thStyle(t)}>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleSkillWorkers.map((w) => (
                  <tr key={w.name}>
                    <td style={tdStyle(t)}>
                      <div style={{ fontWeight: 600 }}>{w.name}</div>
                      <div style={{ color: t.textSecondary, fontSize: 11 }}>
                        {w.team || "—"} · {w.role || "worker"}
                      </div>
                    </td>
                    {skillColumns.map((s) => (
                      <td key={s} style={{ ...tdStyle(t), textAlign: "center" }}>
                        <antd.Checkbox
                          checked={(matrix[w.name] || []).includes(s)}
                          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => toggleSkill(w.name, s, e.target.checked)}
                        />
                      </td>
                    ))}
                    <td style={tdStyle(t)}>
                      <antd.Button
                        size="small"
                        type="link"
                        loading={savingRow === w.name}
                        onClick={() => void saveWorkerSkills(w.name)}
                      >
                        {tr("保存")}
                      </antd.Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {emptySkillCount ? (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                <antd.Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() => setShowEmptySkills((v) => !v)}
                >
                  {showEmptySkills
                    ? tr("显示 {n} 个未分配技能的 Worker", { n: emptySkillCount })
                    : tr("已隐藏 {n} 个未分配技能的 Worker", { n: emptySkillCount })}
                </antd.Button>
              </div>
            ) : null}
          </div>
        ) : (
          <antd.Empty description={st.loading ? tr("加载中…") : tr("无 Worker（admin token 未配置？）")} />
        )}
      </antd.Card>

      {/* ③ MCP Servers（P1） */}
      <antd.Card
        size="small"
        title={tr("③ MCP Servers（L1 可写 · PUT 合并语义 · mcpServers 整字段替换）")}
      >
        {st.workers.length ? (
          <div style={{ display: "grid", gap: 8 }}>
            {mcpVisible.map((w) => {
              const list = mcpMap[w.name] || [];
              return (
                <div
                  key={w.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    border: `1px solid ${t.border}`,
                    borderRadius: 6,
                  }}
                >
                  <span style={{ fontWeight: 600, minWidth: 180 }}>{w.name}</span>
                  {list.length ? (
                    list.map((m, i) => (
                      <antd.Tag key={`${m.name}-${i}`} color="cyan">
                        {m.name}
                        {m.url ? ` · ${m.url}` : ""}
                        {m.transport ? ` · ${m.transport}` : ""}
                      </antd.Tag>
                    ))
                  ) : (
                    <span style={{ color: t.textSecondary, fontSize: 12 }}>{tr("无 MCP")}</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <antd.Button size="small" onClick={() => openMcpEdit(w.name)}>
                    {tr("编辑")}
                  </antd.Button>
                </div>
              );
            })}
            {mcpWithCount ? (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                <antd.Button
                  size="small"
                  type="link"
                  style={{ padding: 0 }}
                  onClick={() => setShowAllMcp((v) => !v)}
                >
                  {showAllMcp
                    ? tr("显示 {n} 个无 MCP 的 Worker", { n: st.workers.length - mcpWithCount })
                    : tr("已隐藏 {n} 个无 MCP 的 Worker", { n: st.workers.length - mcpWithCount })}
                </antd.Button>
              </div>
            ) : null}
          </div>
        ) : (
          <antd.Empty description={st.loading ? tr("加载中…") : tr("无 Worker")} />
        )}
      </antd.Card>

      <antd.Drawer
        title={mcpEditWorker ? tr("编辑 MCP Servers：{w}", { w: mcpEditWorker }) : ""}
        open={Boolean(mcpEditWorker)}
        onClose={() => setMcpEditWorker("")}
        width={520}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10 }}>
          {mcpDraft.map((m, i) => (
            <div key={i} style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1.4fr 0.8fr 36px" }}>
              <antd.Input
                size="small"
                value={String(m.name ?? "")}
                placeholder={tr("name（必填）")}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setMcpDraft((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))
                }
              />
              <antd.Input
                size="small"
                value={String(m.url ?? "")}
                placeholder="url"
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setMcpDraft((prev) => prev.map((p, j) => (j === i ? { ...p, url: e.target.value } : p)))
                }
              />
              <antd.Input
                size="small"
                value={String(m.transport ?? "")}
                placeholder={tr("transport（http/sse）")}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setMcpDraft((prev) => prev.map((p, j) => (j === i ? { ...p, transport: e.target.value } : p)))
                }
              />
              <antd.Button
                size="small"
                danger
                type="text"
                onClick={() => setMcpDraft((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </antd.Button>
            </div>
          ))}
          <antd.Button
            size="small"
            onClick={() => setMcpDraft((prev) => [...prev, { name: "", url: "" }])}
          >
            {tr("添加 MCP")}
          </antd.Button>
          <antd.Space>
            <antd.Button type="primary" loading={mcpSaving} onClick={() => void saveMcp()}>
              {tr("保存")}
            </antd.Button>
            <antd.Button onClick={() => setMcpEditWorker("")}>{tr("取消")}</antd.Button>
          </antd.Space>
        </div>
      </antd.Drawer>
    </div>
  );
}

function thStyle(t: ReturnType<typeof useThemeColors>): React.CSSProperties {
  return {
    textAlign: "left",
    padding: "6px 8px",
    borderBottom: `1px solid ${t.border}`,
    color: t.textSecondary,
    fontSize: 11,
    whiteSpace: "nowrap",
  };
}
function tdStyle(t: ReturnType<typeof useThemeColors>): React.CSSProperties {
  return {
    padding: "6px 8px",
    borderBottom: `1px solid ${t.border}`,
    verticalAlign: "middle",
  };
}
