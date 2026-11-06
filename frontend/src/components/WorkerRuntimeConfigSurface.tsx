// WorkerRuntimeConfigSurface — 运行时配置面状态机（P8c/G3）。
// 取数（surface+config 并行）→ 草稿 → 保存（嵌套 diff + if-rev）→ 重读/rev 栈 → 回滚 → 错误映射。
// 复用：api/domains/memberConfig（契约）+ lib/surfaceForm（草稿/diff）+ lib/surfacePatch（路径/敏感解析）
//  + lib/memberConfigErrors（错误分类）+ components/runtimeCfg/RuntimeConfigPanel（C2 分组渲染）。
// 敏感值永不回写。
// C2：字段渲染接分组面板（自带搜索/高级过滤/已改计数/重置）；草稿更新
// 仍走 onField 不可变赋值。buildDraft 草稿键为 concrete 键；通配展示值
// 由面板经 values 收集（collectConcreteValues）。
import type * as ReactNS from "react";

import {
  type ConfigState,
  type ConfigWriteResult,
  type RuntimeSurface,
  type SurfaceField,
  MemberConfigError,
  fetchMemberConfig,
  fetchRuntimeSurface,
  putMemberConfig,
  rollbackMemberConfig,
} from "../api/domains/memberConfig";
import { restartWorker } from "../api/domains/lifecycle";
import { buildDraft, diffNested, pushRev } from "../lib/surfaceForm";
import { applySensitiveObjectText } from "../lib/surfacePatch";
import { classifyLoadError, classifyWriteError } from "../lib/memberConfigErrors";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import RuntimeConfigPanel from "./runtimeCfg/RuntimeConfigPanel";
import SurfaceStatus, { type SurfaceBanner } from "./surface/SurfaceStatus";
import { SettingsIcon } from "./icons";
import { OpenClawIcon } from "./OpenClawIcon";
import { WorkerCollapseCard } from "./WorkerPanelsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** O4 404 友好化：部署控制器对不支持的运行时返回 404 +
 * {error:"unknown runtime", supported:[...]}（#1493 契约形状是 409 +
 * runtime_unknown）；classifyLoadError 把 404 一律归 gone（整卡消失），
 * 故组件按响应体形状自识别 → 支持运行时列表文本（非该形状 → ""，
 * 落回正常分类，其它错误保持现状）。 */
function supportedRuntimeList(e: unknown): string {
  if (!(e instanceof MemberConfigError)) return "";
  const body =
    e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : null;
  if (!body) return "";
  if (Array.isArray(body.supported)) return (body.supported as string[]).join("、");
  if (typeof body.supported === "string") return body.supported;
  return "";
}

export default function WorkerRuntimeConfigSurface(props: {
  name: string;
  runtime: string;
  l1?: boolean;
  sheet?: boolean;
  onChanged?: () => void;
}): JSX.Element | null {
  const { name, runtime, l1, sheet, onChanged } = props;
  const tr = useT();
  const t = useThemeColors();

  const [open, setOpen] = React.useState(sheet === true);
  const [loading, setLoading] = React.useState(true);
  const [gone, setGone] = React.useState(false);
  const [surface, setSurface] = React.useState<RuntimeSurface | null>(null);
  const [config, setConfig] = React.useState<ConfigState | null>(null);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [loadErr, setLoadErr] = React.useState("");
  const [banner, setBanner] = React.useState<SurfaceBanner | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [rollingBack, setRollingBack] = React.useState(false);
  // 「立即重启」按钮态 + pendingRestart 提示行可见性（提示消失即隐藏）。
  const [restarting, setRestarting] = React.useState(false);
  const [pendingKeys, setPendingKeys] = React.useState<string[]>([]);
  const [readOnly, setReadOnly] = React.useState(false);
  const [runtimeUnknown, setRuntimeUnknown] = React.useState("");
  const [revStack, setRevStack] = React.useState<string[]>([]);

  const busy = saving || rollingBack;
  const noWrite = l1 !== true || readOnly;
  const fields = React.useMemo<SurfaceField[]>(
    () => (surface ? surface.faces.flatMap((f) => f.fields) : []),
    [surface],
  );
  // C2 面板基线草稿：「已改 N 项」计数与重置的依据（surface/config 变化时重建）。
  const initialDraft = React.useMemo(
    () => (surface ? buildDraft(surface, config?.values ?? {}) : {}),
    [surface, config],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    setBanner(null);
    setPendingKeys([]);
    setRuntimeUnknown(""); // 重试需能从 friendly 态恢复（成功后展示表单）
    try {
      const [sRes, cRes] = await Promise.allSettled([
        fetchRuntimeSurface(runtime),
        fetchMemberConfig(name),
      ]);
      if (sRes.status === "rejected") {
        const supported = supportedRuntimeList(sRes.reason);
        if (supported) {
          setRuntimeUnknown(supported);
          return;
        }
        const e = classifyLoadError(sRes.reason);
        if (e.kind === "gone") setGone(true);
        else if (e.kind === "runtime_unknown") setRuntimeUnknown(e.supported);
        else setLoadErr(e.detail);
        return;
      }
      setSurface(sRes.value);
      if (cRes.status === "rejected") {
        const supported = supportedRuntimeList(cRes.reason);
        if (supported) {
          setRuntimeUnknown(supported);
          return;
        }
        const e = classifyLoadError(cRes.reason);
        if (e.kind === "gone") setGone(true);
        else if (e.kind === "runtime_unknown") setRuntimeUnknown(e.supported);
        else {
          setLoadErr(e.detail);
          setDraft(buildDraft(sRes.value, {})); // surface 在、config 读失败 → 空骨架
        }
        return;
      }
      setConfig(cRes.value);
      setDraft(buildDraft(sRes.value, cRes.value.values));
    } finally {
      setLoading(false);
    }
  }, [name, runtime]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onField = React.useCallback((key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setBanner(null);
  }, []);

  // 写成功：重读拿新 rev/values；rev 栈压「被替换的旧 rev」（回滚目标）；按
  // pendingRestart / applied / unsupported 出横幅；通知父层刷新。
  const afterWrite = React.useCallback(
    async (res: ConfigWriteResult, prevRev?: string) => {
      let fresh: ConfigState | null = null;
      try {
        fresh = await fetchMemberConfig(name);
      } catch {
        /* 重读失败 → 以写结果兜底 */
      }
      if (fresh) {
        setConfig(fresh);
        if (surface) setDraft(buildDraft(surface, fresh.values));
      }
      if (prevRev) setRevStack((s) => pushRev(s, prevRev));
      const applied = fresh ? fresh.applied : res.applied;
      const pending = fresh ? fresh.pendingRestart : res.pendingRestart;
      setPendingKeys(pending.length > 0 ? pending : []);
      const notes: string[] = [];
      if (pending.length > 0) notes.push(tr("已写入，重启后生效：{keys}", { keys: pending.join("、") }));
      else if (applied === "pending") notes.push(tr("已写入，尚未生效"));
      else notes.push(tr("已保存"));
      const unsup = res.unsupported ?? [];
      if (unsup.length > 0) {
        notes.push(tr("运行时不接受：{keys}", { keys: unsup.map((u) => `${u.key}（${u.reason}）`).join("、") }));
      }
      setBanner({ type: unsup.length > 0 ? "warning" : "success", text: notes.join("　") });
      onChanged?.();
    },
    [name, surface, tr, onChanged],
  );

  const onWriteError = React.useCallback(
    (e: unknown) => {
      const r = classifyWriteError(e);
      switch (r.kind) {
        case "stale_rev":
          void fetchMemberConfig(name)
            .then(setConfig) // 重读新 rev/values；草稿保留
            .catch(() => undefined);
          setBanner({ type: "warning", text: tr("配置已被他人修改，已重新读取") });
          return;
        case "unknown_field":
          setBanner({
            type: "error",
            text: tr("存在未知字段：{fields}（请刷新后重试）", { fields: r.fields.join("、") }),
          });
          return;
        case "no_writable_keys":
          setBanner({
            type: "error",
            text: tr("运行时不接受：{keys}", {
              keys: r.unsupported.map((u) => `${u.key}（${u.reason}）`).join("、"),
            }),
          });
          return;
        case "invalid_value":
          if (r.key) setFieldErrors((prev) => ({ ...prev, [r.key]: r.detail || r.key }));
          setBanner({ type: "error", text: r.detail || tr("保存失败") });
          return;
        case "runtime_unknown":
          setRuntimeUnknown(r.supported);
          setBanner(null);
          return;
        case "forbidden":
          setReadOnly(true);
          setBanner({ type: "info", text: tr("只读：团队 Leader 或策略限制") });
          return;
        case "gone":
          setGone(true);
          return;
        case "retryable":
          setBanner({ type: "error", text: `${tr("保存失败")}（${r.detail}）` });
          return;
        default:
          setBanner({ type: "error", text: r.detail || tr("保存失败") });
      }
    },
    [name, tr],
  );

  const handleSave = React.useCallback(async () => {
    if (busy || noWrite || !config || !surface) return;
    const values = config.values ?? {};
    const base = diffNested(draft, values);
    if (Object.keys(base).length === 0) {
      antd.message.info(tr("无改动"));
      return;
    }
    const parsed = applySensitiveObjectText(fields, draft, base);
    if (Object.keys(parsed.errors).length > 0) {
      setFieldErrors((prev) => ({ ...prev, ...parsed.errors }));
      setBanner({ type: "error", text: tr("JSON 格式不对") });
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      await afterWrite(await putMemberConfig(name, parsed.patch, config.rev), config.rev);
    } catch (e) {
      onWriteError(e);
    } finally {
      setSaving(false);
    }
  }, [busy, noWrite, config, surface, draft, fields, name, tr, afterWrite, onWriteError]);

  const handleRollback = React.useCallback(async () => {
    if (busy || noWrite || revStack.length === 0) return;
    setRollingBack(true);
    setBanner(null);
    try {
      await afterWrite(await rollbackMemberConfig(name, revStack[0]), config?.rev);
    } catch (e) {
      onWriteError(e);
    } finally {
      setRollingBack(false);
    }
  }, [busy, noWrite, revStack, config, name, afterWrite, onWriteError]);

  // 「立即重启」（pendingRestart 提示行末尾）：confirm → POST
  // /workers/{name}/restart（#1473）→ 成功重读配置（复用 load：重读后
  // pendingRestart 清空、提示行与按钮消失）；失败后端文本原样透出。
  const handleRestartNow = React.useCallback(() => {
    antd.Modal.confirm({
      title: tr("重启 Worker {name}？", { name }),
      content: tr("停止并重新启动容器：运行中的进程重新读配置；进行中的任务会被中断。"),
      okText: tr("重启"),
      cancelText: tr("取消"),
      onOk: async () => {
        setRestarting(true);
        try {
          await restartWorker(name);
          antd.message.success(tr("已发送重启"));
          void load();
        } catch (e) {
          antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
        } finally {
          setRestarting(false);
        }
      },
    });
  }, [name, tr, load]);

  // O4（#1494 hermes surface 已合）：标题按运行时映射——openclaw 品牌标题；
  // hermes 无品牌资产 → 通用标题 + 通用 SettingsIcon（图标行不特化，不硬造）。
  const titleKey =
    runtime === "openclaw"
      ? "OpenClaw 运行配置"
      : runtime === "hermes"
        ? "Hermes 运行配置"
        : "运行配置";

  if (gone) return null;

  return (
    <WorkerCollapseCard
      open={open}
      sheet={sheet}
      icon={runtime === "openclaw" ? <OpenClawIcon size={13} /> : <SettingsIcon size={13} />}
      title={tr(titleKey)}
      headerExtra={
        <>
          <div style={{ flex: 1 }} />
          <antd.Button
            size="small"
            loading={rollingBack}
            disabled={noWrite || busy || revStack.length === 0}
            onClick={() => void handleRollback()}
          >
            {tr("回滚到上次写入")}
          </antd.Button>
          <antd.Button
            size="small"
            type="primary"
            loading={saving}
            disabled={noWrite || busy || !config}
            onClick={() => void handleSave()}
          >
            {tr("保存")}
          </antd.Button>
        </>
      }
      onExpand={() => setOpen(true)}
      onCollapse={() => setOpen(false)}
    >
      <div style={{ display: "grid", gap: 10 }}>
        {/* O4：unknown runtime（控制器版本不支持该运行时的配置面）→ 友好
         * 文案（含 supported 列表）+ 重试；传 "" 给 SurfaceStatus，其旧
         * runtimeUnknown 分支不重复渲染。 */}
        {runtimeUnknown ? (
          <antd.Alert
            type="warning"
            showIcon
            message={tr("当前控制器版本不支持该运行时配置面（控制器支持：{list}）", {
              list: runtimeUnknown,
            })}
            description={
              <antd.Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                loading={loading}
                onClick={() => void load()}
              >
                {tr("重试")}
              </antd.Button>
            }
          />
        ) : (
          <SurfaceStatus
            runtimeUnknown=""
            loading={loading}
            loadErr={loadErr}
            noWrite={noWrite}
            banner={banner}
            onRetry={() => void load()}
            onBannerClose={() => {
              setBanner(null);
              setPendingKeys([]);
            }}
          />
        )}
        {/* pendingRestart 提示行末尾：「立即重启」按钮（提示在才显示）。
         * SurfaceStatus（白名单外）的 Alert 内无法注入控件 → 紧邻提示行右对齐。 */}
        {pendingKeys.length > 0 ? (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -4 }}>
            <antd.Button
              size="small"
              loading={restarting}
              disabled={noWrite || restarting}
              onClick={() => handleRestartNow()}
            >
              {tr("立即重启")}
            </antd.Button>
          </div>
        ) : null}
        {!loading && !runtimeUnknown ? (
          <>
        {surface ? (
              <RuntimeConfigPanel
                surface={surface}
                draft={draft}
                initialDraft={initialDraft}
                onChange={onField}
                disabled={noWrite || busy}
                errors={fieldErrors}
                values={config?.values}
                tr={tr}
              />
            ) : null}
            {config ? (
              <div style={{ fontSize: 10, color: t.textSecondary }}>
                rev {config.rev.slice(0, 8)} · {config.applied === "applied" ? tr("已生效") : tr("待生效")}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </WorkerCollapseCard>
  );
}
