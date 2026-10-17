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
 * - 零后端新端点：走 /agentteams-proxy/controller catch-all 透传。
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
  httpErrorStatus,
  httpErrorDetail,
  type CodingCliId,
  type CodingCliProbeItem,
  type SettingsObject,
  type SettingsValue,
} from "../api";
import {
  CODING_CLI_IDS,
  CODING_CLI_PRESETS,
  isRedacted,
  localizedText,
  type CodingCliPreset,
} from "../codingCliPresets";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { CodeIcon } from "./icons";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

const CLI_LABEL: Record<CodingCliId, string> = {
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
  qoder: "Qoder",
};

// CLI id → npm 包名（正源 = 上游 worker_coding_cli.go CliSpec.NpmPackage）。
// 用于「检查更新」best-effort 拉 registry latest（容器 npm 镜像源可能不同，
// 仅作提示，不可达时优雅降级，用户仍可手动填 tag 升级）。
const CLI_NPM_PACKAGE: Record<CodingCliId, string> = {
  "qwen-code": "@qwen-code/qwen-code",
  opencode: "opencode-ai",
  qoder: "@qoder-ai/qodercli",
};

const LATEST_BASE = "https://registry.npmjs.org/";
const LATEST_TIMEOUT_MS = 12000;

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

/** best-effort 拉某 CLI 的 registry latest 版本号（小载荷 /latest）。 */
async function fetchNpmLatest(pkg: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LATEST_TIMEOUT_MS);
  try {
    // pkg 形如 "@scope/name" 或 "name"，直接作 path（@ 与 / 原样，npm registry 接受）。
    const res = await fetch(`${LATEST_BASE}${pkg}/latest`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { version?: string };
    if (!j.version) throw new Error("no version");
    return j.version;
  } finally {
    clearTimeout(timer);
  }
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

function getModelName(settings: SettingsObject): string {
  const model = settings.model;
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && !Array.isArray(model) && !isRedacted(model)) {
    const name = (model as SettingsObject).name;
    if (typeof name === "string") return name;
  }
  return "";
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

function mergePatch(target: SettingsObject, patch: SettingsObject) {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isRedacted(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      !isRedacted(current)
    ) {
      mergePatch(current as SettingsObject, value as SettingsObject);
    } else {
      target[key] = value;
    }
  }
}

function hasRedactedPlaceholder(value: SettingsValue): boolean {
  if (isRedacted(value)) return true;
  if (Array.isArray(value)) return value.some((item) => hasRedactedPlaceholder(item));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => hasRedactedPlaceholder(item));
  }
  return false;
}

function previewJson(settings: SettingsObject): string {
  return JSON.stringify(
    settings,
    (_key, value) => {
      if (isRedacted(value)) return value.has_value ? "***" : null;
      return value;
    },
    2,
  );
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
  const [settings, setSettings] = React.useState<SettingsObject | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [modelName, setModelName] = React.useState("");
  const [secrets, setSecrets] = React.useState<Record<string, string>>({});
  const [versionTag, setVersionTag] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [appliedPreset, setAppliedPreset] = React.useState<string | null>(null);
  const [suggestion, setSuggestion] = React.useState<CodingCliPreset | null>(null);
  const [jsonPatch, setJsonPatch] = React.useState("");
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
      setModelName("");
      setSecrets({});
      setJsonPatch("");
      try {
        const json = await getCliSettings(worker.name, cli);
        if (cancelledRef.current || reqId !== settingsReqRef.current) return;
        setSettings(json && typeof json === "object" ? json : {});
        setModelName(getModelName(json && typeof json === "object" ? json : {}));
        setSecrets({});
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

  const saveSettings = React.useCallback(async () => {
    if (!settings || busy || readOnly) return;
    const diff: SettingsObject = {};
    if (modelName !== getModelName(settings)) {
      assignPath(diff, ["model", "name"], modelName);
    }
    for (const field of collectRedacted(settings)) {
      const key = field.path.join(".");
      const typed = (secrets[key] ?? "").trim();
      if (typed) assignPath(diff, field.path, typed);
      else if (field.has_value) assignPath(diff, field.path, SENTINEL);
    }
    const patchText = jsonPatch.trim();
    if (patchText) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(patchText) as unknown;
      } catch {
        setMsg({ kind: "err", text: tr("补丁不是合法 JSON") });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMsg({ kind: "err", text: tr("补丁须为 JSON 对象") });
        return;
      }
      if (hasRedactedPlaceholder(parsed as SettingsObject)) {
        setMsg({
          kind: "err",
          text: tr("补丁不能包含脱敏占位，请填写真实密钥或留空由密钥栏保留"),
        });
        return;
      }
      mergePatch(diff, parsed as SettingsObject);
    }
    if (Object.keys(diff).length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      await putCliSettings(worker.name, selected, diff);
      setMsg({ kind: "ok", text: tr("已保存") });
      await loadSettings(selected);
      onChanged?.();
    } catch (e) {
      if (httpErrorStatus(e) === 403) setReadOnly(true);
      setMsg({
        kind: "err",
        text: httpErrorDetail(e) || tr("保存失败"),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, jsonPatch, loadSettings, modelName, onChanged, readOnly, secrets, selected, settings, tr, worker.name]);

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

  const applyPreset = React.useCallback(
    async (preset: CodingCliPreset) => {
      if (busy || readOnly) return;
      const patch = preset.settings_patch ?? {};
      if (Object.keys(patch).length === 0) {
        setAppliedPreset(preset.id);
        setSuggestion(preset);
        setMsg({ kind: "ok", text: tr("已套用 {n}", { n: localizedText(preset.name) }) });
        return;
      }
      setBusy(true);
      setMsg(null);
      try {
        await putCliSettings(worker.name, selected, { ...patch } as SettingsObject);
        setAppliedPreset(preset.id);
        setSuggestion(preset);
        setMsg({ kind: "ok", text: tr("已套用 {n}", { n: localizedText(preset.name) }) });
        if (settingsOpen) await loadSettings(selected);
        onChanged?.();
      } catch (e) {
        if (httpErrorStatus(e) === 403) setReadOnly(true);
        setMsg({ kind: "err", text: httpErrorDetail(e) || tr("套用模板失败") });
      } finally {
        setBusy(false);
      }
    },
    [busy, loadSettings, onChanged, readOnly, selected, settingsOpen, tr, worker.name],
  );

  // 检查更新：对所有已装 CLI 顺序拉 registry latest（best-effort；
  // 失败仅标记该 CLI，不影响其他；容器 npm 镜像源可能不同，仅提示）。
  const checkUpdates = React.useCallback(async () => {
    const installed = items.filter((c) => c.installed);
    if (installed.length === 0) return;
    const next: Record<string, LatestInfo> = { ...latestInfo };
    for (const c of installed) {
      next[c.id] = { checking: true };
      setLatestInfo({ ...next });
      try {
        const latest = await fetchNpmLatest(CLI_NPM_PACKAGE[c.id]);
        next[c.id] = { checking: false, latest };
      } catch {
        next[c.id] = { checking: false, error: "unreachable" };
      }
      setLatestInfo({ ...next });
    }
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
    modelName,
    setModelName,
    secrets,
    setSecrets,
    versionTag,
    setVersionTag,
    busy,
    msg,
    setMsg,
    appliedPreset,
    suggestion,
    jsonPatch,
    setJsonPatch,
    uninstallTarget,
    setUninstallTarget,
    loadSettings,
    saveSettings,
    runInstall,
    applyPreset,
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

  const selectedInstalled = s.items.some((c) => c.id === s.selected && c.installed);
  const redacted = s.settings ? collectRedacted(s.settings) : [];

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
            {CLI_LABEL[s.selected]} settings
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("模型名")}</span>
            <antd.Input
              size="small"
              style={{ fontFamily: "monospace" }}
              value={s.modelName}
              disabled={s.readOnly}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                s.setModelName(e.target.value)
              }
            />
          </div>
          {redacted.map((field) => {
            const key = field.path.join(".");
            return (
              <div key={key} style={{ display: "grid", gap: 3 }}>
                <span style={{ fontSize: 11, color: t.textSecondary }}>
                  {key}
                  {field.has_value ? tr("（已保存，留空保留）") : ""}
                </span>
                <antd.Input.Password
                  size="small"
                  value={s.secrets[key] ?? ""}
                  placeholder={field.has_value ? tr("已保存") : ""}
                  disabled={s.readOnly}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    s.setSecrets((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                />
              </div>
            );
          })}
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("当前配置（只读）")}
            </span>
            <pre
              style={{
                maxHeight: 160,
                overflow: "auto",
                background: t.mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                borderRadius: 4,
                padding: 6,
                fontFamily: "monospace",
                fontSize: 11,
                margin: 0,
              }}
            >
              {previewJson(s.settings)}
            </pre>
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("可选 JSON 补丁（同键以补丁为准）")}
            </span>
            <antd.Input.TextArea
              rows={4}
              style={{ fontFamily: "monospace", fontSize: 12 }}
              placeholder={'{"mcp":{"enabled":true}}'}
              value={s.jsonPatch}
              disabled={s.readOnly}
              onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
                s.setJsonPatch(e.target.value)
              }
            />
          </div>
          <antd.Button
            size="small"
            type="primary"
            disabled={s.busy || s.readOnly}
            loading={s.busy}
            onClick={() => void s.saveSettings()}
          >
            {tr("保存配置")}
          </antd.Button>
        </div>
      ) : null}

      {/* 场景 preset（六场景；空 patch 的 p-gencode=只标记不写）。 */}
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("场景模板（只写模型名，工具链/MCP 需确认）· 当前 CLI：{c}", {
            c: CLI_LABEL[s.selected],
          })}
        </span>
        {!selectedInstalled ? (
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("先安装当前 CLI，再套用场景模板")}
          </span>
        ) : null}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CODING_CLI_PRESETS.map((p) => (
            <antd.Button
              key={p.id}
              size="small"
              type={s.appliedPreset === p.id ? "primary" : "default"}
              disabled={s.busy || s.readOnly || !selectedInstalled}
              onClick={() => void s.applyPreset(p)}
            >
              {localizedText(p.name)}
            </antd.Button>
          ))}
        </div>
      </div>

      {/* 建议清单（human_confirm 项只列不执行）。 */}
      {s.suggestion ? (
        <div
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: 8,
            display: "grid",
            gap: 3,
            fontSize: 11,
          }}
        >
          <span style={{ color: t.textSecondary }}>
            {tr("建议清单（需人工确认，未写入 Worker CR）")}
          </span>
          {s.suggestion.toolchain.shared_volume ? (
            <span>{tr("共享卷：{v}", { v: s.suggestion.toolchain.shared_volume })}</span>
          ) : null}
          {s.suggestion.toolchain.install ? (
            <span>{tr("工具链：{v}", { v: localizedText(s.suggestion.toolchain.install) })}</span>
          ) : null}
          {s.suggestion.toolchain.env && Object.keys(s.suggestion.toolchain.env).length > 0 ? (
            <span>
              {tr("环境变量：{v}", { v: Object.keys(s.suggestion.toolchain.env).join(", ") })}
            </span>
          ) : null}
          {s.suggestion.toolchain.note ? (
            <span>{tr("工具链说明：{v}", { v: localizedText(s.suggestion.toolchain.note) })}</span>
          ) : null}
          {s.suggestion.mcp.suggested.length > 0 ? (
            <span>{tr("MCP：{v}", { v: s.suggestion.mcp.suggested.join("；") })}</span>
          ) : null}
          {s.suggestion.artifacts?.note ? (
            <span>{tr("产物：{v}", { v: s.suggestion.artifacts.note })}</span>
          ) : null}
          {s.suggestion.arch_note ? (
            <span>{tr("架构注意：{v}", { v: localizedText(s.suggestion.arch_note) })}</span>
          ) : null}
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
  const { tr, t } = s;

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
