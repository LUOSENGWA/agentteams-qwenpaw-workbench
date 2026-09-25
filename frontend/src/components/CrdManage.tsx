import { NotesIcon, WarnIcon, DocIcon, CheckIcon, CloseIcon, ClipIcon, SearchIcon, RefreshIcon, ClockIcon } from "./icons";
import type * as ReactNS from "react";

import {
  createHuman,
  createTeam,
  createWorker,
  deleteHuman,
  deleteTeam,
  fetchAdminData,
  fetchGatewayAiProviders,
  fetchGatewayAiRoutes,
  fetchSglangModels,
  updateTeam,
  updateWorker,
  updateWorkerModel,
  type AdminData,
  type HumanInfo,
  type TeamInfo,
} from "../api";
import {
  buildModelSelectionOptions,
  type ModelSelectionOption,
} from "../modelCatalog";
import {
  extractGatewayLists,
  isPathLikeModel,
  modelVerdictText,
  validateModelValue,
} from "../modelUnion";
import TruncatedId from "./TruncatedId";
import SkillCenter from "./SkillCenter";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/**
 * v0.5.0-beta.12: CRD 管理面板（L1 门控——仅配置了 Controller 管理员 token 时由
 * WorkerManage 渲染）。真人"员工"入职（Human CRD）+ 团队创建/配置（Team CRD）。
 * 走现有通用 Controller 代理（/agentteams-proxy/controller），零新后端端点。
 *
 * 权限管理（人员可访问团队）：上游 Controller REST 无 UpdateHuman API
 * （dashboard 的 updateHuman 是死代码——只写了客户端没写路由；agt update
 * 也无 human 子命令）→ 本面板生成「embedded apiserver merge-patch」命令
 * （标准姿势：token.csv 第一列 + 127.0.0.1:6443），在 Controller
 * 宿主机执行。上游 Human PUT 端点合并后此处可零改动升级为一键 PUT
 * （通用代理已支持 PUT）。
 */
export interface CrdManageProps {
  /** 管理数据（humans/teams/workers）——与 WorkerManage 底部三表同一数据源。 */
  admin: AdminData;
  /** 写操作成功后静默刷新管理数据。 */
  onRefresh?: (silent?: boolean) => void;
  /** L1 走 controller_token（无 admin 账号密码 → 无 Higress Console 会话
   * → 网关 alias 层不可见）——为 true 且网关拉取完成仍无会话时显示提示。 */
  l1TokenMode?: boolean;
  /** v0.5.0-beta.13.20：注册式 handle——拓扑 TeamNode「N人」右侧齿轮要
   * 打开本组件的「配置团队」弹窗（与团队表「配置」按钮同一入口）。
   * 用注册回调而非 forwardRef：本组件 2200+ 行，forwardRef 会把整个
   * 函数体缩进 +2，diff 噪音远大于收益（本仓已有 refreshRef 同款
   * 注册式镜像惯例）。 */
  registerHandle?: (h: CrdManageHandle) => void;
}

/** v0.5.0-beta.13.20：注册式 handle 类型（WorkerManage 拓扑齿轮消费）。 */
export interface CrdManageHandle {
  /** 按 CR 名打开配置团队弹窗；团队未加载/不存在时 toast 提示，不静默。 */
  openConfig: (teamName: string) => void;
}

const LEVEL_META: Record<number, { label: string; color: string }> = {
  1: { label: "管理员 (L1)", color: "#ff4d4f" },
  2: { label: "团队 (L2)", color: "#52c41a" },
  3: { label: "Worker", color: "#1677ff" },
};

const PHASE_COLOR: Record<string, string> = {
  Active: "#52c41a",
  Ready: "#52c41a",
  Running: "#52c41a",
  Pending: "#fa8c16",
  Starting: "#1677ff",
  Error: "#ff4d4f",
  Failed: "#ff4d4f",
};

interface WorkerRow {
  name: string;
  role: string;
  /** 团队配置内联编辑 Worker 模型（PUT /workers/{name} 合并语义，provider 不动）。 */
  model?: string;
  /** 打开弹窗时的原值——保存时 diff，未改动不发请求。 */
  modelOrig?: string;
  /** v0.5.0-beta.12（建团自检修复）：SOUL 富文本（多行/上传 → spec.soul 内联）。 */
  soul?: string;
  /** SOUL 编辑器展开状态（行级折叠，默认收起保持表单紧凑）。 */
  soulOpen?: boolean;
}

// ── v0.5.0-beta.12（建团自检修复）──────────────────────────
// 建团缺陷（历史回归）：建团表单只有 name+role，
// Worker 出生即无模型；model 自由文本零校验，SGLang 在服列表被污染时
// 「/models」被当作候选下拉项写进 CRD → 全团 LLM 死亡。修复：
// ① 候选 = SGLang ∪ 在服 Worker 已用模型，且剔除路径形态值（防列表自身被毒）；
// ② 写前校验三入口共用（建 Worker 弹窗/建队行/团队配置内联）；
// ③ SOUL 多行+上传入口（预算告警不阻断）；
// ④ 创建自检（CRD 回读+阶段轮询；LLM 冒烟/SOUL 检查=无通道，如实标注）。

// 模型校验/合并/分组的纯函数在 ../modelUnion（v0.5.0-beta.12 抽出，
// 与 WorkerManage ManagerTable 共用——同一套候选与校验，行为零分叉）。

/** SOUL 行数预算（设计约束 v2.39.2：Worker ≤150 / Leader ≤250 行）——超了告警不阻断。 */
function soulBudget(role: string): number {
  return role === "team_leader" ? 250 : 150;
}

/** v0.5.0-beta.12（用户反馈：配置团队弹窗需选项标题）：Worker 选择选项 = 名字 + 现况（所属团队 · 现用模型），
 * 一眼分辨"换谁、现在跑的什么模型"；无数据时退回纯名字。 */
function workerOptionLabel(
  name: string,
  workers: AdminData["workers"],
): string {
  const w = workers.find((x) => x.name === name);
  const parts = [w?.team, w?.model].filter(Boolean);
  return parts.length ? `${name} (${parts.join(" · ")})` : name;
}

/** 角色选择选项（建队行/团队配置共用）：人话标签 + 原始枚举（提交值不变，
 * Controller 仍收 team_leader/worker）。 */
function roleSelectOptions(tr: (s: string, vars?: Record<string, string | number>) => string) {
  return [
    { value: "team_leader", label: tr("Leader (team_leader)") },
    { value: "worker", label: tr("Worker (worker)") },
  ];
}

function soulLines(s: string): number {
  return (s || "").split("\n").length;
}

const EMPTY_HUMAN_FORM = {
  name: "",
  displayName: "",
  email: "",
  permissionLevel: 2,
  accessibleTeams: [] as string[],
  accessibleWorkers: [] as string[],
  note: "",
};

const EMPTY_TEAM_FORM = {
  name: "",
  teamName: "",
  description: "",
  humanMembers: [] as string[],
  heartbeatEvery: "",
  peerMentions: true,
};

export default function CrdManage(props: CrdManageProps) {
  const t = useThemeColors();
  const tr = useT();
  /** v0.5.0-beta.12（用户反馈配置团队弹窗需选项标题）：
   * 字段标题——输入框/选择器上方人话标签（占位符输入即消失=无标题，
   * 与 11.7 团队成员「名称/角色/模型」标签同构）。 */
  const FieldLabel = ({ children }: { children: ReactNS.ReactNode }) => (
    <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
      {children}
    </div>
  );
  const { admin, onRefresh, l1TokenMode } = props;
  // v0.5.0-beta.13（装验 9/19）：三卡同排 + 可折叠。
  const [crdCardsOpen, setCrdCardsOpen] = React.useState(true);
  const { humans, teams, workers } = admin;

  // ── 员工入职（Human CRD 创建）──
  const [hForm, setHForm] = React.useState(EMPTY_HUMAN_FORM);
  const [hBusy, setHBusy] = React.useState(false);
  /** 创建成功且拿到 initialPassword（只显示一次）。 */
  const [created, setCreated] = React.useState<{
    name: string;
    password: string;
  } | null>(null);

  const doCreateHuman = React.useCallback(async () => {
    const name = hForm.name.trim();
    if (!name || /[@\s:]/.test(name)) {
      antd.message.warning(tr("账号名不能为空，且不能含 @、冒号、空格"));
      return;
    }
    setHBusy(true);
    try {
      const resp = await createHuman({
        name,
        displayName: hForm.displayName.trim() || undefined,
        email: hForm.email.trim() || undefined,
        permissionLevel: hForm.permissionLevel,
        accessibleTeams: hForm.accessibleTeams.length
          ? hForm.accessibleTeams
          : undefined,
        accessibleWorkers: hForm.accessibleWorkers.length
          ? hForm.accessibleWorkers
          : undefined,
        note: hForm.note.trim() || undefined,
      });
      setHForm(EMPTY_HUMAN_FORM);
      if (resp?.initialPassword) {
        setCreated({ name, password: resp.initialPassword });
      } else {
        antd.message.success(tr("入职成功"));
      }
      onRefresh?.(true);
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
    } finally {
      setHBusy(false);
    }
  }, [hForm, onRefresh, tr]);

  const copyPassword = React.useCallback(() => {
    if (!created) return;
    const text = `${created.name} / ${created.password}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => antd.message.success(tr("已复制")),
        () => antd.message.warning(text),
      );
    } else {
      antd.message.warning(text);
    }
  }, [created, tr]);

  const doDeleteHuman = React.useCallback(
    async (name: string) => {
      try {
        await deleteHuman(name);
        antd.message.success(tr("已删除"));
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      }
    },
    [onRefresh, tr],
  );

  // ── 创建团队（Team CRD 创建）──
  const [tForm, setTForm] = React.useState(EMPTY_TEAM_FORM);
  const [workerRows, setWorkerRows] = React.useState<WorkerRow[]>([
    { name: "", role: "team_leader" },
  ]);
  const [tBusy, setTBusy] = React.useState(false);
  // v0.5.0-beta.12.2：导出 JSON 按钮的 loading 态。
  const [exporting, setExporting] = React.useState(false);

  const updateRow = React.useCallback((i: number, patch: Partial<WorkerRow>) => {
    setWorkerRows((prev) =>
      prev.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );
  }, []);
  const removeRow = React.useCallback((i: number) => {
    setWorkerRows((prev) => prev.filter((_, j) => j !== i));
  }, []);
  const addRow = React.useCallback(() => {
    setWorkerRows((prev) => [...prev, { name: "", role: "worker" }]);
  }, []);

  // ── v0.5.0-beta.12：创建团队时新建 Worker（POST /api/v1/workers）──
  // 上游 CreateWorkerRequest：name 必填，containerManaged 默认 true
  // （Controller 调和拉镜像起容器，数分钟就绪）；团队可先保存，
  // Worker 就绪后调和自动关联。
  const [nw, setNw] = React.useState({
    name: "",
    // v0.5.0-beta.12.2：新建 Worker 可选运行时。选项正源 = 上游
    // internal/backend/interface.go（Runtime* 常量 + L158 五值集）；copaw 退役
    // 移除（用户反馈），deepseek-harness 补上（上游近期新加，镜像
    // agentteams-deepseek-harness-worker:v0.1.0）；默认 qwenpaw = 安装脚本默认
    // （agentteams-install.sh L2747 AGENTTEAMS_DEFAULT_WORKER_RUNTIME:-qwenpaw）。
    runtime: "qwenpaw",
    model: "",
    soul: "",
    busy: false,
  });
  /** 在服模型候选（SGLang /v1/models 代理；空=模块未启用→自由输入）。 */
  const [modelOpts, setModelOpts] = React.useState<string[]>([]);
  /** v0.5.0-beta.12：Higress 面 alias 候选（configured+builtin，Higress Console 经
   * admin 密码模式会话取）；null=无会话/不可用→alias 层隐藏（SGLang∪在用
   * +自由输入不受影响）。 */
  const [gatewayOpts, setGatewayOpts] = React.useState<
    ModelSelectionOption[] | null
  >(null);
  const [gatewayLoaded, setGatewayLoaded] = React.useState(false);
  /** v0.5.0-beta.12：网关 alias 拉取（一次性；available=false=无 Console
   * 会话，属正常降级非错误）。 */
  const loadGatewayAliases = React.useCallback(async () => {
    try {
      const [routes, providers] = await Promise.all([
        fetchGatewayAiRoutes(),
        fetchGatewayAiProviders(),
      ]);
      if (!routes.available || !providers.available) {
        setGatewayOpts(null);
        return;
      }
      // v0.5.0-beta.12 起解包逻辑（{code,data} 信封 + providers 键名，
      // 对齐 dashboard unwrapData 实证）；v0.5.0-beta.12 提升为 modelUnion
      // extractGatewayLists 共享（ManagerTable hook 原 ad-hoc 副本漏信封
      // + 错键=alias 恒空根因，同源零分叉）。
      const { routesList, providersList } = extractGatewayLists(
        routes.data,
        providers.data,
      );
      setGatewayOpts(buildModelSelectionOptions(routesList, providersList));
    } catch {
      setGatewayOpts(null); // 不可达/网络错误 → 与无会话同路径
    } finally {
      setGatewayLoaded(true);
    }
  }, []);
  /** v0.5.0-beta.12：最终候选 = SGLang ∪ 在服 Worker 已用模型，剔除路径形态
   * （实锤：SGLang 在服列表本身可被污染出 "/models"——下拉项必须过滤，
   * 否则候选列表成为毒源，成员校验形同虚设）。 */
  const modelCandidates = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (m: string) => {
      const v = (m || "").trim();
      if (!v || isPathLikeModel(v)) return;
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    };
    modelOpts.forEach(push);
    workers.forEach((w) => push(w.model));
    // v0.5.0-beta.12：网关 alias（configured+builtin）同为合法 model 值
    // （经网关路由转发）——入候选，写前校验不误报「不在在服列表」。
    gatewayOpts?.forEach((o) => push(o.alias));
    return out;
  }, [modelOpts, workers, gatewayOpts]);
  /** v0.5.0-beta.12：AutoComplete 下拉——Higress Console 会话可用时三组（Higress alias
   * 可解析 / 内置 alias / 在服+在用）；不可用=原平铺列表。value 恒为 alias 本身。 */
  const modelOptions = React.useMemo(() => {
    if (!gatewayOpts || gatewayOpts.length === 0) {
      return modelCandidates.map((m) => ({ value: m }));
    }
    const aliasSet = new Set(gatewayOpts.map((o) => o.alias));
    const rest = modelCandidates
      .filter((m) => !aliasSet.has(m))
      .map((m) => ({ value: m }));
    const groups: {
      value: string;
      label: string;
      options: { value: string; label?: string }[];
    }[] = [];
    const configured = gatewayOpts.filter((o) => o.kind === "configured");
    const builtin = gatewayOpts.filter((o) => o.kind === "builtin");
    if (configured.length > 0) {
      groups.push({
        value: "gateway-configured",
        label: tr("Higress alias（路由可解析）"),
        options: configured.map((o) => ({
          value: o.alias,
          label: o.binding?.routeName
            ? `${o.alias} → ${o.binding.routeName}/${o.binding.targetModel}`
            : o.alias,
        })),
      });
    }
    if (builtin.length > 0) {
      groups.push({
        value: "gateway-builtin",
        label: tr("Higress 内置 alias（需配路由映射）"),
        options: builtin.map((o) => ({ value: o.alias })),
      });
    }
    if (rest.length > 0) {
      groups.push({ value: "local", label: tr("在服+在用"), options: rest });
    }
    return groups;
  }, [gatewayOpts, modelCandidates, tr]);
  /** 现有 Worker CR 的现值（行选中预填 / 保存 diff 用）。 */
  const modelOf = React.useCallback(
    (n: string) => workers.find((w) => w.name === n)?.model || "",
    [workers],
  );
  /** SOUL 文件上传：异步读文本 → onLoaded 回调填入，行数超预算告警不阻断。 */
  const loadSoulFile = React.useCallback(
    (
      file: File | null | undefined,
      role: string,
      onLoaded: (text: string) => void,
    ) => {
      if (!file) return;
      if (file.size > 200 * 1024) {
        antd.message.warning(tr("SOUL 文件过大（>200KB），已忽略"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const lines = soulLines(text);
        if (lines > soulBudget(role)) {
          antd.message.warning(
            tr("SOUL {n} 行，超出预算 {b} 行（team_leader≤250 / worker≤150）——已填入，请自行裁剪", {
              n: lines,
              b: soulBudget(role),
            }),
          );
        }
        onLoaded(text);
      };
      reader.onerror = () => antd.message.error(tr("SOUL 文件读取失败"));
      reader.readAsText(file);
    },
    [tr],
  );
  // ──  创建自检（建队成功后自动跑：CRD 回读 + 阶段轮询，5s×180s）──
  interface CheckRow {
    name: string;
    sentModel: string;
    crdModel: string;
    phase: string;
    container: string;
    message: string;
    modelOk: boolean;
    ready: boolean;
  }
  const [tCheck, setTCheck] = React.useState<{
    rows: CheckRow[];
    running: boolean;
    startedAt: number;
    deadline: number;
    done: boolean;
  } | null>(null);
  const tCheckTimer = React.useRef<number | null>(null);

  const stopTeamCheck = React.useCallback(() => {
    if (tCheckTimer.current !== null) {
      window.clearInterval(tCheckTimer.current);
      tCheckTimer.current = null;
    }
  }, []);
  React.useEffect(() => stopTeamCheck, [stopTeamCheck]);
  /** v0.5.0-beta.12（历史缺陷：新建团队 Worker 模型问题）：gateway alias 此前只在打开配置团队/新建 Worker 弹窗时拉
   * → 建队卡（常驻视图）模型下拉首开必平铺、无 alias 组。挂载即拉一次，
   * 三入口（建队卡行/新建 Worker 弹窗/配置团队行）开屏即有 alias 组。 */
  React.useEffect(() => {
    if (!gatewayLoaded) void loadGatewayAliases();
  }, [gatewayLoaded, loadGatewayAliases]);

  const startTeamCheck = React.useCallback(
    (rows: { name: string; sentModel: string }[]) => {
      stopTeamCheck();
      const startedAt = Date.now();
      setTCheck({
        rows: rows.map((r) => ({
          ...r,
          crdModel: "",
          phase: "",
          container: "",
          message: "",
          modelOk: false,
          ready: false,
        })),
        running: true,
        startedAt,
        deadline: startedAt + 180_000,
        done: false,
      });
      const tick = async () => {
        let finished = false;
        try {
          const d = await fetchAdminData();
          setTCheck((prev) => {
            if (!prev) return prev;
            const now = Date.now();
            const nextRows = prev.rows.map((r) => {
              const w = d.workers.find((x) => x.name === r.name);
              if (!w) return r;
              const crdModel = w.model || "";
              // 提交留空=跟随集群默认：CRD 为空是预期（ok），非空也 ok
              const modelOk =
                !r.sentModel || crdModel === r.sentModel || crdModel === "";
              const ready =
                w.phase === "Ready" ||
                w.phase === "Running" ||
                w.phase === "Active" ||
                (w.containerState || "").toLowerCase() === "running";
              return {
                ...r,
                crdModel,
                phase: w.phase || "",
                container: w.containerState || "",
                message: w.message || "",
                modelOk,
                ready,
              };
            });
            finished =
              nextRows.every((r) => r.modelOk && r.ready) ||
              now >= prev.deadline;
            return {
              ...prev,
              rows: nextRows,
              running: !finished,
              done: finished,
            };
          });
        } catch {
          /* 单次轮询失败不终止（下轮重试） */
        }
        if (finished) stopTeamCheck();
      };
      void tick();
      tCheckTimer.current = window.setInterval(() => void tick(), 5000);
    },
    [stopTeamCheck],
  );

  // v0.5.0-beta.12.2（用户反馈：参考 dashboard 加导出 JSON 功能）——参考
  // dashboard teams-section handleExport（Blob + a.download + toast）。
  // 插件侧导出一份 fetchAdminData 全量（teams/workers/humans/managers 四类
  // CRD，比 dashboard 的 teams-only 更实），文件名 agentteams-crd-YYYY-MM-DD.json。
  const doExportCrd = React.useCallback(async () => {
    setExporting(true);
    try {
      const data = await fetchAdminData();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agentteams-crd-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      antd.message.success(tr("CRD 数据已导出（teams/workers/humans/managers）"));
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("导出失败"));
    } finally {
      setExporting(false);
    }
  }, [tr]);

  const doCreateWorker = React.useCallback(async () => {
    const name = nw.name.trim();
    if (!name) {
      antd.message.warning(tr("Worker 名不能为空"));
      return;
    }
    if (workerRows.some((r) => r.name.trim() === name)) {
      antd.message.warning(tr("该 Worker 已在团队成员行中"));
      return;
    }
    // 写前校验（入口①：新建 Worker 弹窗）。
    const mv = validateModelValue(nw.model, modelCandidates);
    if (mv.level === "error") {
      antd.message.error(modelVerdictText(tr, mv, nw.model, modelCandidates));
      return;
    }
    const run = async () => {
      setNw((p) => ({ ...p, busy: true }));
      try {
        await createWorker({
          name,
          // runtime 透传（Worker CR spec.runtime；留空=安装默认 qwenpaw）。
          runtime: nw.runtime,
          model: nw.model.trim() || undefined,
          soul: nw.soul.trim() || undefined,
        });
        antd.message.success(
          nw.model.trim()
            ? tr("Worker 已创建并加入团队成员（容器数分钟就绪）")
            : tr("Worker 已创建并加入团队成员——未配模型（跟随集群默认），请在创建自检页确认"),
        );
        setWorkerRows((prev) => [
          ...prev,
          { name, role: "worker", model: nw.model.trim(), modelOrig: nw.model.trim() },
        ]);
        setNw({ name: "", runtime: "qwenpaw", model: "", soul: "", busy: false });
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      } finally {
        setNw((p) => ({ ...p, busy: false }));
      }
    };
    if (mv.level === "warn") {
      antd.Modal.confirm({
        title: tr("模型未命中在服列表"),
        content: (
          <div style={{ lineHeight: 1.8 }}>
            <div>
              {tr("模型")}: {nw.model.trim()}
            </div>
            <div>{modelVerdictText(tr, mv, nw.model, modelCandidates)}</div>
          </div>
        ),
        okText: tr("确认强写"),
        cancelText: tr("返回修改"),
        onOk: () => void run(),
      });
      return;
    }
    void run();
  }, [nw, workerRows, onRefresh, tr, modelCandidates]);

  const doCreateTeam = React.useCallback(async () => {
    const name = tForm.name.trim();
    if (!name) {
      antd.message.warning(tr("团队 ID 不能为空"));
      return;
    }
    const rows = workerRows.filter((r) => r.name.trim());
    const names = rows.map((r) => r.name.trim());
    if (names.length === 0) {
      antd.message.warning(tr("至少需要 1 个 Worker（且至少 1 个 team_leader）"));
      return;
    }
    if (new Set(names).size !== names.length) {
      antd.message.warning(tr("Worker 不能重复"));
      return;
    }
    if (!rows.some((r) => r.role === "team_leader")) {
      antd.message.warning(tr("至少需要 1 个 team_leader"));
      return;
    }
    // 写前校验（入口②：建队表单 Worker 行）——先拦后写。
    const badRows = rows.filter(
      (r) => validateModelValue(r.model || "", modelCandidates).level === "error",
    );
    if (badRows.length) {
      antd.message.error(
        tr("模型校验不通过：{list}", {
          list: badRows.map((r) => `${r.name}=${(r.model || "").trim()}`).join("、"),
        }),
      );
      return;
    }
    const warnRows = rows.filter((r) => {
      const v = validateModelValue(r.model || "", modelCandidates);
      return (r.model || "").trim() && v.level === "warn";
    });
    const proceed = async () => {
      setTBusy(true);
      try {
        // /：行上填的 model/soul 先落到 Worker CR（PUT 合并语义：
        // 只发改动/非空；Team CRD 的 workerMembers 只是引用，model/soul
        // 只存在于 Worker CR——建团缺陷的结构性根因）。
        for (const r of rows) {
          const m = (r.model || "").trim();
          const s = (r.soul || "").trim();
          const cur = modelOf(r.name.trim());
          const body: Record<string, unknown> = {};
          if (m && m !== cur) body.model = m;
          if (s) body.soul = s;
          if (Object.keys(body).length) {
            await updateWorker(r.name.trim(), body);
          }
        }
        await createTeam({
          name,
          teamName: tForm.teamName.trim() || undefined,
          description: tForm.description.trim() || undefined,
          humanMembers: tForm.humanMembers.length
            ? tForm.humanMembers.map((n) => ({ name: n }))
            : undefined,
          workerMembers: rows.map((r) => ({
            name: r.name.trim(),
            role: r.role,
          })),
          heartbeatEvery: tForm.heartbeatEvery.trim() || undefined,
          peerMentions: tForm.peerMentions,
        });
        antd.message.success(tr("创建成功"));
        // 创建自检：CRD 回读 + 阶段轮询（LLM 冒烟/SOUL 检查无通道，面板如实标注）。
        startTeamCheck(
          rows.map((r) => ({
            name: r.name.trim(),
            sentModel: (r.model || "").trim(),
          })),
        );
        setTForm(EMPTY_TEAM_FORM);
        setWorkerRows([{ name: "", role: "team_leader" }]);
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      } finally {
        setTBusy(false);
      }
    };
    if (warnRows.length) {
      antd.Modal.confirm({
        title: tr("部分模型未命中在服列表"),
        content: (
          <div style={{ lineHeight: 1.8 }}>
            {warnRows.map((r) => (
              <div key={r.name}>
                {r.name} → {(r.model || "").trim()}
              </div>
            ))}
            <div>{tr("仍要继续创建吗？")}</div>
          </div>
        ),
        okText: tr("继续创建"),
        cancelText: tr("返回修改"),
        onOk: () => void proceed(),
      });
      return;
    }
    void proceed();
  }, [tForm, workerRows, onRefresh, tr, modelCandidates, modelOf, startTeamCheck]);

  const teamNames = teams.map((x) => x.name);
  const workerNames = workers.map((x) => x.name);
  const humanNames = humans.map((x) => x.name);

  // ── 配置团队（PUT 部分更新：空字段不覆盖；成员编辑 = workerMembers 全量替换）──
  const [cfgTeam, setCfgTeam] = React.useState<TeamInfo | null>(null);
  // v0.5.0-beta.13.22（13.21 装验反馈 F3）：收起动画——旧实现 cfgTeam 置 null
  // 即整树卸载=弹窗瞬间消失（弹出有动画、收起没有）。cfgOpen 控制 antd 退出
  // 过渡，afterClose 才清 cfgTeam（动画期间内容保持，不闪空）。
  const [cfgOpen, setCfgOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState({
    description: "",
    heartbeatEvery: "",
    peerMentions: true,
    subagentModel: "",
  });
  const [cfgRows, setCfgRows] = React.useState<WorkerRow[]>([]);
  const [cfgBusy, setCfgBusy] = React.useState(false);

  const openCfg = React.useCallback((team: TeamInfo) => {
    setCfgTeam(team);
    setCfgOpen(true);
    setCfg({
      description: team.description || "",
      heartbeatEvery: team.heartbeatEvery || "",
      peerMentions: team.peerMentions !== false,
      subagentModel: team.subagentModel || "",
    });
    // 预填每个成员的当前模型（admin workers 同源），diff 用于保存时只发改动
    setCfgRows(
      team.workerMembers?.length
        ? team.workerMembers.map((m) => ({
            name: m.name,
            role: m.role,
            model: modelOf(m.name),
            modelOrig: modelOf(m.name),
          }))
        : [],
    );
    // 模型候选（与创建 Worker 弹窗共享 modelOpts，空=拉一次）
    if (modelOpts.length === 0) {
      void fetchSglangModels().then(setModelOpts);
    }
    // v0.5.0-beta.12：网关 alias（一次性；available=false=无 Higress Console 会话，正常）
    if (!gatewayLoaded) void loadGatewayAliases();
    // v0.5.0-beta.13.24（F6）：批量画笔每次开弹窗复位（不跨团队残留）。
    setCfgBatchModel({ leader: "", workers: "" });
  }, [modelOf, modelOpts, gatewayLoaded, loadGatewayAliases]);

  // v0.5.0-beta.13.20：齿轮入口——拓扑 TeamNode「N人」右侧 ⚙ 点按 →
  // 按 CR 名找到 TeamInfo → 走既有 openCfg（预填/模型候选/网关 alias
  // 逻辑零复制）。注册式 handle：父侧只持有 ref，无渲染依赖。
  const { registerHandle } = props;
  React.useEffect(() => {
    if (!registerHandle) return;
    registerHandle({
      openConfig: (teamName: string) => {
        const team = teams.find((x) => x.name === teamName);
        if (!team) {
          antd.message.warning(tr("团队数据未加载或团队不存在——请刷新后重试"));
          return;
        }
        openCfg(team);
      },
    });
  }, [registerHandle, teams, openCfg, tr]);

  const updateCfgRow = React.useCallback(
    (i: number, patch: Partial<WorkerRow>) => {
      setCfgRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    },
    [],
  );
  const removeCfgRow = React.useCallback((i: number) => {
    setCfgRows((prev) => prev.filter((_, j) => j !== i));
  }, []);
  const addCfgRow = React.useCallback(() => {
    setCfgRows((prev) => [
      ...prev,
      { name: "", role: "worker", model: "", modelOrig: "" },
    ]);
  }, []);

  // v0.5.0-beta.13.24（F6·装验反馈「团队配置窗口批量改模型，leader/workers 两批」）：
  // 批量模型画笔——两把独立画笔（Leader 批 / Workers 批）。选中值即刷到对应
  // 角色行的 model 字段（行内仍可按人精修，行 diff/橙框/校验态全复用），
  // 落盘走既有「保存」链（updateTeam + 逐改动行 updateWorkerModel），
  // 零新端点。留空=不刷。只刷有名字的行（新增空行选 Worker 时自动基线）。
  const [cfgBatchModel, setCfgBatchModel] = React.useState<{
    leader: string;
    workers: string;
  }>({ leader: "", workers: "" });
  const applyCfgBatch = React.useCallback(
    (kind: "leader" | "workers", value: string) => {
      setCfgRows((prev) =>
        prev.map((r) => {
          if (!r.name.trim()) return r;
          const isLeader = r.role === "team_leader";
          const target = kind === "leader" ? isLeader : !isLeader;
          return target ? { ...r, model: value } : r;
        }),
      );
    },
    [],
  );
  const cfgBatchLeaderCount = cfgRows.filter(
    (r) => r.role === "team_leader" && r.name.trim(),
  ).length;
  const cfgBatchWorkerCount = cfgRows.filter(
    (r) => r.role !== "team_leader" && r.name.trim(),
  ).length;

  const doCfg = React.useCallback(async () => {
    if (!cfgTeam) return;
    const body: Record<string, unknown> = {
      description: cfg.description,
      // 空串=不改（上游 PUT 语义：heartbeatEvery 发 null 才表示不改）
      heartbeatEvery: cfg.heartbeatEvery.trim() || null,
      peerMentions: cfg.peerMentions,
      // v0.5.0-beta.13.21（「团队的技能等团队配置也要放在团队配置里面」）：
      // subagentModel=团队级 spawn 子代理默认模型（上游 PUT 指针语义：
      // null=清空/继承 Worker 主模型；值=覆盖）。与 heartbeatEvery 同 UX。
      subagentModel: cfg.subagentModel.trim() || null,
    };
    // 成员：源响应含 workerMembers 或用户添加了行 → 全量替换（未改动=发同列表 no-op）；
    // 源响应无该字段（旧版本）且无新增行 → 不发（避免误清空）
    if (cfgTeam.workerMembers || cfgRows.length) {
      const rows = cfgRows.filter((r) => r.name.trim());
      const names = rows.map((r) => r.name.trim());
      if (names.length === 0) {
        antd.message.warning(tr("至少需要 1 个 Worker（且至少 1 个 team_leader）"));
        return;
      }
      if (new Set(names).size !== names.length) {
        antd.message.warning(tr("Worker 不能重复"));
        return;
      }
      if (!rows.some((r) => r.role === "team_leader")) {
        antd.message.warning(tr("至少需要 1 个 team_leader"));
        return;
      }
      const missing = names.filter((n) => !workerNames.includes(n));
      if (missing.length) {
        antd.message.error(tr(`引用的 Worker CR 不存在：${missing.join("、")}（请先创建）`));
        return;
      }
      body.workerMembers = rows.map((r) => ({
        name: r.name.trim(),
        role: r.role,
      }));
    }
    // 写前校验（入口③：团队配置内联编辑）——只查改动行。
    const changedRows = cfgRows.filter((r) => {
      const m = (r.model || "").trim();
      return r.name.trim() && m && m !== (r.modelOrig ?? "");
    });
    const badCfg = changedRows.filter(
      (r) => validateModelValue(r.model || "", modelCandidates).level === "error",
    );
    if (badCfg.length) {
      antd.message.error(
        tr("模型校验不通过：{list}", {
          list: badCfg.map((r) => `${r.name}=${(r.model || "").trim()}`).join("、"),
        }),
      );
      return;
    }
    const warnCfg = changedRows.filter(
      (r) => validateModelValue(r.model || "", modelCandidates).level === "warn",
    );
    const proceedCfg = async () => {
      setCfgBusy(true);
      try {
        await updateTeam(cfgTeam.name, body);
      // 团队保存成功后，逐个应用改动的 Worker 模型（diff：未改动不发）
      const changed = cfgRows.filter((r) => {
        const m = (r.model || "").trim();
        return r.name.trim() && m && m !== (r.modelOrig ?? "");
      });
      let okCount = 0;
      for (const r of changed) {
        try {
          await updateWorkerModel(r.name.trim(), (r.model || "").trim());
          okCount += 1;
        } catch (we) {
          antd.message.error(
            `${r.name}: ${we instanceof Error ? we.message : tr("模型更新失败")}`,
          );
        }
      }
      antd.message.success(
        changed.length
          ? tr("已保存，已更新 {n} 个 Worker 模型", { n: okCount })
          : tr("已保存"),
      );
      // v0.5.0-beta.13.22（F3）：走收起动画（afterClose 清 cfgTeam）。
      setCfgOpen(false);
      onRefresh?.(true);
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
    } finally {
      setCfgBusy(false);
    }
    };
    if (warnCfg.length) {
      antd.Modal.confirm({
        title: tr("部分模型未命中在服列表"),
        content: (
          <div style={{ lineHeight: 1.8 }}>
            {warnCfg.map((r) => (
              <div key={r.name}>
                {r.name} → {(r.model || "").trim()}
              </div>
            ))}
            <div>{tr("仍要保存吗？")}</div>
          </div>
        ),
        okText: tr("确认强写"),
        cancelText: tr("返回修改"),
        onOk: () => void proceedCfg(),
      });
      return;
    }
    void proceedCfg();
  }, [cfgTeam, cfg, cfgRows, workerNames, onRefresh, tr, modelCandidates]);

  // v0.5.0-beta.13.21（undo）：删团队前快照 → 删除成功后 6s「撤销」
  // toast → 点撤销按快照重建（createTeam 原字段回写）。诚实语义=重建
  // 非恢复：Matrix 房间历史/容器状态不随 CRD 回来（上游删除是破坏性的），
  // toast 文案明示。workerMembers 只含引用（name/role），Worker CR 本体
  // 不随团队删除而删 → 重建即重新挂接。
  const undoTeam = React.useCallback(
    async (snap: TeamInfo) => {
      try {
        await createTeam({
          name: snap.name,
          teamName: snap.teamName || undefined,
          description: snap.description || undefined,
          workerMembers: (snap.workerMembers || []).map((m) => ({
            name: m.name,
            role: m.role,
          })),
          heartbeatEvery: snap.heartbeatEvery || undefined,
          peerMentions: snap.peerMentions,
          subagentModel: snap.subagentModel || undefined,
        });
        antd.message.success(tr("团队 {name} 已按快照重建", { name: snap.name }));
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(
          (tr("重建失败") + "：" + (e instanceof Error ? e.message : String(e))).slice(0, 200),
        );
      }
    },
    [onRefresh, tr],
  );

  const doDeleteTeam = React.useCallback(
    async (name: string) => {
      const snap = teams.find((t) => t.name === name) || null;
      try {
        await deleteTeam(name);
        if (snap) {
          const key = `atw-undo-team-${Date.now()}`;
          antd.message.warning({
            key,
            duration: 6,
            content: (
              <span>
                {tr("团队 {name} 已删除（房间历史与容器状态不随之恢复）", { name })}{" "}
                <a
                  onClick={() => {
                    antd.message.destroy(key);
                    void undoTeam(snap);
                  }}
                >
                  {tr("撤销（按快照重建）")}
                </a>
              </span>
            ),
          });
        } else {
          antd.message.success(tr("已删除"));
        }
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      }
    },
    [onRefresh, tr, teams, undoTeam],
  );

  // ── 权限管理（Human CRD spec 编辑）──
  // 上游 Controller REST 无 PUT /humans/{name}（dashboard updateHuman=死代码，
  // agt update 无 human 子命令）→ 生成 embedded apiserver merge-patch 命令
  // （标准姿势：token.csv 第一列 + 127.0.0.1:6443 + application/merge-patch+json）。
  const [permHuman, setPermHuman] = React.useState<HumanInfo | null>(null);
  const [permForm, setPermForm] = React.useState({
    permissionLevel: 2,
    accessibleTeams: [] as string[],
    accessibleWorkers: [] as string[],
  });
  const [permCmd, setPermCmd] = React.useState("");

  const openPerm = React.useCallback((h: HumanInfo) => {
    setPermHuman(h);
    setPermForm({
      permissionLevel: h.permissionLevel ?? 2,
      accessibleTeams: h.accessibleTeams ?? [],
      accessibleWorkers: h.accessibleWorkers ?? [],
    });
    setPermCmd("");
  }, []);

  const generatePermCmd = React.useCallback(() => {
    if (!permHuman) return;
    const spec: Record<string, unknown> = {
      permissionLevel: permForm.permissionLevel,
      accessibleTeams: permForm.accessibleTeams,
      accessibleWorkers: permForm.accessibleWorkers,
    };
    const json = JSON.stringify({ spec });
    setPermCmd(
      [
        "# 在运行 agentteams-controller 的宿主机执行",
        "# 生效：reconcile 周期（约 5 分钟）内把此人拉入/移出团队房间",
        "docker exec agentteams-controller sh -c '",
        "TOKEN=$(cut -d, -f1 /data/agentteams-controller/pki/token.csv)",
        `curl -sk -X PATCH "https://127.0.0.1:6443/apis/agentteams.io/v1beta1/namespaces/default/humans/${permHuman.name}" \\`,
        '  -H "Authorization: Bearer $TOKEN" \\',
        '  -H "Content-Type: application/merge-patch+json" \\',
        `  -d "${json.replace(/"/g, '\\"')}"`,
        "'",
      ].join("\n"),
    );
  }, [permHuman, permForm]);

  const copyPermCmd = React.useCallback(() => {
    if (!permCmd) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(permCmd).then(
        () => antd.message.success(tr("已复制")),
        () => antd.message.warning(tr("复制失败——请手动全选复制")),
      );
    } else {
      antd.message.warning(tr("复制失败——请手动全选复制"));
    }
  }, [permCmd, tr]);

  // ── 团队访问配置（员工 × 团队矩阵）──
  // v0.5.0-beta.12 ：需求——「可以配置哪些员工可以访问哪些团队」。
  // 勾选只改本地 overlay（不直写）——上游 Controller REST 无 PUT humans
  // （三重实锤同权限管理）→ 「生成命令」把全部变更汇成一条批量
  // merge-patch 脚本（每变更员工一行 patch 调用），在 Controller 宿主机
  // 执行。P-HUMANS-PUT 合并后此处零改动升级为一键 PUT（通用代理已支持）。
  const [accessOverlay, setAccessOverlay] = React.useState<
    Record<string, string[]>
  >({});
  const [accessCmd, setAccessCmd] = React.useState("");

  /** 当前生效值 = overlay 覆盖层，未覆盖 = CRD 原值。 */
  const accessOf = React.useCallback(
    (h: HumanInfo): string[] => accessOverlay[h.name] ?? h.accessibleTeams ?? [],
    [accessOverlay],
  );

  /** 有变更的员工：name → 目标 accessibleTeams（排序后与原值不等即变更）。 */
  const accessChanged = React.useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const h of humans) {
      const cur = accessOf(h);
      const orig = h.accessibleTeams ?? [];
      if (
        JSON.stringify([...cur].sort()) !== JSON.stringify([...orig].sort())
      ) {
        map[h.name] = cur;
      }
    }
    return map;
  }, [humans, accessOf]);

  const toggleAccess = React.useCallback(
    (name: string, team: string, on: boolean) => {
      const h = humans.find((x) => x.name === name);
      if (!h) return;
      const cur = accessOverlay[name] ?? h.accessibleTeams ?? [];
      const next = on ? [...cur, team] : cur.filter((x) => x !== team);
      setAccessOverlay((prev) => ({ ...prev, [name]: next }));
      setAccessCmd(""); // 数据变了，旧命令作废
    },
    [humans, accessOverlay],
  );

  const generateAccessCmd = React.useCallback(() => {
    const names = Object.keys(accessChanged);
    if (!names.length) return;
    const patchLines = names.map((n) => {
      const json = JSON.stringify({
        spec: { accessibleTeams: accessChanged[n] },
      }).replace(/"/g, '\\"');
      return `patch "${n}" "${json}"`;
    });
    setAccessCmd(
      [
        "# 在运行 agentteams-controller 的宿主机执行",
        `# 团队访问变更：${names.length} 名员工（reconcile 周期约 5 分钟生效）`,
        "docker exec agentteams-controller sh -c '",
        "TOKEN=$(cut -d, -f1 /data/agentteams-controller/pki/token.csv)",
        "patch() {",
        '  curl -sk -X PATCH "https://127.0.0.1:6443/apis/agentteams.io/v1beta1/namespaces/default/humans/$1" \\',
        '    -H "Authorization: Bearer $TOKEN" \\',
        '    -H "Content-Type: application/merge-patch+json" \\',
        '    -d "$2" && echo "  OK $1" || echo "  FAIL $1"',
        "}",
        ...patchLines,
        "'",
      ].join("\n"),
    );
  }, [accessChanged]);

  const copyAccessCmd = React.useCallback(() => {
    if (!accessCmd) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(accessCmd).then(
        () => antd.message.success(tr("已复制")),
        () => antd.message.warning(tr("复制失败——请手动全选复制")),
      );
    } else {
      antd.message.warning(tr("复制失败——请手动全选复制"));
    }
  }, [accessCmd, tr]);

  const humanCols = [
    {
      title: tr("账号"),
      dataIndex: "name",
      width: 100,
      ellipsis: true,
    },
    {
      title: tr("显示名"),
      dataIndex: "displayName",
      width: 100,
      ellipsis: true,
      render: (v: string) => v || "—",
    },
    {
      title: tr("级别"),
      dataIndex: "permissionLevel",
      width: 80,
      render: (v: number | undefined) => {
        const lv = v ?? 2;
        const m = LEVEL_META[lv] ?? { label: `L${lv}`, color: "#999" };
        const tag = <antd.Tag color={m.color}>{m.label}</antd.Tag>;
        return lv === 1 ? (
          <antd.Tooltip
            title={tr(
              "级别 1 管理员不能经 Matrix 登录获得 L2（上游设计）——团队/团队配置页需用 Controller 管理员 token",
            )}
          >
            {tag}
          </antd.Tooltip>
        ) : (
          tag
        );
      },
    },
    {
      title: tr("可访问团队"),
      dataIndex: "accessibleTeams",
      width: 210,
      render: (v: string[] | undefined) =>
        v && v.length ? (
          <antd.Space size={[0, 4]} wrap>
            {v.map((x) => (
              <antd.Tag key={x}>{x}</antd.Tag>
            ))}
          </antd.Space>
        ) : (
          "—"
        ),
    },
    {
      title: "MXID",
      dataIndex: "matrixUserID",
      // v0.5.0-beta.12（用户反馈：已有省略号的列过宽）：
      // 不定宽列在 fixed 布局吃掉全部剩余（170px）→ 定宽 120，余量给可访问团队。
      width: 120,
      ellipsis: true,
      // v0.5.0-beta.12 ：长 MXID 截断展示（前 8+…+后 4），悬停看完整值+复制
      // （对齐 dashboard Manager 卡片 TruncatedId 交互）。
      render: (v: string) => <TruncatedId value={v} label="MXID" />,
    },
    {
      title: tr("操作"),
      key: "op",
      width: 90,
      render: (_: unknown, r: HumanInfo) => (
        <antd.Space size={4}>
          <antd.Button size="small" onClick={() => openPerm(r)}>
            {tr("权限")}
          </antd.Button>
          <antd.Popconfirm
            title={tr("确认删除该员工？（不可恢复）")}
            okText={tr("删除")}
            cancelText={tr("取消")}
            onConfirm={() => void doDeleteHuman(r.name)}
          >
            <antd.Button danger size="small">
              {tr("删除")}
            </antd.Button>
          </antd.Popconfirm>
        </antd.Space>
      ),
    },
  ];

  const teamCols = [
    {
      title: tr("团队"),
      dataIndex: "name",
      width: 140,
      ellipsis: true,
      render: (v: string, r: TeamInfo) => (
        <span>
          {v}
          {r.teamName ? (
            <span style={{ color: t.textSecondary }}>（{r.teamName}）</span>
          ) : null}
        </span>
      ),
    },
    {
      title: tr("阶段"),
      dataIndex: "phase",
      width: 88,
      render: (v: string) => (
        <antd.Tag color={PHASE_COLOR[v] ?? "#999"}>{v || "—"}</antd.Tag>
      ),
    },
    {
      title: tr("Leader"),
      dataIndex: "leaderName",
      width: 110,
      ellipsis: true,
      render: (v: string) => v || "—",
    },
    {
      title: tr("就绪"),
      key: "ready",
      width: 64,
      render: (_: unknown, r: TeamInfo) =>
        `${r.readyWorkers}/${r.totalWorkers}`,
    },
    {
      title: tr("团队房间"),
      dataIndex: "teamRoomID",
      width: 140,
      ellipsis: true,
      // v0.5.0-beta.12 ：房间 ID 同为长字符串——同款截断+悬停+复制。
      // label 走 tr() 保持 EN 环境提示文案语言一致（词条已有）。
      render: (v: string) => <TruncatedId value={v} label={tr("团队房间")} />,
    },
    {
      title: tr("心跳"),
      dataIndex: "heartbeatEvery",
      width: 70,
      render: (v: string) => v || "—",
    },
    {
      title: tr("操作"),
      key: "op",
      width: 130,
      render: (_: unknown, r: TeamInfo) => (
        <antd.Space size={4}>
          <antd.Button size="small" onClick={() => openCfg(r)}>
            {tr("配置")}
          </antd.Button>
          <antd.Popconfirm
            title={tr("确认删除该团队？（不可恢复）")}
            okText={tr("删除")}
            cancelText={tr("取消")}
            onConfirm={() => void doDeleteTeam(r.name)}
          >
            <antd.Button danger size="small">
              {tr("删除")}
            </antd.Button>
          </antd.Popconfirm>
        </antd.Space>
      ),
    },
  ];

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <antd.Card
        size="small"
        title={
          <span style={{ fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <NotesIcon size={14} /> {tr("CRD 管理（L1 管理员）")}
          </span>
        }
        extra={
          // v0.5.0-beta.12.2：导出 JSON（参考 dashboard 团队页同款；按钮不用
          // emoji 图标——用户反馈，icon SVG 化在 backlog）。
          <antd.Button size="small" loading={exporting} onClick={() => void doExportCrd()}>
            {tr("导出 JSON")}
          </antd.Button>
        }
        styles={{ body: { padding: 8 } }}
      >
        {/* token 模式无 Higress Console 会话 → 网关 alias 层不可见（显式提示，
            不再静默降级——用户反馈：token 模式要提示）。 */}
        {l1TokenMode && gatewayLoaded && gatewayOpts === null ? (
          <div
            style={{
              fontSize: 12,
              color: "#ad6800",
              background: "#fffbe6",
              border: "1px solid #ffe58f",
              borderRadius: 4,
              padding: "4px 8px",
              marginBottom: 8,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 5 }}><WarnIcon size={12} style={{ marginTop: 2, flexShrink: 0 }} /> {tr("token 模式无 Higress Console 会话——Higress alias 层当前不可见。配置 admin 账号密码后，「Higress alias（路由可解析）」与「Higress 内置 alias」分组将出现在模型下拉中；或等待 P1-3 上游 PR（controller_token 直连 Higress Console）合入。")}</span>
          </div>
        ) : null}
        {/* v0.5.0-beta.13（装验 9/19）：三张快捷操作卡同排（lg=8×3）+
            可折叠——此前 员工入职/创建团队 各占半行、新建 Worker 单占半行。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: crdCardsOpen ? 6 : 0 }}>
          <antd.Button
            size="small"
            type="text"
            style={{ padding: 0, fontSize: 12, height: "auto" }}
            onClick={() => setCrdCardsOpen((v) => !v)}
          >
            {crdCardsOpen
              ? `▾ ${tr("收起快捷操作（员工入职 / 创建团队 / 新建 Worker）")}`
              : `▸ ${tr("展开快捷操作（员工入职 / 创建团队 / 新建 Worker）")}`}
          </antd.Button>
        </div>
        {crdCardsOpen ? (
        <antd.Row gutter={[10, 10]}>
          <antd.Col xs={24} lg={8}>
            <antd.Card
              size="small"
              title={tr("员工入职（Human CRD）")}
              styles={{ body: { padding: 10 } }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                <antd.Input
                  size="small"
                  placeholder={tr("账号名（Matrix localpart，如 alice）")}
                  value={hForm.name}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setHForm({ ...hForm, name: e.target.value })
                  }
                />
                <antd.Input
                  size="small"
                  placeholder={tr("显示名（如 张三）")}
                  value={hForm.displayName}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setHForm({ ...hForm, displayName: e.target.value })
                  }
                />
                <antd.Input
                  size="small"
                  placeholder={tr("邮箱（可选）")}
                  value={hForm.email}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setHForm({ ...hForm, email: e.target.value })
                  }
                />
                <antd.Select
                  size="small"
                  style={{ width: "100%" }}
                  value={hForm.permissionLevel}
                  onChange={(v: number) =>
                    setHForm({ ...hForm, permissionLevel: v })
                  }
                  options={[
                    {
                      value: 2,
                      label: tr("2 = 团队成员（Matrix 登录 → L2，可看本团队）"),
                    },
                    {
                      value: 1,
                      label: tr(
                        "1 = 管理员（L1；Matrix 登录拿不到 L1，需用管理员 token）",
                      ),
                    },
                    { value: 3, label: tr("3 = Worker") },
                  ]}
                />
                <antd.Select
                  size="small"
                  mode="multiple"
                  allowClear
                  style={{ width: "100%" }}
                  placeholder={tr("可访问团队（可选）")}
                  value={hForm.accessibleTeams}
                  onChange={(v: string[]) =>
                    setHForm({ ...hForm, accessibleTeams: v })
                  }
                  options={teamNames.map((n) => ({ value: n, label: n }))}
                />
                <antd.Select
                  size="small"
                  mode="multiple"
                  allowClear
                  style={{ width: "100%" }}
                  placeholder={tr("可访问 Worker（可选）")}
                  value={hForm.accessibleWorkers}
                  onChange={(v: string[]) =>
                    setHForm({ ...hForm, accessibleWorkers: v })
                  }
                  options={workerNames.map((n) => ({ value: n, label: n }))}
                />
                <antd.Input
                  size="small"
                  placeholder={tr("备注（可选）")}
                  value={hForm.note}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setHForm({ ...hForm, note: e.target.value })}
                />
                <antd.Button
                  size="small"
                  type="primary"
                  loading={hBusy}
                  onClick={() => void doCreateHuman()}
                >
                  {tr("确认入职")}
                </antd.Button>
              </div>
            </antd.Card>
          </antd.Col>
          <antd.Col xs={24} lg={8}>
            <antd.Card
              size="small"
              title={tr("创建团队（Team CRD）")}
              styles={{ body: { padding: 10 } }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                <FieldLabel>{tr("团队 ID（唯一，小写字母/数字/-）")}</FieldLabel>
                <antd.Input
                  size="small"
                  placeholder={tr("团队 ID（唯一，小写字母/数字/-）")}
                  value={tForm.name}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setTForm({ ...tForm, name: e.target.value })
                  }
                />
                <FieldLabel>{tr("团队显示名（可选）")}</FieldLabel>
                <antd.Input
                  size="small"
                  placeholder={tr("团队显示名（可选）")}
                  value={tForm.teamName}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setTForm({ ...tForm, teamName: e.target.value })
                  }
                />
                <FieldLabel>{tr("描述（可选）")}</FieldLabel>
                <antd.Input
                  size="small"
                  placeholder={tr("描述（可选）")}
                  value={tForm.description}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setTForm({ ...tForm, description: e.target.value })
                  }
                />
                <FieldLabel>{tr("人类成员（可选，仅创建时可设）")}</FieldLabel>
                <antd.Select
                  size="small"
                  mode="multiple"
                  allowClear
                  style={{ width: "100%" }}
                  placeholder={tr("人类成员（可选，仅创建时可设）")}
                  value={tForm.humanMembers}
                  onChange={(v: string[]) =>
                    setTForm({ ...tForm, humanMembers: v })
                  }
                  options={humanNames.map((n) => ({ value: n, label: n }))}
                />
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("Worker 成员（必填，至少 1 个 team_leader）")}
                </div>
                {workerRows.map((row, i) => {
                  const taken = new Set(
                    workerRows
                      .map((r, j) => (j === i ? "" : r.name))
                      .filter(Boolean),
                  );
                  const rowMv = validateModelValue(
                    row.model || "",
                    modelCandidates,
                  );
                  return (
                    <div
                      key={i}
                      style={{
                        display: "grid",
                        gap: 6,
                        border: `1px dashed ${t.border}`,
                        borderRadius: 8,
                        padding: 8,
                      }}
                    >
                      {/* v0.5.0-beta.12（用户反馈：选项标签——配置团队弹窗
                          同名需求，建队卡片同构补齐，不留半截）。 */}
                      <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                        {tr("名称 / 角色")}
                      </div>
                      {/* v0.5.0-beta.12（用户反馈：竖屏创建团队卡溢出——
                          行内 Select flex 项 min-width:auto 撑宽，与 cfgRows
                          同几何：40% 基线 + wrap 断撑链）。 */}
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <antd.Select
                          size="small"
                          showSearch
                          style={{ flex: "1 1 40%", minWidth: 0 }}
                          placeholder={tr("选择 Worker（已有 CR）")}
                          value={row.name || undefined}
                          onChange={(v: string) => {
                            // ：选中即预填该 Worker CR 现值（diff 基线）
                            const mm = modelOf(v);
                            updateRow(i, {
                              name: v,
                              model: mm,
                              modelOrig: mm,
                              soul: "",
                              soulOpen: false,
                            });
                          }}
                          options={workerNames
                            .filter((n) => !taken.has(n))
                            .map((n) => ({
                              value: n,
                              label: workerOptionLabel(n, workers),
                            }))}
                        />
                        <antd.Select
                          size="small"
                          style={{ width: 132 }}
                          value={row.role}
                          onChange={(v: string) => updateRow(i, { role: v })}
                          options={roleSelectOptions(tr)}
                        />
                        {workerRows.length > 1 ? (
                          <antd.Button
                            size="small"
                            type="text"
                            danger
                            onClick={() => removeRow(i)}
                          >
                            ×
                          </antd.Button>
                        ) : null}
                      </div>
                      {/* /：行级模型（AutoComplete + 写前校验实时提示） */}
                      <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                        {tr("模型")}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {/* v0.5.0-beta.12（用户反馈：新建团队 Worker 模型问题）：240 定宽，与配置团队/Manager 表同几何。 */}
                        <antd.AutoComplete
                          size="small"
                          style={{ width: 240 }}
                          placeholder={tr("模型（留空=不改；新建跟随集群默认；下拉=在服∪在用∪Higress alias）")}
                          options={modelOptions as { value: string }[]}
                          value={row.model || ""}
                          onChange={(v: string) => updateRow(i, { model: v })}
                          status={
                            rowMv.level === "error"
                              ? "error"
                              : rowMv.level === "warn"
                                ? "warning"
                                : undefined
                          }
                        />
                        {(row.model || "").trim() && rowMv.level !== "ok" ? (
                          <antd.Tooltip title={modelVerdictText(tr, rowMv, row.model || "", modelCandidates)}>
                            <span
                              style={{
                                fontSize: 11,
                                cursor: "help",
                                color: rowMv.level === "error" ? "#f5222d" : "#fa8c16",
                              }}
                            >
                              {rowMv.level === "error" ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                                  <CloseIcon size={10} /> {tr("路径形态")}
                                </span>
                              ) : (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                                  <WarnIcon size={10} /> {tr("未命中")}
                                </span>
                              )}
                            </span>
                          </antd.Tooltip>
                        ) : null}
                      </div>
                      {/* ：行级 SOUL（折叠；多行+上传） */}
                      <div>
                        <antd.Button
                          size="small"
                          type="link"
                          style={{ padding: 0, fontSize: 11 }}
                          onClick={() =>
                            updateRow(i, { soulOpen: !row.soulOpen })
                          }
                        >
                          <DocIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {tr("SOUL（可选，多行/上传）")}
                          {(row.soul || "").trim() ? <CheckIcon size={10} style={{ color: "#52c41a", verticalAlign: "-1px", marginLeft: 2 }} /> : null}
                          {row.soulOpen ? " ▾" : " ▸"}
                        </antd.Button>
                        {row.soulOpen ? (
                          <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
                            <antd.Input.TextArea
                              size="small"
                              autoSize={{ minRows: 3, maxRows: 10 }}
                              placeholder={tr("SOUL 全文（写入 spec.soul；预算 team_leader≤250 / worker≤150 行）")}
                              value={row.soul || ""}
                              onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                                updateRow(i, { soul: e.target.value })
                              }
                            />
                            <antd.Upload
                              showUploadList={false}
                              beforeUpload={(f: File) => {
                                loadSoulFile(f, row.role, (t) =>
                                  updateRow(i, { soul: t }),
                                );
                                return false;
                              }}
                            >
                              <antd.Button size="small" type="text" style={{ padding: 0, height: "auto" }}>
                                <ClipIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {tr("上传 SOUL 文件")}
                              </antd.Button>
                            </antd.Upload>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <antd.Button
                  size="small"
                  type="dashed"
                  block
                  onClick={addRow}
                >
                  ＋ {tr("添加 Worker")}
                </antd.Button>
                <FieldLabel>{tr("心跳间隔（可选，如 10m）")}</FieldLabel>
                <antd.Input
                  size="small"
                  placeholder={tr("心跳间隔（可选，如 10m）")}
                  value={tForm.heartbeatEvery}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setTForm({ ...tForm, heartbeatEvery: e.target.value })
                  }
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <antd.Switch
                    size="small"
                    checked={tForm.peerMentions}
                    onChange={(v: boolean) =>
                      setTForm({ ...tForm, peerMentions: v })
                    }
                  />
                  <span style={{ fontSize: 11 }}>
                    {tr("peerMentions（团队成员可互 @）")}
                  </span>
                </div>
                <antd.Button
                  size="small"
                  type="primary"
                  loading={tBusy}
                  onClick={() => void doCreateTeam()}
                >
                  {tr("确认创建")}
                </antd.Button>
              </div>
            </antd.Card>
            {/*  创建自检（建队成功自动跑：CRD 回读 + 阶段轮询 5s×3min；
                LLM 冒烟/SOUL 检查=插件无网关 key/容器通道，如实标注不装）。 */}
            {tCheck ? (
              <div
                style={{
                  border: `1px solid ${tCheck.done ? t.border : "rgba(255,127,22,0.45)"}`,
                  borderRadius: 10,
                  padding: 10,
                  background: t.cardBg,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <SearchIcon size={12} /> {tr("创建自检")}
                  </span>
                  {tCheck.running ? (
                    <antd.Tag color="processing">{tr("进行中（5s 轮询，最长 3 分钟）")}</antd.Tag>
                  ) : (
                    <antd.Tag color="green">{tr("已完成")}</antd.Tag>
                  )}
                  <span style={{ flex: 1 }} />
                  <antd.Button
                    size="small"
                    onClick={() =>
                      startTeamCheck(
                        tCheck.rows.map((r) => ({
                          name: r.name,
                          sentModel: r.sentModel,
                        })),
                      )
                    }
                  >
                    <RefreshIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("重新检查")}
                  </antd.Button>
                </div>
                <div style={{ display: "grid", gap: 5, fontSize: 12 }}>
                  {tCheck.rows.map((r) => (
                    <div
                      key={r.name}
                      style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                    >
                      <span style={{ fontWeight: 600, minWidth: 150 }}>
                        {r.ready ? <CheckIcon size={12} style={{ color: "#52c41a", verticalAlign: "-1px", marginRight: 3 }} /> : <ClockIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} />} {r.name}
                      </span>
                      <span style={{ color: r.modelOk ? t.textSecondary : "#f5222d" }}>
                        {r.sentModel ? (
                          r.crdModel === r.sentModel ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                              model <CheckIcon size={10} style={{ color: "#52c41a" }} /> {r.sentModel}
                            </span>
                          ) : r.crdModel ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                              model <CloseIcon size={10} style={{ color: "#f5222d" }} /> {tr("期望")} {r.sentModel}，CRD={r.crdModel}
                            </span>
                          ) : (
                            `model … 已提交 ${r.sentModel}（CRD 尚未回读）`
                          )
                        ) : (
                          <>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                              model <WarnIcon size={10} style={{ color: "#fa8c16" }} /> {tr("无显式模型（跟随集群默认；若集群无默认，该 Worker 无模型）")}
                            </span>
                          </>
                        )}
                      </span>
                      <span style={{ color: t.textSecondary }}>
                        phase: {r.phase || tr("等待调和")} · container: {r.container || "—"}
                      </span>
                      {r.message ? (
                        <span style={{ color: "#fa8c16" }}>{r.message}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: t.textSecondary, lineHeight: 1.8 }}>
                  ◌ LLM 冒烟（网关实弹）：{tr("当前版本暂不支持（插件无网关 key 通道，待上游 API）")}
                  <br />
                  ◌ SOUL stub 检查（容器内行数）：{tr("当前版本暂不支持（无容器通道；创建后请到团队房间发一条消息验证 Worker 应答）")}
                </div>
              </div>
            ) : null}
          </antd.Col>
          {/* v0.5.0-beta.12.2（用户反馈：创建 Worker 独立成卡）：
              新建 Worker 从建队卡内折叠区独立成卡（建队卡聚焦团队字段）。
              行为不变：创建成功后仍自动加入建队表单的 Worker 成员行。
              模型/alias 拉取由组件 mount 时统一触发（原展开时拉取的逻辑移除）。 */}
          <antd.Col xs={24} lg={8}>
            <antd.Card
              size="small"
              title={
                <span style={{ fontWeight: 700 }}>
                  {tr("新建 Worker（Worker CRD）")}
                </span>
              }
              styles={{ body: { padding: 10 } }}
            >
              <div style={{ display: "grid", gap: 6 }}>
                <FieldLabel>{tr("Worker 名（唯一，小写字母/数字/-）")}</FieldLabel>
                <antd.Input
                  size="small"
                  placeholder={tr("Worker 名（唯一，小写字母/数字/-）")}
                  value={nw.name}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setNw((p) => ({ ...p, name: e.target.value }))
                  }
                />
                {/* v0.5.0-beta.12.2：运行时下拉 4 项——copaw 退役移除、
                    deepseek-harness 补上（上游 RuntimeDeepSeekHarness 常量实锤）、
                    默认 qwenpaw（安装脚本 AGENTTEAMS_DEFAULT_WORKER_RUNTIME:-qwenpaw）。 */}
                <FieldLabel>{tr("运行时")}</FieldLabel>
                <antd.Select
                  size="small"
                  value={nw.runtime}
                  onChange={(v: string) => setNw((p) => ({ ...p, runtime: v }))}
                  options={[
                    { value: "openclaw", label: "OpenClaw" },
                    { value: "hermes", label: "Hermes" },
                    { value: "qwenpaw", label: "QwenPaw" },
                    { value: "deepseek-harness", label: "DeepSeek Harness" },
                  ]}
                  style={{ width: "100%" }}
                />
                <FieldLabel>{tr("模型（留空=跟随集群默认）")}</FieldLabel>
                <antd.AutoComplete
                  size="small"
                  placeholder={tr("模型（留空=跟随集群默认；下拉=在服∪在用∪Higress alias）")}
                  options={modelOptions as { value: string }[]}
                  value={nw.model}
                  onChange={(v: string) =>
                    setNw((p) => ({ ...p, model: v }))
                  }
                  style={{ width: "100%" }}
                />
                {(() => {
                  const mv = validateModelValue(nw.model, modelCandidates);
                  if (mv.level === "ok" && !(nw.model || "").trim()) return null;
                  return (
                    <div
                      style={{
                        fontSize: 10.5,
                        color:
                          mv.level === "error"
                            ? "#f5222d"
                            : mv.level === "warn"
                              ? "#fa8c16"
                              : "#52c41a",
                      }}
                    >
                      {mv.level === "ok" ? <CheckIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> : mv.level === "error" ? <CloseIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> : <WarnIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} />}
                      {modelVerdictText(tr, mv, nw.model, modelCandidates)}
                    </div>
                  );
                })()}
                <FieldLabel>{tr("SOUL（可选，多行，worker≤150 行）")}</FieldLabel>
                <antd.Input.TextArea
                  size="small"
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  placeholder={tr("SOUL（可选，多行；可上传 .md/.txt，worker≤150 行）")}
                  value={nw.soul}
                  onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                    setNw((p) => ({ ...p, soul: e.target.value }))
                  }
                />
                <antd.Upload
                  showUploadList={false}
                  beforeUpload={(f: File) => {
                    loadSoulFile(f, "worker", (t) =>
                      setNw((p) => ({ ...p, soul: t })),
                    );
                    return false;
                  }}
                >
                  <antd.Button size="small" type="text" style={{ padding: 0, height: "auto" }}>
                    <ClipIcon size={11} style={{ verticalAlign: "-1px", marginRight: 2 }} /> {tr("上传 SOUL 文件")}
                  </antd.Button>
                </antd.Upload>
                <antd.Button
                  size="small"
                  type="primary"
                  loading={nw.busy}
                  onClick={() => void doCreateWorker()}
                >
                  {tr("创建并加入团队")}
                </antd.Button>
                <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                  {tr("创建后由 Controller 调和器拉镜像起容器（数分钟就绪）；可先保存团队，Worker 就绪后自动生效。")}
                </div>
              </div>
            </antd.Card>
          </antd.Col>
        </antd.Row>
        ) : null}
        <antd.Space
          direction="vertical"
          size={12}
          style={{ display: "flex", marginTop: 12 }}
        >
          {/* v0.5.0-beta.12 ：团队访问配置矩阵（员工 × 团队）。
              勾选 = 本地目标态；「生成命令」汇成批量 merge-patch 脚本
              （上游无 PUT humans——P-HUMANS-PUT 合并后升级一键 PUT）。 */}
          <antd.Card
            size="small"
            title={tr("团队访问配置（员工 × 团队）")}
            styles={{ body: { padding: 0 } }}
            extra={
              <antd.Button
                size="small"
                type="primary"
                disabled={!Object.keys(accessChanged).length}
                onClick={generateAccessCmd}
              >
                {tr("生成命令")}
              </antd.Button>
            }
          >
            <div
              style={{
                padding: "6px 12px",
                fontSize: 11,
                color: t.textSecondary,
                borderBottom: `1px solid ${t.border}`,
              }}
            >
              {tr(
                "勾选要授予/取消的团队——改动先落本地，点「生成命令」后复制到 Controller 宿主机执行才真正生效（reconcile 约 5 分钟把员工拉入/移出团队房间）。上游 PR P-HUMANS-PUT 合并后此处升级为一键保存。",
              )}
            </div>
            <antd.Table
              size="small"
              rowKey="name"
              pagination={false}
              scroll={{ x: 160 + teams.length * 96 }}
              dataSource={humans}
              locale={{ emptyText: tr("暂无人员记录") }}
              columns={[
                {
                  title: tr("账号"),
                  dataIndex: "name",
                  width: 160,
                  render: (v: string, r: HumanInfo) => (
                    <div>
                      {v}
                      {r.displayName ? (
                        <div style={{ fontSize: 10, color: t.textSecondary }}>
                          {r.displayName}
                        </div>
                      ) : null}
                    </div>
                  ),
                },
                ...teams.map((tm) => ({
                  title: tm.name,
                  key: `team_${tm.name}`,
                  width: 96,
                  align: "center" as const,
                  render: (_: unknown, r: HumanInfo) => (
                    <antd.Checkbox
                      checked={accessOf(r).includes(tm.name)}
                      onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                        toggleAccess(r.name, tm.name, e.target.checked)
                      }
                    />
                  ),
                })),
                {
                  title: tr("状态"),
                  key: "access_status",
                  width: 80,
                  render: (_: unknown, r: HumanInfo) =>
                    accessChanged[r.name] ? (
                      <antd.Tag color="orange">{tr("已改动")}</antd.Tag>
                    ) : (
                      <span style={{ color: t.textSecondary }}>—</span>
                    ),
                },
              ]}
            />
            {accessCmd ? (
              <div style={{ padding: "0 12px 12px" }}>
                <antd.Input.TextArea
                  rows={8}
                  readOnly
                  value={accessCmd}
                  style={{ fontFamily: "monospace", fontSize: 11 }}
                />
                <antd.Button
                  size="small"
                  style={{ marginTop: 6 }}
                  onClick={copyAccessCmd}
                >
                  {tr("复制命令")}
                </antd.Button>
              </div>
            ) : null}
          </antd.Card>
          <antd.Card
            size="small"
            title={tr("人员列表")}
            styles={{ body: { padding: 0 } }}
          >
            <antd.Table
              size="small"
              rowKey="name"
              columns={humanCols}
              dataSource={humans}
              pagination={false}
              tableLayout="fixed"
              scroll={{ x: 700 }}
              locale={{ emptyText: tr("暂无人员记录") }}
            />
          </antd.Card>
          <antd.Card
            size="small"
            title={tr("团队列表")}
            styles={{ body: { padding: 0 } }}
          >
            <antd.Table
              size="small"
              rowKey="name"
              columns={teamCols}
              dataSource={teams}
              pagination={false}
              tableLayout="fixed"
              scroll={{ x: 820 }}
              locale={{ emptyText: tr("暂无团队记录") }}
            />
          </antd.Card>
        </antd.Space>
      </antd.Card>

      {/* 入职成功——initialPassword 只显示一次 */}
      {created ? (
        <antd.Modal
          open
          title={tr("入职成功——初始密码")}
          onCancel={() => setCreated(null)}
          footer={
            <antd.Space>
              <antd.Button onClick={copyPassword}>{tr("复制")}</antd.Button>
              <antd.Button type="primary" onClick={() => setCreated(null)}>
                {tr("我已保存")}
              </antd.Button>
            </antd.Space>
          }
        >
          <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 10 }}>
            {tr(
              "此密码只显示一次，关闭后无法找回。请让用户首次 Matrix 登录后立即修改。",
            )}
          </div>
          <antd.Input
            readOnly
            value={`${created.name} / ${created.password}`}
            style={{ fontFamily: "monospace" }}
          />
        </antd.Modal>
      ) : null}

      {/* 配置团队（PUT 部分更新） */}
      {cfgTeam ? (
        <antd.Modal
          open={cfgOpen}
          width={780}
          title={`${tr("配置团队")} · ${cfgTeam.name}`}
          // v0.5.0-beta.13.22（F3）：收起动画——onCancel 只关 cfgOpen（antd
          // 播退出过渡），afterClose 才卸载（cfgTeam=null），动画期间内容
          // 保持不闪空。
          onCancel={() => setCfgOpen(false)}
          afterClose={() => setCfgTeam(null)}
          footer={
            <antd.Space>
              <antd.Button onClick={() => setCfgOpen(false)}>
                {tr("取消")}
              </antd.Button>
              <antd.Button
                type="primary"
                loading={cfgBusy}
                onClick={() => void doCfg()}
              >
                {tr("保存")}
              </antd.Button>
            </antd.Space>
          }
        >
          <div style={{ display: "grid", gap: 10 }}>
                <FieldLabel>{tr("描述（留空 = 保持不变）")}</FieldLabel>
            <antd.Input.TextArea
              rows={2}
              placeholder={tr("描述（留空 = 保持不变）")}
              value={cfg.description}
              onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                setCfg({ ...cfg, description: e.target.value })
              }
            />
                <FieldLabel>{tr("心跳间隔（留空 = 保持不变，如 10m）")}</FieldLabel>
            <antd.Input
              size="small"
              placeholder={tr("心跳间隔（留空 = 保持不变，如 10m）")}
              value={cfg.heartbeatEvery}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setCfg({ ...cfg, heartbeatEvery: e.target.value })
              }
            />
            {/* v0.5.0-beta.13.21（「团队的技能等团队配置也要放在团队配置里面」）：
                subagentModel=团队级 spawn 子代理默认模型（""=继承 Worker 主模型）。
                v0.5.0-beta.13.22（13.21 装验反馈 F6）：裸 Input → 与 Worker 选模型
                同款 AutoComplete（同数据源 modelOptions=在服∪在用模型∪网关 alias，
                同 validateModelValue 校验态）——「来源一样」。 */}
            <FieldLabel>{tr("子代理默认模型（留空 = 继承各 Worker 主模型）")}</FieldLabel>
            <antd.AutoComplete
              size="small"
              style={{ width: 320, maxWidth: "100%" }}
              placeholder={tr("子代理默认模型（如 qwen3.6:27b-fp8；留空 = 继承）")}
              options={modelOptions as { value: string }[]}
              value={cfg.subagentModel}
              onChange={(v: string) => setCfg({ ...cfg, subagentModel: v })}
              status={(() => {
                const v = cfg.subagentModel.trim();
                if (!v) return undefined;
                const lv = validateModelValue(v, modelCandidates).level;
                return lv === "error" ? "error" : lv === "warn" ? "warning" : undefined;
              })()}
            />
            {(() => {
              const v = cfg.subagentModel.trim();
              if (!v) return null;
              const sv = validateModelValue(v, modelCandidates);
              return sv.level === "ok" ? null : (
                <antd.Tooltip title={modelVerdictText(tr, sv, v, modelCandidates)}>
                  <antd.Tag color={sv.level === "error" ? "red" : "orange"} style={{ marginBottom: 4 }}>
                    {sv.level === "error" ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <CloseIcon size={10} /> {tr("路径形态")}
                      </span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <WarnIcon size={10} /> {tr("未命中")}
                      </span>
                    )}
                  </antd.Tag>
                </antd.Tooltip>
              );
            })()}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <antd.Switch
                size="small"
                checked={cfg.peerMentions}
                onChange={(v: boolean) =>
                  setCfg({ ...cfg, peerMentions: v })
                }
              />
              <span style={{ fontSize: 11 }}>
                {tr("peerMentions（团队成员可互 @）")}
              </span>
            </div>
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr(
                "人类成员（humanMembers）仅创建团队时可设——上游 PUT 不应用该字段，如需变更请删除重建。",
              )}
            </div>
            {cfgTeam.workerMembers || cfgRows.length ? (
              <>
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("团队成员（workerMembers）——保存 = 全量替换成员列表")}
                </div>
                {/* v0.5.0-beta.13.24（F6·装验反馈「团队配置的窗口应该增加批量改模型，
                    leader/workers 两批」）：批量模型画笔——Leader 批 / Workers 批
                    两把独立 AutoComplete（数据源/校验态与行内模型框完全同源：
                    modelOptions=在服∪在用∪网关 alias，validateModelValue）。
                    选中值即刷到对应角色行的 model（行内仍可按人精修）；留空=不刷；
                    落盘=下方「保存」的既有 diff 链（只发改动行），零新端点。 */}
                <div
                  style={{
                    display: "grid",
                    gap: 6,
                    border: `1px solid ${t.border}`,
                    borderRadius: 8,
                    padding: 8,
                    background: t.bg,
                  }}
                >
                  <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                    {tr("批量设置模型（选中值直接刷到对应角色全部成员；留空 = 不改）")}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                        {tr("Leader 批（{n} 人）", { n: cfgBatchLeaderCount })}
                      </div>
                      <antd.AutoComplete
                        size="small"
                        style={{ width: "100%" }}
                        placeholder={tr("批量模型（选中=刷到该批全部成员）")}
                        options={modelOptions as { value: string }[]}
                        value={cfgBatchModel.leader}
                        onChange={(v: string) => {
                          setCfgBatchModel((p) => ({ ...p, leader: v }));
                          applyCfgBatch("leader", v);
                        }}
                        status={(() => {
                          const v = cfgBatchModel.leader.trim();
                          if (!v) return undefined;
                          const lv = validateModelValue(v, modelCandidates).level;
                          return lv === "error"
                            ? "error"
                            : lv === "warn"
                              ? "warning"
                              : undefined;
                        })()}
                      />
                    </div>
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                        {tr("Workers 批（{n} 人）", { n: cfgBatchWorkerCount })}
                      </div>
                      <antd.AutoComplete
                        size="small"
                        style={{ width: "100%" }}
                        placeholder={tr("批量模型（选中=刷到该批全部成员）")}
                        options={modelOptions as { value: string }[]}
                        value={cfgBatchModel.workers}
                        onChange={(v: string) => {
                          setCfgBatchModel((p) => ({ ...p, workers: v }));
                          applyCfgBatch("workers", v);
                        }}
                        status={(() => {
                          const v = cfgBatchModel.workers.trim();
                          if (!v) return undefined;
                          const lv = validateModelValue(v, modelCandidates).level;
                          return lv === "error"
                            ? "error"
                            : lv === "warn"
                              ? "warning"
                              : undefined;
                        })()}
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: 10.5, color: t.textSecondary }}>
                    {tr(
                      "画笔语义：选中值立即同步到对应行的「模型」（行内仍可按人精修，覆盖刷值）；调整角色/新增行不会自动补刷——对那批重新选一次即可。",
                    )}
                  </div>
                </div>
                {/* v0.5.0-beta.12（历史缺陷：标题位置——11.7 共享头行的「模型」悬在满宽模型框上方错位，
                    标题没有落在它的框上）：删共享头，改每行行内标签
                    （与建队卡同构：名称/角色、模型 各管各的框）。 */}
                {cfgRows.map((row, i) => {
                  const taken = new Set(
                    cfgRows
                      .map((r, j) => (j === i ? "" : r.name))
                      .filter(Boolean),
                  );
                  const missingRef =
                    !!row.name && !workerNames.includes(row.name);
                  // 模型内联编辑——diff 原值，改动行橙框提示
                  const modelChanged =
                    !!row.model?.trim() &&
                    row.model.trim() !== (row.modelOrig ?? "");
                  return (
                    <div
                      key={i}
                      style={{
                        display: "grid",
                        gap: 6,
                        border: `1px dashed ${t.border}`,
                        borderRadius: 8,
                        padding: 8,
                      }}
                    >
                      <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                        {tr("名称 / 角色")}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <antd.Select
                        size="small"
                        showSearch
                        style={{ flex: "1 1 40%", minWidth: 0 }}
                        placeholder={tr("选择 Worker")}
                        value={row.name || undefined}
                        onChange={(v: string) => {
                          // 换 Worker = 模型重新基线到新成员的现值（防串改）
                          const mm = workers.find((w) => w.name === v)?.model || "";
                          updateCfgRow(i, { name: v, model: mm, modelOrig: mm });
                        }}
                        options={workerNames
                          .filter((n) => !taken.has(n))
                          .map((n) => ({
                            value: n,
                            label: workerOptionLabel(n, workers),
                          }))}
                      />
                      <antd.Select
                        size="small"
                        style={{ width: 132 }}
                        value={row.role}
                        onChange={(v: string) => updateCfgRow(i, { role: v })}
                        options={roleSelectOptions(tr)}
                      />
                      {missingRef ? (
                        <antd.Tag color="red">{tr("不存在")}</antd.Tag>
                      ) : null}
                      {cfgRows.length > 1 ? (
                        <antd.Button
                          size="small"
                          type="text"
                          danger
                          onClick={() => removeCfgRow(i)}
                        >
                          ×
                        </antd.Button>
                      ) : null}
                      </div>
                      {/* v0.5.0-beta.12：模型框 240 定宽（原 1 1 100% 满宽
                          =「超宽」；与 Manager 表模型列 180-240 同几何）+ 行内
                          「模型」标签落在框正上方。 */}
                      <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
                        {tr("模型")}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <antd.AutoComplete
                        size="small"
                        style={{
                          width: 240,
                          borderColor: modelChanged ? "#fa8c16" : undefined,
                        }}
                        placeholder={tr("模型（留空=不改；下拉=在服∪在用模型，provider 不变）")}
                        options={modelOptions as { value: string }[]}
                        value={row.model || ""}
                        onChange={(v: string) => updateCfgRow(i, { model: v })}
                        status={
                          modelChanged
                            ? validateModelValue(row.model || "", modelCandidates).level === "error"
                              ? "error"
                              : validateModelValue(row.model || "", modelCandidates).level === "warn"
                                ? "warning"
                                : undefined
                            : undefined
                        }
                      />
                      {modelChanged ? (
                        (() => {
                          const cmv = validateModelValue(row.model || "", modelCandidates);
                          return cmv.level === "ok" ? (
                            <antd.Tag color="orange">{tr("模型已改动")}</antd.Tag>
                          ) : (
                            <antd.Tooltip
                              title={modelVerdictText(tr, cmv, row.model || "", modelCandidates)}
                            >
                              <antd.Tag color={cmv.level === "error" ? "red" : "orange"}>
                                {cmv.level === "error" ? (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                                    <CloseIcon size={10} /> {tr("路径形态")}
                                  </span>
                                ) : (
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                                    <WarnIcon size={10} /> {tr("未命中")}
                                  </span>
                                )}
                              </antd.Tag>
                            </antd.Tooltip>
                          );
                        })()
                      ) : null}
                      </div>
                    </div>
                  );
                })}
                <antd.Button
                  size="small"
                  type="dashed"
                  block
                  onClick={addCfgRow}
                >
                  ＋ {tr("添加 Worker")}
                </antd.Button>
              </>
            ) : null}
            {/* v0.5.0-beta.13.21（13.20 装验「团队的技能等团队配置也要放在团队
                配置里面，和技能中心一样的搜索/上传/自定义等」）：团队技能节=
                SkillCenter 同款组件 onlyTeam 模式内嵌（目录搜索/上传/自定义/
                下载 + 成员分配矩阵 + MCP 卡；保存走原技能中心端点链，本弹窗
                底部「保存」只管团队 PUT，互不干扰）。L1/L2 分权：L1 可管理
                任意团队；L2 用户走「技能中心（我的团队）」（服务端按本团队
                作用域强校验，两条入口同权同级）。高度封顶 460 弹窗内滚动。 */}
            <antd.Divider style={{ margin: "10px 0 8px" }}>
              {tr("团队技能（目录 / 分配矩阵 / MCP）")}
            </antd.Divider>
            <div
              style={{
                maxHeight: 460,
                overflowY: "auto",
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                padding: 8,
              }}
            >
              <SkillCenter onlyTeam={cfgTeam.name} />
            </div>
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("技能/分配/MCP 的保存独立于上方「保存」按钮（走技能中心原端点）；L2 用户经「技能中心（我的团队）」入口，同能力、服务端限本团队。")}
            </div>
          </div>
        </antd.Modal>
      ) : null}

      {/* 权限管理（Human CRD spec）——上游无 UpdateHuman API，生成 merge-patch 命令 */}
      {permHuman ? (
        <antd.Modal
          open
          title={`${tr("权限管理")} · ${permHuman.name}`}
          onCancel={() => setPermHuman(null)}
          footer={
            <antd.Space>
              <antd.Button onClick={() => setPermHuman(null)}>
                {tr("关闭")}
              </antd.Button>
              <antd.Button
                type="primary"
                onClick={() => generatePermCmd()}
              >
                {tr("生成命令")}
              </antd.Button>
            </antd.Space>
          }
        >
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr(
                "上游 Controller 无 UpdateHuman API（dashboard 的 updateHuman 是死代码）——这里生成「内嵌 apiserver merge-patch」命令，复制到运行 Controller 的宿主机执行。执行完回本页点刷新即可核对生效。上游 Human PUT 端点合并后此处自动升级为一键 PUT。",
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, width: 72 }}>{tr("级别")}</span>
              <antd.Select
                size="small"
                style={{ flex: 1 }}
                value={permForm.permissionLevel}
                onChange={(v: number) =>
                  setPermForm({ ...permForm, permissionLevel: v })
                }
                options={[
                  {
                    value: 2,
                    label: tr("2 = 团队成员（Matrix 登录 → L2，可看本团队）"),
                  },
                  {
                    value: 1,
                    label: tr(
                      "1 = 管理员（L1；Matrix 登录拿不到 L1，需用管理员 token）",
                    ),
                  },
                  { value: 3, label: tr("3 = Worker") },
                ]}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                {tr("可访问团队（决定此人被拉入哪些团队房间）")}
              </div>
              <antd.Select
                size="small"
                mode="multiple"
                allowClear
                style={{ width: "100%" }}
                placeholder={tr("不选任何团队 = 清空列表")}
                value={permForm.accessibleTeams}
                onChange={(v: string[]) =>
                  setPermForm({ ...permForm, accessibleTeams: v })
                }
                options={teamNames.map((n) => ({ value: n, label: n }))}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                {tr("可访问 Worker（可选）")}
              </div>
              <antd.Select
                size="small"
                mode="multiple"
                allowClear
                style={{ width: "100%" }}
                placeholder={tr("不选任何 Worker = 清空列表")}
                value={permForm.accessibleWorkers}
                onChange={(v: string[]) =>
                  setPermForm({ ...permForm, accessibleWorkers: v })
                }
                options={workerNames.map((n) => ({ value: n, label: n }))}
              />
            </div>
            {permCmd ? (
              <>
                <div style={{ fontSize: 11, color: t.textSecondary }}>
                  {tr("在运行 Controller 的宿主机执行；空列表 = 清空。merge-patch 不改 status——初始密码不变。")}
                </div>
                <antd.Input.TextArea
                  rows={7}
                  readOnly
                  value={permCmd}
                  style={{ fontFamily: "monospace", fontSize: 11 }}
                />
                <antd.Button size="small" onClick={copyPermCmd}>
                  {tr("复制命令")}
                </antd.Button>
              </>
            ) : null}
          </div>
        </antd.Modal>
      ) : null}
    </div>
  );
}
