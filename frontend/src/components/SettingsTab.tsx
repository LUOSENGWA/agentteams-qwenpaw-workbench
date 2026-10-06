import type * as ReactNS from "react";

import {
  requestJson,
  testAddresses,
  entryUrl,
  exportFullConfig,
  importFullConfig,
  verifyAdmin,
  type VerifyAdminResult,
  type AddressEntry,
  type AddressTestResult,
  type ConfigTestResponse,
  type ProbeDiag,
  type WorkbenchConfig,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { SearchIcon, RefreshIcon, CheckIcon, CloseIcon, WarnIcon, HomeIcon, MonitorIcon } from "./icons";


const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const { message } = antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const DownloadIcon = pick("DownloadOutlined");
const UploadIcon = pick("UploadOutlined");
const FileZipOutlined = pick("FileZipOutlined");
// v0.5.0-beta.14.14（UIPERF-T23）：备份与恢复——导出弹窗复制按钮。
const CopyIcon = pick("CopyOutlined");

function EffectiveBadge({ url, label }: { url?: string; label: string }) {
  if (!url) return null;

  return (
    <span
      style={{
        fontSize: 12,
        color: "#52c41a",
        background: "rgba(82,196,26,0.1)",
        padding: "2px 8px",
        borderRadius: 6,
        marginLeft: 8,
      }}
    >
      {label}生效：{url}
    </span>
  );
}

/** v0.5.0-beta.12: 连通性测试结构化诊断展开区——外网 DPI 定位锚点。
    分步过程（✓/✗+ms）/ 完整原始异常（等宽全栈）/ 客户端环境（TLS 栈指纹，等宽）。 */
function ConnDiagPanel({ diag }: { diag: ProbeDiag }) {
  const tr = useT();
  const mono: React.CSSProperties = {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  };
  const proxyLines = Object.entries(diag.env.proxies || {});
  return (
    <div
      style={{
        margin: "4px 0 6px 16px",
        padding: "8px 10px",
        borderRadius: 6,
        background: "rgba(0,0,0,0.03)",
        border: "1px solid rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={mono}>
        <b>{tr("测试目标")}</b>：{diag.target}
      </div>
      <div style={{ ...mono, color: "#333" }}>
        <div><b>{tr("分步过程")}</b></div>
        {diag.steps.map((s) => (
          <div key={s.name}>
            {s.ok ? <CheckIcon size={12} style={{ color: "#52c41a", verticalAlign: "-1px" }} /> : <CloseIcon size={12} style={{ color: "#ff4d4f", verticalAlign: "-1px" }} />} {s.name} <span style={{ color: "#999" }}>{s.ms} ms</span>
            {s.detail ? ` — ${s.detail}` : ""}
          </div>
        ))}
      </div>
      <div style={{ ...mono, color: "#cf1322" }}>
        <div><b>{tr("完整原始异常")}</b></div>
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          {diag.error ? diag.error.traceback : tr("全部成功（无异常）")}
        </div>
      </div>
      <div style={{ ...mono, color: "#333" }}>
        <div><b>{tr("客户端环境")}</b></div>
        <div>Python {diag.env.python} / OpenSSL {diag.env.openssl} / httpx {diag.env.httpx}</div>
        <div>{diag.env.platform}</div>
        {proxyLines.length > 0 ? (
          <>
            <div><b>{tr("代理环境变量")}</b></div>
            {proxyLines.map(([k, v]) => (
              <div key={k}>{k}={v}</div>
            ))}
          </>
        ) : (
          <div style={{ color: "#999" }}>{tr("代理环境变量")}：无</div>
        )}
      </div>
      <div style={{ ...mono, color: "#999" }}>
        {tr("测试时间")}：{diag.ts}
      </div>
    </div>
  );
}

/** v0.5.0-beta.12: 连通性测试单行——✅ 延迟 / ❌ 错误原因，生效地址带「生效中」标。
    v0.5.0-beta.12: 三态——✅ 连通可用（绿）/ ⚠️ 已连通但需鉴权或异常状态（橙）/ ❌ 网络层失败（红）。
    v0.5.0-beta.12: 点击展开结构化诊断（分步+全栈 traceback+客户端环境）；折叠态=现状一句话摘要。 */
function ConnRow({
  row,
  tag,
  active,
  pinned,
  // v0.5.0-beta.14.17（C2）：Higress 会话三态在 detail 里——ok 时也强制显示
  // detail（而非仅 ms）。
  showDetail,
}: {
  row: AddressTestResult;
  tag: string;
  active: boolean;
  // v0.5.0-beta.14.1: 固定档——该地址被 address_mode 钉住（与 active 徽标并行显示）。
  pinned?: boolean;
  showDetail?: boolean;
}) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const degraded = row.ok && row.http_ok === false;
  const color = !row.ok ? "#cf1322" : degraded ? "#d48806" : "#52c41a";
  return (
    <div style={{ minWidth: 0 }}>
      <div
        onClick={row.diag ? () => setOpen(!open) : undefined}
        title={row.diag ? tr("详情") : undefined}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          minWidth: 0,
          padding: "4px 8px",
          borderRadius: 6,
          background: active ? "rgba(255,127,22,0.06)" : "transparent",
          cursor: row.diag ? "pointer" : "default",
          userSelect: "none",
        }}
      >
        {row.diag ? (
          <span style={{ flexShrink: 0, color: "#999", fontSize: 11 }}>
            {open ? "▾" : "▸"}
          </span>
        ) : null}
        <span style={{ flexShrink: 0 }}>{!row.ok ? <CloseIcon size={13} style={{ color: "#ff4d4f" }} /> : degraded ? <WarnIcon size={13} style={{ color: "#fa8c16" }} /> : <CheckIcon size={13} style={{ color: "#52c41a" }} />}</span>
        <span style={{ color: "#999", flexShrink: 0, width: 64 }}>{tag}</span>
        <span
          title={row.url}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: "0 1 auto",
            minWidth: 0,
          }}
        >
          {row.url || tr("（未设置）")}
        </span>
        <span
          style={{
            flexShrink: 0,
            marginLeft: "auto",
            color,
          }}
          title={row.detail}
        >
          {row.ok && !degraded && !showDetail
            ? `${row.ms} ms`
            : showDetail && row.ok && row.ms != null
              ? `${row.detail}｜${row.ms} ms`
              : row.detail}
        </span>
        {active ? (
          <antd.Tag color="orange" style={{ margin: 0, flexShrink: 0 }}>
            {tr("生效中")}
          </antd.Tag>
        ) : null}
        {pinned ? (
          <antd.Tag color="blue" style={{ margin: 0, flexShrink: 0 }}>
            {tr("固定")}
          </antd.Tag>
        ) : null}
      </div>
      {open && row.diag ? <ConnDiagPanel diag={row.diag} /> : null}
    </div>
  );
}

// 启动页偏好（用户反馈）：开关存 localStorage，默认"上次打开的页面"。
const STARTUP_PREF_KEY = "agentteams-qwenpaw-workbench:startup-pref";
export function readStartupPref(): "last" | "home" {
  try {
    const raw = window.localStorage.getItem(STARTUP_PREF_KEY);
    return raw === "home" ? "home" : "last";
  } catch {
    return "last";
  }
}
/** 启动页偏好行：上次打开的页面（默认）/ 首页（用户反馈）。 */

function StartupPrefRow() {
  const tr = useT();
  const [pref, setPref] = React.useState<"last" | "home">(readStartupPref());
  const apply = (next: "last" | "home") => {
    setPref(next);
    try {
      window.localStorage.setItem(STARTUP_PREF_KEY, next);
    } catch {
      /* storage 不可用则跳过 */
    }
  };
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><MonitorIcon size={14} /> {tr("启动页")}</span>
        <span style={{ fontWeight: 400, color: "#888", marginLeft: 8, fontSize: 12 }}>
          {tr("下次打开插件时先看到哪里")}
        </span>
      </div>
      <antd.Segmented
        value={pref}
        onChange={(v: string | number) => apply(v as "last" | "home")}
        options={[
          { label: tr("上次打开的页面"), value: "last" },
          { label: <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><HomeIcon size={13} /> {tr("首页")}</span>, value: "home" },
        ]}
        style={{ marginBottom: 12 }}
      />
    </div>
  );
}

// ── v0.5.0-beta.14.3: 地址覆盖凭据（公网网关 Basic 门 / API key 门）──
// 编辑草稿（每地址一份；提交时 buildAuthEntry 组装条目，无凭据=纯 URL 串）。
// v0.5.0-beta.14.17（C1 凭据记忆重做）：stored=「该类型原有已保存凭据」。
// 输入框协议：秘密字段**永不预填脱敏字面量**（*** 回显进框 = 用户不清空直接
// 输入 → 拼接串覆盖真凭据；状态也不透明）。空框 = 保持不变，提交时按 stored
// 语义发 *** 占位（后端 merge 继承旧值）；显式清除=把类型切回「服务自身认证」。
type AddrAuthDraft = {
  type: "none" | "basic" | "bearer";
  username: string;
  password: string;
  token: string;
  stored: boolean;
};
const EMPTY_ADDR_AUTH: AddrAuthDraft = {
  type: "none",
  username: "",
  password: "",
  token: "",
  stored: false,
};
/** 地址条目（string | {url, auth?}）→ 编辑草稿（字符串/无效 = none）。
 *  v0.5.0-beta.14.17（C1）：脱敏值 *** 不进输入框（存 stored 标记）。 */
function entryToAuthDraft(e: AddressEntry | undefined | null): AddrAuthDraft {
  if (e && typeof e === "object" && e.auth) {
    const a = e.auth;
    if (a.type === "basic")
      return {
        type: "basic",
        username: a.username || "",
        password: a.password && a.password !== "***" ? a.password : "",
        token: "",
        stored: Boolean(a.username && a.password),
      };
    if (a.type === "bearer")
      return {
        type: "bearer",
        username: "",
        password: "",
        token: a.token && a.token !== "***" ? a.token : "",
        stored: Boolean(a.token),
      };
  }
  return { ...EMPTY_ADDR_AUTH };
}
/** 草稿 + URL → 提交条目。
 *  v0.5.0-beta.14.17（C1）：秘密字段空 = 保持不变（stored → 发 *** 占位让后端
 *  继承；非 stored 且字段不全 = 降级纯 URL，诚实不装）。显式清除=类型切 none
 *  （=纯 URL 条目，后端按显式清除处理）——旧「选了类型但密码空=纯 URL」会把
 *  已保存凭据误清除，已废。 */
function buildAuthEntry(url: string, d: AddrAuthDraft): AddressEntry {
  const u = (url || "").trim();
  if (!u) return "";
  if (d.type === "basic" && d.username.trim()) {
    const pw = d.password.trim();
    if (pw)
      return {
        url: u,
        auth: { type: "basic", username: d.username.trim(), password: pw },
      };
    if (d.stored)
      return {
        url: u,
        auth: { type: "basic", username: d.username.trim(), password: "***" },
      };
  }
  if (d.type === "bearer") {
    const tok = d.token.trim();
    if (tok) return { url: u, auth: { type: "bearer", token: tok } };
    if (d.stored) return { url: u, auth: { type: "bearer", token: "***" } };
  }
  return u;
}

/** 地址行下方的公网凭据编辑（紧凑：选择器一行；选了才展开输入行）。 */
function AddrAuthEditor({
  value,
  onChange,
  disabled,
}: {
  value: AddrAuthDraft;
  onChange: (v: AddrAuthDraft) => void;
  disabled?: boolean;
}) {
  const tr = useT();
  return (
    <div style={{ marginLeft: 2, marginBottom: 8 }}>
      <antd.Select
        size="small"
        value={value.type}
        disabled={disabled}
        // v0.5.0-beta.14.17（C1）：换类型=新类型无已存凭据（stored 清零，
        // 防把 A 类型的 stored 标记误带到 B 类型触发 *** 继承）。
        onChange={(t: "none" | "basic" | "bearer") =>
          onChange({ ...value, type: t, stored: false })
        }
        style={{ width: 300, maxWidth: "100%" }}
        options={[
          { value: "none", label: tr("使用服务自身认证（内网默认，留空即用；选此项=清除该地址已存凭据）") },
          { value: "basic", label: tr("Basic 认证（公网网关 Basic 门，如 Caddy）") },
          { value: "bearer", label: tr("API Key（Bearer，公网网关 API key 门，如 Higress）") },
        ]}
      />
      {value.type === "basic" ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <antd.Input
            size="small"
            placeholder={tr("用户名（与网关一致）")}
            value={value.username}
            disabled={disabled}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              onChange({ ...value, username: e.target.value })
            }
            style={{ width: 150 }}
          />
          {/* v0.5.0-beta.14.17（C1）：已存密码不回显字面量——空框+占位提示
              「已保存·留空保持不变」，消除拼接覆盖真密码的路径。 */}
          <antd.Input.Password
            size="small"
            placeholder={tr(
              value.stored ? "密码（已保存 · 留空保持不变）" : "密码（与网关一致）",
            )}
            value={value.password}
            disabled={disabled}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              onChange({ ...value, password: e.target.value })
            }
            style={{ width: 180 }}
          />
        </div>
      ) : null}
      {value.type === "bearer" ? (
        <antd.Input
          size="small"
          placeholder={tr(
            value.stored ? "API Key（已保存 · 留空保持不变）" : "API Key（Bearer token）",
          )}
          value={value.token}
          disabled={disabled}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            onChange({ ...value, token: e.target.value })
          }
          style={{ marginTop: 4, width: 330, maxWidth: "100%" }}
        />
      ) : null}
    </div>
  );
}

// v0.5.0-beta.14.10（UIPERF-T13）：面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
const SettingsTab = React.memo(function SettingsTab({
  config,
  configLoadState,
  onRetryConfig,
  onConfigChange,
  onLoginSuccess,
  chatForceWide,
  onChatForceWideChange,
  sseState,
}: {
  config: WorkbenchConfig | null;
  // v0.5.0-beta.14.16（F1）：config 加载态（加载中横幅 / 失败+重试 / 保存钮门控）。
  configLoadState: "loading" | "ready" | "failed";
  onRetryConfig: () => void;
  onConfigChange: () => void;
  // v0.5.0-beta.12: 登录（账号切换）成功后 → 清本地旧账号数据 + 全量刷新。
  onLoginSuccess?: () => void;
  // 12.14：聊天分栏强制开关（忽略宽度判定）。
  chatForceWide?: boolean;
  onChatForceWideChange?: (v: boolean) => void;
  // v0.5.0-beta.14.1 (S1-4)：事件流连接态（设置页可见——排障一眼定位 S1 类问题）。
  sseState?: { status: "connected" | "reconnecting"; since: number };
}) {
  const tr = useT();
  // v0.5.0-beta.14.4：设置页 UI 整理——分节卡片底色跟随主题（宿主配色）。
  const t = useThemeColors();
  const cardBox: React.CSSProperties = {
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: 12,
    background: t.cardBg,
  };
  const [matrixLan, setMatrixLan] = React.useState("");
  const [matrixWan, setMatrixWan] = React.useState("");
  // v0.5.0-beta.14.1: 地址手动固定档（auto=自动切换[默认] / lan=固定内网 / wan=固定外网）。
  const [addressMode, setAddressMode] = React.useState<"auto" | "lan" | "wan">("auto");
  const [controllerLan, setControllerLan] = React.useState("");
  const [controllerWan, setControllerWan] = React.useState("");
  const [controllerToken, setControllerToken] = React.useState("");
  // v0.5.0-beta.12: token 文件路径字段已删（用户反馈：「文件路径可以删掉了，
  // 留个命令就行」）——获取方式=下方命令提示 + 粘贴；env 作部署期注入兜底。
  // v0.5.0-beta.12: Higress Console 会话（admin 账号+密码，验证通过才
  // 由 verify-admin 持久化；普通保存不提交凭据）。密码不回填（脱敏），
  // 留空=保持已存值。
  const [adminUsername, setAdminUsername] = React.useState("");
  const [adminPassword, setAdminPassword] = React.useState("");
  // v0.5.0-beta.14.7: Higress 双地址——gatewayAdminUrl=内网（变量名保持省
  // diff），gatewayWan=外网（内网不可达时自动降级）。
  const [gatewayAdminUrl, setGatewayAdminUrl] = React.useState("");
  const [gatewayWan, setGatewayWan] = React.useState("");
  // v0.5.0-beta.14.12（UIPERF-T18）：控制台特效三档（默认 light；取代旧
  // consoleCalm bool——light=动画保留+模糊封顶 / off=全停 / full=原样）。
  const [fxMode, setFxMode] = React.useState<"light" | "off" | "full">(
    "light",
  );
  const [verifying, setVerifying] = React.useState(false);
  const [verifyRes, setVerifyRes] = React.useState<VerifyAdminResult | null>(null);
  // 可选模块：集群负载（L1 专属）
  const [sglangEnabled, setSglangEnabled] = React.useState(false);
  // v0.5.0-beta.12: SGLang 双地址（内网/外网）——与 matrix/controller 同构。
  const [sglangLan, setSglangLan] = React.useState("");
  const [sglangWan, setSglangWan] = React.useState("");
  // v0.5.0-beta.14.3: 每地址公网凭据（key=<kind>:<idx>，idx 0=内网 1=外网）。
  const [addrAuth, setAddrAuth] = React.useState<Record<string, AddrAuthDraft>>(
    () => ({
      "matrix:0": EMPTY_ADDR_AUTH,
      "matrix:1": EMPTY_ADDR_AUTH,
      "controller:0": EMPTY_ADDR_AUTH,
      "controller:1": EMPTY_ADDR_AUTH,
      "sglang:0": EMPTY_ADDR_AUTH,
      "sglang:1": EMPTY_ADDR_AUTH,
    }),
  );
  const setAddrAuthFor = React.useCallback(
    (key: string, v: AddrAuthDraft) =>
      setAddrAuth((prev) => ({ ...prev, [key]: v })),
    [],
  );
  // 表单当前值 → 提交条目（URL + 可选凭据；空=空串，后端合并时丢弃）。
  // v0.5.0-beta.14.17（C2）：gateway 族（Higress 双地址，同构）。
  const buildAddrEntries = React.useCallback(
    (kind: "matrix" | "controller" | "sglang" | "gateway"): AddressEntry[] => {
      const urls =
        kind === "matrix"
          ? [matrixLan, matrixWan]
          : kind === "controller"
            ? [controllerLan, controllerWan]
            : kind === "gateway"
              ? [gatewayAdminUrl, gatewayWan]
              : [sglangLan, sglangWan];
      return [0, 1].map((i) =>
        buildAuthEntry(urls[i], addrAuth[`${kind}:${i}`] || EMPTY_ADDR_AUTH),
      );
    },
    [
      matrixLan,
      matrixWan,
      controllerLan,
      controllerWan,
      gatewayAdminUrl,
      gatewayWan,
      sglangLan,
      sglangWan,
      addrAuth,
    ],
  );
  // v0.5.0-beta.12: Controller 认证双模式（Matrix 登录 L2 / 管理员 token L1）。
  const [ctlMode, setCtlMode] = React.useState<"matrix" | "token">("matrix");
  const [loginUser, setLoginUser] = React.useState("");
  const [loginPassword, setLoginPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loggingIn, setLoggingIn] = React.useState(false);
  // v0.5.0-beta.12: 连通性测试（手动触发；后台每 120s 自动重排，此处只看结果）
  const [connTest, setConnTest] = React.useState<ConfigTestResponse | null>(null);
  const [testing, setTesting] = React.useState(false);
  const importInputRef = React.useRef<HTMLInputElement | null>(null);
  // v0.5.0-beta.14.14（UIPERF-T23）：备份与恢复（含凭据完整配置）——导出=弹窗
  // 全文本（复制按钮）；导入=粘贴+确认（后端校验+先自动备份当前态+覆盖）。
  const [exportOpen, setExportOpen] = React.useState(false);
  const [exportText, setExportText] = React.useState("");
  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [importing, setImporting] = React.useState(false);

  const downloadJson = React.useCallback(
    (filename: string, data: unknown) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [],
  );

  const exportConfig = React.useCallback(async () => {
    try {
      const cfg = await requestJson("/agentteams-proxy/config");
      downloadJson("agentteams-qwenpaw-workbench-config.json", cfg);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("导出失败"));
    }
  }, [downloadJson]);

  const importConfig = React.useCallback(
    async (e: ReactNS.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 重置 input.value——同一文件可再次选择
      if (!file) return;
      try {
        const text = await file.text();
        const cfg = JSON.parse(text) as Record<string, unknown>;
        await requestJson("/agentteams-proxy/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: cfg }),
        });
        message.success(tr("配置已导入"));
        onConfigChange();
      } catch (err) {
        message.error(
          err instanceof Error ? err.message : tr("导入失败（JSON 格式错误？）"),
        );
      }
    },
    [onConfigChange],
  );

  // v0.5.0-beta.14.14（UIPERF-T23）：完整配置导出（含凭据）→ 弹窗全文本。
  const exportFull = React.useCallback(async () => {
    try {
      const cfg = await exportFullConfig();
      setExportText(JSON.stringify(cfg, null, 2));
      setExportOpen(true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("导出失败"));
    }
  }, [tr]);

  // 复制兜底：navigator.clipboard 不可用（宿主 webview 差异）→ execCommand。
  const copyText = React.useCallback(
    (text: string) => {
      const done = () => message.success(tr("已复制到剪贴板"));
      const fail = () => message.error(tr("复制失败——请手动全选复制"));
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, fail);
        return;
      }
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) done();
        else fail();
      } catch {
        fail();
      } finally {
        document.body.removeChild(ta);
      }
    },
    [tr],
  );

  // v0.5.0-beta.14.14（UIPERF-T23）：完整配置导入——粘贴 JSON → 后端校验 +
  // 自动备份当前配置 + 覆盖（失败 400 可读错误经 message 透出）。
  const doImportFull = React.useCallback(async () => {
    const text = importText.trim();
    if (!text) {
      message.warning(tr("请先粘贴配置 JSON"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      message.error(tr("导入失败（JSON 格式错误？）"));
      return;
    }
    setImporting(true);
    try {
      const res = await importFullConfig(parsed);
      message.success(
        res.restart === "none"
          ? tr("配置已导入（同步已自动重启）")
          : tr("配置已导入（建议刷新页面确认生效）"),
      );
      setImportOpen(false);
      setImportText("");
      onConfigChange();
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("导入失败"));
    } finally {
      setImporting(false);
    }
  }, [importText, tr, onConfigChange]);

  const exportDiagnostic = React.useCallback(async () => {
    try {
      const [cfg, selfcheck] = await Promise.all([
        requestJson("/agentteams-proxy/config"),
        requestJson("/agentteams-proxy/selfcheck/all", { method: "POST" }),
      ]);
      downloadJson("agentteams-qwenpaw-workbench-diagnostic.json", {
        exported_at: new Date().toISOString(),
        config: cfg,
        selfcheck,
        version:
          (window as unknown as Record<string, unknown>)
            .__AGENTTEAMS_WORKBENCH_VERSION__ || "unknown",
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("诊断包导出失败"));
    }
  }, [downloadJson]);

  // v0.5.0-beta.14.17（C1 凭据记忆重做）：回填 effect 冻结——首载（或换账号）
  // 后初始化一次，之后 config 引用变化（保存/验证/登录都触发 onConfigChange
  // → 主组件 re-GET → 新对象）不再重置表单草稿。此前用户未保存的凭据编辑
  // （如填了 Higress 密码、改了控制器 basic 密码）会被任意一次验证/保存
  // 引发的 config 刷新整体冲掉（装验反馈「输完 Higress 账号密码，控制器的
  // basic 认证又要重新输入」）。换账号=doLogin→onLoginSuccess 清数据+重挂载，
  // 新实例自然重新初始化；user_id 变化兜底（同实例热切账号场景）。
  const backfillKeyRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!config) return;
    const uid =
      ((config.matrix as { user_id?: string } | undefined)?.user_id as
        | string
        | undefined) || "";
    const key = uid || "__not-logged-in__";
    if (backfillKeyRef.current === key) return;
    backfillKeyRef.current = key;
    setMatrixLan(entryUrl(config.matrix_homeservers?.[0]));
    setMatrixWan(entryUrl(config.matrix_homeservers?.[1]));
    // v0.5.0-beta.14.3: 每地址凭据回填（v0.5.0-beta.14.17（C1）：脱敏 *** 不进
    // 输入框，存 stored 标记——空框=保持不变）。
    setAddrAuth({
      "matrix:0": entryToAuthDraft(config.matrix_homeservers?.[0]),
      "matrix:1": entryToAuthDraft(config.matrix_homeservers?.[1]),
      "controller:0": entryToAuthDraft(config.controller_urls?.[0]),
      "controller:1": entryToAuthDraft(config.controller_urls?.[1]),
      "sglang:0": entryToAuthDraft(config.sglang?.urls?.[0]),
      "sglang:1": entryToAuthDraft(config.sglang?.urls?.[1]),
      // v0.5.0-beta.14.17（C2）：Higress 双地址凭据（四地址族同构）。
      "gateway:0": entryToAuthDraft(config.gateway_admin_urls?.[0]),
      "gateway:1": entryToAuthDraft(config.gateway_admin_urls?.[1]),
    });
    // v0.5.0-beta.14.1: 地址模式回填（垃圾值后端已降级 auto）。
    setAddressMode(config.address_mode || "auto");
    setControllerLan(entryUrl(config.controller_urls?.[0]));
    setControllerWan(entryUrl(config.controller_urls?.[1]));
    // v0.5.0-beta.14.17（C1）：token 脱敏 *** 不进输入框（同密码协议：空框=
    // 保持不变；此前字面量回显 + 不清空直接输入 = 拼接串覆盖真 token）。
    setControllerToken(
      config.controller_token && config.controller_token !== "***"
        ? config.controller_token
        : "",
    );
    // v0.5.0-beta.12: admin 账号 / 网关地址回填；密码只标记「已配置」不回填。
    setAdminUsername(config.admin_username || "");
    // v0.5.0-beta.14.7: Higress 双地址（内/外网），legacy 单值回退内网框。
    setGatewayAdminUrl(
      entryUrl(config.gateway_admin_urls?.[0]) || config.gateway_admin_url || "",
    );
    setGatewayWan(entryUrl(config.gateway_admin_urls?.[1]));
    // v0.5.0-beta.14.12（UIPERF-T18 补完）：特效三档回填（旧 console_calm
    // bool 迁移：显式 false=full，其余=light）+ 门控属性同步（模块级已先写
    // light，此处以配置覆写；旧 data-wb-calm 已退役）。
    const _fxMode =
      config.console_effects ?? (config.console_calm === false ? "full" : "light");
    setFxMode(_fxMode);
    document.documentElement.dataset.wbFx = _fxMode;
    setAdminPassword("");
    setSglangEnabled(config.sglang?.enabled || false);
    // v0.5.0-beta.12: 双地址读取；旧配置单地址 url 回退（后端亦会迁移）。
    setSglangLan(entryUrl(config.sglang?.urls?.[0]) || config.sglang?.url || "");
    setSglangWan(entryUrl(config.sglang?.urls?.[1]) || "");
    // 已有 token（本地配置粘贴 / 宿主 env）的用户默认落在 L1 模式。
    if (
      config.controller_token ||
      config.controllerTokenSource === "env"
    )
      setCtlMode("token");
  }, [config]);

  const save = async () => {
    setSaving(true);
    try {
      await requestJson("/agentteams-proxy/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            // v0.5.0-beta.14.3: 条目 str | {url, auth?}（凭据随条目走）。
            matrix_homeservers: buildAddrEntries("matrix"),
            controller_urls: buildAddrEntries("controller"),
            // v0.5.0-beta.14.17（C1）：token 空=不覆盖已存（后端字段合并保留
            // 旧值；空串/脱敏 *** 都不落盘）——此前回显 *** 字面量+拼接=覆盖。
            controller_token: controllerToken || undefined,
            // v0.5.0-beta.14.1: 地址模式（auto/lan/wan）——保存后不重启即生效。
            address_mode: addressMode,
            // v0.5.0-beta.14.12（UIPERF-T18 补完）：特效三档直存。
            console_effects: fxMode,
            sglang: {
              enabled: sglangEnabled,
              urls: buildAddrEntries("sglang"),
            },
            // v0.5.0-beta.14.17（C2）：Higress 双地址（凭据随条目，四族同构）。
            gateway_admin_urls: buildAddrEntries("gateway"),
          },
        }),
      });
      message.success(tr("配置已保存（已自动探测生效地址）"));
      onConfigChange();
      // v0.5.0-beta.12: 保存后立即连通性测试——用户当场看到两条路径的延迟与状态。
      // v0.5.0-beta.14.3: 草稿凭据随测（未保存也能当场验证公网门）。
      // v0.5.0-beta.14.17（C2）：gateway=Higress 探测（诊断面）。
      void runConnTest(
        buildAddrEntries("matrix"),
        buildAddrEntries("controller"),
        buildAddrEntries("sglang"),
        buildAddrEntries("gateway"),
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("保存失败"));
    } finally {
      setSaving(false);
    }
  };

  // v0.5.0-beta.12: 连通性测试——测表单当前值（可未保存）；后端并行探测测延迟，
  // 列表与已配置一致时顺手按最快可达重排生效地址（applied）。
  // v0.5.0-beta.14.17（C2）：gateway=Higress 探测（可达性+会话三态，诊断面）。
  const runConnTest = React.useCallback(
    async (
      matrix?: AddressEntry[],
      controller?: AddressEntry[],
      sglang?: AddressEntry[],
      gateway?: AddressEntry[],
    ) => {
      setTesting(true);
      try {
        const res = await testAddresses(matrix, controller, sglang, gateway);
        setConnTest(res);
      } catch (e) {
        message.error(
          e instanceof Error ? e.message : tr("连通性测试失败"),
        );
      } finally {
        setTesting(false);
      }
    },
    [],
  );

  // v0.5.0-beta.12: L1 验证（Controller token / Higress 账号两块独立，验证通过才持久化凭据）。
  const runVerify = React.useCallback(
    async (body: {
      admin_username?: string;
      admin_password?: string;
      controller_token?: string;
      gateway_admin_url?: string;
      // v0.5.0-beta.14.7: Higress 双地址（列表优先；空框已过滤）。
      gateway_admin_urls?: string[];
    }) => {
      setVerifying(true);
      setVerifyRes(null);
      try {
        const res = await verifyAdmin(body);
        setVerifyRes(res);
        if (res.ok) {
          // token 模式带来源说明（config/env——env 不落盘，轮换=更新宿主 env）。
          message.success(
            res.mode === "token" && res.message
              ? tr("{msg}", { msg: res.message })
              : tr("验证通过（{mode}）", {
                  mode:
                    res.mode === "password"
                      ? tr("admin 账号密码（Higress Console 会话已持有）")
                      : tr("管理员 token"),
                }),
          );
          onConfigChange();
        }
      } catch (e) {
        setVerifyRes({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setVerifying(false);
      }
    },
    [onConfigChange, tr],
  );

  const doLogin = async () => {
    if (!loginUser || !loginPassword) {
      message.warning(tr("先填写 Matrix 账号和密码"));
      return;
    }
    setLoggingIn(true);
    try {
      await requestJson("/agentteams-proxy/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: loginUser, password: loginPassword }),
      });
      message.success(tr("登录成功"));
      onConfigChange();
      // v0.5.0-beta.12: 切账号 = 数据源切换。后端 /login 已同步清 60s 聚合缓存 +
      // 重置 sync 游标；前端本地旧账号的房间/树/管理数据必须清掉并重取，
      // 否则切完账号屏幕还挂着上一个账号的内容（用户反馈 真机反馈）。
      onLoginSuccess?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("登录失败"));
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 720 }}>
      {/* v0.5.0-beta.14.16（F1）：config 加载态横幅——加载中/失败必须显式。
          静默吞错会让用户把默认态当成已保存值（10/6「没有记忆」事故根因）。 */}
      {config === null && (
        <div
          style={{
            ...cardBox,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 13,
            color: configLoadState === "failed" ? "#d4380d" : t.textSecondary,
            border:
              configLoadState === "failed"
                ? "1px solid #ffccc7"
                : undefined,
          }}
        >
          {configLoadState === "failed" ? (
            <>
              <span>
                {tr(
                  "配置加载失败（插件后端可能正在重载）。页面上显示的是默认值，不是你的已保存配置——请勿直接保存，以免覆盖。",
                )}
              </span>
              <button
                type="button"
                onClick={onRetryConfig}
                style={{
                  border: "1px solid currentColor",
                  borderRadius: 6,
                  background: "transparent",
                  color: "inherit",
                  padding: "2px 12px",
                  cursor: "pointer",
                }}
              >
                {tr("重试")}
              </button>
            </>
          ) : (
            <span>{tr("正在加载已保存配置…")}</span>
          )}
        </div>
      )}
      {/* v0.5.0-beta.14.4（设置页 UI 整理）：分节卡片化——「聊天页面」卡片。 */}
      <div style={{ ...cardBox, fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
        {tr("内网和外网是同一服务器的两条访问路径（家里用内网 IP，外出用公网域名），无需手动切换——插件每 2 分钟自动重测全部地址（测延迟），自动切到最快可达的一条，外网/内网切换自动识别。")}
      </div>

      <div style={cardBox}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{tr("聊天页面")}</div>
      {/* 12.14：聊天分栏强制开关——宿主面板宽度判定为窄屏时的豁免。 */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <antd.Switch
          checked={Boolean(chatForceWide)}
          onChange={(v: boolean) => onChatForceWideChange?.(v)}
        />
        <div>
          <div style={{ fontWeight: 600 }}>{tr("聊天页面强制左右分栏")}</div>
          <div style={{ fontSize: 12, color: "#888" }}>
            {tr("忽略宽窄判定：房间列表与聊天框始终左右分栏、各自独立滚动。窄面板下可用拖动条调宽、⟨ 可收起列表。")}
          </div>
        </div>
      </div>
      </div>

      {/* v0.5.0-beta.14.4：「访问地址」卡片。 */}
      <div style={{ ...cardBox, display: "grid", gap: 16 }}>
        <div style={{ fontWeight: 700 }}>{tr("访问地址")}</div>
        {/* v0.5.0-beta.14.17（C1）：凭据记忆状态总览——每个系统凭据是否已保存
            一眼可见（装验反馈「每个账号密码的认证都要分开」的可视化收口）。 */}
        {config ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 6,
              fontSize: 12,
              padding: 8,
              borderRadius: 6,
              background: "rgba(128,128,128,0.06)",
            }}
          >
            {([
              [
                tr("Matrix 登录"),
                Boolean((config.matrix as { user_id?: string } | undefined)?.user_id),
              ],
              [
                tr("Controller token"),
                Boolean(config.controllerTokenSource && config.controllerTokenSource !== "invalid"),
              ],
              [
                tr("Controller 地址凭据"),
                (config.controller_urls || []).some((e) => typeof e === "object" && e !== null && (e as { auth?: unknown }).auth),
              ],
              [
                tr("Higress 账号（Console 会话）"),
                Boolean(config.admin_username) && Boolean(config.console_session),
              ],
              [
                tr("Higress 地址凭据"),
                (config.gateway_admin_urls || []).some((e) => typeof e === "object" && e !== null && (e as { auth?: unknown }).auth),
              ],
              [
                tr("SGLang 地址凭据"),
                ((config.sglang as { urls?: AddressEntry[] } | undefined)?.urls || []).some((e) => typeof e === "object" && e !== null && (e as { auth?: unknown }).auth),
              ],
            ] as [string, boolean][]).map(([label, on]) => (
              <span key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: on ? "#52c41a" : "#d9d9d9",
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: on ? t.text : t.textSecondary }}>{label}</span>
              </span>
            ))}
          </div>
        ) : null}
        {/* v0.5.0-beta.14.1 (S1-4)：事件流连接态——「断开自动重连」从黑箱变可见。 */}
        {sseState ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 6,
              background: sseState.status === "connected" ? "#f6ffed" : "#fffbe6",
              border: `1px solid ${sseState.status === "connected" ? "#b7eb8f" : "#ffe58f"}`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: sseState.status === "connected" ? "#52c41a" : "#faad14",
                flexShrink: 0,
              }}
            />
            {sseState.status === "connected"
              ? tr("事件流：已连接")
              : tr("事件流：已断开——自动重连中（上次断开 {time}）", {
                  time: new Date(sseState.since).toLocaleTimeString(),
                })}
          </div>
        ) : null}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Matrix 地址（必填至少一个）
            <EffectiveBadge url={config?.effective?.matrix} label={tr("当前")} />
          </div>
          <antd.Input
            placeholder={tr("内网：http://192.168.x.x:6867")}
            value={matrixLan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setMatrixLan(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          <AddrAuthEditor
            value={addrAuth["matrix:0"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("matrix:0", v)}
          />
          <antd.Input
            placeholder={tr("外网：https://你的域名:6867（可留空）")}
            value={matrixWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setMatrixWan(e.target.value)
            }
          />
          <AddrAuthEditor
            value={addrAuth["matrix:1"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("matrix:1", v)}
          />
        </div>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("Controller 地址（L1/CRD 管理/Worker/Team 状态依赖；不填仅房间侧功能）")}
            <EffectiveBadge url={config?.effective?.controller} label={tr("当前")} />
          </div>
          <antd.Input
            placeholder={tr("内网：http://192.168.x.x:8090（可留空）")}
            value={controllerLan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setControllerLan(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          <AddrAuthEditor
            value={addrAuth["controller:0"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("controller:0", v)}
          />
          <antd.Input
            placeholder={tr("外网：https://你的域名:8090（可留空）")}
            value={controllerWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setControllerWan(e.target.value)
            }
          />
          <AddrAuthEditor
            value={addrAuth["controller:1"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("controller:1", v)}
          />
        </div>

        {/* v0.5.0-beta.14.7（UIPERF-P3）：Higress 地址并入地址配置区（与
            Matrix/Controller/SGLang 同处），内网/外网按序降级、受地址模式
            固定档控制。
            v0.5.0-beta.14.16（F3）：Higress=模型管理面=L1 专属 → L2 模式
            隐藏（10/6 用户装验反馈「如果是 L2 登录，该隐藏的就隐藏」）。 */}
        {ctlMode === "token" && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("Higress Console 地址（模型管理面；内网/外网按序降级）")}
            <EffectiveBadge url={config?.effective?.gateway} label={tr("当前")} />
          </div>
          <antd.Input
            placeholder={tr("Higress 地址·内网（Console 管理面；宿主端口部署时自选，默认 18001）")}
            value={gatewayAdminUrl}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setGatewayAdminUrl(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          {/* v0.5.0-beta.14.17（C2）：Higress 内网地址覆盖凭据（四族同构；
              公网入口挂 Basic/key 门时用）。 */}
          <AddrAuthEditor
            value={addrAuth["gateway:0"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("gateway:0", v)}
          />
          <antd.Input
            placeholder={tr("Higress 地址·外网（公网入口，可留空；内网不可达时自动降级）")}
            value={gatewayWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setGatewayWan(e.target.value)
            }
            style={{ marginBottom: 8 }}
          />
          <AddrAuthEditor
            value={addrAuth["gateway:1"] || EMPTY_ADDR_AUTH}
            onChange={(v) => setAddrAuthFor("gateway:1", v)}
          />
        </div>
        )}

        {/* v0.5.0-beta.14.1: 地址手动固定档——固定档请求只用固定地址、失败
            诚实报错不静默 failover；探测循环照跑（显示层不受影响）。 */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("地址模式（内网/外网切换策略）")}
          </div>
          <antd.Select
            value={addressMode}
            onChange={(v: "auto" | "lan" | "wan") => {
              setAddressMode(v);
              // v0.5.0-beta.14.11（装验反馈）：模式变更即落盘——修复「改了但
              // 未点保存 → 重开跳回自动」。轻量 PUT，仅 address_mode 一键。
              void (async () => {
                try {
                  await requestJson("/agentteams-proxy/config", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ config: { address_mode: v } }),
                  });
                  message.success(tr("地址模式已保存并即时生效"));
                  onConfigChange();
                } catch {
                  message.error(tr("地址模式保存失败，请重试"));
                }
              })();
            }}
            style={{ width: "100%" }}
            options={[
              { value: "auto", label: tr("自动（默认：最快可达自动切换）") },
              { value: "lan", label: tr("固定内网（失败不自动切换）") },
              { value: "wan", label: tr("固定外网（失败不自动切换）") },
            ]}
          />
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            {tr("切换即自动保存并生效。固定档下后台探测照跑（连通性测试仍可见另一条路径状态），但请求不再自动切换；失败会明确报错。")}
          </div>
        </div>

        {/* v0.5.0-beta.14.12（UIPERF-T18）：控制台特效三档（light 默认；取代
            旧 console_calm 开关）。light=动画保留+模糊半径封顶（观感保留、
            成本降一个量级）；off=最省电（动画与模糊全停）；full=上游原样。 */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("控制台特效质量")}
          </div>
          <antd.Select
            value={fxMode}
            onChange={(v: "light" | "off" | "full") => {
              setFxMode(v);
              document.documentElement.dataset.wbFx = v;
              // 与地址模式同款：变更即落盘（轻量 PUT）。
              void (async () => {
                try {
                  await requestJson("/agentteams-proxy/config", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ config: { console_effects: v } }),
                  });
                  message.success(tr("特效档已保存并即时生效"));
                  onConfigChange();
                } catch {
                  message.error(tr("特效档保存失败，请重试"));
                }
              })();
            }}
            style={{ width: "100%" }}
            options={[
              { value: "light", label: tr("轻量（默认：动画保留，模糊半径封顶，省 GPU）") },
              { value: "off", label: tr("关闭特效（最省电：动画与模糊全停）") },
              { value: "full", label: tr("完整特效（上游原样，最费 GPU）") },
            ]}
          />
        </div>

        {/* v0.5.0-beta.12: 连通性测试——逐地址测延迟，外/内网识别可视化。
            测表单当前值（可未保存）；保存成功后自动跑一次。 */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <antd.Button
              size="small"
              loading={testing}
              onClick={() =>
                void runConnTest(
                  buildAddrEntries("matrix"),
                  buildAddrEntries("controller"),
                  sglangEnabled ? buildAddrEntries("sglang") : [],
                  // v0.5.0-beta.14.17（C2）：Higress 双地址（内网框非空才测）。
                  gatewayAdminUrl.trim() || gatewayWan.trim()
                    ? buildAddrEntries("gateway")
                    : [],
                )
              }
            >
              <SearchIcon size={14} style={{ verticalAlign: "-2px" }} /> {tr("连通性测试")}
            </antd.Button>
            <span style={{ fontSize: 12, color: "#888" }}>
              {tr("逐个地址测延迟（失败重试一次），识别外网/内网，测完自动切到最快；后台按状态自适应重测（稳定时低频、单地址不探测）")}
            </span>
          </div>
          {connTest ? (
            <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
              {connTest.matrix.map((r) => (
                <ConnRow
                  key={`m-${r.url}`}
                  row={r}
                  tag="Matrix"
                  // v0.5.0-beta.14.1: 固定档——固定地址即使另一条更快也显示生效。
                  active={
                    connTest.effective.matrix === r.url ||
                    connTest.pinned?.matrix === r.url
                  }
                  pinned={connTest.pinned?.matrix === r.url}
                />
              ))}
              {connTest.controller.map((r) => (
                <ConnRow
                  key={`c-${r.url}`}
                  row={r}
                  tag="Controller"
                  active={
                    connTest.effective.controller === r.url ||
                    connTest.pinned?.controller === r.url
                  }
                  pinned={connTest.pinned?.controller === r.url}
                />
              ))}
              {connTest.sglang
                ? connTest.sglang.map((r) => (
                    <ConnRow
                      key={`s-${r.url}`}
                      row={r}
                      tag="SGLang"
                      active={false}
                      pinned={connTest.pinned?.sglang === r.url}
                    />
                  ))
                : null}
              {/* v0.5.0-beta.14.17（C2）：Higress 探测行（诊断面；含会话三态）。 */}
              {connTest.gateway?.length
                ? connTest.gateway.map((r) => (
                    <ConnRow
                      key={`g-${r.url}`}
                      row={r}
                      tag="Higress"
                      active={false}
                      pinned={connTest.pinned?.gateway === r.url}
                      showDetail
                    />
                  ))
                : null}
            </div>
          ) : null}
          {/* v0.5.0-beta.12：测完自动切换要可见——横幅说清切没切、切到哪 */}
          {connTest ? (
            <div
              style={{
                marginTop: 8,
                fontSize: 12,
                padding: "6px 10px",
                borderRadius: 6,
                background: connTest.applied
                  ? connTest.switched?.matrix || connTest.switched?.controller
                    ? "rgba(255,127,22,0.08)"
                    : "rgba(82,196,26,0.08)"
                  : "rgba(128,128,128,0.08)",
              }}
            >
              {connTest.applied ? (
                connTest.switched?.matrix || connTest.switched?.controller ? (
                  <>
                    <RefreshIcon size={13} style={{ verticalAlign: "-2px" }} /> {tr("已自动切换到最快可达")}：
                    {[
                      connTest.switched?.matrix
                        ? `Matrix → ${connTest.effective.matrix}`
                        : null,
                      connTest.switched?.controller
                        ? `Controller → ${connTest.effective.controller}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join("；")}
                  </>
                ) : (
                  <>
                    <CheckIcon size={13} style={{ color: "#52c41a", verticalAlign: "-2px" }} /> {tr("当前生效地址已是最快，无变化")}
                  </>
                )
              ) : (
                <>
                  {tr("测的是未保存的地址——保存后自动按延迟切换生效")}
                </>
              )}
            </div>
          ) : null}
        </div>

      </div>

      {/* v0.5.0-beta.14.4：「认证」卡片（Controller 认证 + 启动偏好）。 */}
      <div style={{ ...cardBox, display: "grid", gap: 16 }}>
        <div style={{ fontWeight: 700 }}>{tr("认证与登录")}</div>
        {/* v0.5.0-beta.12: Controller 认证双模式（用户需求）——「用 admin 的 matrix
            账号登录」或「输入 Controller 管理员 token」。无 API 可取 admin
            token（上游安全设计）；L2 需 Human level=2，level-1 走 Matrix
            登录会被 Controller 401（权限自检有对应提示）。 */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("Controller 认证（可选）")}
          </div>
          <antd.Segmented
            size="small"
            style={{ marginBottom: 8 }}
            value={ctlMode}
            onChange={(v: string | number) => {
              const m = v as "matrix" | "token";
              setCtlMode(m);
              if (m === "matrix" && controllerToken) setControllerToken("");
            }}
            options={[
              { label: tr("Matrix 登录（L2，默认）"), value: "matrix" },
              { label: tr("L1 管理面（token / Higress）"), value: "token" },
            ]}
          />
          {ctlMode === "token" ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 12, color: "#888" }}>
                {tr("两块凭据互相独立、各管一个系统（不是二选一）：")}
                <div>
                  {tr("① Controller 管理员 token——Controller 管理 API 的唯一凭证（CRD 管理/全量视图）。Controller 只认 SA token 与 Matrix token：Matrix 路径只放行 level-2/3（只读），level-1（admin）明确 401，且无任何密码登录端点——dashboard 能「admin 账密进门」同样是部署期把该 token 注入服务端 env，浏览器用户从不输入它。")}
                </div>
                <div>
                  {tr("② Higress 账号+密码——Higress Console 的账号（模型 alias 面，独立系统）。它恰好与 Matrix @admin 同源（部署时同一对账密注册两处），但不是 Controller 凭证、也不改变 Controller 权限。")}
                </div>
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {tr("① Controller 管理员 token")}
                </div>
                {/* v0.5.0-beta.12（用户反馈：「controller token 的文件路径可以
                    删掉了，留个命令就行」）：文件路径字段删除，留获取命令。 */}
                <div style={{ fontSize: 11, color: "#888", lineHeight: 1.6 }}>
                  {tr("获取命令（在 Controller 宿主机执行，复制输出粘贴到下方）：")}
                  <code
                    style={{
                      display: "block",
                      padding: "3px 6px",
                      background: "#f5f5f5",
                      borderRadius: 4,
                      fontSize: 11,
                      userSelect: "all",
                    }}
                  >
                    docker exec agentteams-controller cat /var/run/agentteams/cli-token
                  </code>
                  {tr("非 docker 部署：部署期给 QwenPaw 进程注入环境变量 AGENTTEAMS_CONTROLLER_TOKEN（注入值优先于粘贴值需重贴才覆盖）。")}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <antd.Input.Password
                    placeholder={tr("粘贴 token 内容（见上方获取命令；部署期注入 env 时留空即可）")}
                    value={controllerToken}
                    onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                      setControllerToken(e.target.value)
                    }
                    style={{ flex: 1 }}
                  />
                  <antd.Button
                    size="small"
                    loading={verifying}
                    /* env 可用时留空也可验证（后端按 粘贴>env 解析）。 */
                    disabled={
                      !controllerToken.trim() &&
                      config?.controllerTokenSource !== "env"
                    }
                    onClick={() =>
                      void runVerify({
                        controller_token: controllerToken.trim() || undefined,
                      })
                    }
                  >
                    {tr("验证")}
                  </antd.Button>
                </div>
                {/* token 来源状态提示（值永不离开连接器进程，只见来源标记）。 */}
                {config?.controllerTokenSource === "env" ? (
                  <div style={{ fontSize: 12, color: "#389e0d" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><CheckIcon size={13} /> {tr("当前使用 QwenPaw 宿主环境变量 AGENTTEAMS_CONTROLLER_TOKEN（手动粘贴的值优先。）")}</span>
                  </div>
                ) : config?.controllerTokenSource === "invalid" ? (
                  <div style={{ fontSize: 12, color: "#cf1322" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><WarnIcon size={13} /> {tr("token 内容含非法字符（复制时混入不可见字符）——重新复制纯 ASCII 内容，或改用 env 注入。")}</span>
                  </div>
                ) : null}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {tr("② Higress Console 会话（模型面）——admin 账号+密码")}
                </div>
                <antd.Input
                  placeholder={tr("admin 账号（如 admin）")}
                  value={adminUsername}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setAdminUsername(e.target.value)
                  }
                />
                <antd.Input.Password
                  placeholder={tr("admin 密码（留空=保持现有）")}
                  value={adminPassword}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setAdminPassword(e.target.value)
                  }
                />
                <div>
                  <antd.Button
                    size="small"
                    loading={verifying}
                    disabled={
                      !adminUsername.trim() && !adminPassword.trim()
                    }
                    onClick={() =>
                      void runVerify({
                        admin_username: adminUsername.trim(),
                        admin_password: adminPassword.trim() || undefined,
                        // v0.5.0-beta.14.7: 双地址（内/外网；空框过滤）。
                        gateway_admin_urls: [
                          gatewayAdminUrl.trim(),
                          gatewayWan.trim(),
                        ].filter(Boolean),
                      })
                    }
                  >
                    {tr("验证")}
                  </antd.Button>
                  <span style={{ fontSize: 11.5, color: "#888", marginLeft: 8 }}>
                    {tr("验证通过后自动保存（仅建立 Higress Console 会话；与 Controller token 无关，两者可同时配置）")}
                  </span>
                </div>
              </div>
              {verifyRes && !verifyRes.ok ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "#cf1322",
                    background: "rgba(245,34,45,0.08)",
                    padding: "6px 10px",
                    borderRadius: 6,
                  }}
                >
                  {tr("验证失败：{err}", { err: verifyRes.error || "" })}
                </div>
              ) : null}
              {/* v0.5.0-beta.12：验证成功常驻回报——alias 层自检
                  （用户反馈实报「还是看不见」= 静默平铺无锚点；验证即诊断，
                  0 alias 时直接列出路由数与原因方向，不用再猜）。 */}
              {verifyRes && verifyRes.ok && verifyRes.gateway_routes !== undefined ? (
                <div
                  style={{
                    fontSize: 12,
                    color:
                      verifyRes.gateway_aliases && verifyRes.gateway_aliases.length > 0
                        ? "#389e0d"
                        : "#d46b08",
                    background:
                      verifyRes.gateway_aliases && verifyRes.gateway_aliases.length > 0
                        ? "rgba(82,196,26,0.08)"
                        : "rgba(250,173,20,0.1)",
                    padding: "6px 10px",
                    borderRadius: 6,
                    display: "grid",
                    gap: 4,
                  }}
                >
                  {verifyRes.gateway_aliases && verifyRes.gateway_aliases.length > 0 ? (
                    <span>
                      {tr("Higress alias 自检：{n} 条路由 / {m} 个可解析 alias（模型下拉可见）", {
                        n: String(verifyRes.gateway_routes),
                        m: String(verifyRes.gateway_aliases.length),
                      })}
                      <span style={{ color: "#888" }}>
                        {" — " + verifyRes.gateway_aliases.join("、")}
                      </span>
                    </span>
                  ) : (
                    <span>
                      {tr("Higress alias 自检：{n} 条路由 / 0 个可解析 alias——精确匹配（EXACT/EQUAL）且 provider 存在的路由才会进模型下拉；若路由已配仍为 0，检查模型匹配规则是否为「精确匹配」", {
                        n: String(verifyRes.gateway_routes),
                      })}
                    </span>
                  )}
                </div>
              ) : null}
              {/* v0.5.0-beta.13.10（F8：L1 路径 A 成功后明示「还需 Controller
                  token」）——路径 A（账号+密码）只建立 Higress Console 会话
                  （模型下拉 alias 面）；Worker 运行配置 L1 字段 / CRD 管理
                  需要 Controller 管理员 token（另一套凭证，无签发端点）。
                  密码验证通过且 token 未配 → 常驻指引（取法命令 + 回贴入口）。 */}
              {verifyRes &&
              verifyRes.ok &&
              verifyRes.mode === "password" &&
              !(
                config?.controller_token ||
                config?.controllerTokenSource === "env"
              ) ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "#d46b08",
                    background: "rgba(250,173,20,0.1)",
                    padding: "6px 10px",
                    borderRadius: 6,
                    display: "grid",
                    gap: 4,
                    marginTop: 6,
                  }}
                >
                  <span>
                    {tr("L1 账号/密码验证通过 = 已持有网关 Console 会话（模型下拉的 alias 可用）。但 Worker 运行配置的 L1 字段（并发限流/上下文管理/shell 组等）与 CRD 管理还需要 Controller 管理员 token——另一套凭证，密码不替代 token。")}
                  </span>
                  <span>
                    {tr("获取（在部署宿主机执行后复制，粘进上方 ① 字段）：")}
                    <code
                      style={{
                        background: "rgba(0,0,0,0.06)",
                        borderRadius: 4,
                        padding: "1px 5px",
                        fontSize: 11.5,
                        overflowWrap: "anywhere",
                      }}
                    >
                      docker exec agentteams-controller cat /var/run/agentteams/cli-token
                    </code>
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <div
              style={{
                fontSize: 12,
                color: "#888",
                marginBottom: 6,
                background: "rgba(0,0,0,0.03)",
                padding: "6px 10px",
                borderRadius: 6,
              }}
            >
              {tr("使用当前登录的 Matrix 账号，无需 token。注意：Controller 的 Matrix 认证只接受权限等级 2（level 2）的 Human 账号——level 1 的 admin 账号会 401，请改用管理员 token 模式，或让部署管理员把该 Human 改为 level 2（权限自检可见当前账号等级）。")}
            </div>
          )}
          <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
            {tr("Matrix 登录（L2）：查看本账号可访问的团队 + 项目操作（启动/暂停/产物），日常够用。L1 两块独立配置：① Controller 管理员 token——CRD 管理（入职/建队/改配/删除）+ 全部 Worker/Team 状态视图（Controller 唯一凭证，无接口获取——上游安全设计，部署管理员提供，粘贴一次永久记住）；② Higress 账号+密码——另建 Higress Console 会话（模型下拉 alias 层），与 ① 互不替代、可同时配置。")}
          </div>
        </div>
        <StartupPrefRow />
      </div>

      {/* v0.5.0-beta.14.4：「集群负载」独立卡片。
          v0.5.0-beta.14.16（F3）：部署者专属模块（L2 用户无 SGLang 集群）
          → L2 模式隐藏（10/6 用户装验反馈「该隐藏的就隐藏」；切 L1 模式仍可配置，
          值已持久化不丢）。 */}
      {ctlMode === "token" && (
      <div style={{ ...cardBox, display: "grid", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {tr("集群负载（可选模块）")}
            <span style={{ fontWeight: 400, color: t.textSecondary, marginLeft: 8, fontSize: 12 }}>
              {tr("L1 专属——只有部署了本地 SGLang 推理集群才需要开启")}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <antd.Switch
              checked={sglangEnabled}
              onChange={setSglangEnabled}
              checkedChildren="开启"
              unCheckedChildren="关闭"
            />
          </div>
          {/* v0.5.0-beta.12: SGLang 双地址（内网/外网）——与 Matrix/Controller 同款：
              两条路径同一集群，后台自动测延迟切最快，无需手动切换。 */}
          <div style={{ display: "grid", gap: 8 }}>
            <antd.Input
              placeholder={tr("内网：http://192.168.x.x:30000")}
              value={sglangLan}
              disabled={!sglangEnabled}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setSglangLan(e.target.value)
              }
            />
            <AddrAuthEditor
              value={addrAuth["sglang:0"] || EMPTY_ADDR_AUTH}
              onChange={(v) => setAddrAuthFor("sglang:0", v)}
              disabled={!sglangEnabled}
            />
            <antd.Input
              placeholder={tr("外网：https://你的域名:30000（可留空）")}
              value={sglangWan}
              disabled={!sglangEnabled}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setSglangWan(e.target.value)
              }
            />
            <AddrAuthEditor
              value={addrAuth["sglang:1"] || EMPTY_ADDR_AUTH}
              onChange={(v) => setAddrAuthFor("sglang:1", v)}
              disabled={!sglangEnabled}
            />
          </div>
          <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
            {tr("开启后首页/运维页显示各 DP rank 的排队/运行/显存负载（SGLang /v1/loads）。内网/外网是同一集群的两条访问路径，插件自动探测最快可达的一条。没有本地部署模型的用户保持关闭——零痕迹。")}
          </div>
        </div>
      </div>
      )}

      <div>
        <antd.Button
          type="primary"
          loading={saving}
          // v0.5.0-beta.14.16（F1）：config 未就绪时禁用保存——默认态保存
          // 会用 UI 空值覆盖已保存的地址/模式（10/6「没有记忆」事故放大点）。
          disabled={config === null}
          onClick={() => void save()}
        >
          {tr("保存配置")}
        </antd.Button>
      </div>

      {/* v0.5.0-beta.14.4：「配置迁移与诊断」卡片。 */}
      <div style={{ ...cardBox, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{tr("配置迁移与诊断")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Button
            icon={<DownloadIcon />}
            onClick={() => void exportConfig()}
          >
            {tr("导出配置（脱敏）")}
          </antd.Button>
          <antd.Button
            icon={<UploadIcon />}
            onClick={() => importInputRef.current?.click()}
          >
            {tr("导入配置")}
          </antd.Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => void importConfig(e)}
          />
          <antd.Button
            icon={<FileZipOutlined />}
            onClick={() => void exportDiagnostic()}
          >
            {tr("导出诊断包")}
          </antd.Button>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
          {tr("导出配置含全部地址但不含密码/token（显示为 ***）——导入不会覆盖现有凭据。诊断包 = 脱敏配置 + 自检结果，用于排查问题时交给管理员。")}
        </div>
      </div>

      {/* v0.5.0-beta.14.14（UIPERF-T23）：「备份与恢复」卡片——含凭据完整
          配置（用户自己还原用；与上方脱敏导出/导入=交管理员排查 区分）。 */}
      <div style={{ ...cardBox, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{tr("备份与恢复")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Button
            icon={<DownloadIcon />}
            onClick={() => void exportFull()}
          >
            {tr("导出配置（含凭据）")}
          </antd.Button>
          <antd.Button
            icon={<UploadIcon />}
            onClick={() => setImportOpen(true)}
          >
            {tr("导入配置（含凭据）")}
          </antd.Button>
        </div>
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.7 }}>
          {tr("导出含密码/token 的完整配置 JSON，存到安全位置；换环境/重装插件后粘贴回来导入即快速还原，不必重填。导入前会先自动备份当前配置。注意：此导出含明文凭据，勿粘贴到公开渠道。")}
        </div>
      </div>

      <antd.Modal
        title={tr("导出配置（含凭据）")}
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        width={720}
        footer={[
          <antd.Button
            key="copy"
            type="primary"
            icon={<CopyIcon />}
            onClick={() => copyText(exportText)}
          >
            {tr("复制")}
          </antd.Button>,
          <antd.Button key="close" onClick={() => setExportOpen(false)}>
            {tr("关闭")}
          </antd.Button>,
        ]}
      >
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 8 }}>
          {tr("以下为含明文凭据的完整配置——请只保存到可信位置。")}
        </div>
        <antd.Input.TextArea
          value={exportText}
          readOnly
          autoSize={{ minRows: 10, maxRows: 24 }}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </antd.Modal>
      <antd.Modal
        title={tr("导入配置（含凭据）")}
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => void doImportFull()}
        confirmLoading={importing}
        okText={tr("导入")}
        cancelText={tr("取消")}
        width={720}
      >
        <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 8 }}>
          {tr("粘贴「导出配置（含凭据）」得到的 JSON 全文。导入会校验并先自动备份当前配置，再覆盖。")}
        </div>
        <antd.Input.TextArea
          value={importText}
          onChange={(e: ReactNS.ChangeEvent<HTMLTextAreaElement>) =>
            setImportText(e.target.value)
          }
          autoSize={{ minRows: 10, maxRows: 24 }}
          placeholder={`{\n  "matrix_homeservers": []\n}`}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </antd.Modal>

      {/* v0.5.0-beta.14.4：「Matrix 登录」卡片。 */}
      <div style={{ ...cardBox, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>
          {tr("Matrix 登录")}
          {config?.matrix?.user_id ? (
            <span style={{ fontWeight: 400, color: "#888", marginLeft: 8 }}>
              {tr("当前身份：")} {config.matrix.user_id}
            </span>
          ) : null}
        </div>
        <antd.Input
          placeholder={tr("Matrix 账号（不含 @ 和域名）")}
          value={loginUser}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setLoginUser(e.target.value)
          }
        />
        <antd.Input.Password
          placeholder={tr("Matrix 密码")}
          value={loginPassword}
          onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
            setLoginPassword(e.target.value)
          }
        />
        <div>
          <antd.Button
            type="primary"
            loading={loggingIn}
            onClick={() => void doLogin()}
          >
            {tr("登录")}
          </antd.Button>
        </div>
      </div>
      {/* v0.5.0-beta.14.16（F2）：宿主 Agent 技能管理区块移除（10/6 用户装验反馈：
          「配置页的 QwenPaw 宿主 Agent 技能不需要了」）——SkillsTab 组件
          已删（死代码零残留）；宿主技能系统本体是 QwenPaw 核心功能，
          不受影响（SkillCenter 团队技能池保留）。 */}
    </div>
  );
});

export default SettingsTab;
