/**
 * 🧩 技能中心（，技能中心与 MCP 实施方案 v0.1）。
 *
 * 三节（L1 admin 视角，插件以 admin token 操作 Controller）：
 * ① 技能上传——POST /api/v1/skills（zip 上传 / 新建自定义技能）。
 * 15.18 方案 B：只读技能目录卡已删（与 ② 矩阵重复）；目录数据层
 * （catalog/loadCatalog）保留供 ② 矩阵取来源标签。
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
  uploadTeamSkill,
} from "../api";
import { strToU8, zipSync } from "fflate";
import { invalidateTags } from "../requestCache";
import { BoltIcon } from "./icons";
import { WbTooltip } from "./WbTooltip";
import { useWbViewport } from "../WbViewportContext";
import type { MatrixState, SkillDetail } from "./SkillCenterShared";
import { SkillMatrix } from "./SkillCenterMatrix";
import { McpCard, McpEditDrawer } from "./SkillCenterMcp";
import { UploadSkillModal, SkillDetailModal } from "./SkillCenterModals";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


/**
 * （L2 双模式——调研 P0 + 上游设计文档
 * docs/design/l2-worker-scoped-write.md（#1274 已合）+ team-skills.md +
 * skill-catalog-api.md 已合 main）：
 * l2=true → Matrix 身份（无 admin token）：
 * ① 目录 = GET /skills?team=<本团队>（Controller 按 accessibleTeams
 * scope；cross-team → 404 反探测）；
 * ② 矩阵 = L2 scoped workers（standalone 隐藏）+ PUT {skills} 可写
 * （白名单唯一字段；remoteSkills/mcpServers 400 待 elevated
 * capability 设计）；
 * ③ MCP = 只读（写权限同上待设计）。
 * 铁律（P0）：L2 路径不走 admin token——代理链在 router.py
 * catch-all 已实现（admin token 空 → Matrix access_token）。
 */
export default function SkillCenter({
  l2 = false,
  onlyWorker,
  onlyTeam,
  sections,
}: {
  l2?: boolean;
  /** ：
 * 限定单 Worker——矩阵只渲染该 Worker 行（自动展开编辑区）、MCP 卡只
 * 渲染该 Worker 行、隐藏页面题头。无此 prop 时行为与既有全量视图完全一致。 */
  onlyWorker?: string;
  /** （13.20 「团队的技能等团队配置要放在团队配置里，
 * 和技能中心一样的搜索/上传/自定义，worker 也是」）：限定单团队——
 * 目录按 ?team= 取（L1 任意团队/L2 本团队）、矩阵/MCP 只渲染该团队
 * Worker、上传 scope 固定该团队（选择器隐藏）。团队配置弹窗（齿轮）
 * 嵌入用；与 onlyWorker 可组合。 */
  onlyTeam?: string;
  /** 模块裁剪：默认全渲染（目录①+矩阵②+MCP③）；拓扑嵌入按需（如
 * ["matrix"] 只出可编辑技能矩阵 / ["mcp"] 只出可编辑 MCP 卡）。 */
  sections?: ReadonlyArray<"catalog" | "matrix" | "mcp">;
}) {
  const t = useThemeColors();
  const tr = useT();
  const { narrow } = useWbViewport();
  const showCatalog = !sections || sections.includes("catalog");
  const showMatrix = !sections || sections.includes("matrix");
  const showMcp = !sections || sections.includes("mcp");
  const [st, setSt] = React.useState<MatrixState>({
    workers: [],
    loading: true,
    catalog: null,
    catalogNote: "",
  });
  // L2 团队选择（accessibleTeams 单团队自动；多团队显选择器）。
  const [l2Teams, setL2Teams] = React.useState<TeamInfo[]>([]);
  const [l2Team, setL2Team] = React.useState("");
  // 技能包上传/自定义新建/下载（技能目录卡动作）。
  const [upOpen, setUpOpen] = React.useState(false);
  const [upMode, setUpMode] = React.useState<"zip" | "new">("zip");
  const [upTeam, setUpTeam] = React.useState("");
  const [upFile, setUpFile] = React.useState<File | null>(null);
  const [upName, setUpName] = React.useState("");
  const [upDesc, setUpDesc] = React.useState("");
  const [upBody, setUpBody] = React.useState("");
  const [upBusy, setUpBusy] = React.useState(false);
  // 技能详情弹窗（卡面去描述后，完整 description/source/version 的唯一入口
  // = 分配卡与物化层行的「详情」按钮，376 竖屏）。显示模型 = 目录项
  // 与物化层项的公共字段超集（两边结构不同，统一收敛到这个视图模型）。
  const [detailSkill, setDetailSkill] = React.useState<SkillDetail | null>(null);
  const [matrix, setMatrix] = React.useState<Record<string, string[]>>({});
  // 服务端基线（脏检测用——矩阵相对基线有改动才显「保存」）。
  const [baseMatrix, setBaseMatrix] = React.useState<Record<string, string[]>>({});
  // 单 Worker 展开态（一次只展开一个，面板恒紧凑）。
  // 拓扑嵌入（onlyWorker）→ 默认展开该 Worker 编辑区。
  const [expandedWorker, setExpandedWorker] = React.useState<string | null>(
    onlyWorker ?? null,
  );
  // 物化层（runtime /api/skills，
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
  // // 物化层 per-skill 预加载开关——PUT /workers/{name}/skills/{skill}/preload。
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
  // 防刷屏（用户报告「技能中心刷屏」）：MCP 空行默认收起。
  const [showAllMcp, setShowAllMcp] = React.useState(false);
  const mcpWithCount = React.useMemo(
    () => st.workers.filter((w) => (mcpMap[w.name] || []).length).length,
    [st.workers, mcpMap],
  );
  // onlyWorker/onlyTeam 作用域过滤（两者可组合）。
  const scopeWorker = React.useCallback(
    (w: WorkerInfo) =>
      (!onlyWorker || w.name === onlyWorker) &&
      (!onlyTeam || w.team === onlyTeam),
    [onlyWorker, onlyTeam],
  );
  const mcpVisible = React.useMemo(() => {
    // 拓扑嵌入（onlyWorker）→ 只出该 Worker 行，且
    // **无条件出**（无 MCP 时行内走「无 MCP」文案——全局「隐藏无 MCP
    // Worker」折叠开关在嵌入态无意义，不能把目标行滤成空白卡）。
    if (onlyWorker || onlyTeam) return st.workers.filter(scopeWorker);
    return mcpWithCount === 0 || showAllMcp
      ? st.workers
      : st.workers.filter((w) => (mcpMap[w.name] || []).length);
  }, [st.workers, mcpMap, mcpWithCount, showAllMcp, onlyWorker, onlyTeam, scopeWorker]);
  // 拓扑嵌入 = 单 Worker 视图（矩阵卡组头/其他行不出）。
  const workersView = React.useMemo(
    () => (onlyWorker || onlyTeam ? st.workers.filter(scopeWorker) : st.workers),
    [st.workers, onlyWorker, onlyTeam, scopeWorker],
  );


  const loadWorkers = React.useCallback(async () => {
    try {
      // L2 用宽松取数（humans/managers 403 置空不炸）。
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
  // L2 带 ?team=（skill-catalog-api.md W8 反探测契约）。
  const loadCatalog = React.useCallback(async () => {
    try {
      // onlyTeam 优先（L1 团队配置弹窗按 ?team= 取该团队目录）。
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
    // onlyTeam 已定团队 → 无需等 l2Team 选择。
    if (l2 && !onlyTeam && !l2Team) return;
    void loadCatalog();
  }, [loadCatalog, l2, l2Team, onlyTeam]);

  // // 技能包上传 / 自定义新建 / 下载（技能目录卡动作）。
  // 上传 = 选择本地 zip → POST /api/v1/skills（scope=team+file）
  // 新建 = 名称/描述/正文 → 前端 fflate 打包 SKILL.md → 同一端点
  // 下载 = GET /api/v1/skills/{name}/download（上游 v1.2.4 尚无此端点 →
  // 404 时诚实提示，端点就位即自动可用）
  const teamChoices = React.useMemo(() => {
    // onlyTeam 固定上传 scope（选择器隐藏）。
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
      // 技能中心安装=写路径 → 失效 skills 缓存
      // （loadCatalog 走 fetchSkillCatalog 未入 缓存，但同步失效
      // skills/list 缓存保证技能目录读新值）。
      invalidateTags(["skills"]);
      void loadCatalog();
      void loadWorkers();
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("上传失败"));
    } finally {
      setUpBusy(false);
    }
  }, [upTeam, upMode, upFile, upName, upDesc, upBody, tr, loadCatalog, loadWorkers]);
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
        // 服务端已接受 → 基线推进（脏标记消失）；
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

  return (
    // minmax(0,1fr) 钉轨道：隐式 auto 轨按 item min-content 撑宽（技能矩阵
    // 宽内容 702px > 窄容器 400px → 卡溢出弹窗被裁；.wb-main 全局 grid 锁轨
    // 规则不覆盖 portal 弹窗，onlyWorker 嵌入弹窗场景须自锁）。
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: onlyWorker ? 8 : 16, minWidth: 0 }}>
      {/* 拓扑嵌入（onlyWorker）→ 页面题头不出（上下文中
 已明示 Worker 与「技能」页签，避免重复层级）。 */}
      {!onlyWorker ? (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15, display: "inline-flex", alignItems: "center", gap: 6 }}><BoltIcon size={15} /> {tr("技能中心")}</span>
        <WbTooltip
          title={tr(
            l2
            ? "团队技能/MCP 的统一管理面（L2 我的团队视角）：技能上传（本团队）+ Worker 技能分配（可写 skills）+ MCP Servers（只读，写权限待上游 elevated capability 设计）。身份=Matrix token，L2 路径不走 admin token。频道接入见「团队管理 → 频道」。"
            : "团队技能/MCP 的统一管理面：技能上传（zip/新建）+ Worker 技能分配矩阵 + MCP Servers。L1（admin）可写；L2/Leader 写操作被 Controller 拒绝时明确提示。频道接入见「团队管理 → 频道」。",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </WbTooltip>
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

      {/* L2 多团队选择器（accessibleTeams >1 时；
 单团队自动选中不出选择器）。切团队 → 目录按 ?team= 重拉。
 onlyTeam 嵌入态不出选择器（团队已由入口固定）。 */}
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

      {/* ① 技能上传（15.18：技能目录块删除——方案 B「目录上传/下载没意义」；
          只保留技能上传/新建入口。目录数据层（catalog/loadCatalog/catalogByName）
          保留供 ② 矩阵来源标签；catalogSearch/filteredCatalog/目录列表/下载已删。） */}
      {showCatalog ? (
      <antd.Card
        size="small"
        title={tr("① 技能上传（POST /api/v1/skills）")}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Button size="small" onClick={() => openUpload("zip")}>
            {tr("上传技能（zip）")}
          </antd.Button>
          <antd.Button size="small" type="primary" ghost onClick={() => openUpload("new")}>
            {tr("新建自定义技能")}
          </antd.Button>
        </div>
      </antd.Card>
      ) : null}

      {showMatrix ? (
        <SkillMatrix
          l2={l2}
          onlyWorker={onlyWorker}
          onlyTeam={onlyTeam}
          workersView={workersView}
          workers={st.workers}
          loading={st.loading}
          matrix={matrix}
          setMatrix={setMatrix}
          baseMatrix={baseMatrix}
          expandedWorker={expandedWorker}
          setExpandedWorker={setExpandedWorker}
          matByWorker={matByWorker}
          skillColumns={skillColumns}
          catalogByName={catalogByName}
          toggleSkill={toggleSkill}
          onDetail={setDetailSkill}
          preloadBusy={preloadBusy}
          togglePreload={togglePreload}
          savingRow={savingRow}
          onSave={(w) => void saveWorkerSkills(w)}
          onRefresh={() => {
            void loadWorkers();
            void loadCatalog();
          }}
        />
      ) : null}

      {showMcp ? (
        <McpCard
          l2={l2}
          narrow={narrow}
          workers={st.workers}
          loading={st.loading}
          mcpMap={mcpMap}
          mcpVisible={mcpVisible}
          mcpWithCount={mcpWithCount}
          onlyWorker={onlyWorker}
          showAllMcp={showAllMcp}
          onToggleShowAll={() => setShowAllMcp((v) => !v)}
          onEdit={openMcpEdit}
        />
      ) : null}

      {/* 上传技能包 / 新建自定义技能（团队层写入）。 */}
      <UploadSkillModal
        open={upOpen}
        mode={upMode}
        team={upTeam}
        teams={teamChoices}
        name={upName}
        desc={upDesc}
        body={upBody}
        busy={upBusy}
        onClose={() => setUpOpen(false)}
        onSubmit={() => void submitUpload()}
        onTeamChange={(v) => setUpTeam(v)}
        onFileChange={(f) => setUpFile(f)}
        onNameChange={(v) => setUpName(v)}
        onDescChange={(v) => setUpDesc(v)}
        onBodyChange={(v) => setUpBody(v)}
      />

      {/* 技能详情弹窗（卡面去描述后的唯一完整信息入口，376 竖屏）。 */}
      <SkillDetailModal
        detail={detailSkill}
        onClose={() => setDetailSkill(null)}
      />

      <McpEditDrawer
        editWorker={mcpEditWorker}
        setEditWorker={setMcpEditWorker}
        draft={mcpDraft}
        setDraft={setMcpDraft}
        saving={mcpSaving}
        onSave={() => void saveMcp()}
      />
    </div>
  );
}

