/**
 * QwenCodeBridgeSection.tsx — CodingCLI 弹窗 QwenCode 卡内的
 * 「QwenPaw × QwenCode 桥」安装/更新栏。
 *
 * 参照千锻模块卡（2026-11-08 新口径）：状态 Tag（未装 / 可更新 / 已是
 * 最新 / 该频道无更新 / 该频道暂无版本）+ 频道选择（stable/beta/alpha）+
 * 版本下拉 + 单个安装/更新按钮——不逐版本渲染按钮。纯逻辑在
 * bridgeModuleModel.ts（可单测）。
 *
 * 显隐：仅 QwenPaw 运行时渲染（判据同全仓 runtimeGuard——非 qwenpaw 整段
 * 不出现，不留 disabled 占位）。调用方在 QwenCode 卡展开时挂载本组件，收起
 * 即卸载（索引/插件列表走 30s 读缓存，反复展开零成本）。
 *
 * 数据面：GET /workers/{name}/plugins（已装，pluginId=qwen-code-bridge）+
 * GET /millforge/index?source=github&repo=DEFAULT&ref=main&channel=<选择>
 * （索引，模块键 qwenpaw-qwencode-bridge）；安装走
 * POST /workers/{name}/plugins/install（body.module=模块键，channel=当前频道）。
 */
import type * as ReactNS from "react";

import {
  DEFAULT_MODULE_REPO,
  MODULE_UPDATES_TAG,
  getIndex,
  getWorkerPlugins,
  httpErrorDetail,
  httpErrorStatus,
  installWorkerPlugin,
} from "../api";
import type {
  IndexModuleEntry,
  IndexVersionEntry,
  ModuleChannel,
  ModuleIndexResponse,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import { isQwenpawOnlyDisabled } from "../runtimeGuard";
import { invalidateTags } from "../requestCache";
import {
  BRIDGE_CHANNELS,
  BRIDGE_DEFAULT_CHANNEL,
  BRIDGE_MODULE_KEY,
  BRIDGE_REF,
  BRIDGE_SOURCE,
  bridgeChannelLabel,
  bridgeDirection,
  bridgeHasAction,
  bridgeInstallBody,
  bridgeInstalledVersion,
  bridgeOptions,
  bridgeState,
  bridgeVersions,
  pickBridgeModule,
} from "./bridgeModuleModel";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type Tr = (text: string, vars?: Record<string, string | number>) => string;

/** 安装错误映射（与千锻模块卡同口径）：409 sha / 502 离线 / 404 版本不存在 /
 * 400 不可安装 / 503 embedded 不支持。 */
function installErrorText(e: unknown, tr: Tr): string {
  const status = httpErrorStatus(e);
  const detail = httpErrorDetail(e);
  const base =
    status === 409
      ? tr("版本校验失败（sha256 不匹配）——索引与制品不一致，请刷新索引后重试")
      : status === 502
        ? tr("目标离线或不可达，稍后重试")
        : status === 404
          ? tr("版本在索引中不存在，请刷新索引")
          : status === 400
            ? tr("该模块不可安装（runner 类型或非 zip 制品）")
            : status === 503
              ? tr("当前运行时形态（embedded）不支持安装该模块")
              : tr("安装失败");
  return detail ? `${base}（${detail}）` : base;
}

export function QwenCodeBridgeSection({
  workerName,
  runtime,
  onChanged,
}: {
  workerName: string;
  /** Worker 运行时（空/未上报按 QwenPaw 放行，同 runtimeGuard 判据）。 */
  runtime?: string;
  onChanged?: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [channel, setChannel] = React.useState<ModuleChannel>(
    BRIDGE_DEFAULT_CHANNEL,
  );
  const [entry, setEntry] = React.useState<IndexModuleEntry | null>(null);
  const [installed, setInstalled] = React.useState<string | null>(null);
  const [pluginsUnsupported, setPluginsUnsupported] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [indexErr, setIndexErr] = React.useState("");
  const [pluginsErr, setPluginsErr] = React.useState("");
  const [selected, setSelected] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );
  const cancelledRef = React.useRef(false);
  // 已取频道缓存：切回不重复请求（手动刷新/重试才穿透）。
  const indexCacheRef = React.useRef(new Map<ModuleChannel, ModuleIndexResponse>());
  const indexReqRef = React.useRef(0);

  const loadIndex = React.useCallback(
    async (ch: ModuleChannel, force = false) => {
      const cached = indexCacheRef.current.get(ch);
      if (cached && !force) {
        setEntry(pickBridgeModule(cached));
        setIndexErr("");
        setLoading(false);
        return;
      }
      const reqId = ++indexReqRef.current;
      setLoading(true);
      setIndexErr("");
      try {
        const r = await getIndex({
          source: BRIDGE_SOURCE,
          repo: DEFAULT_MODULE_REPO,
          ref: BRIDGE_REF,
          channel: ch,
        });
        if (cancelledRef.current || reqId !== indexReqRef.current) return;
        indexCacheRef.current.set(ch, r);
        setEntry(pickBridgeModule(r));
      } catch (e) {
        if (cancelledRef.current || reqId !== indexReqRef.current) return;
        setEntry(null);
        setIndexErr(httpErrorDetail(e) || tr("索引获取失败"));
      } finally {
        if (!cancelledRef.current && reqId === indexReqRef.current) {
          setLoading(false);
        }
      }
    },
    [tr],
  );

  const loadPlugins = React.useCallback(async () => {
    try {
      const r = await getWorkerPlugins(workerName);
      if (cancelledRef.current) return;
      setPluginsErr("");
      if (!r.supported) {
        setPluginsUnsupported(true);
        setInstalled(null);
      } else {
        setPluginsUnsupported(false);
        setInstalled(bridgeInstalledVersion(r.plugins));
      }
    } catch (e) {
      if (cancelledRef.current) return;
      setPluginsUnsupported(false);
      setPluginsErr(httpErrorDetail(e) || tr("获取失败"));
    }
  }, [tr, workerName]);

  React.useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // 切频道：重置版本选择 + 重拉该频道索引（页面不整卡 reload）。
  React.useEffect(() => {
    setSelected("");
    setMsg(null);
    void loadIndex(channel);
  }, [channel, loadIndex]);

  const refresh = React.useCallback(() => {
    // 手动刷新必穿透 30s TTL（顺手失效模块标签，已装列表同源）。
    invalidateTags([MODULE_UPDATES_TAG]);
    indexCacheRef.current.delete(channel);
    void loadIndex(channel, true);
  }, [channel, loadIndex]);

  const versions = React.useMemo(() => bridgeVersions(entry), [entry]);
  const state = bridgeState({
    installedVersion: installed,
    versions,
    latest: entry?.latest,
  });
  const options = React.useMemo(
    () => bridgeOptions(versions, installed),
    [versions, installed],
  );
  const defaultVersion = options.find((o) => o.defaultSelected)?.version ?? "";
  const selectedVersion =
    options.find((o) => o.version === selected && !o.disabled)?.version ??
    defaultVersion;
  const target: IndexVersionEntry | null =
    versions.find((v) => v.version === selectedVersion) ?? null;
  const direction = bridgeDirection(selectedVersion, installed);
  const actionText =
    direction === "update"
      ? tr("更新")
      : direction === "downgrade"
        ? tr("降级")
        : tr("安装");

  const doInstall = React.useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    setMsg(null);
    const dir = bridgeDirection(target.version, installed);
    try {
      await installWorkerPlugin(
        workerName,
        bridgeInstallBody(target, DEFAULT_MODULE_REPO, channel),
      );
      if (cancelledRef.current) return;
      setInstalled(target.version);
      setMsg({
        kind: "ok",
        text:
          dir === "update"
            ? tr("已更新到 {v}", { v: target.version })
            : tr("已安装 {v}", { v: target.version }),
      });
      onChanged?.();
      // 写成功后刷新已装列表（api 层已失效模块缓存标签；失败不覆盖乐观值）。
      try {
        const p = await getWorkerPlugins(workerName);
        if (!cancelledRef.current && p.supported) {
          setInstalled(bridgeInstalledVersion(p.plugins) ?? target.version);
        }
      } catch {
        /* 刷新失败保留本次安装版本，下次展开重拉 */
      }
    } catch (e) {
      if (cancelledRef.current) return;
      setMsg({ kind: "err", text: installErrorText(e, tr) });
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  }, [busy, channel, installed, onChanged, target, tr, workerName]);

  // QwenPaw 独有面：非 qwenpaw 运行时整段不渲染（不留 disabled 占位）。
  if (isQwenpawOnlyDisabled(runtime)) return null;

  const statusTag = () => {
    switch (state) {
      case "not-installed":
        return <antd.Tag style={{ marginInlineEnd: 0 }}>{tr("未装")}</antd.Tag>;
      case "update-available":
        return (
          <antd.Tag color="orange" style={{ marginInlineEnd: 0 }}>
            {tr("可更新")}
          </antd.Tag>
        );
      case "up-to-date":
        return (
          <antd.Tag color="green" style={{ marginInlineEnd: 0 }}>
            {tr("已是最新")}
          </antd.Tag>
        );
      case "ahead":
        return (
          <antd.Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
            {tr("已装 {v}", { v: installed ?? "" })}
          </antd.Tag>
        );
      default:
        return (
          <antd.Tag style={{ marginInlineEnd: 0 }}>{tr("该频道暂无版本")}</antd.Tag>
        );
    }
  };

  const hasSelectable = options.some((o) => !o.disabled);

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        padding: "8px 10px",
        display: "grid",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {tr("QwenPaw × QwenCode 桥")}
        </span>
        <span
          style={{ fontFamily: "monospace", fontSize: 11, color: t.textSecondary }}
        >
          {BRIDGE_MODULE_KEY}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("频道")}</span>
        <antd.Select
          size="middle"
          className="wb-touch-lg"
          style={{ minWidth: 104 }}
          value={channel}
          disabled={busy}
          onChange={(v: ModuleChannel) => setChannel(v)}
          options={BRIDGE_CHANNELS.map((c) => ({
            value: c,
            label: bridgeChannelLabel(c),
          }))}
        />
        <antd.Button
          size="small"
          type="text"
          className="wb-touch-lg"
          disabled={busy || loading}
          onClick={refresh}
        >
          {tr("刷新")}
        </antd.Button>
        {loading ? <antd.Spin size="small" /> : statusTag()}
      </div>

      {state === "ahead" ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("该频道无更新")}
        </div>
      ) : null}

      {indexErr ? (
        <antd.Alert
          type="warning"
          showIcon
          message={`${tr("索引获取失败")} · ${tr("重试")}`}
          description={indexErr}
          action={
            <antd.Button size="small" onClick={refresh}>
              {tr("重试")}
            </antd.Button>
          }
          style={{ fontSize: 11, padding: "3px 8px" }}
        />
      ) : null}

      {pluginsUnsupported ? (
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("控制器不支持插件列表（无法检测已装版本）")}
        </div>
      ) : null}

      {pluginsErr ? (
        <div
          style={{ fontSize: 11, color: t.mode === "dark" ? "#faad14" : "#d46b08" }}
        >
          {tr("获取失败")}：{pluginsErr}
        </div>
      ) : null}

      {!loading && bridgeHasAction(state) && hasSelectable ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <antd.Select
            size="middle"
            className="wb-touch-lg"
            style={{ minWidth: 180, maxWidth: 320 }}
            value={selectedVersion || undefined}
            placeholder={tr("选择版本")}
            disabled={busy}
            onChange={(v: string) => setSelected(v)}
            options={options.map((o) => ({
              value: o.version,
              disabled: o.disabled,
              label: o.current
                ? `${o.version} · ${tr("当前")}`
                : o.disabled
                  ? `${o.version} · ${tr("不可用")}`
                  : o.version,
            }))}
          />
          <antd.Button
            size="middle"
            type="primary"
            className="wb-touch-lg"
            loading={busy}
            disabled={busy || !selectedVersion}
            onClick={() => void doInstall()}
          >
            {actionText}
          </antd.Button>
        </div>
      ) : null}

      {msg ? (
        <div
          style={{
            fontSize: 11,
            color:
              msg.kind === "ok"
                ? t.mode === "dark"
                  ? "#95de64"
                  : "#389e0d"
                : "#cf1322",
          }}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

export default QwenCodeBridgeSection;
