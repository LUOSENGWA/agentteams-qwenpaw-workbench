/**
 * WorkerDetailPane.tsx — 「管理」页团队域·右栏 Worker 详情（方案 §4.1.3，P2）。
 *
 * 头部（方案 §4.1.3 头部四行，16.27 B 起模型行升级为「模型配置」卡）：
 * - 头像 + 名字 + 角色徽标
 * - 状态灯 + phase（不一致时附容器态红字 = crashloop 诊断信号）
 * - 运行时 + 版本（AgentTeams 版本 = 镜像 tag 正源；L1 再经
 *   node-version 端点探测容器内运行时实际版本，10min 缓存）
 *
 * 模型配置卡（16.27 B，任务 A 弹窗化）：内联编辑改为只读摘要 +
 * 「点击编辑」（与 ManagerDetailPane 模型卡一致），点击 →
 * ModelEditModal（宽屏左右 / 窄屏上下响应式，与 Manager 详情面板
 * 共用同一组件零分叉）；候选与写前校验走 useModelUnionOptions（与
 * StandaloneWorkerModels/ManagerTable 同源）；保存 = PUT /workers/{name}
 * 合并语义，model + modelProvider 同时下发（多 provider 部署只改 model
 * 仍走旧 provider）；L1-only（与唤醒/休眠同门控）；成功 →
 * invalidateTags + onRefreshAdmin（写后强读 #1407，不新增轮询）。
 *
 * 状态卡：休眠 / 重启中 / 心跳态（agentStatus）/ 在跑任务 /
 * 上次运行 / 上次完成 + loop 预算（GET /workers/{name}/loops/status，
 * 404/失败 → 整行不显，诚实降级）；唤醒/休眠/重启操作 L1-only
 *（重启 = #1473 POST /workers/{name}/restart）。
 *
 * 资源卡（运行配置/环境变量与网关/Coding CLI/MCP/插件/技能/工具/
 * 频道/审批模式/运行时升级）= ResourceCards（P3，本组件下方接续）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  deleteWorker,
  fetchNodeVersion,
  fetchWorkerDetail,
  fetchWorkerLoopStatusBySession,
  httpErrorStatus,
  imageTag,
  postController,
  updateWorkerModel,
  type NodeVersion,
  type WorkerInfo,
  type WorkerLoopStatus,
} from "../api";
import {
  ensureWorkerReadyWithFallback,
  modelSaveCopyKey,
  restartWorker,
  shouldShowEnsureReady,
} from "../api/domains/lifecycle";
import { providerForWrite, resolveProviderBaseline } from "../lib/providerBaseline";
import { modelGrantErrorText } from "../lib/modelGrantErrors";
import {
  modelVerdictText,
  providerForModel,
  useModelUnionOptions,
  validateModelValue,
} from "../modelUnion";
import { invalidateTags } from "../requestCache";
import { useAvatarUrl } from "../useAvatar";
import {
  ROLE_BADGE,
  ROLE_COLOR,
  RUNTIME_LABELS,
  WakeIcon,
  SleepIcon,
  ReloadIcon,
  fmtRfc3339,
  isStateConsistent,
  phaseMeta,
} from "../components/WorkerManageShared";
import { RuntimeNotice } from "../runtimeGuard";
import { BulbIcon, MessageIcon, PlayIcon } from "../components/icons";
import { SessionDot } from "../components/WorkerSessionDot";
import { WbTooltip } from "../components/WbTooltip";
import type { WorkerSessionState } from "../workerSessionState";
import { resourceControlDeniedHint } from "../lib/resourceControl";
import { tracingUrl } from "../lib/tracingUrl";
import ModelEditModal from "./ModelEditModal";
import CheckpointCard from "./CheckpointCard";
import WorkerChats from "../components/WorkerChats";
import { dmTargetFor } from "./dmTarget";
import ResourceCards from "./ResourceCards";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 状态卡行（标签 96px 定宽 + 值；值可为 ReactNode）。 */
function Row({
  label,
  value,
  warn,
}: {
  label: string;
  value: ReactNS.ReactNode;
  warn?: boolean;
}) {
  const t = useThemeColors();
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 22 }}>
      <span
        style={{
          width: 96,
          flexShrink: 0,
          fontSize: 12,
          color: t.textSecondary,
        }}
      >
        {label}
      </span>
      <span
        title={typeof value === "string" ? value : undefined}
        style={{
          minWidth: 0,
          flex: 1,
          fontSize: 12.5,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          // token 集无 danger 色 → 语义红走 CSS 关键字（深浅色均正）。
          color: warn ? "red" : t.text,
          fontWeight: warn ? 600 : 400,
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function WorkerDetailPane({
  worker,
  avatarUrl,
  hasToken,
  canControl = false,
  sessionState,
  onRefreshAdmin,
  onOpenSettings,
  onDeleted,
  onDm,
  dashboardUrl = "",
}: {
  worker: WorkerInfo;
  /** 头像源（room 成员表 mxc 头像；undefined → 首字母兜底）。 */
  avatarUrl?: string;
  hasToken?: boolean;
  /**
   * Worker 会话态（父层 useWorkerSessionStates 派生，零新增请求）。
   * undefined = 旧 controller 未派生 / 不在团队树内 → 不渲染指示灯。
   */
  sessionState?: WorkerSessionState;
  /**
   * #1536：调用者是否 L1（permissionLevel === 1）——资源控制
   * （删除 Worker）仅此放行；缺省 = false（fail closed）。
   * 与 hasToken（workbench 配置了管理员 token）是两回事：
   * L2 带 token 也只能看不能删，后端按调用者档位 403。
   */
  canControl?: boolean;
  onRefreshAdmin?: (silent?: boolean, strong?: boolean) => void;
  /** 运行配置卡内「去设置」跳转（透传 WorkerRuntimeConfig）。 */
  onOpenSettings?: () => void;
  /** 删除成功后的导航（回团队拓扑）——父层决定落地位置。 */
  onDeleted?: () => void;
  /**
   * 私聊入口（ManageData.onDm 透传）：有 MXID 才显示；个人房间存在时直跳。
   */
  onDm?: (mxid: string, roomId?: string) => void;
  /**
   * Dashboard 地址（config.dashboard_url）——「打开 Tracing」跳转目标。
   * 空/非法 → 入口隐藏（Tracing 是 Dashboard 能力，插件只跳转）。
   */
  dashboardUrl?: string;
}) {
  const t = useThemeColors();
  const tr = useT();
  const obj = useAvatarUrl(avatarUrl);
  const l1 = !!hasToken;
  const deniedHint = resourceControlDeniedHint(tr);
  const tracing = tracingUrl(dashboardUrl);
  // 私聊目标：有 MXID 才可私聊（个人房间可选直跳）。
  const dm = dmTargetFor(worker);
  const meta = phaseMeta(worker.phase);
  const sleeping = worker.phase === "Sleeping" || worker.phase === "Stopped";
  const restarting = (worker.containerState || "").toLowerCase() === "restarting";
  const stateInconsistent = !isStateConsistent(worker.state, worker.containerState);
  const [acting, setActing] = React.useState<"wake" | "sleep" | "restart" | "ensureReady" | null>(null);
  // 拉起就绪入口降级（404 = 老控制器 ensure-ready 与 ready 双路由皆无
  // → 隐藏按钮不报错，诚实降级）。
  const [ensureReadyUnsupported, setEnsureReadyUnsupported] = React.useState(false);

  // 容器内运行时版本（L1-only 拨号；旧 WorkerManageInfo 同款模式）。
  const [nodeVer, setNodeVer] = React.useState<NodeVersion | null>(null);
  const [nodeVerErr, setNodeVerErr] = React.useState("");
  React.useEffect(() => {
    if (!l1) return;
    let alive = true;
    setNodeVer(null);
    setNodeVerErr("");
    fetchNodeVersion(worker.name)
      .then((d) => {
        if (alive) setNodeVer(d);
      })
      .catch((e) => {
        if (alive) setNodeVerErr(e instanceof Error ? e.message : tr("探测失败"));
      });
    return () => {
      alive = false;
    };
  }, [l1, worker.name, tr]);

  // loop 预算：按 1:1 Worker 房间 session 查激活 loop
  // （session_id = `matrix:{room_id}`）；404/失败 → 整行不显。
  const [loop, setLoop] = React.useState<WorkerLoopStatus | null>(null);
  React.useEffect(() => {
    if (!worker.roomID) return;
    let alive = true;
    setLoop(null);
    fetchWorkerLoopStatusBySession(worker.name, `matrix:${worker.roomID}`)
      .then((d) => {
        if (alive) setLoop(d);
      })
      .catch(() => {
        // 404（旧 controller 无端点 / 无该 session）或网络失败
        // → loop 行不显（诚实降级，不显错误占位）。
        if (alive) setLoop(null);
      });
    return () => {
      alive = false;
    };
  }, [worker.name, worker.roomID]);

  // ── 模型配置（任务 A 弹窗化）——候选/校验与 StandaloneWorkerModels 同源 ──
  // 草稿由 ModelEditModal 持有（打开时重置为当前值）。
  // provider 基线（#1477：16.61 起列表投影 fields=spec/status 不含
  // modelProvider）= 写前读 detail 的 modelProvider > 列表行（仍带时）>
  // alias 回填推导；detail 成功（或列表带值）才可信，不可信 + 用户未显式
  // 改 provider → 保存不下发 modelProvider（保持控制器现值，防误清）。
  const union = useModelUnionOptions([worker.model || ""], tr);
  const [modelModal, setModelModal] = React.useState(false);
  const [modelSaving, setModelSaving] = React.useState(false);
  // 写前读 detail 缓存（fetchWorkerDetail 内 15s TTL；成功/失败各记一次，
  // 失败下次打开重试）。modelProvider/subagentModel 均以此为准。
  const [provDetail, setProvDetail] = React.useState<{
    loading: boolean;
    failed: boolean;
    modelProvider?: string;
    subagentModel?: string;
  }>({ loading: false, failed: false });
  // 切 worker 不卸载本组件（TeamSection 无 key）→ 复位弹窗态 + 基线态。
  React.useEffect(() => {
    setModelModal(false);
    setModelSaving(false);
    setProvDetail({ loading: false, failed: false });
    setEnsureReadyUnsupported(false);
  }, [worker.name]);

  const provBaseline = React.useMemo(
    () =>
      resolveProviderBaseline(
        provDetail.modelProvider,
        worker.modelProvider,
        providerForModel(union.gatewayOptions, worker.model || ""),
      ),
    [provDetail.modelProvider, worker.modelProvider, union.gatewayOptions, worker.model],
  );

  // 打开弹窗：先起写前读 detail（列表投影下基线不可信的补数路径）；
  // 加载中弹窗内 provider 字段显「正在读取…」、入口禁用；失败 → 基线保持
  // 不可信（保存时不下发 modelProvider），弹窗仍可编辑 model。
  const openModelModal = React.useCallback(() => {
    if (provDetail.loading || modelSaving) return;
    setModelModal(true);
    if (provDetail.modelProvider !== undefined || provDetail.subagentModel !== undefined) {
      return;
    }
    setProvDetail({ loading: true, failed: false });
    fetchWorkerDetail(worker.name)
      .then((d) =>
        setProvDetail({
          loading: false,
          failed: false,
          modelProvider: d.modelProvider,
          subagentModel: d.subagentModel,
        }),
      )
      .catch(() => setProvDetail({ loading: false, failed: true }));
  }, [provDetail, modelSaving, worker.name]);

  const handleModelSave = React.useCallback(
    async (mIn: string, pIn: string, subIn: string | null): Promise<boolean> => {
      // 基线仍加载中（含「读取完成但弹窗字段尚未复位」的竞态窗口）→ 不写，
      // 防把「正在读取…占位文案」当成 provider 下发。
      const loadingText = tr("正在读取 Worker 配置…");
      if (provDetail.loading || pIn.trim() === loadingText) {
        antd.message.warning(loadingText);
        return false;
      }
      const m = mIn.trim();
      const p = pIn.trim();
      const vd = validateModelValue(m, union.candidates);
      if (vd.level === "error") {
        antd.message.error(modelVerdictText(tr, vd, m, union.candidates));
        return false;
      }
      // 基线判定（#1477）：可信 → 下发用户值（未改=现值，与旧行为一致）；
      // 不可信 + 用户未显式改 provider → undefined = 不带 modelProvider，
      // 控制器 merge 语义保持现值（alias 猜测基线不得写盘）。
      const pSend = providerForWrite(provBaseline, p === provBaseline.value ? undefined : p);
      setModelSaving(true);
      try {
        // PUT 合并语义：model + modelProvider + subagentModel 同时下发
        // （subagentModel=null=清除/与主模型相同；modelProvider=undefined
        // 时不带该键=保持控制器现值）。
        await updateWorkerModel(worker.name, m, pSend, subIn);
        antd.message.success(
          vd.level === "warn"
            ? tr("已保存（提示：{t}）", {
                t: modelVerdictText(tr, vd, m, union.candidates),
              })
            : tr(modelSaveCopyKey(worker.runtime)),
        );
        // 模型 = Worker spec 变更 → 失效缓存 + 写后强读（#1407）。
        invalidateTags(["teams", "admin"]);
        // 写后基线作废：下次打开弹窗重新读 detail 取新现值。
        setProvDetail({ loading: false, failed: false });
        void onRefreshAdmin?.(true, true);
        return true;
      } catch (e) {
        // #1514：grant 错误（pair_required/unresolvable/overflow/forbidden）
        // 走统一文案；其余错误展示后端错误文本（不吞错）。
        antd.message.error(
          modelGrantErrorText(e, tr) ??
            (e instanceof Error ? e.message : tr("保存失败")),
        );
        return false;
      } finally {
        setModelSaving(false);
      }
    },
    [worker.name, union.candidates, onRefreshAdmin, tr, provBaseline, provDetail.loading],
  );

  const handleLifecycle = React.useCallback(
    async (action: "wake" | "sleep") => {
      setActing(action);
      try {
        await postController(`/workers/${encodeURIComponent(worker.name)}/${action}`);
        antd.message.success(
          action === "wake" ? tr("{name} 已唤醒", { name: worker.name }) : tr("{name} 已休眠", { name: worker.name }),
        );
        // 唤醒/休眠 = Worker 运行态变更 → 失效缓存（同旧 WorkerManage）。
        invalidateTags(["teams", "admin"]);
        void onRefreshAdmin?.();
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      } finally {
        setActing(null);
      }
    },
    [worker.name, onRefreshAdmin, tr],
  );

  // 重启（#1473）：POST /workers/{name}/restart（authz=wake）；停容器
  // 失败 → 502（后端文本原样透出）；容器不存在 → 仍 Restarting
  //（控制器 reconcile 拉起），UI 无需特殊分支。
  const handleRestart = React.useCallback(() => {
    antd.Modal.confirm({
      title: tr("重启 Worker {name}？", { name: worker.name }),
      content: tr("停止并重新启动容器：运行中的进程重新读配置；进行中的任务会被中断。"),
      okText: tr("重启"),
      cancelText: tr("取消"),
      onOk: async () => {
        setActing("restart");
        try {
          await restartWorker(worker.name);
          antd.message.success(tr("{name} 重启中", { name: worker.name }));
          // 重启 = Worker 运行态变更 → 失效缓存（同唤醒/休眠）。
          invalidateTags(["teams", "admin"]);
          void onRefreshAdmin?.();
        } catch (e) {
          antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
        } finally {
          setActing(null);
        }
      },
    });
  }, [worker.name, onRefreshAdmin, tr]);

  // 拉起就绪：ensure-ready（任意失败回落 ready，旧控制器版本门）；
  // 双 404 = 老控制器两路由皆无 → 隐藏按钮（能力降级，不报错）。
  const handleEnsureReady = React.useCallback(async () => {
    setActing("ensureReady");
    try {
      await ensureWorkerReadyWithFallback(worker.name);
      antd.message.success(tr("已请求拉起 {name}", { name: worker.name }));
      // 运行态变更 → 失效缓存 + 刷新（同唤醒/休眠）。
      invalidateTags(["teams", "admin"]);
      void onRefreshAdmin?.();
    } catch (e) {
      if (httpErrorStatus(e) === 404) {
        setEnsureReadyUnsupported(true);
      } else {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      }
    } finally {
      setActing(null);
    }
  }, [worker.name, onRefreshAdmin, tr]);

  const tag = imageTag(worker.image);

  // 删除 Worker（危险区，L1）：DELETE /workers/{name} → 204；该 Worker 是
  // 任一团队成员时 Controller 返回 409（body.message 含团队与出口端点，
  // requestJson 已拼成 "HTTP 409: …"）→ 原样透出，不自行改写语义。
  const confirmDelete = React.useCallback(() => {
    antd.Modal.confirm({
      title: tr("删除 Worker {name}", { name: worker.name }),
      okText: tr("删除"),
      cancelText: tr("取消"),
      okButtonProps: { danger: true },
      content: (
        <div style={{ display: "grid", gap: 6, fontSize: 12.5 }}>
          <span>{tr("删除 Worker CR 及其容器。")}</span>
          <span style={{ fontSize: 11 }}>
            {tr("若该 Worker 属于某团队，Controller 会拒绝删除（请先从团队移除）。")}
          </span>
        </div>
      ),
      onOk: async () => {
        try {
          await deleteWorker(worker.name);
          antd.message.success(tr("Worker {name} 已删除", { name: worker.name }));
          invalidateTags(["teams", "admin", "workers-status"]);
          void onRefreshAdmin?.(true, true);
          onDeleted?.();
        } catch (e) {
          antd.message.error(
            (e instanceof Error ? e.message : tr("操作失败")).slice(0, 300),
          );
        }
      },
    });
  }, [worker.name, onRefreshAdmin, onDeleted, tr]);
  return (
    <div style={{ display: "grid", gap: 10, padding: 4, minWidth: 0, overflow: "hidden" }}>
      <RuntimeNotice runtime={worker.runtime} compact />
      {/* 头部四行（方案 §4.1.3） */}
      <div style={{ display: "grid", gap: 6, padding: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <antd.Avatar
            size={36}
            src={obj}
            style={{ flexShrink: 0, fontSize: 14 }}
          >
            {worker.name ? worker.name.slice(0, 1) : "?"}
          </antd.Avatar>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontWeight: 700,
                fontSize: 15,
                color: t.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {worker.name}
            </span>
            <SessionDot state={sessionState} />
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: ROLE_COLOR[worker.role as keyof typeof ROLE_COLOR] || t.textSecondary,
              flexShrink: 0,
            }}
          >
            {tr(ROLE_BADGE[worker.role as keyof typeof ROLE_BADGE] ?? "?")}
          </span>
          <div style={{ flex: 1 }} />
          {/* 私聊入口（旧拓扑 WorkerRow 行尾 DM 迁入；无 MXID 隐藏）。 */}
          {dm && onDm ? (
            <antd.Button
              size="large"
              icon={<MessageIcon size={14} />}
              style={{ minHeight: 44, flexShrink: 0 }}
              title={tr("私聊")}
              aria-label={tr("私聊")}
              onClick={() => onDm(dm.mxid, dm.roomId)}
            >
              {tr("私聊")}
            </antd.Button>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color, flexShrink: 0 }}
            title={tr("Worker 状态")}
          />
          <antd.Tag color={meta.color} style={{ margin: 0 }}>
            {meta.label}
          </antd.Tag>
          {stateInconsistent ? (
            <span style={{ fontSize: 11, color: "red" }}>
              {tr("容器态")}：{worker.containerState || "—"}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
            {tr("运行时")}
          </span>
          <span style={{ fontSize: 12.5, color: t.text }}>
            {RUNTIME_LABELS[worker.runtime] || worker.runtime || "—"}
          </span>
          {worker.runtimeDeprecated ? (
            <antd.Tag color="orange" style={{ margin: 0 }}>
              {tr("legacy")}
            </antd.Tag>
          ) : null}
          {/* AgentTeams 版本 = Worker 镜像 tag（正源，tooltip 完整镜像）。 */}
          <span style={{ fontSize: 12, color: t.textSecondary, flexShrink: 0 }}>
            {tr("AgentTeams")}
          </span>
          <span
            style={{ fontSize: 12.5, color: t.text }}
            title={worker.image || undefined}
          >
            {tag || "—"}
          </span>
          {/* 容器内运行时实际版本 = node-version 探测（L1-only，10min 缓存）。 */}
          {nodeVer?.runtime_version ? (
            <span
              style={{ fontSize: 12, color: t.textSecondary }}
              title={nodeVer.runtime_version_error || undefined}
            >
              {tr("运行时版本")} {nodeVer.runtime_version}
            </span>
          ) : l1 && nodeVerErr ? (
            <span style={{ fontSize: 12, color: t.textSecondary }} title={nodeVerErr}>
              {tr("版本探测失败")}
            </span>
          ) : null}
        </div>
      </div>
      {/* 模型配置卡（任务 A 弹窗化）——只读摘要 +「点击编辑」，
          与 ManagerDetailPane 模型卡一致（L1-only）。 */}
      <div
        style={{
          padding: "10px 14px",
          borderRadius: 8,
          background: t.cardBg,
          border: `1px solid ${t.border}`,
          cursor: l1 && !provDetail.loading ? "pointer" : "default",
          transition: "border 0.2s",
        }}
        // 基线加载中禁用打开（弹窗内 provider 字段另显「正在读取…」）。
        onClick={l1 && !provDetail.loading ? openModelModal : undefined}
        // R4 a11y：整卡可点但原先是裸 div（键盘/读屏不可达）——补按钮语义 +
        // 回车/空格等价点击；不可点时整组属性不挂（不谎报可交互）。
        role={l1 && !provDetail.loading ? "button" : undefined}
        tabIndex={l1 && !provDetail.loading ? 0 : undefined}
        aria-label={l1 ? tr("模型配置") : undefined}
        onKeyDown={
          l1 && !provDetail.loading
            ? (e: ReactNS.KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openModelModal();
                }
              }
            : undefined
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BulbIcon size={14} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
            {tr("模型配置")}
          </span>
          <div style={{ flex: 1 }} />
          {l1 ? (
            <span style={{ fontSize: 10, color: t.textSecondary }}>{tr("点击编辑")}</span>
          ) : null}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: t.textSecondary }}>
          {worker.model || tr("未配置")}
          {worker.modelProvider ? ` · ${worker.modelProvider}` : ""}
          {/* 基线不可信（列表投影丢 modelProvider 且 detail 未读到/失败）：
              明示保存时不会动 provider（诚实降级，不显猜测值）。 */}
          {l1 && !provBaseline.trusted
            ? ` · ${tr("未读取到 Provider（保存时保持不变）")}`
            : ""}
        </div>
        {!l1 ? (
          <div style={{ marginTop: 6, fontSize: 11, color: t.textSecondary }}>
            {tr("修改模型配置需 L1 管理权限（Controller 管理员 token）")}
          </div>
        ) : null}
      </div>
      {/* 状态卡（方案 §4.1.3：唤醒/休眠/重启 L1-only；重启 = #1473） */}
      <antd.Card
        size="small"
        title={tr("状态")}
        styles={{ body: { padding: "8px 12px", display: "grid", gap: 2 } }}
      >
        <Row label={tr("休眠")} value={sleeping ? tr("是") : tr("否")} />
        <Row label={tr("重启中")} value={restarting ? tr("是") : tr("否")} warn={restarting} />
        <Row
          label={tr("心跳态")}
          value={
            worker.agentStatus ? (
              <antd.Tag
                color={
                  worker.agentStatus === "active" || worker.agentStatus === "running"
                    ? "green"
                    : worker.agentStatus === "error" || worker.agentStatus === "failed"
                      ? "red"
                      : "default"
                }
                style={{ margin: 0 }}
              >
                {worker.agentStatus}
              </antd.Tag>
            ) : (
              "—"
            )
          }
        />
        <Row label={tr("在跑任务")} value={worker.runningTaskCount ?? "—"} />
        <Row
          label={tr("上次运行")}
          value={worker.lastRunAt ? fmtRfc3339(worker.lastRunAt) : "—"}
        />
        <Row
          label={tr("上次完成")}
          value={worker.lastFinishAt ? fmtRfc3339(worker.lastFinishAt) : "—"}
        />
        {/* loop 预算行：404/失败时 loop=null → 整行不显。 */}
        {loop ? (
          <Row
            label={tr("loop 预算")}
            value={`${loop.state}${loop.mode?.name ? ` · ${loop.mode.name}` : ""}`}
          />
        ) : null}
        {/* Dashboard Tracing 跳转：仅配置了 dashboard 地址时显示（未配置
            → 隐藏）；只跳转不复制页面，也不拼 worker/筛选参数——tracing
            页不支持 URL 参数。 */}
        {tracing ? (
          <div style={{ display: "flex", marginTop: 8 }}>
            <antd.Button
              size="large"
              aria-label={tr("打开 Tracing（Dashboard 调用链页面，新窗口）")}
              style={{ minHeight: 44 }}
              onClick={() =>
                window.open(tracing, "_blank", "noopener,noreferrer")
              }
            >
              {tr("打开 Tracing")}
            </antd.Button>
          </div>
        ) : null}
        {l1 ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {sleeping ? (
              <antd.Button
                size="large"
                type="primary"
                icon={<WakeIcon />}
                loading={acting === "wake"}
                disabled={acting != null}
                style={{ minHeight: 44 }}
                onClick={() => void handleLifecycle("wake")}
              >
                {tr("唤醒")}
              </antd.Button>
            ) : (
              <antd.Button
                size="large"
                icon={<SleepIcon />}
                loading={acting === "sleep"}
                disabled={acting != null || restarting}
                style={{ minHeight: 44 }}
                onClick={() => void handleLifecycle("sleep")}
              >
                {tr("休眠")}
              </antd.Button>
            )}
            <antd.Button
              size="large"
              icon={<ReloadIcon />}
              loading={acting === "restart"}
              disabled={acting != null || restarting}
              style={{ minHeight: 44 }}
              onClick={() => handleRestart()}
            >
              {tr("重启")}
            </antd.Button>
            {/* 拉起就绪：仅 phase 非 Running/Ready 时显示（任务书口径）；
                双 404（老控制器）→ unsupported 态隐藏。 */}
            {shouldShowEnsureReady(worker.phase) && !ensureReadyUnsupported ? (
              <antd.Button
                size="large"
                icon={<PlayIcon />}
                loading={acting === "ensureReady"}
                disabled={acting != null}
                style={{ minHeight: 44 }}
                onClick={() => void handleEnsureReady()}
              >
                {tr("拉起就绪")}
              </antd.Button>
            ) : null}
            {/* #1536：删除 Worker = 资源控制，非 L1 调用者 disabled +
                统一提示（不隐藏）；disabled 按钮不触发 mouse 事件 →
                tooltip 挂在 wrapper span 上。 */}
            {canControl ? (
              <antd.Button
                size="large"
                danger
                style={{ minHeight: 44, marginLeft: "auto" }}
                onClick={confirmDelete}
              >
                {tr("删除")}
              </antd.Button>
            ) : (
              <WbTooltip title={deniedHint} tap={false}>
                <span style={{ display: "inline-block", marginLeft: "auto" }}>
                  <antd.Button size="large" danger disabled style={{ minHeight: 44 }}>
                    {tr("删除")}
                  </antd.Button>
                </span>
              </WbTooltip>
            )}
          </div>
        ) : null}
      </antd.Card>
      {/* 检查点卡（旧拓扑 CheckpointCard 迁入，只读 + 懒加载：展开才拨
          /checkpoints/{status,graph}；四态各自降级，失败不外溢到其它面板）。
          key=worker.name：切 Worker 强制复位折叠/数据态。 */}
      <CheckpointCard
        key={worker.name}
        workerName={worker.name}
        runtime={worker.runtime}
      />
      {/* 会话卡（智能体会话 / 子代理会话双 tab）：数据面 = Worker 运行时
          /workers/{name}/chats（不再从 Worker 详情扇出项目级 /spawns）。
          key=worker.name：切 Worker 强制复位列表/详情/折叠态。 */}
      <antd.Card
        size="small"
        title={tr("会话")}
        styles={{ body: { padding: "8px 12px" } }}
      >
        <div
          style={{
            height: "min(62vh, 560px)",
            minHeight: 240,
            minWidth: 0,
            overflowY: "auto",
          }}
        >
          <WorkerChats
            key={`chats-${worker.name}`}
            workers={[worker]}
            fixedWorker={worker.name}
            showKindTabs
          />
        </div>
      </antd.Card>
      {/* 模型编辑弹窗（响应式：宽屏左右/窄屏上下；与 Manager 详情面板共用）。 */}
      <ModelEditModal
        open={modelModal}
        title={tr("Worker 模型配置")}
        currentModel={worker.model ?? ""}
        // 基线加载中显「正在读取…」占位（读取完成/失败后 effect 复位为
        // 基线值）；handleModelSave 守卫禁止该占位作为 provider 下发。
        currentProvider={provDetail.loading ? tr("正在读取 Worker 配置…") : provBaseline.value}
        runtime={worker.runtime}
        // subagentModel 基线同 provider：detail 优先，列表行兜底。
        currentSubagentModel={provDetail.subagentModel ?? worker.subagentModel ?? ""}
        union={union}
        saving={modelSaving}
        workerName={worker.name}
        l1={l1}
        onCancel={() => setModelModal(false)}
        onSave={handleModelSave}
      />
      {/* 资源卡（10 格，P3）——弹窗承载、懒挂载。 */}
      <ResourceCards
        worker={worker}
        hasToken={hasToken}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
