// WorkerRuntimeConfigSurface — 运行时配置面状态机（P8c/G3）。
// 取数（surface+config 并行）→ 草稿 → 保存（嵌套 diff + if-rev）→ 重读/rev 栈 → 回滚 → 错误映射。
// 复用：api/domains/memberConfig（契约）+ lib/surfaceForm（草稿/diff/过滤）+ lib/surfacePatch（路径/敏感解析）
//  + lib/memberConfigErrors（错误分类）+ components/SurfaceForm（渲染）。敏感值永不回写。
// O2：表单上方「搜索字段 + 仅看已修改」过滤行（纯函数 filterFields/
// changedKeys）；surface 渲染入口接 O1 通配逻辑（buildDraft 草稿键为
// concrete 键，双星只读/单星按条目由 SurfaceForm 渲染）。
import type * as ReactNS from "react";

import {
  type ConfigState,
  type ConfigWriteResult,
  type RuntimeSurface,
  type SurfaceField,
  fetchMemberConfig,
  fetchRuntimeSurface,
  putMemberConfig,
  rollbackMemberConfig,
} from "../api/domains/memberConfig";
import { buildDraft, changedKeys, diffNested, pushRev } from "../lib/surfaceForm";
import { applySensitiveObjectText } from "../lib/surfacePatch";
import { classifyLoadError, classifyWriteError } from "../lib/memberConfigErrors";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";
import SurfaceForm from "./SurfaceForm";
import SurfaceStatus, { type SurfaceBanner } from "./surface/SurfaceStatus";
import { SettingsIcon } from "./icons";
import { OpenClawIcon } from "./OpenClawIcon";
import { WorkerCollapseCard } from "./WorkerPanelsShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

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
  const [readOnly, setReadOnly] = React.useState(false);
  const [runtimeUnknown, setRuntimeUnknown] = React.useState("");
  const [revStack, setRevStack] = React.useState<string[]>([]);
  // O2 字段过滤：搜索子串 + 「仅看已修改」开关（默认关）。
  const [query, setQuery] = React.useState("");
  const [changedOnly, setChangedOnly] = React.useState(false);

  const busy = saving || rollingBack;
  const noWrite = l1 !== true || readOnly;
  const fields = React.useMemo<SurfaceField[]>(
    () => (surface ? surface.faces.flatMap((f) => f.fields) : []),
    [surface],
  );
  // 草稿值与 values 不同的键集合（含通配 concrete 键）；开关关 → 空集
  //（filterFields 对空集不做修改过滤）。
  const changedSet = React.useMemo(
    () => (changedOnly ? changedKeys(draft, config?.values ?? {}) : new Set<string>()),
    [changedOnly, draft, config],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadErr("");
    setBanner(null);
    try {
      const [sRes, cRes] = await Promise.allSettled([
        fetchRuntimeSurface(runtime),
        fetchMemberConfig(name),
      ]);
      if (sRes.status === "rejected") {
        const e = classifyLoadError(sRes.reason);
        if (e.kind === "gone") setGone(true);
        else if (e.kind === "runtime_unknown") setRuntimeUnknown(e.supported);
        else setLoadErr(e.detail);
        return;
      }
      setSurface(sRes.value);
      if (cRes.status === "rejected") {
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

  if (gone) return null;

  return (
    <WorkerCollapseCard
      open={open}
      sheet={sheet}
      icon={runtime === "openclaw" ? <OpenClawIcon size={13} /> : <SettingsIcon size={13} />}
      title={tr(runtime === "openclaw" ? "OpenClaw 运行配置" : "运行配置")}
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
        <SurfaceStatus
          runtimeUnknown={runtimeUnknown}
          loading={loading}
          loadErr={loadErr}
          noWrite={noWrite}
          banner={banner}
          onRetry={() => void load()}
          onBannerClose={() => setBanner(null)}
        />
        {!loading && !runtimeUnknown ? (
          <>
        {surface ? (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <antd.Input
                    size="small"
                    allowClear
                    style={{ flex: 1, minWidth: 120, maxWidth: 280 }}
                    placeholder={tr("搜索字段…")}
                    value={query}
                    onChange={(ev: ReactNS.ChangeEvent<HTMLInputElement>) =>
                      setQuery(ev.target.value)
                    }
                  />
                  <antd.Switch
                    size="small"
                    checked={changedOnly}
                    onChange={(c: boolean) => setChangedOnly(c)}
                  />
                  <span style={{ fontSize: 11, color: t.textSecondary }}>
                    {tr("仅看已修改")}
                  </span>
                </div>
                <SurfaceForm
                  surface={surface}
                  draft={draft}
                  onChange={onField}
                  disabled={noWrite || busy}
                  errors={fieldErrors}
                  sheet={sheet}
                  values={config?.values}
                  query={query}
                  changedKeys={changedSet}
                />
              </>
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
