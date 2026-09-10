/**
 * 📡 频道接入（v0.5.0-beta.11，频道接入图形化调研 v0.3 定案实现）。
 *
 * 位置：「👷 团队管理」tab 内的子节（9/1 设计决策：不独立成 tab）。
 * 数据面：Controller #1219 的 10 个代理端点（draft，未合）——
 *   GET  /workers/{name}/channels[|/types|/schemas]
 *   GET/PUT /workers/{name}/channels/{ch}
 *   GET  .../{ch}/health | /qrcode | /qrcode/status
 *   POST .../{ch}/restart | /conflict-check
 * 走既有通用 Controller 代理（/api/ 白名单，后端零新端点）。
 *
 * 版本门：Controller 未升级（v1.2.3，#1219 未合）→ 端点 404 →
 *  整节显示占位说明（不炸 tab，与 L2 冲突检查版本门同模式）。
 *
 * 表单策略（调研定案「schema 驱动 + 零 per-channel 代码」）：
 *   ① 插件频道（schemas 端点有 config_fields 元数据）→ 按元数据渲染；
 *   ② 内置频道（无 schema 条目）→ 通用键值编辑器：现有配置字段按
 *      类型推断渲染（bool→Switch / number→InputNumber / 凭据键→
 *      Password），支持增/删字段行。
 *   凭据不脱敏（9/1 设计决策：表单回写需已存值；L2 限本团队）。
 *
 * 写路径纪律：PUT = 全量频道配置（官方 /channels/{ch} PUT 语义）；
 *  保存前 conflict-check（QQ 双 AppID 踢出防护，#1219 非 mutating）；
 *  PUT 后 GET 读回校验（治 7/27 MinIO 丢 secret 类事故）。
 */
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT, useLang } from "../i18n";
import {
  type WorkerInfo,
  type WorkerChannelConfig,
  type ChannelSchema,
  fetchWorkerChannels,
  fetchWorkerChannelTypes,
  fetchWorkerChannelSchemas,
  fetchWorkerChannel,
  putWorkerChannel,
  fetchWorkerChannelHealth,
  restartWorkerChannel,
  conflictCheckWorkerChannel,
  fetchWorkerChannelQrcode,
  fetchWorkerChannelQrcodeStatus,
  httpErrorStatus,
} from "../api";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

// 频道显示名（QwenPaw console constants.ts CHANNEL_LABELS 同集移植）。
const CHANNEL_LABELS: Record<string, string> = {
  imessage: "iMessage",
  discord: "Discord",
  dingtalk: "DingTalk",
  feishu: "Feishu",
  qq: "QQ",
  telegram: "Telegram",
  slack: "Slack",
  mqtt: "MQTT",
  mattermost: "Mattermost",
  matrix: "Matrix",
  console: "Console",
  voice: "Twilio",
  sip: "SIP",
  wecom: "WeCom",
  xiaoyi: "XiaoYi",
  wechat: "WeChat",
  onebot: "OneBot",
  yuanbao: "Yuanbao",
};
const CHANNEL_LABELS_ZH: Record<string, string> = {
  dingtalk: "钉钉",
  feishu: "飞书",
  qq: "QQ",
  wecom: "企业微信",
  wechat: "微信",
  matrix: "Matrix",
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  console: "控制台",
  xiaoyi: "小艺",
  yuanbao: "元宝",
  onebot: "OneBot",
  mqtt: "MQTT",
  sip: "SIP",
  voice: "Twilio 语音",
  imessage: "iMessage",
  mattermost: "Mattermost",
};

/** 频道显示名（英文环境=CHANNEL_LABELS；中文环境=常见频道中文名）。 */
function channelLabel(key: string, lang: "zh" | "en"): string {
  const cap =
    key.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const en = CHANNEL_LABELS[key] || cap;
  return lang === "zh" ? CHANNEL_LABELS_ZH[key] || en : en;
}

/** 凭据类键名（Password 输入回显控制）。 */
function isSecretKey(key: string): boolean {
  return /token|secret|password|passwd|apikey|api_key|appkey|app_secret|appsecret|credential|authorization/i.test(key);
}

/** 配置值类型推断（通用编辑器）。 */
function inferType(v: unknown): "bool" | "number" | "string" {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  return "string";
}

interface FieldRow {
  key: string;
  value: unknown;
  removed?: boolean;
}

function configToRows(cfg: WorkerChannelConfig): FieldRow[] {
  const rows: FieldRow[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "enabled" || k === "bot_prefix" || k === "isBuiltin") continue;
    rows.push({ key: k, value: v });
  }
  return rows;
}

export default function WorkerChannels(props: {
  workers: WorkerInfo[];
  active?: boolean;
}) {
  const { workers, active = true } = props;
  const t = useThemeColors();
  const tr = useT();
  const lang = useLang();
  const [sel, setSel] = React.useState("");
  // 版本门：404 = Controller 无频道端点（#1219 未合/未升级）。
  const [gate, setGate] = React.useState<"" | "404" | "err">("");
  const [channels, setChannels] = React.useState<Record<string, WorkerChannelConfig>>({});
  const [schemas, setSchemas] = React.useState<Record<string, ChannelSchema>>({});
  const [loading, setLoading] = React.useState(false);
  const [health, setHealth] = React.useState<Record<string, boolean | null>>({});
  const [healthBusy, setHealthBusy] = React.useState(false);

  // 编辑抽屉。
  const [drawerCh, setDrawerCh] = React.useState("");
  const [rows, setRows] = React.useState<FieldRow[]>([]);
  const [enabled, setEnabled] = React.useState(false);
  const [botPrefix, setBotPrefix] = React.useState("");
  const [newKey, setNewKey] = React.useState("");
  const [newValue, setNewValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [restartBusy, setRestartBusy] = React.useState(false);
  const [persisted, setPersisted] = React.useState<"" | "true" | "false" | "skipped">("");

  // 二维码授权（QwenPaw 同款流程：fetch→展示→轮询→凭据回填）。
  const [qrImg, setQrImg] = React.useState("");
  const [qrBusy, setQrBusy] = React.useState(false);
  const qrPollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => { if (qrPollRef.current) clearTimeout(qrPollRef.current); }, []);

  // 默认选中 Leader（不限 Leader——调研定案）。
  React.useEffect(() => {
    if (!sel && workers.length > 0) {
      const lead = workers.find((w) => w.role === "leader") || workers[0];
      setSel(lead.name);
    }
  }, [workers, sel]);

  const stopQrPoll = React.useCallback(() => {
    if (qrPollRef.current) {
      clearTimeout(qrPollRef.current);
      qrPollRef.current = null;
    }
  }, []);

  const load = React.useCallback(async (silent = false) => {
    if (!sel) return;
    if (!silent) setLoading(true);
    try {
      const [chRes, schemaRes] = await Promise.allSettled([
        fetchWorkerChannels(sel),
        fetchWorkerChannelSchemas(sel),
      ]);
      if (chRes.status === "rejected") {
        const st = httpErrorStatus(chRes.reason);
        if (st === 404) {
          setGate("404");
          setChannels({});
          return;
        }
        setGate("err");
        antd.message.error(chRes.reason instanceof Error ? chRes.reason.message : tr("加载失败"));
        return;
      }
      setGate("");
      setChannels(chRes.value || {});
      if (schemaRes.status === "fulfilled") setSchemas(schemaRes.value || {});
    } finally {
      if (!silent) setLoading(false);
    }
  }, [sel, tr]);

  React.useEffect(() => {
    setGate("");
    setChannels({});
    setHealth({});
    setPersisted("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // 保活 tab 激活时 30s 静默刷新（WorkerManage 同款节奏）。
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    const id = window.setInterval(() => {
      if (active && !document.hidden) void loadRef.current(true);
    }, 30000);
    return () => window.clearInterval(id);
  }, [active]);

  const openDrawer = React.useCallback(async (ch: string) => {
    const cfg = channels[ch] || { enabled: false, bot_prefix: "" };
    setDrawerCh(ch);
    setEnabled(Boolean(cfg.enabled));
    setBotPrefix(String(cfg.bot_prefix ?? ""));
    setRows(configToRows(cfg));
    setQrImg("");
    stopQrPoll();
    setPersisted("");
    // 读最新现值（避免卡片数据陈旧）。
    try {
      const fresh = await fetchWorkerChannel(sel, ch);
      setEnabled(Boolean(fresh.enabled));
      setBotPrefix(String(fresh.bot_prefix ?? ""));
      setRows(configToRows(fresh));
    } catch {
      /* 现值读失败用卡片缓存 */
    }
  }, [channels, sel, stopQrPoll]);

  const closeDrawer = React.useCallback(() => {
    setDrawerCh("");
    setQrImg("");
    stopQrPoll();
  }, [stopQrPoll]);

  const buildConfig = React.useCallback((): WorkerChannelConfig => {
    const cfg: WorkerChannelConfig = { enabled, bot_prefix: botPrefix };
    for (const r of rows) {
      if (r.removed || !r.key) continue;
      if (r.value === "" || r.value === null || r.value === undefined) continue;
      cfg[r.key] = r.value;
    }
    return cfg;
  }, [enabled, botPrefix, rows]);

  /** 二维码状态轮询（官方 useChannelQrcode 同节奏：2s；凭据回填=成功）。 */
  const pollQrStatus = React.useCallback(
    (token: string) => {
      stopQrPoll();
      const tick = async () => {
        try {
          const r = await fetchWorkerChannelQrcodeStatus(sel, drawerCh, token);
          if (r.credentials && Object.keys(r.credentials).length > 0) {
            stopQrPoll();
            setRows((prev) => {
              const next = prev.map((p) => ({ ...p }));
              for (const [k, v] of Object.entries(r.credentials || {})) {
                const i = next.findIndex((p) => p.key === k && !p.removed);
                if (i >= 0) next[i] = { ...next[i], value: v };
                else next.push({ key: k, value: v });
              }
              return next;
            });
            antd.message.success(tr("扫码授权成功，凭据已回填（保存后生效）"));
            return;
          }
          if (r.status === "expired" || r.status === "fail" || r.status === "failed") {
            stopQrPoll();
            setQrImg("");
            antd.message.warning(tr("二维码已失效，请重新生成"));
            return;
          }
        } catch {
          /* 单次失败继续轮询 */
        }
        qrPollRef.current = setTimeout(tick, 2000);
      };
      void tick();
    },
    [sel, drawerCh, stopQrPoll, tr],
  );

  const startQr = React.useCallback(async () => {
    setQrBusy(true);
    try {
      const r = await fetchWorkerChannelQrcode(sel, drawerCh);
      setQrImg(r.qrcode_img);
      pollQrStatus(r.poll_token);
    } catch (e) {
      const st = httpErrorStatus(e);
      if (st === 404) {
        antd.message.info(tr("该频道不支持二维码授权"));
      } else {
        antd.message.error(e instanceof Error ? e.message : tr("获取二维码失败"));
      }
    } finally {
      setQrBusy(false);
    }
  }, [sel, drawerCh, pollQrStatus, tr]);

  const save = React.useCallback(async () => {
    const cfg = buildConfig();
    setSaving(true);
    try {
      // 保存前冲突检查（非 mutating；端点不可用[版本差异]静默跳过）。
      let conflict = false;
      try {
        const c = await conflictCheckWorkerChannel(sel, drawerCh, cfg);
        conflict = Boolean(
          (c && typeof c === "object" && (c.conflict === true || c.has_conflict === true)) ||
          (Array.isArray(c?.conflicts) && (c.conflicts as unknown[]).length > 0),
        );
      } catch {
        /* 404/501 = 端点不可用 → 跳过（PUT 仍会成功或报错） */
      }
      if (conflict) {
        const ok = await new Promise<boolean>((resolve) => {
          antd.Modal.confirm({
            title: tr("检测到频道冲突"),
            content: tr("相同凭据可能正被其他 Agent 使用（保存后对方可能被踢出，如 QQ 双 AppID）。仍要保存？"),
            okText: tr("仍要保存"),
            cancelText: tr("取消"),
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });
        if (!ok) return;
      }
      await putWorkerChannel(sel, drawerCh, cfg);
      // 读回校验（治 MinIO 丢 secret 类事故）。
      let persistedOk: "true" | "false" | "skipped" = "true";
      try {
        const back = await fetchWorkerChannel(sel, drawerCh);
        const eq = JSON.stringify(back) === JSON.stringify(cfg);
        persistedOk = eq ? "true" : "false";
      } catch {
        persistedOk = "skipped";
      }
      setPersisted(persistedOk);
      setChannels((prev) => ({ ...prev, [drawerCh]: cfg }));
      if (persistedOk === "false") {
        antd.message.warning(tr("已保存，但读回校验不一致（push_loop 收敛中，稍后自动一致）"));
      } else {
        antd.message.success(tr("已保存（热加载，立即生效）"));
      }
      void load(true);
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
    } finally {
      setSaving(false);
    }
  }, [sel, drawerCh, buildConfig, load, tr]);

  const doRestart = React.useCallback(async () => {
    setRestartBusy(true);
    try {
      await restartWorkerChannel(sel, drawerCh);
      antd.message.success(tr("频道已重启"));
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("重启失败"));
    } finally {
      setRestartBusy(false);
    }
  }, [sel, drawerCh, tr]);

  const checkHealth = React.useCallback(async () => {
    if (!sel) return;
    setHealthBusy(true);
    const keys = Object.keys(channels);
    const out: Record<string, boolean | null> = {};
    await Promise.all(
      keys.map(async (k) => {
        try {
          const r = await fetchWorkerChannelHealth(sel, k);
          out[k] = !r || r.healthy !== false ? true : false;
        } catch {
          out[k] = null; // 未知（端点不支持该频道/未配置）
        }
      }),
    );
    setHealth(out);
    setHealthBusy(false);
  }, [sel, channels]);

  const schema = drawerCh ? schemas[drawerCh] : undefined;
  const schemaFields = schema?.config_fields || [];
  // 元数据驱动的字段键集（与 rows 合并：元数据补空行，rows 里的额外键保留）。
  const metaKeys = schemaFields
    .map((f) => f.key || f.name || "")
    .filter(Boolean) as string[];
  const metaFor = (key: string) =>
    schemaFields.find((f) => (f.key || f.name) === key);

  const sortedRows = React.useMemo(() => {
    const base = [...rows];
    for (const mk of metaKeys) {
      if (!base.some((r) => r.key === mk && !r.removed)) {
        const f = metaFor(mk);
        base.push({ key: mk, value: f?.default ?? "" });
      }
    }
    // 元数据字段在前（按 schema 顺序），自由字段在后。
    return base.sort((a, b) => {
      const ia = metaKeys.indexOf(a.key);
      const ib = metaKeys.indexOf(b.key);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, metaKeys.join(",")]);

  if (gate === "404") {
    return (
      <div>
        <antd.Alert
          type="info"
          showIcon
          message={tr("频道接入 API 待上游合并")}
          description={tr(
            "Controller 频道代理端点（PR #1219，review 中）尚未合并/Controller 尚未升级，当前版本无此 API。合并并升级后本节自动点亮（schema 驱动表单，零 per-channel 代码）。",
          )}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>{tr("Worker")}</span>
        <antd.Select
          size="small"
          style={{ width: 220 }}
          value={sel || undefined}
          onChange={(v: string) => {
            setSel(v);
            setPersisted("");
          }}
          options={workers.map((w) => ({
            value: w.name,
            label: `${w.name}${w.role === "leader" ? "（Leader）" : ""}`,
          }))}
          placeholder={tr("选择 Worker")}
        />
        <div style={{ flex: 1 }} />
        <antd.Button size="small" onClick={() => void load()} loading={loading}>
          {tr("刷新")}
        </antd.Button>
        <antd.Button size="small" onClick={() => void checkHealth()} loading={healthBusy}>
          {tr("健康检查")}
        </antd.Button>
      </div>

      {loading && !Object.keys(channels).length ? (
        <antd.Spin />
      ) : (
        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
          }}
        >
          {Object.entries(channels).map(([key, cfg]) => {
            const on = Boolean(cfg.enabled);
            const h = health[key];
            return (
              <antd.Card
                key={key}
                size="small"
                hoverable
                onClick={() => void openDrawer(key)}
                title={
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {cfg.isBuiltin ? "🧱" : "🔌"} {channelLabel(key, lang)}
                  </span>
                }
                extra={
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {h !== undefined && h !== null && (
                      <antd.Tag color={h ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                        {h ? tr("健康") : tr("异常")}
                      </antd.Tag>
                    )}
                    <antd.Tag color={on ? "green" : "default"} style={{ marginInlineEnd: 0 }}>
                      {on ? tr("已启用") : tr("未启用")}
                    </antd.Tag>
                  </span>
                }
              >
                <div style={{ fontSize: 12, color: t.textSecondary, minHeight: 30 }}>
                  {schemas[key]?.description ||
                    (cfg.bot_prefix ? tr("前缀：{p}", { p: String(cfg.bot_prefix) }) : tr("未配置"))}
                </div>
              </antd.Card>
            );
          })}
          {!Object.keys(channels).length && (
            <antd.Empty description={tr("无频道配置")} />
          )}
        </div>
      )}

      <antd.Drawer
        title={drawerCh ? `${tr("编辑频道")}：${channelLabel(drawerCh, lang)}` : ""}
        open={Boolean(drawerCh)}
        onClose={closeDrawer}
        width={520}
        destroyOnClose
      >
        {drawerCh && (
          <div style={{ display: "grid", gap: 14 }}>
            <antd.Space>
              <antd.Switch
                checked={enabled}
                onChange={setEnabled}
                checkedChildren={tr("启用")}
                unCheckedChildren={tr("停用")}
              />
              {persisted !== "" && (
                <antd.Tag color={persisted === "true" ? "green" : persisted === "skipped" ? "default" : "orange"}>
                  {persisted === "true"
                    ? tr("读回校验一致")
                    : persisted === "skipped"
                      ? tr("读回校验不可用")
                      : tr("读回校验不一致")}
                </antd.Tag>
              )}
            </antd.Space>

            <antd.Input
              addonBefore={tr("消息前缀 bot_prefix")}
              value={botPrefix}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setBotPrefix(e.target.value)}
              placeholder={tr("（留空=不带前缀）")}
            />

            {qrImg && (
              <div style={{ textAlign: "center" }}>
                <img
                  src={`data:image/png;base64,${qrImg}`}
                  alt="qr"
                  style={{ width: 220, height: 220, border: `1px solid ${t.border}` }}
                />
                <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 6 }}>
                  {tr("用手机扫码授权，成功后凭据自动回填")}
                </div>
              </div>
            )}

            <div style={{ display: "grid", gap: 8 }}>
              {sortedRows.map((r, idx) => {
                if (r.removed) return null;
                const f = metaFor(r.key);
                const type = f?.type ? String(f.type) : inferType(r.value);
                const secret = Boolean(f?.secret) || isSecretKey(r.key);
                return (
                  <div key={`${r.key}-${idx}`} style={{ display: "grid", gap: 2 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, color: t.textSecondary, minWidth: 130 }}>
                        {f?.label || r.key}
                      </span>
                      <div style={{ flex: 1 }}>
                        {type === "bool" ? (
                          <antd.Switch
                            size="small"
                            checked={Boolean(r.value)}
                            onChange={(v: boolean) =>
                              setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, value: v } : p)))
                            }
                          />
                        ) : type === "number" ? (
                          <antd.InputNumber
                            size="small"
                            style={{ width: "100%" }}
                            value={typeof r.value === "number" ? r.value : undefined}
                            onChange={(v: number | null) =>
                              setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, value: v ?? "" } : p)))
                            }
                          />
                        ) : secret ? (
                          <antd.Input.Password
                            size="small"
                            value={r.value == null ? "" : String(r.value)}
                            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                              setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)))
                            }
                          />
                        ) : (
                          <antd.Input
                            size="small"
                            value={r.value == null ? "" : String(r.value)}
                            placeholder={f?.placeholder}
                            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                              setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)))
                            }
                          />
                        )}
                      </div>
                      <antd.Button
                        size="small"
                        type="text"
                        danger
                        onClick={() =>
                          setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, removed: true } : p)))
                        }
                      >
                        {tr("删除")}
                      </antd.Button>
                    </div>
                    {f?.description ? (
                      <div style={{ fontSize: 11, color: t.textSecondary, paddingLeft: 136 }}>
                        {f.description}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <antd.Input
                size="small"
                style={{ width: 150 }}
                value={newKey}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setNewKey(e.target.value)}
                placeholder={tr("字段名")}
              />
              <antd.Input
                size="small"
                style={{ flex: 1 }}
                value={newValue}
                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setNewValue(e.target.value)}
                placeholder={tr("字段值")}
              />
              <antd.Button
                size="small"
                disabled={!newKey.trim()}
                onClick={() => {
                  if (!newKey.trim()) return;
                  setRows((prev) => [
                    ...prev.map((p) => ({ ...p, removed: false })),
                    { key: newKey.trim(), value: newValue },
                  ]);
                  setNewKey("");
                  setNewValue("");
                }}
              >
                {tr("加字段")}
              </antd.Button>
            </div>

            <antd.Space wrap>
              <antd.Button type="primary" loading={saving} onClick={() => void save()}>
                {tr("保存（热加载）")}
              </antd.Button>
              <antd.Button loading={restartBusy} onClick={() => void doRestart()}>
                {tr("重启频道")}
              </antd.Button>
              {!qrImg && (
                <antd.Button loading={qrBusy} onClick={() => void startQr()}>
                  {tr("扫码授权（如支持）")}
                </antd.Button>
              )}
            </antd.Space>
          </div>
        )}
      </antd.Drawer>
    </div>
  );
}
