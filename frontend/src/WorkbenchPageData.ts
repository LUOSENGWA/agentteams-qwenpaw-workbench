// WorkbenchPage 拆分模块——配置/房间/工作流取数与轮询。
// 自 WorkbenchPage 单体原样搬移（技术债批次 D3b）；逻辑零改动，
// 壳持有的 React state 经 ctx 传入，标识符保持原名。

import {
  fetchAdminData,
  enrichWorkflowRoomNames,
  fetchTeamsStructure,
  fetchTeamsSync,
  fetchWorkflowEvents,
  fetchWorkflowProjects,
  fetchWorkerSpawns,
  getCachedRooms,
  requestJson,
  setCachedRooms,
  fetchAuthStatus,
  fetchAttention,
  type AdminData,
  type AttentionPayload,
  type RoomMessage,
  type SpawnNode,
  type TeamRoom,
  type InviteRoom,
  type WorkbenchConfig,
  type WorkerTreeTeam,
  type WorkflowEvent,
  type AuthStatus,
} from "./api";
import { useT } from "./i18n";
import { usePoller } from "./usePoller";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;

export interface WorkbenchPageDataCtx {
  activeRoom: TeamRoom | null;
  config: WorkbenchConfig | null;
  setConfig: React.Dispatch<React.SetStateAction<WorkbenchConfig | null>>;
  configRef: React.MutableRefObject<WorkbenchConfig | null>;
  configLoadState: "loading" | "ready" | "failed";
  setConfigLoadState: (v: "loading" | "ready" | "failed") => void;
  setAuthStatus: React.Dispatch<React.SetStateAction<AuthStatus | null>>;
  setMatrixNoneDismissed: (v: boolean) => void;
  setRooms: React.Dispatch<React.SetStateAction<TeamRoom[]>>;
  setRoomsLoading: (v: boolean) => void;
  setInvites: React.Dispatch<React.SetStateAction<InviteRoom[]>>;
  setMutedRooms: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveRoom: React.Dispatch<React.SetStateAction<TeamRoom | null>>;
  initialUi: React.MutableRefObject<{ tab?: string; roomId?: string; wfView?: string; wfTopo?: string } | null>;
  refreshMessages: (room: TeamRoom, silent?: boolean) => Promise<void>;
  setWorkerTree: React.Dispatch<React.SetStateAction<WorkerTreeTeam[]>>;
  setTreeSource: (v: string) => void;
  setSpawnLoading: (v: boolean) => void;
  tab: string;
  messages: RoomMessage[];
  setWorkflowEvents: React.Dispatch<React.SetStateAction<WorkflowEvent[]>>;
  setWorkflowLoading: (v: boolean) => void;
  setWorkflowSource: (v: "controller" | "rooms") => void;
  setWorkflowFailReason: (v: "auth" | "not_deployed" | "error") => void;
  setWorkflowFailDetail: (v: string) => void;
  setAdminData: React.Dispatch<React.SetStateAction<AdminData | null>>;
  setAdminLoading: (v: boolean) => void;
  setAdminFailCount: React.Dispatch<React.SetStateAction<number>>;
  setSelectedRunId: (v: string) => void;
  setTabState: React.Dispatch<React.SetStateAction<string>>;
  writeUiState: (tab: string, roomId: string | null) => void;
  tr: ReturnType<typeof useT>;
}

export function useWorkbenchData(ctx: WorkbenchPageDataCtx) {
  const { activeRoom, config, setConfig, configRef, configLoadState, setConfigLoadState, setAuthStatus, setMatrixNoneDismissed, setRooms, setRoomsLoading, setInvites, setMutedRooms, setActiveRoom, initialUi, refreshMessages, setWorkerTree, setTreeSource, setSpawnLoading, tab, messages, setWorkflowEvents, setWorkflowLoading, setWorkflowSource, setWorkflowFailReason, setWorkflowFailDetail, setAdminData, setAdminLoading, setAdminFailCount, setSelectedRunId, setTabState, writeUiState, tr } = ctx;

 const dismissMatrixNone = React.useCallback(() => {
    setMatrixNoneDismissed(true);
    try {
      window.localStorage.setItem(
        "agentteams-qwenpaw-workbench:matrix-none-dismissed",
        "1",
      );
    } catch {
      /* storage 不可用则跳过（横幅仍可点「登录」进入配置） */
    }
  }, []);

  // 恢复房间（rooms 加载后自动定位；找不到静默回退聊天页）。
  const restoredRoomRef = React.useRef(false);

  const handleOpenProject = React.useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setTabState("workflow");
      writeUiState("workflow", activeRoom?.room_id || null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, writeUiState],
  );

  // 进行锁——退避重试链最长 15.5s，
  // 期间 poller / 切 tab / 手动重试的重入直接丢弃（避免并发链互踩 loadState）。
  const configFetchingRef = React.useRef(false);
  const refreshConfig = React.useCallback(async () => {
    if (configFetchingRef.current) return;
    configFetchingRef.current = true;
    try {
      // 失败重试 3 次（1.5/4/10s 退避）。
      // 根因（地址模式/凭据没有记忆）：插件安装重载窗口 /
      // WAN 抖动时首个 GET /config 失败被静默吞掉 → config=null 贯穿页面
      // 生命周期 → 设置页全默认态 → 用户以为「没记住」重填。回环（保存→落盘→
      // 重载→回填）本身完好（debug 插桩+回环实验实锤）。重试覆盖重载窗口
      // （实测 <30s 恢复）。
      const backoffs = [1500, 4000, 10000];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        try {
          const payload = await requestJson("/agentteams-proxy/config");
          if (attempt > 0) {
            // eslint-disable-next-line no-console
            console.info(
              `[workbench] config fetch recovered on retry #${attempt}`,
            );
          }
          // 首载（null→payload）走高优先立即落地——保证设置页首帧即回填；
          // 静默刷新（已有 config）仍走 transition（切 tab 数据波
          // 是可中断低优先工作，不压切换帧）。
          if (configRef.current === null) {
            setConfig(payload as WorkbenchConfig);
          } else {
            React.startTransition(() =>
              setConfig(payload as WorkbenchConfig),
            );
          }
          setConfigLoadState("ready");
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < backoffs.length) {
            await new Promise((r) => setTimeout(r, backoffs[attempt]));
          }
        }
      }
      // 全部重试失败：显式置 failed（设置页出「加载失败+重试」横幅），
      // 不再静默——静默吞错 = 用户把默认态当成已保存值（本次事故根因）。
      setConfigLoadState("failed");
      // eslint-disable-next-line no-console
      console.error("[workbench] config fetch failed after retries", lastErr);
      // 重试链（15.5s）覆盖不了的安装重载长窗
      // （换容器/重载 >60s）——failed 后转低频后台自恢复（10s 间隔、
      // 至多 6 次=60s），成功即落地回填（与首载同语义）；不再依赖
      // 用户手动点「重试」。期间 poller 触发的 refreshConfig 被
      // configFetchingRef/本链互斥，不叠链。
      void (async () => {
        for (let n = 1; n <= 6; n++) {
          await new Promise((r) => setTimeout(r, 10000));
          if (configRef.current !== null) return;
          try {
            const payload = await requestJson("/agentteams-proxy/config");
            configRef.current === null
              ? setConfig(payload as WorkbenchConfig)
              : React.startTransition(() =>
                  setConfig(payload as WorkbenchConfig),
                );
            setConfigLoadState("ready");
            // eslint-disable-next-line no-console
            console.info(
              `[workbench] config recovered on background retry #${n}`,
            );
            return;
          } catch {
            /* 继续下一轮 */
          }
        }
      })();
    } finally {
      configFetchingRef.current = false;
    }
  }, []);

  const refreshRooms = React.useCallback(async (silent = false, force = false) => {
    // 静默刷新（自动/切换刷新不闪页）——保留旧数据在屏，新数据到达才换；
    // 仅手动刷新/首载显示 loading 骨架。
    // force=绕过 60s 服务端缓存（邀请接受/拒绝后立即重同步，
    // 否则缓存期邀请区/房间列表不更新）。
    if (!silent) setRoomsLoading(true);
    try {
      const payload = await fetchTeamsSync(force);
      // diff 跳过：数据无变化 → 返回原引用 → React 跳过重渲染（零闪）。
      // 数据波 setState 转 transition
      // （可中断——切换帧不再被整波落地渲染压满）。
      React.startTransition(() => {
        setRooms((prev) => (JSON.stringify(prev) === JSON.stringify(payload.rooms) ? prev : payload.rooms));
        const nextInvites = payload.invites || [];
        setInvites((prev) => (JSON.stringify(prev) === JSON.stringify(nextInvites) ? prev : nextInvites));
        const nextMuted = payload.muted_rooms || [];
        setMutedRooms((prev) => (JSON.stringify(prev) === JSON.stringify(nextMuted) ? prev : nextMuted));
        setCachedRooms(payload);
        setActiveRoom((current) =>
          current
            ? payload.rooms.find((r) => r.room_id === current.room_id) || current
            : null,
        );
      });
      // 状态记忆恢复：首次加载完成后自动打开上次房间。
      if (!restoredRoomRef.current) {
        restoredRoomRef.current = true;
        const savedRoomId = initialUi.current?.roomId || "";
        if (savedRoomId) {
          const saved = payload.rooms.find(
            (r) => r.room_id === savedRoomId,
          );
          if (saved) {
            React.startTransition(() => {
              setActiveRoom(saved);
              setCachedRooms(payload);
            });
            // 状态恢复与 openRoom 同源——旧内联取数
            // 块是第 4 条窗口建立路径（无 I2 合并 / 无 I1 窗口游标 /
            // 缓存被浅页覆盖：上会话翻过的深历史在恢复瞬间蒸发，游标
            // 回退假死家族）。refreshMessages = 缓存即时显示 + 合并 +
            // 首窗游标 + 预取起步，一条路径全语义。
            void refreshMessages(saved);
          }
        }
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取房间列表失败"));
    } finally {
      if (!silent) setRoomsLoading(false);
    }
  }, []);

  // Worker 树数据源 = 真实团队结构（Team/Worker CRD）+ spawn 正源填充
  // （端点已合并；apiOk=false → spawns 保持空，UI 显示占位文案）。
  // （13.11 「团队管理 tab 刷不出完整信息，手动刷新
  // 也不行，要等 30s 自动刷新」根因）：后端 /teams/structure 有 60s TTL
  // 缓存，且**首次失败/空树也写缓存（负缓存）**——token 未就绪时首拉得
  // 空树，之后 60s 内所有手动刷新都命中空缓存；30s tick 恰在 TTL 过期后
  // miss 重拉才"活"。force 语义：用户意图（手动钮/切 tab/登录/mount）
  // 一律 force=true 绕过缓存；仅 30s 后台 tick 走缓存（silent=true 且不
  // 显式 force）保护 Controller。
  // structure 与 spawn 拆分——
  // 旧 Promise.all 让整棵树等 20 项目 spawn 扇出（冷窗每请求 +6s，最坏
  // +2min）：团队管理「一开始刷不出、手动也不行」。现 structure 一到即
  // 渲染树（携带旧 spawns 值防闪烁），spawn 异步合并（in-flight 闸防
  // 30s tick 重叠双拉）；树首帧不再被 spawn 拖累。
  const spawnsInFlightRef = React.useRef(false);
  const loadSpawns = React.useCallback(async () => {
    if (spawnsInFlightRef.current) return;
    spawnsInFlightRef.current = true;
    try {
      const spawns = await fetchWorkerSpawns();
      if (!spawns.apiOk) return;
      // 数据波 setState 转 transition。
      React.startTransition(() => {
        setWorkerTree((prev) => {
          if (!prev) return prev;
          const tree = prev.map((team) => ({
            ...team,
            workers: team.workers.map((w) => ({
              ...w,
              spawns: spawns.byWorker[w.worker_name] || [],
            })),
          }));
          return JSON.stringify(tree) === JSON.stringify(prev) ? prev : tree;
        });
      });
    } catch {
      /* spawn 失败 = 树保持无 spawn 占位（旧语义），不炸主流程 */
    } finally {
      spawnsInFlightRef.current = false;
    }
  }, []);

  const refreshTree = React.useCallback(
    async (silent = false, force?: boolean) => {
      const useForce = force ?? !silent;
      if (!silent) setSpawnLoading(true);
      try {
        const payload = await fetchTeamsStructure(useForce);
 // 数据波 setState 转 transition。
        React.startTransition(() => {
          setTreeSource(payload.source);
          // 结构先到先渲染；每 (team, worker) 携带旧 spawns（新扇出回来前
          // spawn chip 不闪空），无旧值（新增 Worker/首载）= 空。
          setWorkerTree((prev) => {
            const prevByName = new Map<string, { spawns?: SpawnNode[] }>();
            for (const t of prev || [])
              for (const w of t.workers) prevByName.set(w.worker_name, w);
            const tree = payload.tree.map((team) => ({
              ...team,
              workers: team.workers.map((w) => ({
                ...w,
                spawns: prevByName.get(w.worker_name)?.spawns || [],
              })),
            }));
            return JSON.stringify(tree) === JSON.stringify(prev)
              ? prev
              : tree;
          });
        });
        void loadSpawns();
      } catch (e) {
        if (!silent) message.error(e instanceof Error ? e.message : tr("获取团队结构失败"));
      } finally {
        if (!silent) setSpawnLoading(false);
      }
    },
    [loadSpawns, tr],
  );

  React.useEffect(() => {
    // 缓存即时显示（页面重开不空白），后台静默刷新。
    const cached = getCachedRooms();
    if (cached) {
      setRooms(cached.rooms);
      setInvites(cached.invites || []);
      setMutedRooms(cached.muted_rooms || []);
    }
    void refreshRooms();
    void refreshTree();
    void refreshConfig();
  }, [refreshConfig, refreshRooms, refreshTree]);

  // 登录态轮询（30s）——usePoller（hidden 自动停 + 回前台 catch-up 立即
  // 刷：失效态要马上上横幅，不等 30s 节拍）+ 字段级值门：网络层每回包
  // 必新对象，登录态却几乎不变，无条件 set 会让 3400 行本组件每 30s
  // 空转重渲一次。
  const authPollerFn = React.useCallback(async () => {
    const s = await fetchAuthStatus();
    if (!s) return; // 取数失败保旧值（横幅状态不因瞬时抖动闪变）
    setAuthStatus((prev) => {
      const same =
        prev !== null &&
        prev.matrix_token === s.matrix_token &&
        prev.console_session === s.console_session &&
        prev.controller_token === s.controller_token;
      return same ? prev : s;
    });
  }, []);
  usePoller({ fn: authPollerFn, intervalMs: 30000 });

  // Workflow adapter 双轨：正源 = Controller projects/workflow API（端点已合并）；
  // apiOk=false（端点未部署/网络失败）→ 降级 Matrix agentteams.workflow 事件聚合。
  // 首页「任务进展」卡需要 workflow 数据——启动时也拉一次（定义后置，独立 effect）。
  React.useEffect(() => {
    void refreshWorkflow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 注（评估后不改）：15s 周期内的 JSON.stringify
  // 全量 diff 是**正确性门**（steps 内容变而 status/数量不变的情况只有
  // 全量比对能抓住）；双 poller 翻倍问题已由双 poller 合并修复，单 poller
  // 下数组规模（数十项）stringify 为毫秒级，指纹门方案有更新丢失风险，
  // 收益不抵风险 → 保持原样。

  const refreshWorkflow = React.useCallback(async (silent = false) => {
    // 记录拉取时间——切 tab 立即刷新用 2s 去抖（防连环拉）。
    workflowLastFetchRef.current = Date.now();
    if (!silent) setWorkflowLoading(true);
    try {
      const { events, apiOk, failReason, failDetail } =
        await fetchWorkflowProjects();
      // 数据波 setState 转 transition。
      if (apiOk) {
        const enriched = enrichWorkflowRoomNames(events);
        React.startTransition(() => {
          setWorkflowEvents((prev) =>
            JSON.stringify(prev) === JSON.stringify(enriched) ? prev : enriched
          );
          setWorkflowSource("controller");
          setWorkflowFailDetail("");
        });
      } else {
        // 记录降级原因——横幅提示「只看已加入房间的项目」+
        // 可操作指引（此前静默降级，正源 401 时用户以为数据就是这样）。
        // 同时记录真实错误 detail（5xx 上游故障不再被通用文案掩盖）。
        React.startTransition(() => {
          setWorkflowSource("rooms");
          setWorkflowFailReason(failReason || "error");
          setWorkflowFailDetail(failDetail || "");
        });
        const payload = await fetchWorkflowEvents();
        React.startTransition(() => {
          setWorkflowEvents((prev) => (JSON.stringify(prev) === JSON.stringify(payload.events) ? prev : payload.events));
        });
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取工作流失败"));
    } finally {
      if (!silent) setWorkflowLoading(false);
    }
  }, []);

  // R4（16.23）：15s 工作流兜底轮询退役——task_status 已有 SSE 主路
  // （sync_watcher _track_workflow 状态变化 → SSE task_status →
  // WorkbenchPageEvents refreshWorkflow），steady-state 不再轮询；SSE
  // 断连期的兜底由 WorkbenchPage 的 60s bootFallback 统一承担（断连才
  // 启动，在线零轮询）。
  // memoize——此前每次 WP 渲染 O(n) 扫全量
  // messages（最高频渲染组件 × 消息数组大）。messages 引用只在 mergeForward
  // 换数组时变（无变化复用 prev）→ 扫描只随消息到达发生。
  const chatHasWfCards = React.useMemo(
    () => tab === "chat" && messages.some((m) => m.workflow != null),
    [tab, messages],
  );

  // （13.12 「工作流一点开应先自动刷新，而不是等 15s
  // 自动刷新或手动刷新」）：切到工作流 tab（或聊天出现工作流卡）立即拉一次
  // 正源——此前只有 15s interval + 手动/登录时拉，tab 切回时看到的是最长
  // 15s 前的数据。2s 去抖防止快速切 tab 连环拉取。
  const workflowLastFetchRef = React.useRef(0);
  React.useEffect(() => {
    if (tab !== "workflow" && !chatHasWfCards) return;
    const now = Date.now();
    if (now - workflowLastFetchRef.current < 2000) return;
    workflowLastFetchRef.current = now;
    void refreshWorkflow(true);
  }, [tab, chatHasWfCards, refreshWorkflow]);

  // L1 数据面可用 = 本地配置 token 或宿主 env
  // （AGENTTEAMS_CONTROLLER_TOKEN，env 不落盘——config.controller_token 为空
  // 但 controllerTokenSource="env" 时数据面同样可用，门控以此为准）。
  const hasCtlToken = Boolean(
    config?.controller_token || config?.controllerTokenSource === "env",
  );

  // attention 决策面（读聚合）——30s 静默轮询，hasCtlToken 门控（L2 用户
  // 无 controller token，后端恒 502，轮询无意义）。badge/全局弹窗/P2「待
  // 决策」页共用此数据源（全局数据，不绑任何 tab）。失败保旧值（网络抖动
  // 不清已渲染数据）；deployed=false（旧 controller）→ 无 badge 无入口
  // （诚实降级）。
  const [attention, setAttention] = React.useState<AttentionPayload | null>(
    null,
  );
  const attentionFetchingRef = React.useRef(false);
  const refreshAttention = React.useCallback(
    async (bypass = false) => {
      if (attentionFetchingRef.current) return;
      attentionFetchingRef.current = true;
      try {
        const payload = await fetchAttention(bypass);
        // diff 门：30s 内数据常不变——返回原引用跳过重渲（同 rooms 约定）。
        React.startTransition(() => {
          setAttention((prev) =>
            prev && JSON.stringify(prev) === JSON.stringify(payload)
              ? prev
              : payload,
          );
        });
      } catch {
        /* 瞬时抖动 → 保旧值（入口可见性由 deployed/数据决定，不报错） */
      } finally {
        attentionFetchingRef.current = false;
      }
    },
    [],
  );
  usePoller({
    fn: () => void refreshAttention(),
    intervalMs: 30000,
    active: hasCtlToken,
    minPokeMs: 15000,
  });
  // hasCtlToken false→true 翻转（config 异步就绪/env 注入晚于挂载）触发首次
  // 取数（admin armed-ref 同款语义）。
  const attentionArmedRef = React.useRef(false);
  React.useEffect(() => {
    if (!hasCtlToken) {
      attentionArmedRef.current = false;
      return;
    }
    if (attentionArmedRef.current) return;
    attentionArmedRef.current = true;
    void refreshAttention();
  }, [hasCtlToken, refreshAttention]);

  // L1 admin view: only when a Controller token is available (config or env).
  const refreshAdmin = React.useCallback(async (silent = false) => {
    if (!hasCtlToken) return;
    if (!silent) setAdminLoading(true);
    try {
      const data = await fetchAdminData();
      // 数据波 setState 转 transition。
      React.startTransition(() => {
        setAdminFailCount(0);
        setAdminData((prev) => (prev && JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
      });
    } catch (e) {
      setAdminFailCount((n) => n + 1);
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取管理视图失败"));
    } finally {
      if (!silent) setAdminLoading(false);
    }
  }, [hasCtlToken]);

  // hasCtlToken false→true 翻转（config 异步就绪/
  // env 注入晚于挂载）触发首次 admin 取数。此前该翻转无任何重触发——token 未就绪
  // 窗口内所有 admin 取数被 `if (!hasCtlToken) return` 短路，token 就绪后 admin
  // 面板恒空，直到用户手动点刷新（首屏只显拓扑的根因之一）。
  const adminArmedRef = React.useRef(false);
  React.useEffect(() => {
    if (!hasCtlToken) {
      adminArmedRef.current = false;
      return;
    }
    if (adminArmedRef.current) return;
    adminArmedRef.current = true;
    void refreshAdmin(true);
  }, [hasCtlToken, refreshAdmin]);

  // 记忆 tab=models 但当前 L2
  // （config 已落地且无 token）→ 回首页。config ready 前不判——L1 用户
  // 的 config 异步窗口内 hasCtlToken 短暂为 false，不能误踢。
  React.useEffect(() => {
    if (tab === "models" && !hasCtlToken && configLoadState === "ready") {
      setTabState("home");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, hasCtlToken, configLoadState]);

  // 账号切换（登录成功）= 数据源全切——清本地旧账号数据 + 全量重取。
  // 与后端联动：/login 已同步清 60s 聚合缓存（rooms/workflow/artifacts/
  // structure）+ 重置 sync 游标；前端本地状态不清的话，切完账号屏幕还挂着
  // 上一个账号的房间/树/管理数据，要等下一轮静默刷新（真机反馈：
  // 「点刷新看起来是刷新了，但团队管理和产物没有刷新」）。
  const onLoginSuccess = React.useCallback(() => {
    setRooms([]);
    setWorkerTree([]);
    setTreeSource("");
    setAdminData(null);
    setWorkflowEvents([]);
    setAttention(null);
    void refreshConfig();
    void refreshRooms();
    void refreshTree();
    void refreshAdmin();
    void refreshWorkflow();
    void refreshAttention(true);
  }, [refreshConfig, refreshRooms, refreshTree, refreshAdmin, refreshWorkflow, refreshAttention]);
  return {
    dismissMatrixNone,
    handleOpenProject,
    refreshConfig,
    refreshRooms,
    refreshTree,
    refreshWorkflow,
    hasCtlToken,
    refreshAdmin,
    attention,
    refreshAttention,
    onLoginSuccess,
  };
}
