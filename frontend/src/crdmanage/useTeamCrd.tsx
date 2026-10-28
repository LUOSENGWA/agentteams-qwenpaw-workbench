// CrdManage 拆分（QC-196 方案 §5.2）· B/C/D/H/F 簇大 hook：创建团队（含
// 行内新建 Worker）/ 创建自检（CRD 回读 + 阶段轮询 5s×180s）/ CRD 导出 /
// 配置团队（PUT 部分更新 + 成员编辑 + 批量模型画笔 + 配置撤销/删除）/ 拓扑
// TeamNode 齿轮注册入口。函数体逐字自 components/CrdManage.tsx 搬移；唯一
// 改写 = catalog 数据源六标识符 → catalog.*（G 簇已抽 useModelCatalog，
// deps 数组同步改写，语义同构）。.tsx：doCreateWorker/doCreateTeam/doCfg
// 的 Modal.confirm content 含 JSX（方案 §5.1 写 .ts，偏离见 result.md）。

import type * as ReactNS from "react";

import {
  createTeam,
  createWorker,
  deleteTeam,
  fetchAdminData,
  fetchSglangModels,
  updateTeam,
  updateWorker,
  updateWorkerModel,
  type AdminData,
  type TeamInfo,
} from "../api";
import { modelVerdictText, validateModelValue } from "../modelUnion";
import { invalidateTags } from "../requestCache";
import { createPoller, type Poller } from "../usePoller";
import {
  EMPTY_TEAM_FORM,
  type CheckRow,
  type CrdManageProps,
  type TrFn,
  type WorkerRow,
} from "./types";
import {
  diffLlmTuning,
  findLlmTuningError,
  pickLlmTuning,
  type LlmTuningRecord,
} from "../lib/llm-tuning";
import { useModelCatalog } from "./useModelCatalog";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface UseTeamCrdArgs {
  /** 当前管理数据团队列表（配置弹窗/撤销/删除的数据源）。 */
  teams: AdminData["teams"];
  /** 在服 Workers（建队行初始化 + 行内新建 Worker 校验）。 */
  workers: AdminData["workers"];
  onRefresh: CrdManageProps["onRefresh"];
  tr: TrFn;
  /** 模型目录（G 簇）——三入口共享的候选/alias/SOUL 数据源。 */
  catalog: ReturnType<typeof useModelCatalog>;
  /** 拓扑 TeamNode 齿轮注册回调（原主组件内 `const { registerHandle } = props;`）。 */
  registerHandle: CrdManageProps["registerHandle"];
  /** 千锻建队前置（B6，可选）：团队 ID 校验后调用；返回非 null = 覆盖
   * 表单成员行（workerMembers = 选中/新建的 worker 名）；null = 不参与
   * （表单行原样走）；抛错 = 中止建队（调用方已 toast）。 */
  millforgePreCreate?: (teamName: string) => Promise<WorkerRow[] | null>;
  /** 千锻建队后置（可选）：创建成功后复位千锻段状态；返回 core 技能
   * 注入结果摘要（非 null = 成功消息里带出——C 建队流程结果可见）。 */
  millforgePostCreate?: () => string | null;
}

export function useTeamCrd({ teams, workers, onRefresh, tr, catalog, registerHandle, millforgePreCreate, millforgePostCreate }: UseTeamCrdArgs) {
  // ── 创建团队（Team CRD 创建）──
  const [tForm, setTForm] = React.useState(EMPTY_TEAM_FORM);
  const [workerRows, setWorkerRows] = React.useState<WorkerRow[]>([
    { name: "", role: "team_leader" },
  ]);
  const [tBusy, setTBusy] = React.useState(false);
  // 导出 JSON 按钮的 loading 态。
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

  // ── 创建团队时新建 Worker（POST /api/v1/workers）──
  // 上游 CreateWorkerRequest：name 必填，containerManaged 默认 true
  // （Controller 调和拉镜像起容器，数分钟就绪）；团队可先保存，
  // Worker 就绪后调和自动关联。
  const [nw, setNw] = React.useState({
    name: "",
    // 新建 Worker 可选运行时。选项正源 = 上游
    // internal/backend/interface.go（Runtime* 常量 + L158 五值集）；copaw 退役
 // 移除，deepseek-harness 补上（上游近期新加，镜像
    // agentteams-deepseek-harness-worker:v0.1.0）；默认 qwenpaw = 安装脚本默认
    // （agentteams-install.sh L2747 AGENTTEAMS_DEFAULT_WORKER_RUNTIME:-qwenpaw）。
    runtime: "qwenpaw",
    model: "",
    soul: "",
    busy: false,
  });

  // ── 创建自检（建队成功后自动跑：CRD 回读 + 阶段轮询，5s×180s）──
  const [tCheck, setTCheck] = React.useState<{
    rows: CheckRow[];
    running: boolean;
    startedAt: number;
    deadline: number;
    done: boolean;
  } | null>(null);
  // 旧定时器 → 命令式 createPoller（5s 检查 tick，
  // !document.hidden——后台不查；finished 时 tick 内自停逻辑保留）。
  const tCheckPoller = React.useRef<Poller | null>(null);

  const stopTeamCheck = React.useCallback(() => {
    if (tCheckPoller.current !== null) {
      tCheckPoller.current.stop();
      tCheckPoller.current = null;
    }
  }, []);
  React.useEffect(() => stopTeamCheck, [stopTeamCheck]);

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
      tCheckPoller.current = createPoller({
        fn: () => void tick(),
        intervalMs: 5000,
        isActive: () => !document.hidden,
      });
      tCheckPoller.current.start();
    },
    [stopTeamCheck],
  );

 // ——参考
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
    const mv = validateModelValue(nw.model, catalog.modelCandidates);
    if (mv.level === "error") {
      antd.message.error(modelVerdictText(tr, mv, nw.model, catalog.modelCandidates));
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
        // Worker CRD 变更（加入团队成员）→ 失效
        // teams/admin 缓存再刷。
        invalidateTags(["teams", "admin"]);
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
            <div>{modelVerdictText(tr, mv, nw.model, catalog.modelCandidates)}</div>
          </div>
        ),
        okText: tr("确认强写"),
        cancelText: tr("返回修改"),
        onOk: () => void run(),
      });
      return;
    }
    void run();
  }, [nw, workerRows, onRefresh, tr, catalog.modelCandidates]);

  const doCreateTeam = React.useCallback(async () => {
    const name = tForm.name.trim();
    if (!name) {
      antd.message.warning(tr("团队 ID 不能为空"));
      return;
    }
    // 千锻前置（B6）：启用时编译（若未编译）→ 注入；返回值覆盖成员行
    // （workerMembers = 选中/新建的 worker 名）；抛错 = 中止（已 toast）。
    let mfRows: WorkerRow[] | null = null;
    if (millforgePreCreate) {
      setTBusy(true);
      try {
        mfRows = await millforgePreCreate(name);
      } catch (e) {
        setTBusy(false);
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
        return;
      }
      setTBusy(false);
    }
    const rows = mfRows ?? workerRows.filter((r) => r.name.trim());
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
      (r) => validateModelValue(r.model || "", catalog.modelCandidates).level === "error",
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
      const v = validateModelValue(r.model || "", catalog.modelCandidates);
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
          const cur = catalog.modelOf(r.name.trim());
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
        // 千锻后置（B6）：复位千锻段（清 build/注入结果/自定义；源保留）；
        // 返回 core 技能结果摘要——成功消息带出（C 建队流程结果可见）。
        const mfNote = millforgePostCreate?.() ?? null;
        antd.message.success(
          mfNote ? (
            <div style={{ lineHeight: 1.8 }}>
              <div>{tr("创建成功")}</div>
              <div style={{ fontSize: 12 }}>{mfNote}</div>
            </div>
          ) : tr("创建成功"),
          mfNote ? 6 : undefined,
        );
        // 创建自检：CRD 回读 + 阶段轮询（LLM 冒烟/SOUL 检查无通道，面板如实标注）。
        startTeamCheck(
          rows.map((r) => ({
            name: r.name.trim(),
            sentModel: (r.model || "").trim(),
          })),
        );
        setTForm(EMPTY_TEAM_FORM);
        setWorkerRows([{ name: "", role: "team_leader" }]);
        // 建队=团队结构+admin 变更 → 失效缓存再刷
        // （否则 30s TTL 内拓扑树/管理面板读旧值）。
        invalidateTags(["teams", "admin"]);
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
  }, [tForm, workerRows, onRefresh, tr, catalog.modelCandidates, catalog.modelOf, startTeamCheck, millforgePreCreate, millforgePostCreate]);

  const workerNames = workers.map((x) => x.name);

  // ── 配置团队（PUT 部分更新：空字段不覆盖；成员编辑 = workerMembers 全量替换）──
  const [cfgTeam, setCfgTeam] = React.useState<TeamInfo | null>(null);
 // 收起动画——旧实现 cfgTeam 置 null
  // 即整树卸载=弹窗瞬间消失（弹出有动画、收起没有）。cfgOpen 控制 antd 退出
  // 过渡，afterClose 才清 cfgTeam（动画期间内容保持，不闪空）。
  const [cfgOpen, setCfgOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState({
    description: "",
    heartbeatEvery: "",
    peerMentions: true,
    subagentModel: "",
    llm: pickLlmTuning(null),
  });
  /** 团队 LLM 调优基线（打开弹窗时从团队现值取）——保存时 diff 用，
   * 与 cfg.llm（draft）分离：空闲跟随、有编辑不动（同 Worker 面板语义）。 */
  const [llmBase, setLlmBase] = React.useState<LlmTuningRecord | null>(null);
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
      llm: pickLlmTuning(team),
    });
    // 团队 LLM 调优基线（现值）——保存 diff 用（""=清除/未改不发）。
    setLlmBase(pickLlmTuning(team));
    // 预填每个成员的当前模型（admin workers 同源），diff 用于保存时只发改动
    setCfgRows(
      team.workerMembers?.length
        ? team.workerMembers.map((m) => ({
            name: m.name,
            role: m.role,
            model: catalog.modelOf(m.name),
            modelOrig: catalog.modelOf(m.name),
          }))
        : [],
    );
    // 模型候选（与创建 Worker 弹窗共享 modelOpts，空=拉一次）
    if (catalog.modelOpts.length === 0) {
      void fetchSglangModels().then(catalog.setModelOpts);
    }
    // 网关 alias（一次性；available=false=无 Higress Console 会话，正常）
    if (!catalog.gatewayLoaded) void catalog.loadGatewayAliases();
 // 批量画笔每次开弹窗复位（不跨团队残留）。
    setCfgBatchModel({ leader: "", workers: "" });
  }, [catalog.modelOf, catalog.modelOpts, catalog.gatewayLoaded, catalog.loadGatewayAliases]);

  // 齿轮入口——拓扑 TeamNode「N人」右侧 ⚙ 点按 →
  // 按 CR 名找到 TeamInfo → 走既有 openCfg（预填/模型候选/网关 alias
  // 逻辑零复制）。注册式 handle：父侧只持有 ref，无渲染依赖。
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

 // // 批量模型画笔——两把独立画笔（Leader 批 / Workers 批）。选中值即刷到对应
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
      // // subagentModel=团队级 spawn 子代理默认模型（上游 PUT 指针语义：
      // null=清空/继承 Worker 主模型；值=覆盖）。与 heartbeatEvery 同 UX。
      subagentModel: cfg.subagentModel.trim() || null,
    };
    // 团队级 LLM 调优：字段级 diff（未改不发 / ""=清除 / 值=覆盖），与
    // Worker llm* 同指针语义（源码 resource_handler.go UpdateTeam 逐字段
    // `if req.LlmX != nil`）。先整组校验，再并入 body。
    if (llmBase) {
      const llmErr = findLlmTuningError(cfg.llm);
      if (llmErr) {
        antd.message.error(
          tr("{label}：{message}", { label: llmErr.label, message: llmErr.message }),
        );
        return;
      }
      const llmDiff = diffLlmTuning(llmBase, cfg.llm);
      for (const [k, v] of Object.entries(llmDiff)) body[k] = v;
    }
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
      (r) => validateModelValue(r.model || "", catalog.modelCandidates).level === "error",
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
      (r) => validateModelValue(r.model || "", catalog.modelCandidates).level === "warn",
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
 // 走收起动画（afterClose 清 cfgTeam）。
      setCfgOpen(false);
      // 团队配置保存=团队结构+admin 变更 → 失效再刷。
      invalidateTags(["teams", "admin"]);
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
  }, [cfgTeam, cfg, cfgRows, llmBase, workerNames, onRefresh, tr, catalog.modelCandidates]);

  // 删团队前快照 → 删除成功后 6s「撤销」
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
        // 撤销=按快照重建团队 → 失效再刷。
        invalidateTags(["teams", "admin"]);
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
        // 删团队=团队结构+admin 变更 → 失效再刷。
        invalidateTags(["teams", "admin"]);
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      }
    },
    [onRefresh, tr, teams, undoTeam],
  );
  return {
    tForm,
    setTForm,
    workerRows,
    updateRow,
    removeRow,
    addRow,
    tBusy,
    exporting,
    nw,
    setNw,
    tCheck,
    startTeamCheck,
    doExportCrd,
    doCreateWorker,
    doCreateTeam,
    workerNames,
    cfgTeam,
    setCfgTeam,
    cfgOpen,
    cfg,
    cfgRows,
    cfgBusy,
    openCfg,
    setCfgOpen,
    setCfg,
    setCfgBatchModel,
    updateCfgRow,
    removeCfgRow,
    addCfgRow,
    cfgBatchModel,
    applyCfgBatch,
    cfgBatchLeaderCount,
    cfgBatchWorkerCount,
    doCfg,
    undoTeam,
    doDeleteTeam,
  };
}
