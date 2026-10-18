// 远端团队知识库视图（QC-164 阶段 1 自 components/KnowledgeBase.tsx 纯搬移）。

import { CrownIcon, DownloadIcon, SearchIcon } from "../components/icons";
import type * as ReactNS from "react";

import {
  fetchKbDir,
  fetchKbFile,
  fetchKbGraph,
  fetchKbGraphMerged,
  fetchKbSearch,
  fetchKbTree,
  fetchTeamsStructure,
  type KbAgent,
  type KbDirItem,
  type KbFileItem,
  type KbSearchMatch,
  type WorkerTreeTeam,
} from "../api";
import MdText from "../components/MdText";
import { isQwenpawOnlyDisabled, RuntimeNotice } from "../runtimeGuard";
import { formatDateTime } from "../util";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { GraphCard } from "./GraphCard";
import { loadKbState, saveKbState } from "./persist";
import { DirNode, FileGroup, RefreshIcon, StatusChip } from "./parts";
import { useKbColHeight } from "./useKbColHeight";
import { KB_CARD_BODY_STYLE, KB_CARD_STYLE, KB_COL_STYLE, saveTextFile } from "./util";
import type { DirChild, GraphNodeLike, KbState, SelectedFile } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 远端（团队 Agent）分类配色。 */
const REMOTE_CAT_COLOR: Record<string, string> = {
  profile: "#FF7F16",
  soul: "#f5222d",
  agents: "#52c41a",
  memory: "#1677ff",
  other: "#8c8c8c",
  virtual: "#bfbfbf",
};

/** 聚合图谱按 Agent 着色的调色板（GraphCard 切片误删，补回）。 */
const AGENT_PALETTE = [
 "#FF7F16", "#1677ff", "#52c41a", "#f5222d", "#722ed1",
  "#fa8c16", "#13c2c2", "#eb2f96",
];

// ── 远端团队知识库视图（主视图）──────────────────────────────

export function RemoteKbView(props: {
  agents: KbAgent[];
  refreshTick: number;
}) {
  const { agents, refreshTick } = props;
  const t = useThemeColors();
  const tr = useT();
  // 选择记忆（只读一次，失效校验在初始化 effect 里做）。
  const kbStateRef = React.useRef<KbState>(loadKbState());
  const [agent, setAgent] = React.useState("");
  const [tree, setTree] = React.useState<{
    files: KbFileItem[];
    dirs: KbDirItem[];
    workspace: string;
  } | null>(null);
  const [graph, setGraph] = React.useState<{ nodes: GraphNodeLike[]; edges: { source: string; target: string; target_anchor?: string | null }[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [graphLoading, setGraphLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState<SelectedFile | null>(null);
  const [content, setContent] = React.useState("");
  const [contentLoading, setContentLoading] = React.useState(false);
  const [contentError, setContentError] = React.useState("");
  // 文件取回竞态守卫——慢请求的迟到响应（含其报错）不得覆盖新选择。
  const fileSeqRef = React.useRef(0);
  // 两栏全容器化：包裹 Row 的 ref + 量得的两栏高度（未测得 null → 回退旧 CSS 值）。
  const { setRowRef, colH } = useKbColHeight();
  // 图谱模式（当前 Agent / 团队聚合）
  // 记忆恢复（非法值回退 "agent"，loadKbState 已校验枚举）。
  const [graphMode, setGraphMode] = React.useState<
    "agent" | "merged"
  >(() => kbStateRef.current.graphMode ?? "agent");
  /** 聚合图谱团队化——聚合=当前团队内（非全部团队）。
 * kbTeams=团队→成员（teams/structure）；kbTeam=选中团队（""=全部，
 * 默认=当前 agent 所在团队，缺省第一个团队）。 */
  const [kbTeams, setKbTeams] = React.useState<WorkerTreeTeam[]>([]);
  // 记忆恢复（团队列表落地后校验存在性，失效回退默认）。
  const [kbTeam, setKbTeam] = React.useState(
    () => kbStateRef.current.team ?? "",
  );
  const [mergedGraph, setMergedGraph] = React.useState<{
    nodes: GraphNodeLike[];
    edges: { source: string; target: string; target_anchor?: string | null }[];
    agents: string[];
  } | null>(null);
  const [mergedLoading, setMergedLoading] = React.useState(false);
  // （旧疾：聚合图首载出非所选团队 worker，切 tab 才正常）：
  // 范围/竞态双轨状态——
  // mergedForRef=上一次**成功**落图的范围（agents csv；""=正确的空态）；
  // mergedGenRef=单飞代际——旧请求晚到不得覆盖新范围（切团队秒切场景）。
  const mergedForRef = React.useRef("");
  const mergedGenRef = React.useRef(0);
  // refreshTick 自动重拉节流：聚合图有 30s SWR 门，无需逐 SSE 事件重拉
  //（旧版每 tick 新对象引用 → GraphCanvas 全量重布局，「加载慢」的持续性
  // 观感之一）。
  const lastMergedFetchRef = React.useRef(0);
  // 团队知识搜索（跨 Worker）
  const [searchQ, setSearchQ] = React.useState("");
  const [searchBusy, setSearchBusy] = React.useState(false);
  const [searchResults, setSearchResults] = React.useState<
    KbSearchMatch[] | null
  >(null);
  // 目录懒加载（工作区子目录文件可见可开）
  const [dirCache, setDirCache] = React.useState<
    Record<string, DirChild | "loading">
  >({});
  const [expandedDirs, setExpandedDirs] = React.useState<
    Record<string, boolean>
  >({});

  // Agent 选项按所选「聚合团队」收敛
  //（团队记忆=sysdev-team 时不再列全量 worker）；"全部团队"=全量。
  // 记忆团队已设（如某团队），首帧却列出**全集群
  // 其他团队的 worker**，切换 tab 后再回来才收敛到所选团队。根因：
  // ① fetchTeamsStructure 旧版只在 graphMode==="merged" 的 effect 里调用
  // ——agent 模式下团队结构永不被拉 → kbTeams 恒空；
  // ② scopedAgents 旧版降级分支 `kbTeam && teamWorkerNames.length` 在
  // teams 未落地时落回 **全量 agents** → 首帧下拉=全集群列表（错）。
  // 修：teams 拉取挪到 mount 无条件（下方 effect）；scopedAgents 语义改为
  // 「kbTeam 非空但团队未落地 = 空列表（宁空勿错）」——teams 落地后
  // scopedAgents 变化会重新触发默认选择 effect，秒级收敛到记忆/leader。
  const scopedAgents = React.useMemo(() => {
    if (!kbTeam) return agents; // 「全部团队」= 全量（显式选择）
    const t = kbTeams.find((x) => x.team_name === kbTeam);
    if (!t) return []; // 记忆团队未落地/失效 → 不展示全量（防错列表）
    const names = (t.workers || []).map((w) => w.worker_name).filter(Boolean);
    return agents.filter((a) => names.includes(a.name));
  }, [agents, kbTeam, kbTeams]);

  // 默认选第一个 leader（无则首个 worker）。
  // 优先恢复记忆的 Worker（仍在列表中才用，失效回退默认）。
  // 校验范围改用 scopedAgents（kbTeam 非空时
  // 已收敛到所选团队），语义不变——记忆优先，失效回退 leader/首个。
  React.useEffect(() => {
    if (!agent && scopedAgents.length > 0) {
      const saved = kbStateRef.current.agent;
      const savedOk = saved
        ? scopedAgents.find((a) => a.name === saved)
        : undefined;
      const lead =
        savedOk ||
        scopedAgents.find((a) => a.role === "leader") ||
        scopedAgents[0];
      setAgent(lead.name);
    }
  }, [scopedAgents, agent]);

  // 团队切换后当前 Agent 不在范围内 → 收敛到
  // 该团队 leader（无则首个）；记忆值若在范围内则保留（现有恢复逻辑已保证）。
  React.useEffect(() => {
    if (!kbTeam || scopedAgents.length === 0) return;
    if (scopedAgents.some((a) => a.name === agent)) return;
    const lead =
      scopedAgents.find((a) => a.role === "leader") || scopedAgents[0];
    if (lead && lead.name !== agent) setAgent(lead.name);
  }, [kbTeam, scopedAgents, agent]);

  // 记忆持久化（worker/团队/图谱模式三态）。
  React.useEffect(() => {
    if (agent) saveKbState(agent, kbTeam, graphMode);
  }, [agent, kbTeam, graphMode]);

  // 选中 Agent 非 qwenpaw → 知识文件视图降级
  // 空态 + 说明（workspace-files 是 QwenPaw 独有面；controller 透传
  // runtime，旧 controller 无字段 = undefined 放行不误伤）。
  const kbGated = React.useMemo(() => {
    const info = agents.find((a) => a.name === agent);
    return isQwenpawOnlyDisabled(info?.runtime);
  }, [agents, agent]);

  const loadAll = React.useCallback(
    (silent = false) => {
      if (!agent) return;
      if (kbGated) {
        // 降级空态：不发起文件/图谱拨号（对齐 dashboard B2 数据源级过滤）。
        setTree(null);
        setGraph(null);
        setError("");
        setLoading(false);
        setGraphLoading(false);
        return;
      }
      if (!silent) {
        setLoading(true);
        setGraphLoading(true);
      }
      setError("");
      void (async () => {
        const [trRes, gRes] = await Promise.allSettled([
          fetchKbTree(agent),
          fetchKbGraph(agent),
        ]);
        if (trRes.status === "fulfilled") {
          setTree({
            files: trRes.value.files,
            dirs: trRes.value.dirs || [],
            workspace: trRes.value.workspace,
          });
        } else {
          setError(trRes.reason instanceof Error ? trRes.reason.message : String(trRes.reason));
          setTree(null);
        }
        if (gRes.status === "fulfilled") {
          setGraph({ nodes: gRes.value.nodes, edges: gRes.value.edges });
        } else {
          setGraph(null);
        }
        setLoading(false);
        setGraphLoading(false);
      })();
    },
    [agent, kbGated],
  );

  React.useEffect(() => {
    setTree(null);
    setGraph(null);
    setSelected(null);
    setContent("");
    setContentError("");
    setDirCache({});
    setExpandedDirs({});
    void loadAll();
  }, [agent, loadAll]);

  // 目录展开=懒加载一级（kb/{a}/ls）；收起不缓存清理（再展开免费）。
  const toggleDir = React.useCallback(
    (d: KbDirItem) => {
      const willExpand = !expandedDirs[d.path];
      setExpandedDirs((m) => ({ ...m, [d.path]: willExpand }));
      if (willExpand && !(d.path in dirCache)) {
        setDirCache((m) => ({ ...m, [d.path]: "loading" }));
        fetchKbDir(agent, d.path)
          .then((r) =>
            setDirCache((m) => ({
              ...m,
              [d.path]: { files: r.files, dirs: r.dirs },
            })),
          )
          .catch((e) => {
            setDirCache((m) => {
              const n = { ...m };
              delete n[d.path];
              return n;
            });
            antd.message.error(
              e instanceof Error ? e.message : String(e),
            );
          });
      }
    },
    [agent, dirCache, expandedDirs],
  );

  // 切 tab 刷新（rc-tabs 保活）。
  // 聚合图重拉加双门——① teams 未落地禁止拉（防无参
  // 全集群拉取竞态）② 30s 节流（聚合图后端有 30s SWR 门，逐 SSE tick
  // 重拉=纯浪费+全量重布局）。
  React.useEffect(() => {
    if (refreshTick > 0 && agent) void loadAll(true);
    if (
      graphMode === "merged" &&
      kbTeams.length > 0 &&
      Date.now() - lastMergedFetchRef.current > 30000
    ) {
      void loadMerged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // 团队结构**无条件 mount 拉取**——
  // 旧版只在 merged 模式拉，agent 模式下 kbTeams 恒空 → 下拉错列全集群
  // （根因见 scopedAgents 注释）。拉取与图谱模式解耦：
  // - agent 模式：收敛 agent 下拉范围（记忆团队 → 只列该团队 worker）；
  // - merged 模式：确定聚合范围。
  React.useEffect(() => {
    if (kbTeams.length > 0) return;
    void fetchTeamsStructure()
      .then((r) => {
        const tree = r.tree || [];
        setKbTeams(tree);
        setKbTeam((prev) => {
          // 记忆团队仍在团队列表 → 恢复；失效 → 走默认。
          if (prev && tree.some((t) => t.team_name === prev)) {
            return prev;
          }
          // 默认=当前 agent 所在团队；不在任何团队→第一个团队；空→""（全部）
          const home = tree.find((t) =>
            (t.workers || []).some((w) => w.worker_name === agent),
          );
          return (home || tree[0] || { team_name: "" }).team_name;
        });
      })
      .catch(() => setKbTeams([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 首次切到聚合模式时拉一次。
  // 不变式改为「显示范围==当前团队范围」——旧守卫
  // `!mergedGraph` 在错误范围（全集群）响应已落地时**永久挡住**正确重拉
  //（切 tab 重挂才复位=用户看到的「切 tab 才正常」）。mergedForRef 记录
  // 已落地范围，不一致即重拉（含错误范围自愈）。
  React.useEffect(() => {
    if (graphMode !== "merged") return;
    if (kbTeams.length === 0) return;
    const team = kbTeams.find((t) => t.team_name === kbTeam);
    const want = team
      ? (team.workers || []).map((w) => w.worker_name).filter(Boolean).join(",")
      : "";
    if (mergedForRef.current === want) return;
    if (mergedLoading) return;
    void loadMerged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphMode, kbTeams, kbTeam]);

  // 切换聚合团队 → 清旧图重拉（避免旧团队图谱残留显示）。
  React.useEffect(() => {
    if (graphMode === "merged" && kbTeams.length > 0) {
      setMergedGraph(null);
      void loadMerged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbTeam]);

  // agentOverride——跨 Agent 搜索结果点击直接打开目标 Agent 文件
  // （不等 setAgent 状态落地）。
  const openFile = React.useCallback(
    (path: string, agentOverride?: string) => {
      const a = agentOverride || agent;
      const title = path.split("/").pop() || path;
      // （左边文件树一点击就开、图谱基本不开）：不再
      // setAgent(agentOverride)。旧副作用「点图谱节点（聚合模式）切到目标
      // Agent」触发 [agent, loadAll] effect 的 setSelected(null)+
      // setContent("")，把刚发起的预览擦掉——fetch 回来时 selected 已 null，
      // 面板不渲染 = 点击无反应；文件树点击不带 override 故一直正常。
      // 取内容本就按 a=agentOverride 进行，无需切换 UI 当前 Agent（
      // 跨 Agent 搜索的原始意图就是「不等 setAgent 落地」）。
      setSelected({ section: "remote", filename: path, title });
      const seq = ++fileSeqRef.current;
      setContent("");
      setContentError("");
      setContentLoading(true);
      fetchKbFile(a, path)
        .then((f) => {
          if (fileSeqRef.current !== seq) return; // 迟到旧响应，丢弃
          setContent(f.content);
        })
        .catch((e) => {
          if (fileSeqRef.current !== seq) return;
          setContentError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (fileSeqRef.current !== seq) return;
          setContentLoading(false);
        });
    },
    [agent],
  );

  const openNode = React.useCallback(
    (node: GraphNodeLike) => {
      if (node.virtual) {
        antd.message.info(tr("该节点为虚拟根节点，不可打开"));
        return;
      }
      if (node.resolved === false) {
        antd.message.info(tr("未解析引用（对应文件不存在）"));
        return;
      }
      // 聚合图谱 id = agent::path（跨 Agent 跳转）。
      const sep = node.id.indexOf("::");
      if (graphMode === "merged" && sep > 0) {
        openFile(node.id.slice(sep + 2), node.id.slice(0, sep));
      } else {
        openFile(node.id);
      }
    },
    [openFile, tr, graphMode],
  );

  // 团队聚合图谱（节点按 Agent 着色；边保留原 Agent 内）。
  // 团队化：按选中团队成员聚合（kbTeam=""→全部团队）。
  const loadMerged = React.useCallback(() => {
    const team = kbTeams.find((t) => t.team_name === kbTeam);
    const agents = team
      ? (team.workers || []).map((w) => w.worker_name).filter(Boolean).join(",")
      : "";
    if (!agents) {
      // 宁空勿错（与 scopedAgents 同款语义）：团队未落地/无 worker
      // 时**禁止**无参拉取——后端 agents 缺省=全集群，正是「首载出非所选
      // 团队 worker」的根因（旧版此路径被 refreshTick 在 teams 未落地时
      // 命中）。
      mergedForRef.current = "";
      setMergedGraph(null);
      return;
    }
    const gen = ++mergedGenRef.current;
    lastMergedFetchRef.current = Date.now();
    setMergedLoading(true);
    void fetchKbGraphMerged(agents)
      .then((g) => {
        if (gen !== mergedGenRef.current) return; // 晚到的旧范围请求丢弃
        mergedForRef.current = agents;
        setMergedGraph({ nodes: g.nodes as GraphNodeLike[], edges: g.edges, agents: g.agents });
      })
      .catch(() => {
        if (gen !== mergedGenRef.current) return;
        mergedForRef.current = "";
        setMergedGraph(null);
      })
      .finally(() => {
        if (gen === mergedGenRef.current) setMergedLoading(false);
      });
  }, [kbTeams, kbTeam]);

  // 团队知识搜索（跨 Worker，后端并发扫各 Agent 知识文件）。
  const runSearch = React.useCallback((q: string) => {
    const term = q.trim();
    setSearchQ(term);
    if (!term) {
      setSearchResults(null);
      return;
    }
    setSearchBusy(true);
    void fetchKbSearch(term)
      .then((r) => setSearchResults(r.matches))
      .catch((e) =>
        antd.message.error(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSearchBusy(false));
  }, []);

  // 四分类（用户要求对齐 QwenPaw 最新版文件管理：
  // 文件/档案/日记/知识库）——后端 tree 已带 category 字段。
  const groups = React.useMemo(() => {
    const files = tree?.files || [];
    const byCat = (c: string) =>
      files.filter((f) => (f.category || "file") === c);
    const profile = byCat("profile");
    const byDay = new Map<string, KbFileItem[]>();
    for (const f of byCat("daily")) {
      // memory/YYYY-MM-DD/x.md → YYYY-MM-DD；memory/x.md → 顶层
      const parts = f.path.split("/").filter(Boolean);
      const seg = parts.length >= 3 ? (parts[1] || "other") : "top";
      const arr = byDay.get(seg) || [];
      arr.push(f);
      byDay.set(seg, arr);
    }
    const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const bySeg = new Map<string, KbFileItem[]>();
    for (const f of byCat("digest")) {
      // digest/personal|x.md → 段名；digest/x.md → 顶层
      const parts = f.path.split("/").filter(Boolean);
      const seg =
        parts.length >= 3 ? (parts[1] || "other").toLowerCase() : "top";
      const arr = bySeg.get(seg) || [];
      arr.push(f);
      bySeg.set(seg, arr);
    }
    const segs = [...bySeg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const otherFiles = byCat("file");
    return { profile, days, segs, otherFiles, dirs: tree?.dirs || [] };
  }, [tree]);

  const latestMtime = React.useMemo(() => {
    const files = tree?.files || [];
    let m = 0;
    for (const f of files) if (f.mtime > m) m = f.mtime;
    return m;
  }, [tree]);

  const agentInfo = agents.find((a) => a.name === agent);

  // 聚合（merged）模式传给
  // GraphCard 的 graph 对象旧实现在 JSX 里内联新建（每次 render 新引用）
  // → 子组件 layout/agentLegend 等 useMemo 反复重算（毛球布局 O(n²) 级别），
  // 且曾连带「点节点高亮闪一下」（见 GraphCard 内 effect 注释）。
  // memo 化：仅当 mergedGraph/graphMode 真变才换引用。
  const mergedGraphProp = React.useMemo(
    () =>
      mergedGraph
        ? { nodes: mergedGraph.nodes, edges: mergedGraph.edges }
        : null,
    [mergedGraph],
  );
  const mergedAgentLegend = React.useMemo(
    () =>
      mergedGraph
        ? (mergedGraph.agents || []).map((a, i) => ({
            name: a,
            color: AGENT_PALETTE[i % AGENT_PALETTE.length],
          }))
        : null,
    [mergedGraph],
  );

  return (
    <antd.Space direction="vertical" size={12} style={{ width: "100%" }}>
      {/* Agent 选择 + 状态行 */}
      <antd.Card
        size="small"
        title={
          <span style={{ fontSize: 13 }}>
            {tr("团队 Agent")}
            <antd.Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {tr("远端 · Controller Docker API 直读容器工作区（只读）")}
            </antd.Typography.Text>
          </span>
        }
        extra={
          <antd.Button size="small" icon={<RefreshIcon />} onClick={() => void loadAll()}>
            {tr("刷新")}
          </antd.Button>
        }
      >
        <antd.Space size={14} wrap>
          <antd.Select
            style={{ minWidth: 240 }}
            value={agent || undefined}
            placeholder={tr("选择 Agent")}
            onChange={(v: string) => setAgent(v)}
 // 选项按所选团队收敛。
            options={agentSelectOptions(scopedAgents, tr)}
          />
          {agentInfo ? (
            <>
              <StatusChip
                label={tr("角色")}
                value={
                  agentInfo.kind === "manager"
                    ? "Manager"
                    : agentInfo.role === "leader"
                      ? tr("Leader")
                      : agentInfo.role === "critic"
                        ? tr("评审")
                        : tr("Worker")
                }
                ok
              />
              {agentInfo.team ? (
                <StatusChip label={tr("团队")} value={agentInfo.team} ok />
              ) : null}
              <StatusChip
                label={tr("容器")}
                value={agentInfo.state || "—"}
                ok={agentInfo.state === "running"}
              />
            </>
          ) : null}
        </antd.Space>
        <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <StatusChip
            label={tr("知识文件")}
            value={String(tree?.files.length ?? 0)}
            ok
          />
          {latestMtime ? (
            <StatusChip
              label={tr("最近更新")}
              value={formatDateTime(latestMtime * 1000)}
              ok
            />
          ) : null}
          {tree ? (
            <antd.Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {tr("工作区")}：
              <antd.Typography.Text code style={{ fontSize: 11 }}>
                {tree.workspace}
              </antd.Typography.Text>
            </antd.Typography.Text>
          ) : null}
        </div>
      </antd.Card>

      {/* 图谱模式 + 团队知识搜索 */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <antd.Segmented
          size="small"
          value={graphMode}
          onChange={(v: unknown) => setGraphMode(v as "agent" | "merged")}
          options={[
            { value: "agent", label: tr("当前 Agent 图谱") },
            { value: "merged", label: tr("团队聚合图谱") },
          ]}
        />
        {/* 聚合范围=选中团队（默认当前 agent 所在团队；可切"全部"） */}
        {graphMode === "merged" && kbTeams.length > 0 ? (
          <antd.Select
            size="small"
            style={{ minWidth: 160 }}
            value={kbTeam || undefined}
            placeholder={tr("聚合团队")}
            onChange={(v: string) => setKbTeam(v)}
            options={[
              ...kbTeams.map((t) => ({ value: t.team_name, label: t.team_name })),
              { value: "", label: tr("全部团队") },
            ]}
          />
        ) : null}
        <div style={{ flex: 1 }} />
        <antd.Input
          size="small"
          allowClear
          style={{ width: 280 }}
          placeholder={tr("搜索团队知识（跨 Worker）…")}
          value={searchQ}
          onChange={(e: { target: { value: string } }) => setSearchQ(e.target.value)}
          onPressEnter={() => runSearch(searchQ)}
          prefix={<SearchIcon size={12} />}
          suffix={searchBusy ? <antd.Spin size="small" /> : null}
        />
      </div>

      {/* 搜索结果显示（点击=切到该 Agent 并打开文件） */}
      {searchResults !== null ? (
        <antd.Card
          size="small"
          title={
            <span style={{ fontSize: 13 }}>
              {tr("团队知识搜索")}
              {searchResults.length
                ? tr("（匹配 {count} 条）", { count: searchResults.length })
                : ""}
            </span>
          }
        >
          {searchResults.length === 0 ? (
            <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {tr("无搜索结果")}
            </antd.Typography.Text>
          ) : (
            <div style={{ display: "grid", gap: 6, maxHeight: 260, overflow: "auto" }}>
              {searchResults.map((m, i) => (
                <div
                  key={`${m.agent}-${m.path}-${m.line}-${i}`}
                  onClick={() => openFile(m.path, m.agent)}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: t.hoverBg,
                    cursor: "pointer",
                  }}
                >
                  <antd.Tag color="orange" style={{ margin: 0, flexShrink: 0 }}>
                    {m.agent}
                  </antd.Tag>
                  <span style={{ fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>
                    {m.path}:{m.line}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.snippet}
                  </span>
                </div>
              ))}
            </div>
          )}
        </antd.Card>
      ) : null}

      {/* 图谱（可切团队聚合，节点按 Agent 着色）
 merged graph/legend 用 memo 稳定引用。 */}
      <GraphCard
        graph={
          graphMode === "merged" && mergedGraphProp
            ? mergedGraphProp
            : graph
        }
        loading={graphMode === "merged" ? mergedLoading : graphLoading}
        error=""
        onOpenNode={openNode}
        agentLegend={
          graphMode === "merged" ? mergedAgentLegend : null
        }
      />

      {/* 文件浏览 + 预览 */}
      {error ? (
        <antd.Alert type="error" showIcon message={error} />
      ) : null}
      <div ref={setRowRef} style={{ width: "100%" }}>
        <antd.Row gutter={12}>
          <antd.Col span={10} style={{ ...KB_COL_STYLE, height: colH ?? KB_COL_STYLE.height }}>
            <antd.Card size="small" style={KB_CARD_STYLE} styles={{ body: KB_CARD_BODY_STYLE }} title={<span style={{ fontSize: 13 }}>{tr("知识文件")}</span>}>
              {kbGated ? (
                // 非 qwenpaw Agent → 降级空态 + 说明。
                <div style={{ padding: 16 }}>
                  <RuntimeNotice runtime={agentInfo?.runtime} />
                  <antd.Empty
                    image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                    description={tr(
                      "知识文件视图仅支持 QwenPaw 运行时的 Agent（当前：{rt}）",
                      { rt: agentInfo?.runtime || "—" },
                    )}
                    style={{ margin: "24px 0" }}
                  />
                </div>
              ) : (
              <antd.Spin spinning={loading}>
                <FileGroup
                  title={tr("档案（工作区核心文件）")}
                  color={REMOTE_CAT_COLOR.profile}
                  files={groups.profile}
                  selected={selected}
                  onSelect={(k) => openFile(k)}
                />
                {groups.days.map(([day, files]) => (
                  <FileGroup
                    key={`daily-${day}`}
                    title={tr("日记 · {d}", { d: day === "top" ? tr("顶层") : day })}
                    color={REMOTE_CAT_COLOR.memory}
                    files={files}
                    selected={selected}
                    onSelect={(k) => openFile(k)}
                    limit={80}
                  />
                ))}
                {groups.segs.map(([seg, files]) => (
                  <FileGroup
                    key={`digest-${seg}`}
                    title={tr("知识库 · {s}", { s: seg === "top" ? tr("顶层") : seg })}
                    color="#722ed1"
                    files={files}
                    selected={selected}
                    onSelect={(k) => openFile(k)}
                  />
                ))}
                <FileGroup
                  title={tr("文件（工作区其他）")}
                  color={REMOTE_CAT_COLOR.other}
                  files={groups.otherFiles}
                  selected={selected}
                  onSelect={(k) => openFile(k)}
                  limit={40}
                />
                {groups.dirs.length > 0 ? (
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
                          background: REMOTE_CAT_COLOR.other,
                          display: "inline-block",
                        }}
                      />
                      {tr("工作区目录（点文件夹展开）")}
                      <span style={{ fontWeight: 400 }}>
                        ({groups.dirs.length})
                      </span>
                    </div>
                    {groups.dirs.map((d) => (
                      <DirNode
                        key={d.path}
                        dir={d}
                        depth={0}
                        expanded={expandedDirs}
                        cache={dirCache}
                        onToggle={(dd) => void toggleDir(dd)}
                        onOpenFile={(p) => openFile(p)}
                        selected={selected}
                      />
                    ))}
                  </div>
                ) : null}
                {tree && tree.files.length === 0 ? (
                  <antd.Empty
                    image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                    description={tr("该 Agent 暂无知识文件（工作区可能未初始化）")}
                    style={{ margin: "30px 0" }}
                  />
                ) : null}
              </antd.Spin>
              )}
            </antd.Card>
          </antd.Col>
          <antd.Col span={14} style={{ ...KB_COL_STYLE, height: colH ?? KB_COL_STYLE.height }}>
            <antd.Card
              size="small"
              style={KB_CARD_STYLE}
              styles={{ body: KB_CARD_BODY_STYLE }}
              title={
                <span style={{ fontSize: 13 }}>
                  {selected ? selected.title : tr("预览")}
                </span>
              }
              extra={
                selected && !contentLoading && !contentError && content
                  ? (
                    <antd.Button
                      size="small"
                      onClick={() =>
                        saveTextFile(selected.title, content)
                      }
                    >
                      <DownloadIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("下载")}
                    </antd.Button>
                  )
                  : null
              }
            >
              {contentLoading ? (
                <antd.Spin style={{ display: "block", margin: "40px auto" }} />
              ) : contentError ? (
                <antd.Alert type="error" showIcon message={contentError} />
              ) : content ? (
                <div
                  style={{
                    maxHeight: "none",
                    overflow: "auto",
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: t.text,
                  }}
                >
                  <MdText text={content} maxLength={100000} />
                </div>
              ) : (
                <antd.Empty
                  image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
                  description={tr("点击左侧文件查看内容")}
                  style={{ margin: "40px 0" }}
                />
              )}
            </antd.Card>
          </antd.Col>
        </antd.Row>
      </div>
    </antd.Space>
  );
}

/** Agent 选择器分组：Manager 单列 + 各团队（Leader 在前）。 */
function agentSelectOptions(
  agents: KbAgent[],
  tr: (key: string, vars?: Record<string, string | number>) => string,
) {
  const managers = agents.filter((a) => a.kind === "manager");
  const byTeam = new Map<string, KbAgent[]>();
  for (const a of agents.filter((x) => x.kind === "worker")) {
    const team = a.team || tr("未分组");
    const arr = byTeam.get(team) || [];
    arr.push(a);
    byTeam.set(team, arr);
  }
  const roleOrder = { leader: 0, worker: 1, critic: 2 };
  const opts: { value: string; label: ReactNS.ReactNode; options?: { value: string; label: ReactNS.ReactNode }[] }[] = [];
  if (managers.length > 0) {
    opts.push({
      value: "manager",
      label: "Manager",
      options: managers.map((a) => ({
        value: a.name,
        label: `Manager · ${a.name}`,
      })),
    });
  }
  for (const [team, ws] of [...byTeam.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    ws.sort(
      (x, y) =>
        (roleOrder[x.role || "worker"] ?? 3) - (roleOrder[y.role || "worker"] ?? 3) ||
        x.name.localeCompare(y.name),
    );
    opts.push({
      value: `team-${team}`,
      label: team,
      options: ws.map((a) => ({
        value: a.name,
        label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{a.role === "leader" ? <CrownIcon size={11} style={{ color: "#faad14" }} /> : null}{a.name}</span>,
      })),
    });
  }
  return opts;
}
