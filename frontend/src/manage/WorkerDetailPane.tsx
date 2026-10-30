/**
 * WorkerDetailPane.tsx — 「管理」页团队域·右栏 Worker 详情（方案 §4.1.3，P2）。
 *
 * 头部（方案 §4.1.3 头部四行，16.27 B 起模型行升级为「模型配置」卡）：
 * - 头像 + 名字 + 角色徽标
 * - 状态灯 + phase（不一致时附容器态红字 = crashloop 诊断信号）
 * - 运行时 + 版本（AgentTeams 版本 = 镜像 tag 正源；L1 再经
 *   node-version 端点探测容器内运行时实际版本，10min 缓存）
 *
 * 模型配置卡（16.27 B）：原头部只读「模型」行升级为卡（状态卡之前）——
 * 当前值摘要（只读展示保留）+ 模型 alias / Provider 编辑；候选与写前
 * 校验走 useModelUnionOptions（与 StandaloneWorkerModels/ManagerTable
 * 同源）；保存 = PUT /workers/{name} 合并语义，model + modelProvider
 * 同时下发（多 provider 部署只改 model 仍走旧 provider）；L1-only
 * （与唤醒/休眠同门控），未改动不发 PUT；成功 → invalidateTags +
 * onRefreshAdmin（不新增轮询）。
 *
 * 状态卡：休眠 / 重启中 / 心跳态（agentStatus）/ 在跑任务 /
 * 上次运行 / 上次完成 + loop 预算（GET /workers/{name}/loops/status，
 * 404/失败 → 整行不显，诚实降级）；唤醒/休眠操作 L1-only，
 * 重启按钮不显示（端点未上游，接口位留给后续）。
 *
 * 资源卡（运行配置/环境变量与网关/Coding CLI/MCP/插件/技能/工具/
 * 频道/审批模式/运行时升级）= ResourceCards（P3，本组件下方接续）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  fetchNodeVersion,
  fetchWorkerLoopStatusBySession,
  imageTag,
  postController,
  updateWorkerModel,
  type NodeVersion,
  type WorkerInfo,
  type WorkerLoopStatus,
} from "../api";
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
  fmtRfc3339,
  isStateConsistent,
  phaseMeta,
} from "../components/WorkerManageShared";
import { RuntimeNotice } from "../runtimeGuard";
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
  onRefreshAdmin,
  onOpenSettings,
}: {
  worker: WorkerInfo;
  /** 头像源（room 成员表 mxc 头像；undefined → 首字母兜底）。 */
  avatarUrl?: string;
  hasToken?: boolean;
  onRefreshAdmin?: (silent?: boolean) => void;
  /** 运行配置卡内「去设置」跳转（透传 WorkerRuntimeConfig）。 */
  onOpenSettings?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const obj = useAvatarUrl(avatarUrl);
  const l1 = !!hasToken;
  const meta = phaseMeta(worker.phase);
  const sleeping = worker.phase === "Sleeping" || worker.phase === "Stopped";
  const restarting = (worker.containerState || "").toLowerCase() === "restarting";
  const stateInconsistent = !isStateConsistent(worker.state, worker.containerState);
  const [acting, setActing] = React.useState<"wake" | "sleep" | null>(null);

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

  // ── 模型配置卡（16.27 B）——候选/校验与 StandaloneWorkerModels 同源 ──
  // 草稿只存「改动项」（undefined = 跟当前值基线）；基线 provider：
  // Controller 的 modelProvider 优先，旧 Controller 不返回时由 alias 的
  // binding 推导（与 StandaloneWorkerModels 同基线）。
  const union = useModelUnionOptions([worker.model || ""], tr);
  const [modelDraft, setModelDraft] = React.useState<string | undefined>(undefined);
  const [provDraft, setProvDraft] = React.useState<string | undefined>(undefined);
  const [modelSaving, setModelSaving] = React.useState(false);
  // 切 worker 不卸载本组件（TeamSection 无 key）→ 复位草稿。
  React.useEffect(() => {
    setModelDraft(undefined);
    setProvDraft(undefined);
    setModelSaving(false);
  }, [worker.name]);

  const baselineProv =
    worker.modelProvider ||
    providerForModel(union.gatewayOptions, worker.model || "");
  const modelVal = modelDraft ?? worker.model ?? "";
  const provVal = provDraft ?? baselineProv;
  const modelDirty =
    modelVal !== (worker.model || "") || provVal !== baselineProv;
  const modelVerdict = validateModelValue(modelVal, union.candidates);

  const saveModel = React.useCallback(
    async () => {
      const m = modelVal.trim();
      const p = provVal.trim();
      const vd = validateModelValue(m, union.candidates);
      if (vd.level === "error") {
        antd.message.error(modelVerdictText(tr, vd, m, union.candidates));
        return;
      }
      setModelSaving(true);
      try {
        // PUT 合并语义：model + modelProvider 必须同时下发——多 Higress
        // Provider 部署下只改 model 仍走旧 provider（任务书口径）；
        // provider 空 = 跟随默认（StandaloneWorkerModels 语义）。
        await updateWorkerModel(worker.name, m, p);
        antd.message.success(
          vd.level === "warn"
            ? tr("已保存（提示：{t}）", {
                t: modelVerdictText(tr, vd, m, union.candidates),
              })
            : tr("模型已保存（重启 Worker 后生效）"),
        );
        setModelDraft(undefined);
        setProvDraft(undefined);
        // 模型 = Worker spec 变更 → 失效缓存 + 刷新（同唤醒/休眠）。
        invalidateTags(["teams", "admin"]);
        void onRefreshAdmin?.();
      } catch (e) {
        // 失败展示后端错误文本（不吞错）。
        antd.message.error(
          e instanceof Error ? e.message : tr("保存失败"),
        );
      } finally {
        setModelSaving(false);
      }
    },
    [worker.name, modelVal, provVal, union.candidates, onRefreshAdmin, tr],
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

  const tag = imageTag(worker.image);
  return (
    <div style={{ display: "grid", gap: 10, padding: 4 }}>
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
      {/* 模型配置卡（16.27 B）——头部只读模型行升级；当前值摘要 +
          模型/Provider 编辑（L1-only，未改动不发 PUT）。 */}
      <antd.Card
        size="small"
        title={tr("模型配置")}
        styles={{ body: { padding: "8px 12px", display: "grid", gap: 8 } }}
      >
        <Row
          label={tr("当前值")}
          value={`${worker.model || "—"}${
            worker.modelProvider ? `（${worker.modelProvider}）` : ""
          }`}
        />
        {l1 ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 96,
                  flexShrink: 0,
                  fontSize: 12,
                  color: t.textSecondary,
                }}
              >
                {tr("模型")}
              </span>
              <antd.AutoComplete
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                value={modelVal}
                options={union.options}
                allowClear
                disabled={modelSaving}
                placeholder={tr("模型 alias（留空=跟随集群默认）")}
                onChange={(val: string) => {
                  setModelDraft(val || "");
                  // configured alias → 自动回填其 binding.providerName。
                  const auto = providerForModel(
                    union.gatewayOptions,
                    val || "",
                  );
                  if (auto) setProvDraft(auto);
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 96,
                  flexShrink: 0,
                  fontSize: 12,
                  color: t.textSecondary,
                }}
              >
                {tr("Provider")}
              </span>
              <antd.AutoComplete
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                value={provVal}
                options={union.providers.map((p) => ({ value: p.name }))}
                allowClear
                disabled={modelSaving}
                placeholder={tr("留空=跟随默认（Higress Provider 名）")}
                onChange={(val: string) => setProvDraft(val || "")}
              />
            </div>
            {modelVerdict.level !== "ok" ? (
              <div
                style={{
                  fontSize: 11,
                  lineHeight: 1.6,
                  paddingLeft: 104,
                  // token 集无 danger 色 → 语义红走 CSS 关键字（同 Row）。
                  color: modelVerdict.level === "error" ? "red" : t.textSecondary,
                }}
              >
                {modelVerdictText(tr, modelVerdict, modelVal, union.candidates)}
              </div>
            ) : null}
            <antd.Button
              type="primary"
              size="large"
              loading={modelSaving}
              disabled={!modelDirty}
              style={{ minHeight: 44, justifyContent: "center" }}
              onClick={() => void saveModel()}
            >
              {tr("保存")}
            </antd.Button>
          </>
        ) : (
          <div style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("修改模型配置需 L1 管理权限（Controller 管理员 token）")}
          </div>
        )}
      </antd.Card>
      {/* 状态卡（方案 §4.1.3：重启按钮不显示——端点未上游） */}
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
          </div>
        ) : null}
      </antd.Card>
      {/* 资源卡（10 格，P3）——弹窗承载、懒挂载。 */}
      <ResourceCards
        worker={worker}
        hasToken={hasToken}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}
