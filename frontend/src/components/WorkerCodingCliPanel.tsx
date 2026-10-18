/**
 * WorkerCodingCliPanel.tsx — per-Worker coding CLI 管理（消费上游
 * AgentTeams 1.2.5 #1360「manage worker coding CLIs via container exec」）。
 * 逐字段移植自 dashboard worker-coding-cli-panel.tsx（两侧同源不漂移）。
 *
 * 契约（上游 v1.2.5 源码实读：agentteams-controller internal/server/
 * worker_coding_cli.go，2026-10-17 对账）：
 * - GET /workers/{name}/coding-cli → map[cli_id] = {cli, installed,
 *   version?, auth?: {configured, method?}, error?}。探测=容器内逐 CLI
 *   跑 --version（有 exec 成本）→ 惰性加载（展开首拉 + 动作后重拉），
 *   无后台轮询。
 * - POST /workers/{name}/coding-cli/{cli}/install {action:
 *   "install"|"uninstall", version?} → 202 {task_id, state:"running"}；
 *   任务查询 GET .../install/{task_id} → {state: running|done|failed,
 *   exit_code?, stderr_tail?}。409 = 该 CLI 已有任务进行中。
 * - GET/PUT .../{cli}/settings：读=服务端脱敏（{redacted:true,
 *   has_value}）；写 = deep-merge，"***" 哨兵 = 保留现有密钥（哨兵无
 *   现有值 = 400）。
 * - 授权：写 admin/manager-only（L2/Leader → 403 → 整面只读）；
 *   404 = 旧 Controller（整段隐藏，优雅降级，同 env 面板）；
 *   502 = 容器不可达 / 503 = 部署模式不支持容器内管理（embedded 才可）。
 * - 管控面走 /agentteams-proxy/controller catch-all 透传；
 *   「检查更新」走宿主端点 /agentteams-proxy/coding-cli/latest
 *   （后端 server-side 查 npm registry latest——浏览器在内网可能连不上外网
 *    registry，故不直连；升级仍 = 发 install 指令，无新机制）。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键；
 * 破坏性操作（卸载）二次确认。
 */
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
  type CodingCliProbeItem,
  type SettingsObject,
  type SettingsValue,
} from "../api";
import {
  CODING_CLI_IDS,
  isRedacted,
} from "../codingCliPresets";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import {
  modelVerdictText,
  useModelUnionOptions,
  validateModelValue,
} from "../modelUnion";
import { CodeIcon } from "./icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const CLI_LABEL: Record<CodingCliId, string> = {
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
  qoder: "Qoder",
};

interface LatestInfo {
  checking: boolean;
  latest?: string;
  error?: string;
}

/** 宽松版本号比较（仅数字段；prerelease 视为低于同号）。解析失败=0（未知）。 */
function compareVersions(a?: string, b?: string): number {
  const parse = (v?: string): number[] | null => {
    if (!v) return null;
    const core = v.split("-")[0].split("+")[0];
    const parts = core.split(".").map((x) => parseInt(x, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // 同号：prerelease 低于正式版。
  const aPre = a && a.indexOf("-") >= 0 ? 1 : 0;
  const bPre = b && b.indexOf("-") >= 0 ? 1 : 0;
  return bPre - aPre;
}

/** 已装 CLI 的 registry latest 指示徽标（best-effort；不可达优雅降级）。 */
function LatestBadge({
  info,
  installed,
  tr,
}: {
  info?: LatestInfo;
  installed?: string;
  tr: (k: string, v?: Record<string, string | number>) => string;
}) {
  if (!info) return null;
  if (info.checking) {
    return (
      <antd.Tag
        color="processing"
        style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
      >
        {tr("检查更新中…")}
      </antd.Tag>
    );
  }
  if (info.error) {
    return (
      <antd.Tag
        style={{
          marginInlineEnd: 0,
          fontSize: 10,
          lineHeight: "16px",
          opacity: 0.7,
        }}
      >
        {tr("registry 不可达（手动填 tag 仍可升级）")}
      </antd.Tag>
    );
  }
  if (!info.latest) return null;
  const cmp = compareVersions(installed, info.latest);
  if (cmp < 0) {
    return (
      <antd.Tag
        color="gold"
        style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
      >
        {tr("有更新 → {v}", { v: info.latest })}
      </antd.Tag>
    );
  }
  if (cmp === 0) {
    return (
      <antd.Tag
        color="success"
        style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
      >
        {tr("已是最新")}
      </antd.Tag>
    );
  }
  // 无法比较（版本号非标准）→ 仅提示 registry latest。
  return (
    <antd.Tag
      style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
    >
      {tr("registry 最新 {v}", { v: info.latest })}
    </antd.Tag>
  );
}

const SENTINEL = "***";
const POLL_MS = 1500;
const POLL_MAX_MS = 5 * 60 * 1000;

type LoadState = "loading" | "ready" | "unavailable" | "error";

interface CliRowState {
  id: CodingCliId;
  installed: boolean;
  version?: string;
  authConfigured: boolean;
}

/** api 层已把 map 转数组；这里按白名单固定序归一（未知 CLI 静默丢弃）。 */
function rowsFromItems(items: CodingCliProbeItem[]): CliRowState[] {
  const byId = new Map<string, CodingCliProbeItem>();
  for (const it of items) if (it && typeof it === "object") byId.set(it.cli, it);
  return (CODING_CLI_IDS as readonly string[]).map((id) => {
    const f = byId.get(id);
    return {
      id: id as CodingCliId,
      installed: f?.installed === true,
      version: f?.version,
      authConfigured: f?.auth?.configured === true,
    };
  });
}

function collectRedacted(
  obj: SettingsObject,
  path: string[] = [],
): Array<{ path: string[]; has_value: boolean }> {
  const out: Array<{ path: string[]; has_value: boolean }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const next = [...path, key];
    if (isRedacted(value)) out.push({ path: next, has_value: value.has_value });
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...collectRedacted(value as SettingsObject, next));
    }
  }
  return out;
}

/** 按路径读 settings 值（assignPath 的对称只读版）。 */
function getAtPath(obj: SettingsObject | null | undefined, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 15.29：超时错误识别（requestJson 标记 isTimeout）。 */
function isTimeoutError(e: unknown): boolean {
  return !!(e && typeof e === "object" && "isTimeout" in e && (e as { isTimeout?: boolean }).isTimeout);
}

/** 15.29：patch 的 model 值（字符串格式 / 兼容旧 {name} 对象）。 */
function modelOfPatch(patch: SettingsObject): string | undefined {
  const m = patch.model;
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const n = (m as Record<string, unknown>).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}

/** 15.29：读回验证——patch 各顶层键是否已反映在回读 settings 中。
 *  secret 哨兵（"***"=保留）与回读脱敏值不可比 → 跳过；env 子树同
 * 深比较（值相等才算反映）。宁可判「未反映」（报错重试）也不假成功。 */
function patchReflectedInSettings(
  patch: SettingsObject,
  settings: SettingsObject | undefined | null,
): boolean {
  if (!settings || typeof settings !== "object") return false;
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v === "***") continue; // 保留哨兵
    const cur = settings[k];
    if (k === "model") {
      const cm =
        typeof cur === "string" ? cur
        : cur && typeof cur === "object" && typeof (cur as Record<string, unknown>).name === "string"
          ? ((cur as Record<string, unknown>).name as string)
          : "";
      const pm = modelOfPatch({ model: v });
      if (cm !== (pm ?? "")) return false;
      continue;
    }
    if (JSON.stringify(cur) !== JSON.stringify(v)) return false;
  }
  return true;
}

/** AutoComplete options（modelUnion 的三组或平铺；结构类型避免耦合）。 */
type ModelOptions =
  | Array<{ value: string; label?: ReactNS.ReactNode }>
  | Array<{
      value: string;
      label: ReactNS.ReactNode;
      options: Array<{ value: string; label?: ReactNS.ReactNode }>;
    }>;

function assignPath(target: SettingsObject, path: string[], value: SettingsValue) {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const child = cursor[key];
    if (!child || typeof child !== "object" || Array.isArray(child) || isRedacted(child)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as SettingsObject;
  }
  cursor[path[path.length - 1]] = value;
}

/** 深拷贝（settings 是纯 JSON，含 redacted 哨兵对象，JSON 往返安全）。 */
function deepCopySettings(obj: SettingsObject): SettingsObject {
  return JSON.parse(JSON.stringify(obj)) as SettingsObject;
}

/** 叶子级 diff（draft vs base）→ merge-patch。跳过 redacted（secret 另行
 * 处理）；object 递归下钻；array/标量按 JSON 比较，变更则整节点替换。 */
function diffSettings(base: SettingsObject, draft: SettingsObject): SettingsObject {
  const patch: SettingsObject = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(draft)]);
  for (const key of keys) {
    const b = base[key];
    const d = draft[key];
    if (isRedacted(b) || isRedacted(d)) continue;
    const bIsObj = !!b && typeof b === "object" && !Array.isArray(b);
    const dIsObj = !!d && typeof d === "object" && !Array.isArray(d);
    if (bIsObj && dIsObj) {
      const sub = diffSettings(b as SettingsObject, d as SettingsObject);
      if (Object.keys(sub).length > 0) patch[key] = sub;
    } else if (JSON.stringify(b) !== JSON.stringify(d)) {
      patch[key] = d;
    }
  }
  return patch;
}

/** secret 补丁：每个 redacted 路径 → 用户新值 / "***"（保留现有）/ 省略（无值）。 */
function buildSecretPatch(
  base: SettingsObject,
  secretDraft: Record<string, string>,
): SettingsObject {
  const patch: SettingsObject = {};
  for (const { path, has_value } of collectRedacted(base)) {
    const joined = path.join(".");
    const edited = secretDraft[joined] ?? "";
    if (edited !== "") assignPath(patch, path, edited);
    else if (has_value) assignPath(patch, path, SENTINEL);
  }
  return patch;
}
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

  const load = React.useCallback(async () => {
    try {
      const raw = await listCodingCli(worker.name);
      if (cancelledRef.current) return;
      setItems(rowsFromItems(raw));
      setState("ready");
    } catch (e) {
      if (cancelledRef.current) return;
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
        }, POLL_MS);
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
    loadError,
    load,
    latestInfo,
    checkUpdates,
    readOnly,
    selected,
    setSelected,
    settings,
    settingsOpen,
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
/** 结构化全设置表单（15.26 F4②）：递归渲染 settings 树——
 * redacted→密码框（留空=保留）/ object→分组下钻 / array→JSON 文本 /
 * 标量→类型化输入。免硬编码 per-CLI schema（动态渲染任意 CLI 的字段），
 * 保存=叶子级 diff + secret 补丁（网络传输只发变更）。 */
function SettingsTreeEditor({
  base,
  readOnly,
  busy,
  onSave,
  modelValue,
  onModelChange,
  modelOptions,
  modelCandidates,
  objectModel,
}: {
  base: SettingsObject;
  readOnly: boolean;
  busy: boolean;
  onSave: (patch: SettingsObject) => void;
  /** 模型专行（15.27：同 Worker 模型选择的列表选择）。undefined=不启用
   * （树内 model 键照常渲染）；启用后 model 顶层键从树中摘出，由此行
   * 管理（draft 在父组件），保存时按 diff 写入 model（15.29 格式：
   * objectModel=true 写 {name}，否则写扁平字符串）。 */
  modelValue?: string;
  onModelChange?: (v: string) => void;
  modelOptions?: ModelOptions;
  modelCandidates?: string[];
  /** 15.29：model 以对象 {name} 写（qwen-code 现行格式）；false=扁平字符串。 */
  objectModel?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [draft, setDraft] = React.useState<SettingsObject>(() =>
    deepCopySettings(base),
  );
  const [secretDraft, setSecretDraft] = React.useState<Record<string, string>>({});
  // base 变化（切 CLI / 保存回写）→ 重置草稿（对齐最新基线）。
  const baseRef = React.useRef(base);
  React.useEffect(() => {
    if (base !== baseRef.current) {
      baseRef.current = base;
      setDraft(deepCopySettings(base));
      setSecretDraft({});
    }
  }, [base]);

  const setAtPath = (path: string[], value: SettingsValue) => {
    setDraft((prev) => {
      const next = deepCopySettings(prev);
      assignPath(next, path, value);
      return next;
    });
  };

  const dirty =
    Object.keys(diffSettings(base, draft)).length > 0 ||
    Object.entries(secretDraft).some(([, v]) => v !== "");

  const handleSave = () => {
    const patch: SettingsObject = { ...diffSettings(base, draft) };
    Object.assign(patch, buildSecretPatch(base, secretDraft));
    // 模型专行：draft 在父组件——按 base diff 写入。15.29 格式定案：
    // qwen-code 现行 settings.json 的 model 是**对象 {name}**（官方
    // 文档「New Configuration Format」+ dashboard 同款写法实证；旧扁平
    // 字符串格式由 CLI 自动迁移）；opencode/qoder 用扁平字符串
    // （controller 测试夹具 "model":"updated" 实证）。读取双向兼容
    // （settingsModel 同时认 string / {name}）。空串=清除覆盖，merge
    // 直覆，回退 CLI 默认。写前校验同 Worker 模型选择
    // （路径/URL/空格=error 阻止；不在在服列表=warn 放行）。
    if (modelValue !== undefined && onModelChange) {
      const v = (modelValue ?? "").trim();
      const bm = getAtPath(base, ["model"]);
      const baseModel =
        typeof bm === "string"
          ? bm
          : bm && typeof bm === "object" && typeof (bm as Record<string, unknown>).name === "string"
            ? ((bm as Record<string, unknown>).name as string)
            : "";
      if (v !== baseModel)
        patch.model = objectModel ? { name: v } : v;
      if (v) {
        const verdict = validateModelValue(v, modelCandidates ?? []);
        if (verdict.level === "error") {
          antd.message.error(
            modelVerdictText(tr, verdict, v, modelCandidates ?? []),
          );
          return;
        }
        if (verdict.level === "warn") {
          antd.message.warning(
            modelVerdictText(tr, verdict, v, modelCandidates ?? []),
          );
        }
      }
    }
    onSave(patch);
  };

  const renderNode = (value: SettingsValue, path: string[]): ReactNS.ReactNode => {
    if (isRedacted(value)) {
      const joined = path.join(".");
      return (
        <antd.Input.Password
          value={secretDraft[joined] ?? ""}
          onChange={(e: { target: { value: string } }) =>
            setSecretDraft((p) => ({ ...p, [joined]: e.target.value }))}
          placeholder={
            value.has_value ? tr("已保存，留空保留；输入=替换") : tr("未设置；输入=设置")
          }
          disabled={readOnly}
          size="small"
          style={{ maxWidth: 300 }}
        />
      );
    }
    if (Array.isArray(value)) {
      return (
        <antd.Input.TextArea
          value={JSON.stringify(value, null, 2)}
          onChange={(e: { target: { value: string } }) => {
            try {
              const raw = e.target.value.trim();
              const parsed = raw === "" ? [] : JSON.parse(raw);
              if (Array.isArray(parsed)) setAtPath(path, parsed);
            } catch {
              /* 解析失败=不更新草稿（保留上次有效值） */
            }
          }}
          disabled={readOnly}
          autoSize={{ minRows: 2, maxRows: 8 }}
          style={{ fontFamily: "monospace", fontSize: 11, maxWidth: 460 }}
        />
      );
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as SettingsObject);
      if (entries.length === 0) {
        return (
          <span style={{ fontSize: 11, color: t.textSecondary }}>(空对象)</span>
        );
      }
      return (
        <div
          style={{
            display: "grid",
            gap: 4,
            paddingLeft: 8,
            borderLeft: `2px solid ${t.border}`,
          }}
        >
          {entries.map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  color: t.textSecondary,
                  minWidth: 110,
                  fontFamily: "monospace",
                }}
              >
                {k}
              </span>
              {renderNode(v, [...path, k])}
            </div>
          ))}
        </div>
      );
    }
    if (typeof value === "boolean") {
      return (
        <antd.Switch
          checked={value}
          onChange={(c: boolean) => setAtPath(path, c)}
          disabled={readOnly}
          size="small"
        />
      );
    }
    if (typeof value === "number") {
      return (
        <antd.InputNumber
          value={value}
          onChange={(v: number | null) => setAtPath(path, v ?? 0)}
          disabled={readOnly}
          size="small"
          style={{ width: 140 }}
        />
      );
    }
    if (value === null || value === undefined) {
      return <span style={{ fontSize: 11, color: t.textSecondary }}>null</span>;
    }
    return (
      <antd.Input
        value={String(value)}
        onChange={(e: { target: { value: string } }) => setAtPath(path, e.target.value)}
        disabled={readOnly}
        size="small"
        style={{ maxWidth: 460, fontFamily: "monospace", fontSize: 11 }}
      />
    );
  };

  const modelRowEnabled = modelValue !== undefined && !!onModelChange;
  const topEntries = Object.entries(base).filter(
    ([k]) => !(modelRowEnabled && k === "model"),
  );
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {/* 空配置引导（15.28）：文件不存在=正常空态（controller 契约
       * exists:false）——模型行常显，填模型名保存即创建文件。 */}
      {Object.keys(base).length === 0 && modelRowEnabled ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("尚无配置文件——在下方填模型名并保存即创建（其他字段建后在表单出现）。")}
        </div>
      ) : null}
      {/* 模型专行（15.27）：同 Worker 模型选择——列表选择（SGLang 在服 ∪
       * 在用 ∪ 网关 alias）+ 自由输入兜底 + 写前校验。 */}
      {modelRowEnabled ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text, minWidth: 44 }}>
            {tr("模型")}
          </span>
          <antd.AutoComplete
            size="small"
            style={{ flex: 1, maxWidth: 460, fontFamily: "monospace", fontSize: 11 }}
            value={modelValue}
            options={modelOptions}
            allowClear
            placeholder={tr("留空=清除覆盖（跟随 CLI 默认）")}
            disabled={readOnly}
            onChange={(v: string) => onModelChange(v || "")}
          />
        </div>
      ) : null}
      {topEntries.length === 0 && !modelRowEnabled ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("尚无配置文件——填模型名并保存即创建。")}
        </div>
      ) : (
        topEntries.map(([k, v]) => (
          <div key={k} style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>{k}</span>
            {renderNode(v, [k])}
          </div>
        ))
      )}
      {!readOnly ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <antd.Button
            type="primary"
            size="small"
            disabled={!dirty || busy}
            loading={busy}
            onClick={handleSave}
          >
            {tr("保存改动")}
          </antd.Button>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {dirty ? tr("有未保存改动") : tr("无改动")}
          </span>
        </div>
      ) : null}
    </div>
  );
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
  const settingsModel: string = React.useMemo(() => {
    const m = (s.settings?.settings as Record<string, unknown> | undefined)
      ?.model;
    if (typeof m === "string") return m;
    if (m && typeof m === "object") {
      const n = (m as Record<string, unknown>).name;
      if (typeof n === "string") return n;
    }
    return "";
  }, [s.settings]);
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

      {/* CLI 行（点名字=选中，settings 操作随选）。 */}
      <div style={{ display: "grid", gap: 6 }}>
        {s.items.map((cli) => (
          <div
            key={cli.id}
            style={{
              border: `1px solid ${s.selected === cli.id ? (t.mode === "dark" ? "#4096ff" : "#91caff") : t.border}`,
              borderRadius: 6,
              padding: "5px 8px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                onClick={() => {
                  s.setSelected(cli.id);
                  s.setMsg(null);
                }}
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
                <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}>
                  {tr("鉴权已配置")}
                </antd.Tag>
              ) : null}
              {/* 当前 CLI 的生效模型（settings 加载后；同 Worker 模型列的徽标语义）。 */}
              {cli.id === s.selected && s.settingsOpen && s.settings && settingsModel ? (
                <antd.Tag
                  color="blue"
                  style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
                >
                  {tr("模型")} {settingsModel}
                </antd.Tag>
              ) : null}
              {cli.authConfigured && !cli.installed ? (
                <span style={{ fontSize: 11, color: t.mode === "dark" ? "#faad14" : "#d46b08" }}>
                  {tr("容器重建后需重新安装；已保存的鉴权可保留")}
                </span>
              ) : null}
              <div style={{ flex: 1 }} />
              {cli.installed ? (
                <>
                  <antd.Button
                    size="small"
                    type="text"
                    disabled={s.busy || s.readOnly}
                    onClick={() => void s.loadSettings(cli.id)}
                  >
                    {tr("编辑配置")}
                  </antd.Button>
                  <antd.Button
                    size="small"
                    type="text"
                    disabled={s.busy || s.readOnly}
                    onClick={() => void s.runInstall(cli.id, "install")}
                  >
                    {tr("升级")}
                  </antd.Button>
                  <antd.Button
                    size="small"
                    type="text"
                    danger
                    disabled={s.busy || s.readOnly}
                    onClick={() => s.setUninstallTarget(cli.id)}
                  >
                    {tr("卸载")}
                  </antd.Button>
                </>
              ) : (
                <antd.Button
                  size="small"
                  type="text"
                  disabled={s.busy || s.readOnly}
                  onClick={() => void s.runInstall(cli.id, "install")}
                >
                  {tr("安装")}
                </antd.Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 版本 tag（安装/升级均生效；可填具体 tag 探测，空=latest）。 */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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

      {/* settings 编辑器（选中 CLI）。 */}
      {s.settingsOpen && !s.settings ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>{tr("加载 settings…")}</div>
      ) : null}
      {s.settingsOpen && s.settings ? (
        <div
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: 8,
            display: "grid",
            gap: 6,
          }}
        >
          <div style={{ fontSize: 11, color: t.textSecondary }}>
            {CLI_LABEL[s.selected]} settings（结构化表单 · 只保存改动）
          </div>
          {/* 15.28：空配置（容器重建/未建文件）也渲染编辑器——模型行常显，
           * 填模型名保存即 PUT merge 创建 settings 文件（容器重建后 CLI 已装
           * 但配置文件缺失）；场景模板已撤（AgentCom 成熟后放团队管理）。 */}
          <SettingsTreeEditor
            base={s.settings.settings && Object.keys(s.settings.settings).length > 0 ? s.settings.settings : {}}
            readOnly={s.readOnly}
            busy={s.busy}
            modelValue={modelDraft ?? ""}
            onModelChange={setModelDraft}
            modelOptions={union.options}
            modelCandidates={union.candidates}
            objectModel={s.selected === "qwen-code"}
            onSave={(patch) => void s.saveSettings(patch)}
          />
        </div>
      ) : null}


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

  if (!s.open) {
    return (
      <div
        style={{
          margin: sheet ? 0 : "4px 0 4px 22px",
          border: sheet ? "none" : "1px solid rgba(127,127,127,0.25)",
          borderRadius: sheet ? 0 : 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            cursor: "pointer",
          }}
          onClick={() => s.setOpen(true)}
        >
          <span style={{ width: 12, fontSize: 10, color: "#888" }}>▸</span>
          <CodeIcon size={13} />
          <span style={{ fontWeight: 600, fontSize: 12 }}>
            {tr("Coding CLI（安装/升级/settings）")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        margin: sheet ? 0 : "4px 0 4px 22px",
        border: sheet ? "none" : "1px solid rgba(127,127,127,0.25)",
        borderRadius: sheet ? 0 : 8,
        padding: sheet ? 0 : 10,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {sheet ? null : (
          <span
            style={{ width: 12, fontSize: 10, color: "#888", cursor: "pointer" }}
            onClick={() => s.setOpen(false)}
            title={tr("收起")}
          >
            ▾
          </span>
        )}
        {sheet ? null : <CodeIcon size={13} />}
        {sheet ? null : (
          <span style={{ fontWeight: 600, fontSize: 12 }}>
            {tr("Coding CLI（安装/升级/settings）")}
          </span>
        )}
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
      </div>

      <CodingCliPanelBody s={s} />
    </div>
  );
}

export default WorkerCodingCliPanel;
