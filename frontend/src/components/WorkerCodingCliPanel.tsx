import type * as ReactNS from "react";

import {
  listCodingCli,
  getCliSettings,
  putCliSettings,
  startCodingCliInstall,
  getCliInstallTask,
  fetchCodingCliLatest,
  httpErrorStatus,
  httpErrorDetail,
  type CliSettingsResponse,
  type CodingCliId,
  type SettingsObject,
} from "../api";
import {
  CODING_CLI_SEEDS,
  CODING_CLI_WARNINGS,
  FIELD_CATALOG,
  qwenDeprecatedAuthFields,
} from "../codingCliPresets";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { useModelUnionOptions } from "../modelUnion";
import { CodeIcon } from "./icons";
import { WorkerCollapseCard } from "./WorkerPanelsShared";
import {
  CLI_LABEL,
  LatestBadge,
  POLL_MAX_MS,
  taskPollDelayMs,
  isTimeoutError,
  modelNameOf,
  modelOfPatch,
  patchReflectedInSettings,
  rowsFromItems,
  type CliRowState,
  type LatestInfo,
  type LoadState,
} from "./WorkerCodingCliPanelShared";
import { SettingsTreeEditor } from "./WorkerCodingCliPanelEditor";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 探测结果进程内缓存（key=worker 名，TTL 5 分钟）：
 * 展开面板 = 容器内逐 CLI exec（3 次 --version），同一 Worker 反复展开/
 * 切页不应重复付这个成本；过期先渲染旧值再后台刷新（stale-while-revalidate）。 */
const PROBE_TTL_MS = 5 * 60 * 1000;
const probeCache = new Map<string, { items: CliRowState[]; ts: number }>();

function useCodingCliPanel({
  worker,
  sheet,
  onChanged,
}: {
  worker: { name: string };
  sheet?: boolean;
  onChanged?: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [open, setOpen] = React.useState(sheet === true);
  const [state, setState] = React.useState<LoadState>("loading");
  const [items, setItems] = React.useState<CliRowState[]>([]);
  const [loadError, setLoadError] = React.useState("");
  const [readOnly, setReadOnly] = React.useState(false);
  const [selected, setSelected] = React.useState<CodingCliId>("qwen-code");
  const [settings, setSettings] = React.useState<CliSettingsResponse | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  // 15.33：卡片收放（手风琴：至多一卡展开；null=全收）。展开卡=动作行 +
  // settings 表单；收起保留 settings 缓存 → 重开同卡零请求。
  const [expanded, setExpanded] = React.useState<CodingCliId | null>(null);
  const [versionTag, setVersionTag] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [uninstallTarget, setUninstallTarget] = React.useState<CodingCliId | null>(null);
  // 检查更新：各已装 CLI 的 registry latest（best-effort；容器镜像源可能不同）。
  const [latestInfo, setLatestInfo] = React.useState<
    Record<string, LatestInfo>
  >({});
  const pollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = React.useRef(false);
  const settingsReqRef = React.useRef(0);
  // R4（16.23）：卡片展开态的 ref 镜像——任务轮询选档（快档 1.5s /
  // 慢档 30s）在 setTimeout 回调里读，不能用会过期的闭包 state。
  // sheet 模式 open 初值即 true，同一镜像覆盖两种形态。
  const openRef = React.useRef(open);
  openRef.current = open;

  const stopPoll = React.useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      stopPoll();
    };
  }, [stopPoll]);

  const [probedAt, setProbedAt] = React.useState(0);

  const load = React.useCallback(async (force = false) => {
    const cached = probeCache.get(worker.name);
    if (!force && cached) {
      // 先渲染缓存（零等待），未过期则不再打容器。
      setItems(cached.items);
      setProbedAt(cached.ts);
      setState("ready");
      if (Date.now() - cached.ts < PROBE_TTL_MS) return;
    }
    try {
      const raw = await listCodingCli(worker.name);
      if (cancelledRef.current) return;
      const rows = rowsFromItems(raw);
      probeCache.set(worker.name, { items: rows, ts: Date.now() });
      setItems(rows);
      setProbedAt(Date.now());
      setState("ready");
    } catch (e) {
      if (cancelledRef.current) return;
      // 有缓存时保留旧值（stale 优于整块报错），后台刷新失败静默。
      if (cached) return;
      const st = httpErrorStatus(e);
      if (st === 404) {
        setState("unavailable");
        return;
      }
      setState("error");
      setLoadError(httpErrorDetail(e) || tr("网络错误"));
    }
  }, [worker.name, tr]);

  // 展开即首拉（惰性：探测有容器 exec 成本）。
  React.useEffect(() => {
    if (open && state === "loading" && items.length === 0) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadSettings = React.useCallback(
    async (cli: CodingCliId) => {
      const reqId = ++settingsReqRef.current;
      setSelected(cli);
      setSettingsOpen(true);
      setSettings(null);
      try {
        const json = await getCliSettings(worker.name, cli);
        if (cancelledRef.current || reqId !== settingsReqRef.current) return;
        setSettings(json);
      } catch (e) {
        if (cancelledRef.current || reqId !== settingsReqRef.current) return;
        if (httpErrorStatus(e) === 403) {
          setReadOnly(true);
          setSettingsOpen(false);
          setMsg({ kind: "err", text: tr("当前角色仅可查看，不能修改编码 CLI") });
          return;
        }
        setSettingsOpen(false);
        setMsg({
          kind: "err",
          text: httpErrorDetail(e) || tr("加载 settings 失败"),
        });
      }
    },
    [worker.name, tr],
  );

  // 15.33：点卡头=收放（手风琴）。展开=选中该 CLI + 按需拉 settings
  // （缓存归属按响应自带 cli 字段判定——miss 才拉，切卡不盲拉）；
  // 收起只隐藏不取消（settingsOpen 保留 → 重开同卡零请求）。
  const expandToggle = React.useCallback(
    (cli: CodingCliId) => {
      if (expanded === cli) {
        setExpanded(null);
        return;
      }
      setExpanded(cli);
      if (settings === null || settings.cli !== cli) {
        void loadSettings(cli);
      }
    },
    [expanded, settings, loadSettings],
  );

  // 保存（15.26 F4② 网络传输优化）：patch 由结构化树表单算出（叶子级 diff
  // + secret 补丁，只发变更）。PUT 响应已含 merged+redacted settings → 直接
  // 回写本地基线，免再 GET 重拉（省一次全量读）。
  const saveSettings = React.useCallback(
    async (patch: SettingsObject) => {
      if (busy || readOnly) return;
      if (!patch || Object.keys(patch).length === 0) {
        setMsg({ kind: "ok", text: tr("无改动") });
        return;
      }
      setBusy(true);
      setMsg(null);
      try {
        const resp = await putCliSettings(worker.name, selected, patch);
        // 保存摘要回读（15.27）：动了模型=明示新值（留空=已清除）——
        // 对齐「像管理 worker 那样容易管理」：每次保存一眼确认生效值。
        const m = modelOfPatch(patch);
        if (m !== undefined) {
          setMsg({
            kind: "ok",
            text: m
              ? tr("已保存（模型={m}）", { m })
              : tr("已保存（模型覆盖已清除，回退 CLI 默认）"),
          });
        } else {
          setMsg({ kind: "ok", text: tr("已保存") });
        }
        if (resp && resp.settings) setSettings(resp);
        else await loadSettings(selected);
        onChanged?.();
      } catch (e) {
        if (httpErrorStatus(e) === 403) {
          setReadOnly(true);
          setMsg({ kind: "err", text: tr("当前角色仅可查看，不能修改编码 CLI") });
        } else if (isTimeoutError(e)) {
          // 15.29：超时≠失败。服务端同步写可能已在客户端放弃后完成
          // （慢盘/审计尾延迟，写本身数秒内已成功）→ 读回验证：已反映
          // =按成功处理（回写基线）；未反映=如实报错，不假装成功。
          setMsg({
            kind: "ok",
            text: tr("写入慢，读回验证是否已生效…"),
          });
          try {
            const rb = await getCliSettings(worker.name, selected);
            const reflected = patchReflectedInSettings(patch, rb?.settings);
            if (reflected) {
              if (rb) setSettings(rb);
              const m = modelOfPatch(patch);
              setMsg({
                kind: "ok",
                text: m
                  ? tr("已生效（写入慢，读回确认模型={m}）", { m })
                  : tr("已生效（写入慢，读回确认）"),
              });
              onChanged?.();
            } else {
              setMsg({
                kind: "err",
                text: tr("保存超时且读回未见生效——请刷新重试"),
              });
            }
          } catch (e2) {
            setMsg({
              kind: "err",
              text: httpErrorDetail(e2) || tr("保存超时，读回失败——请重试"),
            });
          }
        } else {
          setMsg({ kind: "err", text: httpErrorDetail(e) || tr("保存失败") });
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, loadSettings, onChanged, readOnly, selected, tr, worker.name],
  );

  const pollTask = React.useCallback(
    async (cli: CodingCliId, taskId: string) => {
      const tick = async (): Promise<"stop" | "continue"> => {
        if (cancelledRef.current) return "stop";
        try {
          const task = await getCliInstallTask(worker.name, cli, taskId);
          if (cancelledRef.current) return "stop";
          if (task.state === "done") {
            setMsg({ kind: "ok", text: tr("{cli} 任务完成", { cli: CLI_LABEL[cli] }) });
            await load();
            return "stop";
          }
          if (task.state === "failed") {
            const extra =
              typeof task.stderr_tail === "string" && task.stderr_tail
                ? task.stderr_tail
                : typeof task.exit_code === "number"
                  ? tr("退出码 {c}", { c: task.exit_code })
                  : tr("安装失败");
            setMsg({ kind: "err", text: extra });
            return "stop";
          }
          return "continue";
        } catch (e) {
          if (cancelledRef.current) return "stop";
          setMsg({ kind: "err", text: httpErrorDetail(e) || tr("查询任务失败") });
          return "stop";
        }
      };
      if ((await tick()) === "stop") {
        setBusy(false);
        return;
      }
      const started = Date.now();
      stopPoll();
      const schedule = () => {
        // R4（16.23）：选档——面板可见（卡片展开/sheet）+ 页面可见走
        // 快档 1.5s；任一不可见降 30s 兜底档（每轮实时读，收/展卡片与
        // 切 tab 都即时生效；浏览器对后台 tab 定时器本身也有节流）。
        const delay = taskPollDelayMs(openRef.current, !document.hidden);
        pollRef.current = setTimeout(() => {
          void (async () => {
            if (cancelledRef.current) {
              setBusy(false);
              return;
            }
            if (Date.now() - started > POLL_MAX_MS) {
              stopPoll();
              setBusy(false);
              setMsg({ kind: "err", text: tr("安装仍在进行，请稍后刷新") });
              return;
            }
            const result = await tick();
            if (result === "stop") {
              setBusy(false);
              return;
            }
            schedule();
          })();
        }, delay);
      };
      schedule();
    },
    [load, stopPoll, tr, worker.name],
  );

  const runInstall = React.useCallback(
    async (cli: CodingCliId, action: "install" | "uninstall") => {
      if (busy || readOnly) return;
      setSelected(cli);
      setBusy(true);
      setMsg(null);
      try {
        const tag = versionTag.trim();
        const r = await startCodingCliInstall(worker.name, cli, action, action === "install" && tag ? tag : undefined);
        if (r.task_id) {
          await pollTask(cli, r.task_id);
        } else {
          setBusy(false);
          setMsg({ kind: "err", text: tr("安装请求未返回任务 ID") });
        }
      } catch (e) {
        const st = httpErrorStatus(e);
        if (st === 403) {
          setReadOnly(true);
          setMsg({ kind: "err", text: tr("当前角色仅可查看，不能修改编码 CLI") });
        } else if (st === 409) {
          setMsg({ kind: "err", text: tr("该 CLI 已有安装任务进行中") });
        } else {
          setMsg({
            kind: "err",
            text:
              st === 503
                ? tr("当前部署模式不支持容器内安装与配置（embedded 才可执行）")
                : st === 502
                  ? tr("无法在该 Worker 容器内执行管理命令")
                  : httpErrorDetail(e) || tr("安装请求失败"),
          });
        }
        setBusy(false);
      }
    },
    [busy, pollTask, readOnly, tr, versionTag, worker.name],
  );

  // 检查更新：一次请求让宿主后端查全部已装 CLI 的 registry latest
  // （走 /agentteams-proxy/coding-cli/latest，非浏览器直连——操作机内网
  // 可能连不上外网 registry）。失败仅标记该 CLI，不影响其他。
  const checkUpdates = React.useCallback(async () => {
    const installed = items.filter((c) => c.installed);
    if (installed.length === 0) return;
    const next: Record<string, LatestInfo> = { ...latestInfo };
    for (const c of installed) next[c.id] = { checking: true };
    setLatestInfo({ ...next });
    try {
      const res = await fetchCodingCliLatest(
        installed.map((c) => c.id).join(","),
      );
      for (const c of installed) {
        const it = res.items?.[c.id];
        if (it?.latest) next[c.id] = { checking: false, latest: it.latest };
        else next[c.id] = { checking: false, error: it?.error || "unreachable" };
      }
    } catch {
      // 403（无 L1）/网络失败 → 全部显不可达（仍可手动填 tag 升级）。
      for (const c of installed) next[c.id] = { checking: false, error: "unreachable" };
    }
    setLatestInfo({ ...next });
  }, [items, latestInfo]);

  return {
    open,
    setOpen,
    state,
    items,
    probedAt,
    loadError,
    load,
    latestInfo,
    checkUpdates,
    readOnly,
    selected,
    setSelected,
    settings,
    settingsOpen,
    expanded,
    expandToggle,
    versionTag,
    setVersionTag,
    busy,
    msg,
    setMsg,
    uninstallTarget,
    setUninstallTarget,
    loadSettings,
    saveSettings,
    runInstall,
    tr,
    t,
  };
}

function CodingCliPanelBody({
  s,
}: {
  s: ReturnType<typeof useCodingCliPanel>;
}) {
  const { tr, t } = s;

  // 模型列表选择（15.27，同 Worker 模型选择正源）：候选 = SGLang 在服 ∪
  // 在用（当前 CLI 的 model.name）∪ 网关 alias；写前校验同款。hook 仅在
  // 卡片展开时挂载（惰性，无后台轮询）。
  // 15.29：双格式兼容读——CLI 原生 settings.json 的 model 是**字符串**
  // （controller 测试夹具 "model":"updated" 实证），早期对象格式
  // （{name}，dashboard 同款写法）也兼容读。
  // 15.31：模型名读取收敛到 modelNameOf（对象{name}/扁平串双格式），与
  // 模型行 dirty 判定、handleSave base 比对同一口径（三处不漂移）。
  const settingsModel: string = React.useMemo(
    () => modelNameOf(s.settings?.settings),
    [s.settings],
  );
  const union = useModelUnionOptions(
    settingsModel ? [settingsModel] : [],
    tr,
  );
  const [modelDraft, setModelDraft] = React.useState<string | null>(null);
  React.useEffect(() => {
    // settings 加载/切 CLI/保存回写 → 模型草稿重置为当前生效值。
    setModelDraft(settingsModel);
  }, [s.settings, settingsModel]);

  if (s.state === "loading") {
    return (
      <div style={{ fontSize: 12, color: t.textSecondary }}>
        {tr("编码 CLI 探测中（容器内逐 CLI 跑 --version，有 exec 成本）…")}
      </div>
    );
  }

  if (s.state === "unavailable") {
    return (
      <antd.Alert
        type="warning"
        showIcon
        message={tr("该 Worker 的编码 CLI 管理暂不可用，升级 AgentTeams 后自动生效。")}
      />
    );
  }

  if (s.state === "error") {
    return (
      <antd.Alert
        type="error"
        showIcon
        message={tr("加载失败：{e}", { e: s.loadError })}
        action={
          <antd.Button size="small" onClick={() => void s.load()}>
            {tr("重试")}
          </antd.Button>
        }
      />
    );
  }



  return (
    <>
      {s.readOnly ? (
        <div style={{ fontSize: 11, color: t.mode === "dark" ? "#faad14" : "#d46b08" }}>
          {tr("当前角色仅可查看，不能修改编码 CLI。")}
        </div>
      ) : null}

      {/* 探测缓存提示 + 手动重探（5 分钟 TTL，过期后台刷新不阻塞）。 */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: t.textSecondary,
        }}
      >
        {s.probedAt ? (
          <span>
            {tr("探测于 {t}（缓存 5 分钟）", {
              t: new Date(s.probedAt).toLocaleTimeString(),
            })}
          </span>
        ) : null}
        <antd.Button
          size="small"
          type="link"
          style={{ padding: 0, height: "auto" }}
          onClick={() => void s.load(true)}
        >
          {tr("重新探测")}
        </antd.Button>
      </div>

      {/* 15.33：版本 tag（安装/升级均生效；可填具体 tag 探测，空=latest）。
       * 三卡共用 → 保持全局单行（harness S1f count=1 判据不变）。 */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("版本 tag（安装/升级）")}</span>
        <antd.Input
          size="small"
          style={{ width: 170, fontFamily: "monospace" }}
          placeholder={tr("如 0.25.0；空=latest")}
          value={s.versionTag}
          disabled={s.readOnly}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => s.setVersionTag(e.target.value)}
        />
      </div>

      {/* 15.33：CLI 卡片网格（卡片化收放）——auto-fit 自适应排列：
       * 宽屏 3 列 / 中屏 2 列 / 窄屏 1 列（wbc-narrow 全局 CSS 强制 1 列）。
       * 卡=一个 CLI；点卡头=收放（手风琴：至多一卡展开）；展开卡通栏
       * （1 / -1）容纳动作行 + settings 表单。
       * 触屏：卡头 ≥44px 目标 + userSelect none（防双击选中）；
       * 鼠标：cursor pointer + chevron 指示，无 hover-only 信息。 */}
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))",
        }}
      >
        {s.items.map((cli) => {
          const isExp = s.expanded === cli.id;
          // settings 归属按响应自带 cli 字段判定（防上一张卡的陈旧数据
          // 显示到本卡——切卡 fetch 窗口期的防串卡门）。
          const acc =
            s.settings && s.settings.cli === cli.id ? s.settings : null;
          return (
            <div
              key={cli.id}
              style={{
                gridColumn: isExp ? "1 / -1" : undefined,
                minWidth: 0,
                border: `1px solid ${isExp ? (t.mode === "dark" ? "#4096ff" : "#91caff") : t.border}`,
                borderRadius: 8,
                background: isExp
                  ? t.mode === "dark"
                    ? "rgba(64, 150, 255, 0.07)"
                    : "rgba(145, 204, 255, 0.10)"
                  : undefined,
                overflow: "hidden",
              }}
            >
              {/* 卡头：点=收放（touch ≥44 目标 / mouse cursor+chevron）。 */}
              <div
                onClick={() => s.expandToggle(cli.id)}
                title={tr("点击展开 / 收起")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  minHeight: 44,
                  padding: "8px 12px",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span style={{ width: 12, fontSize: 11, color: "#888" }}>
                  {isExp ? "▾" : "▸"}
                </span>
                <span
                  style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}
                >
                  {CLI_LABEL[cli.id]}
                </span>
                <antd.Tag
                  color={cli.installed ? "green" : "default"}
                  style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
                >
                  {cli.installed ? cli.version || tr("已安装") : tr("未安装")}
                </antd.Tag>
                {cli.installed ? (
                  <LatestBadge
                    info={s.latestInfo[cli.id]}
                    installed={cli.version}
                    tr={tr}
                  />
                ) : null}
                {cli.authConfigured ? (
                  <antd.Tag
                    style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
                  >
                    {tr("鉴权已配置")}
                  </antd.Tag>
                ) : null}
                {/* 当前 CLI 生效模型（仅当该卡 settings 在缓存时显示）。 */}
                {isExp && acc && settingsModel ? (
                  <antd.Tag
                    color="blue"
                    style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
                  >
                    {tr("模型")} {settingsModel}
                  </antd.Tag>
                ) : null}
              </div>
              {isExp ? (
                <div style={{ padding: "2px 12px 10px", display: "grid", gap: 8 }}>
                  {/* 动作行（触屏：middle 32px + wb-touch-lg 命中区扩 ≥44）。 */}
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    {cli.installed ? (
                      <>
                        <antd.Button
                          size="middle"
                          className="wb-touch-lg"
                          disabled={s.busy || s.readOnly}
                          onClick={() => void s.runInstall(cli.id, "install")}
                        >
                          {tr("升级")}
                        </antd.Button>
                        <antd.Button
                          size="middle"
                          danger
                          className="wb-touch-lg"
                          disabled={s.busy || s.readOnly}
                          onClick={() => s.setUninstallTarget(cli.id)}
                        >
                          {tr("卸载")}
                        </antd.Button>
                      </>
                    ) : (
                      <antd.Button
                        size="middle"
                        className="wb-touch-lg"
                        disabled={s.busy || s.readOnly}
                        onClick={() => void s.runInstall(cli.id, "install")}
                      >
                        {tr("安装")}
                      </antd.Button>
                    )}
                    {cli.authConfigured && !cli.installed ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: t.mode === "dark" ? "#faad14" : "#d46b08",
                        }}
                      >
                        {tr("容器重建后需重新安装；已保存的鉴权可保留")}
                      </span>
                    ) : null}
                  </div>
                  {/* 15.30：已知坑告警（配置写了但不生效的坑前置——
                   * coding-cli SKILL 实证）。 */}
                  {CODING_CLI_WARNINGS[cli.id] ? (
                    <antd.Alert
                      type="warning"
                      showIcon
                      message={tr(CODING_CLI_WARNINGS[cli.id])}
                      style={{ padding: "3px 8px", fontSize: 11 }}
                    />
                  ) : null}
                  {/* 15.31：废弃字段检测（以本卡归属的 settings 为源）。 */}
                  {cli.id === "qwen-code" ? (
                    (() => {
                      const dep = qwenDeprecatedAuthFields(acc?.settings);
                      if (dep.length === 0) return null;
                      return (
                        <antd.Alert
                          type="error"
                          showIcon
                          message={tr("检测到已废弃字段 {fields}——Qwen Code 已弃用 security.auth.apiKey/baseUrl，请改用 modelProviders（envKey）+ env 块（JSON 补丁）或容器 ~/.qwen/.env，然后删除这些字段。", {
                            fields: dep.join(", "),
                          })}
                          style={{ padding: "3px 8px", fontSize: 11 }}
                        />
                      );
                    })()
                  ) : null}
                  {/* settings 表单（15.28/15.30：空配置也渲染编辑器——
                   * base 空 + seed 预填常用字段，保存即 PUT merge 创建文件；
                   * 15.32：完整字段清单 FIELD_CATALOG 驱动）。 */}
                  {s.settingsOpen && !acc ? (
                    <div style={{ fontSize: 11, color: t.textSecondary }}>
                      {tr("加载 settings…")}
                    </div>
                  ) : null}
                  {s.settingsOpen && acc ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      <div style={{ fontSize: 11, color: t.textSecondary }}>
                        {tr("{cli} settings（结构化表单 · 只保存改动）", {
                          cli: CLI_LABEL[cli.id],
                        })}
                      </div>
                      <SettingsTreeEditor
                        base={
                          acc.settings && Object.keys(acc.settings).length > 0
                            ? acc.settings
                            : {}
                        }
                        readOnly={s.readOnly}
                        busy={s.busy}
                        modelValue={modelDraft ?? ""}
                        onModelChange={setModelDraft}
                        modelOptions={union.options}
                        modelCandidates={union.candidates}
                        objectModel={cli.id === "qwen-code"}
                        seed={CODING_CLI_SEEDS[cli.id].template}
                        seedSecrets={CODING_CLI_SEEDS[cli.id].secretPaths}
                        patchPlaceholder={CODING_CLI_SEEDS[cli.id].patchPlaceholder}
                        catalog={FIELD_CATALOG[cli.id]}
                        onSave={(patch) => void s.saveSettings(patch)}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>


      {s.msg ? (
        <div
          style={{
            fontSize: 11,
            color: s.msg.kind === "ok" ? (t.mode === "dark" ? "#95de64" : "#389e0d") : "#cf1322",
          }}
        >
          {s.msg.text}
        </div>
      ) : null}

      {/* 卸载二次确认。 */}
      <antd.Modal
        open={s.uninstallTarget !== null}
        title={tr("确认卸载")}
        okText={tr("确认卸载")}
        cancelText={tr("取消")}
        confirmLoading={s.busy}
        onCancel={() => {
          if (!s.busy) s.setUninstallTarget(null);
        }}
        onOk={() => {
          const cli = s.uninstallTarget;
          if (!cli) return;
          s.setUninstallTarget(null);
          void s.runInstall(cli, "uninstall");
        }}
      >
        <span>
          {tr("将从该 Worker 容器卸载 {cli}。安装状态会丢失，已保存的鉴权可保留。", {
            cli: s.uninstallTarget ? CLI_LABEL[s.uninstallTarget] : "",
          })}
        </span>
      </antd.Modal>
    </>
  );
}

/** 折叠卡外壳（与「环境变量与网关探测」同款视觉家族）。 */
function WorkerCodingCliPanel({
  worker,
  sheet,
  onChanged,
}: {
  worker: { name: string };
  sheet?: boolean;
  onChanged?: () => void;
}) {
  const s = useCodingCliPanel({ worker, sheet, onChanged });
  const { tr } = s;

  return (
    <WorkerCollapseCard
      open={s.open}
      sheet={sheet}
      icon={<CodeIcon size={13} />}
      title={tr("Coding CLI（安装/升级/settings）")}
      onExpand={() => s.setOpen(true)}
      onCollapse={() => s.setOpen(false)}
      headerExtra={
        <>
          <div style={{ flex: 1 }} />
          <antd.Button
            size="small"
            type="text"
            disabled={s.state !== "ready" || s.busy}
            onClick={() => void s.checkUpdates()}
          >
            {tr("检查更新")}
          </antd.Button>
          <antd.Button
            size="small"
            type="text"
            disabled={s.state !== "ready"}
            onClick={() => void s.load()}
          >
            {tr("刷新")}
          </antd.Button>
        </>
      }
    >
      <CodingCliPanelBody s={s} />
    </WorkerCollapseCard>
  );
}

export default WorkerCodingCliPanel;
