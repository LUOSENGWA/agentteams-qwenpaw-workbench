/**
 * 🧩 技能中心（v0.5.0-beta.12，技能中心与 MCP 实施方案 v0.1）。
 *
 * 三节（L1 admin 视角，插件以 admin token 操作 Controller）：
 * ① 技能目录（#1268 已合 main）——GET /api/v1/skills，
 * Controller < 合并版本（如 v1.2.3 验证实盘）→ 404 → 占位卡；升级后自动点亮。
 * 契约：{skills:[{name,description?,source,agents?}],total}。
 * ② Worker 技能分配矩阵（P1，v1.2.3 立即可用）——行=Worker，
 * 列=技能（目录可用=目录 ∪ 已分配；否则=已分配并集）。
 * 勾选 → PUT /workers/{name} {skills:[...]}（整字段替换语义）。
 * L2 无权限（L2 白名单外）→ 403 → 明确 toast
 * （P3 的角色反馈自动生效，前端无需写死角色判断）。
 * ③ MCP Servers（P1）——行=Worker，行内编辑 mcpServers。
 * 契约 = Go MCPServer {name,url,transport?}（transport: http 默认|sse；
 * authType 不存在——别加回来）。
 *
 * 频道接入不在本组件：调研结论放「👷 团队管理」→「频道」tab
 * （WorkerChannels.tsx，上游契约，404=版本门）。
 *
 * 原「🎯 技能」tab 更名「宿主技能」（host agent 技能管理，本插件
 * 专用，与团队技能矩阵不同维度）。
 */
import { BoltIcon, CloseIcon } from "./icons";
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  type WorkerInfo,
  type TeamInfo,
  type McpServerInfo,
  type SkillCatalogItem,
  type WorkerRuntimeSkill,
  fetchAdminData,
  fetchL2AdminData,
  updateWorker,
  fetchSkillCatalog,
  fetchWorkerSkills,
  setWorkerSkillPreload,
  httpErrorStatus,
  // v0.5.0-beta.13.19（13.18 装验「技能上传呢」）：团队技能包上传
  // （POST /api/v1/skills，multipart zip；经连接器 multipart 透传）。
  uploadTeamSkill,
} from "../api";
import { strToU8, zipSync } from "fflate";

/** v0.5.0-beta.13.15（B5a 矩阵按团队分类）：Worker 行按 team 分组
 * （保持原始相对序；无 team 的归「未分组」殿后）。 */
function groupWorkersByTeam(
  workers: WorkerInfo[],
): { team: string; workers: WorkerInfo[] }[] {
  const order: string[] = [];
  const m = new Map<string, WorkerInfo[]>();
  for (const w of workers) {
    const key = w.team || "\u0000";
    if (!m.has(key)) {
      m.set(key, []);
      order.push(key);
    }
    m.get(key)!.push(w);
  }
  // 未分组殿后（稳定：先分组、组内原序）。
  order.sort((a, b) => {
    if (a === "\u0000") return 1;
    if (b === "\u0000") return -1;
    return 0;
  });
  return order.map((team) => ({
    team: team === "\u0000" ? "" : team,
    workers: m.get(team)!,
  }));
}

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface MatrixState {
  workers: WorkerInfo[];
  loading: boolean;
  catalog: SkillCatalogItem[] | null | undefined; // null=加载中；[]=已加载空；undefined=404 不可用
  catalogNote: string; // 404 时的说明
}

/**
 * v0.5.0-beta.13.14（L2 双模式——9/11 调研 P0 定案 + 上游设计文档
 * docs/design/l2-worker-scoped-write.md（#1274 已合）+ team-skills.md +
 * skill-catalog-api.md 已合 main）：
 *   l2=true → Matrix 身份（无 admin token）：
 *     ① 目录 = GET /skills?team=<本团队>（Controller 按 accessibleTeams
 *        scope；cross-team → 404 反探测）；
 *     ② 矩阵 = L2 scoped workers（standalone 隐藏）+ PUT {skills} 可写
 *        （白名单唯一字段；remoteSkills/mcpServers 400 待 elevated
 *        capability 设计）；
 *     ③ MCP = 只读（写权限同上待设计）。
 *   铁律（9/11 P0）：L2 路径不走 admin token——代理链在 router.py
 *   catch-all 已实现（admin token 空 → Matrix access_token）。
 */
export default function SkillCenter({
  l2 = false,
  onlyWorker,
  onlyTeam,
  sections,
}: {
  l2?: boolean;
  /** v0.5.0-beta.13.16（13.15 装验「技能中心和 MCP 完全和 worker 拓扑合并」）：
   *  限定单 Worker——矩阵只渲染该 Worker 行（自动展开编辑区）、MCP 卡只
   *  渲染该 Worker 行、隐藏页面题头。无此 prop 时行为与既有全量视图完全一致。 */
  onlyWorker?: string;
  /** v0.5.0-beta.13.21（13.20 装验「团队的技能等团队配置要放在团队配置里，
   *  和技能中心一样的搜索/上传/自定义，worker 也是」）：限定单团队——
   *  目录按 ?team= 取（L1 任意团队/L2 本团队）、矩阵/MCP 只渲染该团队
   *  Worker、上传 scope 固定该团队（选择器隐藏）。团队配置弹窗（齿轮）
   *  嵌入用；与 onlyWorker 可组合。 */
  onlyTeam?: string;
  /** 模块裁剪：默认全渲染（目录①+矩阵②+MCP③）；拓扑嵌入按需（如
   *  ["matrix"] 只出可编辑技能矩阵 / ["mcp"] 只出可编辑 MCP 卡）。 */
  sections?: ReadonlyArray<"catalog" | "matrix" | "mcp">;
}) {
  const t = useThemeColors();
  const tr = useT();
  const showCatalog = !sections || sections.includes("catalog");
  const showMatrix = !sections || sections.includes("matrix");
  const showMcp = !sections || sections.includes("mcp");
  const [st, setSt] = React.useState<MatrixState>({
    workers: [],
    loading: true,
    catalog: null,
    catalogNote: "",
  });
  // v0.5.0-beta.13.14：L2 团队选择（accessibleTeams 单团队自动；多团队显选择器）。
  const [l2Teams, setL2Teams] = React.useState<TeamInfo[]>([]);
  const [l2Team, setL2Team] = React.useState("");
  // v0.5.0-beta.13.19：技能包上传/自定义新建/下载（技能目录卡动作）。
  const [upOpen, setUpOpen] = React.useState(false);
  const [upMode, setUpMode] = React.useState<"zip" | "new">("zip");
  const [upTeam, setUpTeam] = React.useState("");
  const [upFile, setUpFile] = React.useState<File | null>(null);
  const [upName, setUpName] = React.useState("");
  const [upDesc, setUpDesc] = React.useState("");
  const [upBody, setUpBody] = React.useState("");
  const [upBusy, setUpBusy] = React.useState(false);
  const [matrix, setMatrix] = React.useState<Record<string, string[]>>({});
  // v0.5.0-beta.13.14：服务端基线（脏检测用——矩阵相对基线有改动才显「保存」）。
  const [baseMatrix, setBaseMatrix] = React.useState<Record<string, string[]>>({});
  // v0.5.0-beta.13.14：单 Worker 展开态（一次只展开一个，面板恒紧凑）。
  // v0.5.0-beta.13.16：拓扑嵌入（onlyWorker）→ 默认展开该 Worker 编辑区。
  const [expandedWorker, setExpandedWorker] = React.useState<string | null>(
    onlyWorker ?? null,
  );
  // v0.5.0-beta.13.15（B6 双层技能真相）：物化层（runtime /api/skills，
  // 实际能调用什么）懒加载——展开哪个 Worker 拉哪个（N+1 只在展开时发生，
  // 矩阵首屏零额外请求）。null=未加载；"loading"=拉取中；"err"=404/403
  // 版本门或权限门（显示占位不炸）；数组=已加载。
  const [matByWorker, setMatByWorker] = React.useState<
    Record<string, WorkerRuntimeSkill[] | "loading" | "err" | null>
  >({});
  React.useEffect(() => {
    if (!expandedWorker) return;
    const cur = matByWorker[expandedWorker];
    if (cur !== undefined && cur !== null) return; // 已加载/拉取中/已判错
    setMatByWorker((prev) =>
      prev[expandedWorker] === undefined ? { ...prev, [expandedWorker]: "loading" } : prev,
    );
    let dead = false;
    void fetchWorkerSkills(expandedWorker)
      .then((list) => {
        if (dead) return;
        setMatByWorker((prev) => ({ ...prev, [expandedWorker]: list || [] }));
      })
      .catch(() => {
        if (dead) return;
        setMatByWorker((prev) => ({ ...prev, [expandedWorker]: "err" }));
      });
    return () => {
      dead = true;
    };
    // matByWorker 不入 deps（cur 判断用函数式 setState 兜底竞态）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedWorker]);
  // v0.5.0-beta.13.20（「技能不仅有团队技能，还有每 worker 技能」）：
  // 物化层 per-skill 预加载开关——PUT /workers/{name}/skills/{skill}/preload。
  // 语义：技能全文常驻该 Worker 每个 session 的 system prompt（QwenPaw
  // 2.2.1+ 的 always-on 能力，有 per-session token 成本；worker 侧验证 +
  // 持久化 skill.json + agent 热加载，无需重启）。写权限（上游
  // worker_skills.go）：L1 任意 worker；L2 human 限自己团队（拓扑可见性
  // 天然同域）；team leader 只读 → 403 toast。404 = worker 无此技能 /
  // 其 qwenpaw < 2.2.1 版本门 / L2 跨团队防探测；502 = worker 不可达。
  const [preloadBusy, setPreloadBusy] = React.useState<Record<string, boolean>>({});
  const togglePreload = React.useCallback(
    async (workerName: string, s: WorkerRuntimeSkill, next: boolean) => {
      const key = `${workerName}::${s.name}`;
      setPreloadBusy((p) => ({ ...p, [key]: true }));
      try {
        await setWorkerSkillPreload(workerName, s.name, next);
        // 乐观落本地物化层（成功即生效；失败不改动、可再试）。
        setMatByWorker((prev) => {
          const cur = prev[workerName];
          if (!Array.isArray(cur)) return prev;
          return {
            ...prev,
            [workerName]: cur.map((x) =>
              x.name === s.name ? { ...x, preload: next } : x,
            ),
          };
        });
        antd.message.success(
          next
            ? tr("已开启 {skill} 预加载（常驻 system prompt）", { skill: s.name })
            : tr("已关闭 {skill} 预加载", { skill: s.name }),
        );
      } catch (e) {
        const code = httpErrorStatus(e);
        if (code === 403) {
          antd.message.warning(
            tr("无权限调整该 Worker 技能预加载（当前身份只读——团队 Leader 只读 / L2 跨团队被拒）"),
          );
        } else if (code === 404) {
          antd.message.warning(
            tr("预加载不可用（Worker 未装载该技能，或其 QwenPaw < 2.2.1 无 preload 端点）"),
          );
        } else if (code === 502) {
          antd.message.warning(tr("Worker 技能服务不可达（Worker 未运行？）"));
        } else {
          antd.message.error(
            e instanceof Error ? e.message : tr("预加载调整失败"),
          );
        }
      } finally {
        setPreloadBusy((p) => {
          const n = { ...p };
          delete n[key];
          return n;
        });
      }
    },
    [tr],
  );
  const [mcpMap, setMcpMap] = React.useState<Record<string, McpServerInfo[]>>({});
  const [savingRow, setSavingRow] = React.useState("");
  const [mcpEditWorker, setMcpEditWorker] = React.useState("");
  const [mcpDraft, setMcpDraft] = React.useState<McpServerInfo[]>([]);
  const [mcpSaving, setMcpSaving] = React.useState(false);
  const [catalogSearch, setCatalogSearch] = React.useState("");
  // v0.5.0-beta.12  防刷屏（用户报告「技能中心刷屏」）：MCP 空行默认收起。
  const [showAllMcp, setShowAllMcp] = React.useState(false);
  const mcpWithCount = React.useMemo(
    () => st.workers.filter((w) => (mcpMap[w.name] || []).length).length,
    [st.workers, mcpMap],
  );
  // v0.5.0-beta.13.21：onlyWorker/onlyTeam 作用域过滤（两者可组合）。
  const scopeWorker = React.useCallback(
    (w: WorkerInfo) =>
      (!onlyWorker || w.name === onlyWorker) &&
      (!onlyTeam || w.team === onlyTeam),
    [onlyWorker, onlyTeam],
  );
  const mcpVisible = React.useMemo(() => {
    // v0.5.0-beta.13.16：拓扑嵌入（onlyWorker）→ 只出该 Worker 行，且
    // **无条件出**（无 MCP 时行内走「无 MCP」文案——全局「隐藏无 MCP
    // Worker」折叠开关在嵌入态无意义，不能把目标行滤成空白卡）。
    if (onlyWorker || onlyTeam) return st.workers.filter(scopeWorker);
    return mcpWithCount === 0 || showAllMcp
      ? st.workers
      : st.workers.filter((w) => (mcpMap[w.name] || []).length);
  }, [st.workers, mcpMap, mcpWithCount, showAllMcp, onlyWorker, onlyTeam, scopeWorker]);
  // v0.5.0-beta.13.16：拓扑嵌入 = 单 Worker 视图（矩阵卡组头/其他行不出）。
  const workersView = React.useMemo(
    () => (onlyWorker || onlyTeam ? st.workers.filter(scopeWorker) : st.workers),
    [st.workers, onlyWorker, onlyTeam, scopeWorker],
  );


  const loadWorkers = React.useCallback(async () => {
    try {
      // v0.5.0-beta.13.14：L2 用宽松取数（humans/managers 403 置空不炸）。
      const admin = l2 ? await fetchL2AdminData() : await fetchAdminData();
      const workers = admin.workers;
      const m: Record<string, string[]> = {};
      const mm: Record<string, McpServerInfo[]> = {};
      for (const w of workers) {
        m[w.name] = [...(w.skills || [])];
        mm[w.name] = [...(w.mcpServers || [])];
      }
      setMatrix(m);
      setBaseMatrix(m);
      setMcpMap(mm);
      if (l2) {
        const teams = admin.teams;
        setL2Teams(teams);
        // 单团队自动选中；多团队保持/重置选择（切团队 → loadCatalog 重拉）。
        setL2Team((prev) => {
          if (teams.length === 1) return teams[0]?.name || "";
          if (prev && teams.some((tm) => tm.name === prev)) return prev;
          return teams[0]?.name || "";
        });
      }
      setSt((prev) => ({ ...prev, workers, loading: false }));
    } catch (e) {
      setSt((prev) => ({
        ...prev,
        loading: false,
        catalogNote: tr("Worker 列表加载失败：{m}", {
          m: e instanceof Error ? e.message : "?",
        }),
      }));
    }
  }, [l2, tr]);

  // 技能目录（#1268 已合 main——旧 Controller 404 降级占位，不阻塞其余各节）。
  // v0.5.0-beta.13.14：L2 带 ?team=（skill-catalog-api.md W8 反探测契约）。
  const loadCatalog = React.useCallback(async () => {
    try {
      // v0.5.0-beta.13.21：onlyTeam 优先（L1 团队配置弹窗按 ?team= 取该团队目录）。
      const cat = await fetchSkillCatalog(
        onlyTeam || (l2 ? l2Team || undefined : undefined),
      );
      setSt((prev) => ({ ...prev, catalog: cat }));
    } catch (e) {
      const s = httpErrorStatus(e);
      setSt((prev) => ({
        ...prev,
        catalog: undefined,
        catalogNote:
          s === 404
            ? l2
              ? tr("团队技能目录不可用（Controller 待升级或团队无技能）")
              : tr("技能目录 API 待上游合并——合并并升级后本节自动点亮")
            : tr("技能目录加载失败：{m}", {
                m: e instanceof Error ? e.message : "?",
              }),
      }));
    }
  }, [l2, l2Team, onlyTeam, tr]);

  React.useEffect(() => {
    void loadWorkers();
  }, [loadWorkers]);

  React.useEffect(() => {
    // L2：团队名未定前不发请求（避免无 ?team= 的 L2 调用 403 闪烁）。
    // v0.5.0-beta.13.21：onlyTeam 已定团队 → 无需等 l2Team 选择。
    if (l2 && !onlyTeam && !l2Team) return;
    void loadCatalog();
  }, [loadCatalog, l2, l2Team, onlyTeam]);

  // v0.5.0-beta.13.19（13.18 装验「自定义技能和技能上传和下载呢」）：
  // 技能包上传 / 自定义新建 / 下载（技能目录卡动作）。
  //   上传 = 选择本地 zip → POST /api/v1/skills（scope=team+file）
  //   新建 = 名称/描述/正文 → 前端 fflate 打包 SKILL.md → 同一端点
  //   下载 = GET /api/v1/skills/{name}/download（上游 v1.2.4 尚无此端点 →
  //          404 时诚实提示，端点就位即自动可用）
  const teamChoices = React.useMemo(() => {
    // v0.5.0-beta.13.21：onlyTeam 固定上传 scope（选择器隐藏）。
    if (onlyTeam) return [onlyTeam];
    if (l2) return l2Teams.map((t) => t.name);
    const set = new Set<string>();
    st.workers.forEach((w) => {
      if (w.team) set.add(w.team);
    });
    return Array.from(set).sort();
  }, [l2, l2Teams, st.workers, onlyTeam]);
  React.useEffect(() => {
    if (upTeam && teamChoices.includes(upTeam)) return;
    const fallback = l2 ? l2Team || teamChoices[0] || "" : teamChoices[0] || "";
    if (fallback) setUpTeam(fallback);
  }, [teamChoices, l2, l2Team, upTeam]);
  const openUpload = React.useCallback((mode: "zip" | "new") => {
    setUpMode(mode);
    setUpOpen(true);
  }, []);
  const submitUpload = React.useCallback(async () => {
    if (!upTeam) {
      antd.message.warning(tr("请选择目标团队"));
      return;
    }
    let file: File | Blob;
    let filename: string;
    if (upMode === "zip") {
      if (!upFile) {
        antd.message.warning(tr("请选择技能 zip 包"));
        return;
      }
      file = upFile;
      filename = upFile.name;
    } else {
      const name = upName.trim();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        antd.message.warning(tr("技能名需小写字母/数字/连字符（≤64）"));
        return;
      }
      const md = `---\nname: ${name}\ndescription: ${upDesc.trim() || name}\n---\n\n${upBody.trim() || `# ${name}\n`}\n`;
      const zip = zipSync({ "SKILL.md": strToU8(md) });
      file = new Blob([zip], { type: "application/zip" });
      filename = `${name}.zip`;
    }
    setUpBusy(true);
    try {
      const r = await uploadTeamSkill({ team: upTeam, file, filename });
      if (!r.ok) {
        antd.message.error(
          r.detail || tr("上传失败（HTTP {s}）", { s: String(r.status) }),
        );
        return;
      }
      const scanNote =
        r.scan?.status === "pass"
          ? tr("扫描通过")
          : r.scan?.status === "warn"
            ? tr("扫描有警告")
            : r.scan?.status === "skipped"
              ? tr("扫描跳过")
              : "";
      antd.message.success(
        tr("已上传 {name}（{n} 文件{scan}）", {
          name: r.name || filename,
          n: String(r.files ?? "-"),
          scan: scanNote ? ` · ${scanNote}` : "",
        }),
      );
      setUpOpen(false);
      setUpFile(null);
      setUpName("");
      setUpDesc("");
      setUpBody("");
      void loadCatalog();
      void loadWorkers();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("上传失败"));
    } finally {
      setUpBusy(false);
    }
  }, [upTeam, upMode, upFile, upName, upDesc, upBody, tr, loadCatalog, loadWorkers]);
  const downloadSkill = React.useCallback(
    async (name: string) => {
      const host = window.QwenPaw?.host;
      if (!host || typeof host.fetch !== "function") return;
      // 团队层技能需带 ?team=（服务端同日录 scope 规则）；L1 全局视图不带。
      const q = l2 && l2Team ? `?team=${encodeURIComponent(l2Team)}` : "";
      try {
        const resp = await host.fetch(
          `/agentteams-proxy/controller/api/v1/skills/${encodeURIComponent(name)}/download${q}`,
        );
        if (resp.status === 404) {
          antd.message.info(
            tr("当前 Controller 版本不支持技能下载（上游端点待合并）"),
          );
          return;
        }
        if (!resp.ok) {
          antd.message.error(`HTTP ${resp.status}`);
          return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("下载失败"));
      }
    },
    [tr, l2, l2Team],
  );

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
        // v0.5.0-beta.13.14：服务端已接受 → 基线推进（脏标记消失）；
        // 失败不推进，dirty 保留可重试。
        setBaseMatrix((prev) => ({ ...prev, [worker]: [...(matrix[worker] || [])] }));
        antd.message.success(tr("{w} 的技能已保存", { w: worker }));
      } catch (e) {
        const s = httpErrorStatus(e);
        if (s === 403) {
          antd.message.error(
            tr("无权限修改该 Worker 的技能（当前角色被 Controller 拒绝；L2 自服务仅白名单字段）"),
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
    <div style={{ display: "grid", gap: onlyWorker ? 8 : 16 }}>
      {/* v0.5.0-beta.13.16：拓扑嵌入（onlyWorker）→ 页面题头不出（上下文中
          已明示 Worker 与「技能」页签，避免重复层级）。 */}
      {!onlyWorker ? (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15, display: "inline-flex", alignItems: "center", gap: 6 }}><BoltIcon size={15} /> {tr("技能中心")}</span>
        <antd.Tooltip
          title={tr(
            l2
            ? "团队技能/MCP 的统一管理面（L2 我的团队视角）：技能目录（本团队，只读）+ Worker 技能分配（可写 skills）+ MCP Servers（只读，写权限待上游 elevated capability 设计）。身份=Matrix token，L2 路径不走 admin token。频道接入见「团队管理 → 频道」。"
            : "团队技能/MCP 的统一管理面：技能目录（只读）+ Worker 技能分配矩阵 + MCP Servers。L1（admin）可写；L2/Leader 写操作被 Controller 拒绝时明确提示。频道接入见「团队管理 → 频道」。",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </antd.Tooltip>
        <div style={{ flex: 1 }} />
        <antd.Button
          size="small"
          onClick={() => {
            void loadWorkers();
            void loadCatalog();
          }}
          loading={st.loading}
        >
          {tr("刷新")}
        </antd.Button>
      </div>
      ) : null}

      {/* v0.5.0-beta.13.14：L2 多团队选择器（accessibleTeams >1 时；
          单团队自动选中不出选择器）。切团队 → 目录按 ?team= 重拉。
          v0.5.0-beta.13.21：onlyTeam 嵌入态不出选择器（团队已由入口固定）。 */}
      {l2 && !onlyTeam && l2Teams.length > 1 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: t.textSecondary }}>{tr("团队")}</span>
          <antd.Select
            size="small"
            style={{ minWidth: 200 }}
            value={l2Team || undefined}
            placeholder={tr("选择团队")}
            onChange={(v: string) => setL2Team(v)}
            options={l2Teams.map((tm) => ({ value: tm.name, label: tm.name }))}
          />
        </div>
      ) : null}

      {/* ① 技能目录（#1268 已合 main，旧 Controller 404 占位） */}
      {showCatalog ? (
      <antd.Card
        size="small"
        title={tr("① 技能目录（只读 · 上游 /api/v1/skills）")}
        extra={
          st.catalog !== undefined ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <antd.Input
                size="small"
                style={{ width: 180 }}
                allowClear
                placeholder={tr("搜索名称/描述")}
                value={catalogSearch}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setCatalogSearch(e.target.value)}
              />
              {/* v0.5.0-beta.13.19：技能包上传 / 自定义新建（POST /api/v1/skills）。 */}
              <antd.Button size="small" onClick={() => openUpload("zip")}>
                {tr("上传技能（zip）")}
              </antd.Button>
              <antd.Button size="small" type="primary" ghost onClick={() => openUpload("new")}>
                {tr("新建自定义技能")}
              </antd.Button>
            </div>
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
                {(s.source === "team" || s.source === "shared") ? (
                  <antd.Button
                    size="small"
                    type="link"
                    style={{ padding: 0, fontSize: 12 }}
                    onClick={() => void downloadSkill(s.name)}
                  >
                    {tr("下载")}
                  </antd.Button>
                ) : null}
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
      ) : null}

      {/* ② Worker 技能分配矩阵（P1，立即可用）
          v0.5.0-beta.13.14（13.13 装验反馈「矩阵太占地方、不直观、不好用」）：
          宽表（行=Worker × 列=技能 checkbox，技能 10+ 即横向溢出）→ 按
          Worker 紧凑行：默认收起只显已分配技能标签（最多 3 + N）；点行
          展开该 Worker 的完整技能勾选区（名称+来源标签+描述两行截断），
          只保存该 Worker 的技能。脏检测（矩阵 vs 服务端基线）：有改动显
          「未保存」橙标，展开区底部出 重置/保存（保存成功基线推进）。 */}
      {showMatrix ? (
      <antd.Card
        size="small"
        extra={
          onlyWorker ? (
            <antd.Button
              size="small"
              onClick={() => {
                void loadWorkers();
                void loadCatalog();
              }}
              loading={st.loading}
            >
              {tr("刷新")}
            </antd.Button>
          ) : undefined
        }
        title={
          l2
            ? tr("② Worker 技能分配（L2 我的团队 · 仅 skills 可写 · PUT 合并语义）")
            : tr("② Worker 技能分配矩阵（L1 可写 · PUT 合并语义 · skills 整字段替换）")
        }
      >
        {workersView.length ? (
          <div style={{ display: "grid", gap: 6 }}>
            {(onlyWorker
              ? [{ team: "", workers: workersView }]
              : groupWorkersByTeam(st.workers)
            ).map((tg) => (
              <div key={tg.team || "ungrouped"}>
                {/* v0.5.0-beta.13.15（B5a）：团队分组头（组内 Worker 卡原渲染）。
                    v0.5.0-beta.13.16：拓扑嵌入（onlyWorker）→ 组头不出。 */}
                {!onlyWorker ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 2px 0",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 12, color: t.text }}>
                    {tg.team ? tg.team : tr("未分组")}
                  </span>
                  <span style={{ color: t.textSecondary, fontSize: 11 }}>
                    {tr("{n} Worker", { n: tg.workers.length })}
                  </span>
                  <div style={{ flex: 1, height: 1, background: t.border }} />
                </div>
                ) : null}
                <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                {tg.workers.map((w) => {
              const assigned = matrix[w.name] || [];
              const base = baseMatrix[w.name] || [];
              const dirty =
                assigned.length !== base.length ||
                assigned.some((s) => !base.includes(s));
              const expanded = expandedWorker === w.name;
              const mat = matByWorker[w.name];
              return (
                <div
                  key={w.name}
                  style={{
                    border: `1px solid ${t.border}`,
                    borderRadius: 8,
                    background: t.cardBg,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      flexWrap: "wrap",
                      cursor: "pointer",
                    }}
                    onClick={() => setExpandedWorker(expanded ? null : w.name)}
                    title={tr("点行展开/收起该 Worker 的技能编辑")}
                  >
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{w.name}</span>
                    <span style={{ color: t.textSecondary, fontSize: 11 }}>
                      {w.team || "—"} · {w.role || "worker"}
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        gap: 4,
                        flexWrap: "wrap",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {assigned.length ? (
                        assigned.slice(0, 3).map((s) => (
                          <antd.Tag key={s} style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                            {s}
                          </antd.Tag>
                        ))
                      ) : Array.isArray(mat) && mat.length ? (
                        // v0.5.0-beta.13.15（B6）：分配层空但物化层非空——
                        // 「未分配但可调用」的可视化真相（团队层自动物化/
                        // builtin 恢复/镜像自带不写 spec.skills）。
                        <antd.Tooltip
                          title={tr(
                            "未显式分配（CRD 分配层为空），但运行时已装载 {n} 个技能（团队层物化/内置恢复/镜像自带）——展开行查看明细",
                            { n: mat.length },
                          )}
                        >
                          <antd.Tag color="cyan" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                            {tr("运行时已装载 {n}", { n: mat.length })}
                          </antd.Tag>
                        </antd.Tooltip>
                      ) : (
                        <span style={{ color: t.textSecondary, fontSize: 11 }}>
                          {tr("暂无技能分配")}
                        </span>
                      )}
                      {assigned.length > 3 ? (
                        <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                          +{assigned.length - 3}
                        </antd.Tag>
                      ) : null}
                    </span>
                    {dirty ? (
                      <antd.Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                        {tr("未保存")}
                      </antd.Tag>
                    ) : null}
                    <antd.Button
                      size="small"
                      type="text"
                      style={{ flexShrink: 0 }}
                      onClick={(e: ReactNS.MouseEvent) => {
                        e.stopPropagation();
                        setExpandedWorker(expanded ? null : w.name);
                      }}
                    >
                      {expanded ? tr("收起") : tr("编辑技能")} {expanded ? "▴" : "▾"}
                    </antd.Button>
                  </div>
                  {expanded ? (
                    <div
                      style={{
                        border: `1px solid ${t.border}`,
                        borderTop: "none",
                        padding: 10,
                        background: t.popoverBg,
                      }}
                    >
                      {/* v0.5.0-beta.13.15（B6）：物化层明细（runtime 实际
                          装载，懒加载首展即拉；404/403 版本/权限门占位）。 */}
                      {mat === "loading" ? (
                        <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 8 }}>
                          {tr("运行时技能加载中…")}
                        </div>
                      ) : mat === "err" ? (
                        <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 8 }}>
                          {tr(
                            "运行时技能列表不可用（Controller 未含该端点或当前身份无权限——分配层不受影响）",
                          )}
                        </div>
                      ) : Array.isArray(mat) && mat.length ? (
                        <div
                          style={{
                            marginBottom: 10,
                            padding: "6px 8px",
                            borderRadius: 6,
                            background: t.cardBg,
                            border: `1px solid ${t.border}`,
                          }}
                        >
                          <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 4 }}>
                            {tr(
                              "运行时已装载（物化层——实际可调用；分配层空而这里非空 = 团队层自动物化/内置恢复/镜像自带）",
                            )}
                          </div>
                          {/* v0.5.0-beta.13.20：per-worker 技能一等公民——
                              光杆 Tag → 逐技能行：来源 / 描述 / 启用态 /
                              分配态 / **预加载开关**（PUT preload，worker
                              侧热加载）。 */}
                          <div style={{ display: "grid", gap: 4 }}>
                            {mat.map((s) => {
                              const inAssigned = assigned.includes(s.name);
                              const busy = !!preloadBusy[`${w.name}::${s.name}`];
                              const disabled = s.enabled === false;
                              return (
                                <div
                                  key={s.name}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "3px 6px",
                                    borderRadius: 6,
                                    border: `1px solid ${t.border}`,
                                    background: t.cardBg,
                                  }}
                                >
                                  <span
                                    title={disabled ? tr("已禁用") : tr("启用中")}
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: 3,
                                      flexShrink: 0,
                                      background: disabled ? "#bbb" : "#52c41a",
                                    }}
                                  />
                                  {s.emoji ? (
                                    <span style={{ fontSize: 12, flexShrink: 0 }}>
                                      {s.emoji}
                                    </span>
                                  ) : null}
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      fontSize: 11.5,
                                      flexShrink: 0,
                                      maxWidth: 180,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={s.name}
                                  >
                                    {s.name}
                                  </span>
                                  <span
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      color: t.textSecondary,
                                      fontSize: 11,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={s.description || ""}
                                  >
                                    {s.description || ""}
                                  </span>
                                  {s.source ? (
                                    <antd.Tag
                                      style={{ marginInlineEnd: 0, fontSize: 10 }}
                                      title={tr("物化来源（worker 实际装载渠道）")}
                                    >
                                      {s.source}
                                    </antd.Tag>
                                  ) : null}
                                  <antd.Tag
                                    color={inAssigned ? "blue" : "cyan"}
                                    style={{ marginInlineEnd: 0, fontSize: 10 }}
                                    title={
                                      inAssigned
                                        ? tr("已分配 + 已物化")
                                        : tr("仅物化（未显式分配）")
                                    }
                                  >
                                    {inAssigned ? tr("已分配") : tr("仅物化")}
                                  </antd.Tag>
                                  <antd.Tooltip
                                    title={tr(
                                      "预加载：技能全文常驻该 Worker 每个会话的 system prompt（有 per-session token 成本；QwenPaw ≥ 2.2.1；worker 侧热加载无需重启）",
                                    )}
                                  >
                                    <span
                                      style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
                                    >
                                      <span style={{ fontSize: 10.5, color: t.textSecondary }}>
                                        {tr("预加载")}
                                      </span>
                                      <antd.Switch
                                        size="small"
                                        checked={!!s.preload}
                                        loading={busy}
                                        disabled={busy}
                                        onChange={(v: boolean) =>
                                          void togglePreload(w.name, s, v)
                                        }
                                      />
                                    </span>
                                  </antd.Tooltip>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                          gap: 6,
                        }}
                      >
                        {skillColumns.map((s) => {
                          const on = assigned.includes(s);
                          const desc = catalogByName.get(s)?.description;
                          return (
                            <div
                              key={s}
                              onClick={() => toggleSkill(w.name, s, !on)}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: 6,
                                padding: "6px 8px",
                                borderRadius: 6,
                                border: `1px solid ${on ? "rgba(22,119,255,0.5)" : t.border}`,
                                background: on ? "rgba(22,119,255,0.06)" : t.cardBg,
                                cursor: "pointer",
                              }}
                            >
                              <antd.Checkbox
                                checked={on}
                                style={{ marginTop: 1 }}
                                onClick={(e: ReactNS.MouseEvent) => e.stopPropagation()}
                                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                                  toggleSkill(w.name, s, e.target.checked)
                                }
                              />
                              <div style={{ minWidth: 0 }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 4,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      fontSize: 12,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={s}
                                  >
                                    {s}
                                  </span>
                                  <antd.Tag
                                    color={
                                      catalogByName.get(s)?.source === "builtin"
                                        ? "blue"
                                        : "purple"
                                    }
                                    style={{
                                      marginInlineEnd: 0,
                                      fontSize: 10,
                                      lineHeight: "16px",
                                    }}
                                  >
                                    {catalogByName.get(s)?.source || "custom"}
                                  </antd.Tag>
                                </div>
                                {desc ? (
                                  <div
                                    style={{
                                      fontSize: 11,
                                      color: t.textSecondary,
                                      marginTop: 2,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      display: "-webkit-box",
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: "vertical",
                                    }}
                                    title={desc}
                                  >
                                    {desc}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                        {!skillColumns.length ? (
                          <div
                            style={{
                              color: t.textSecondary,
                              fontSize: 12,
                              gridColumn: "1 / -1",
                            }}
                          >
                            {tr("暂无可用技能列表（目录未点亮且尚无已分配技能）")}
                          </div>
                        ) : null}
                      </div>
                      {dirty ? (
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            marginTop: 10,
                            justifyContent: "flex-end",
                          }}
                        >
                          <antd.Button
                            size="small"
                            onClick={() =>
                              setMatrix((prev) => ({ ...prev, [w.name]: [...base] }))
                            }
                          >
                            {tr("重置为当前值")}
                          </antd.Button>
                          <antd.Button
                            size="small"
                            type="primary"
                            loading={savingRow === w.name}
                            onClick={() => void saveWorkerSkills(w.name)}
                          >
                            {tr("保存")}
                          </antd.Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
                })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <antd.Empty
            description={
              st.loading
                ? tr("加载中…")
                : l2
                  ? tr("无 Worker（L2 可见范围=我的团队）")
                  : tr("无 Worker（admin token 未配置？）")
            }
          />
        )}
      </antd.Card>
      ) : null}

      {/* ③ MCP Servers（P1）
          v0.5.0-beta.13.14（L2 只读——l2-worker-scoped-write.md 契约：
          mcpServers 对默认 L2 关闭（网关 bearer key 注入每条条目，L2
          可控 URL 会外泄它）→ elevated capability 设计落地前只读。 */}
      {showMcp ? (
      <antd.Card
        size="small"
        title={
          l2
            ? tr("③ MCP Servers（L2 只读 · 写权限待上游 elevated capability 设计）")
            : tr("③ MCP Servers（L1 可写 · PUT 合并语义 · mcpServers 整字段替换）")
        }
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
                  {!l2 ? (
                    <antd.Button size="small" onClick={() => openMcpEdit(w.name)}>
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
      ) : null}

      {/* v0.5.0-beta.13.19：上传技能包 / 新建自定义技能（团队层写入）。 */}
      <antd.Modal
        open={upOpen}
        title={upMode === "zip" ? tr("上传技能包（zip）") : tr("新建自定义技能")}
        onCancel={() => setUpOpen(false)}
        onOk={() => void submitUpload()}
        confirmLoading={upBusy}
        okText={tr("上传")}
        cancelText={tr("取消")}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12 }}>{tr("目标团队")}</span>
            <antd.Select
              size="small"
              style={{ minWidth: 200 }}
              value={upTeam || undefined}
              onChange={(v: string) => setUpTeam(v)}
              options={teamChoices.map((t) => ({ value: t, label: t }))}
              placeholder={tr("选择团队")}
            />
          </div>
          {upMode === "zip" ? (
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setUpFile(e.target.files?.[0] || null)
              }
            />
          ) : (
            <>
              <antd.Input
                size="small"
                placeholder={tr("技能名（小写字母/数字/连字符）")}
                value={upName}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setUpName(e.target.value)
                }
              />
              <antd.Input
                size="small"
                placeholder={tr("描述（可选）")}
                value={upDesc}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                  setUpDesc(e.target.value)
                }
              />
              <antd.Input.TextArea
                rows={7}
                placeholder={tr("SKILL.md 正文（指令内容）")}
                value={upBody}
                onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                  setUpBody(e.target.value)
                }
              />
            </>
          )}
          <div style={{ fontSize: 11.5, color: t.textSecondary }}>
            {tr("上传进入该团队技能层；L1 可任意团队，L2 限本团队。上传经 skillscan 扫描（截拦即报原因）。")}
          </div>
        </div>
      </antd.Modal>

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
                <CloseIcon size={12} />
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

