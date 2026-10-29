import type * as ReactNS from "react";

import type { AddressEntry, AddressTestResult, ProbeDiag } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { CheckIcon, CloseIcon, HomeIcon, MonitorIcon, WarnIcon } from "./icons";
import HelpDot from "./HelpDot";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export function EffectiveBadge({ url, label }: { url?: string; label: string }) {
  if (!url) return null;

  return (
    <span
      // 15.14：长 URL 会撑破窄容器（320/340 实盘实证横溢）——
      // inline-block + max-width 100% 钳制，URL 内 break-all 断行。
      style={{
        display: "inline-block",
        maxWidth: "100%",
        fontSize: 12,
        color: "#52c41a",
        background: "rgba(82,196,26,0.1)",
        padding: "2px 8px",
        borderRadius: 6,
        marginLeft: 8,
        marginTop: 4,
        verticalAlign: "top",
        wordBreak: "break-all",
        lineHeight: 1.5,
      }}
    >
      {label}生效：{url}
    </span>
  );
}

/** 连通性测试结构化诊断展开区——外网 DPI 定位锚点。
 分步过程（✓/✗+ms）/ 完整原始异常（等宽全栈）/ 客户端环境（TLS 栈指纹，等宽）。 */
function ConnDiagPanel({ diag }: { diag: ProbeDiag }) {
  const tr = useT();
  const t = useThemeColors(); 
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
        background: t.toolBg,
        border: `1px solid ${t.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={mono}>
        <b>{tr("测试目标")}</b>：{diag.target}
      </div>
      <div style={{ ...mono, color: t.text }}>
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
      <div style={{ ...mono, color: t.text }}>
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

/** 连通性测试单行——✅ 延迟 / ❌ 错误原因，生效地址带「生效中」标。
 三态——✅ 连通可用（绿）/ ⚠️ 已连通但需鉴权或异常状态（橙）/ ❌ 网络层失败（红）。
 点击展开结构化诊断（分步+全栈 traceback+客户端环境）；折叠态=现状一句话摘要。 */
export function ConnRow({
  row,
  tag,
  active,
  pinned,
  // Higress 会话三态在 detail 里——ok 时也强制显示
  // detail（而非仅 ms）。
  showDetail,
}: {
  row: AddressTestResult;
  tag: string;
  active: boolean;
  // 固定档——该地址被 address_mode 钉住（与 active 徽标并行显示）。
  pinned?: boolean;
  showDetail?: boolean;
}) {
  const tr = useT();
  const t = useThemeColors(); 
  const [open, setOpen] = React.useState(false);
  const degraded = row.ok && row.http_ok === false;
  const color = !row.ok ? "#cf1322" : degraded ? (t.mode === "dark" ? "#faad14" : "#d48806") : "#52c41a";
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
          background: active ? "color-mix(in srgb, var(--app-accent, #FF7F16) 6%, transparent)" : "transparent",
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
          // （症状：Higress 503 时橙色 detail 过长撑破行）：
          // 长诊断文案可收缩+省略号，全文走 hover title。
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
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

// 启动页偏好：开关存 localStorage，默认"上次打开的页面"。
const STARTUP_PREF_KEY = "agentteams-qwenpaw-workbench:startup-pref";
export function readStartupPref(): "last" | "home" {
  try {
    const raw = window.localStorage.getItem(STARTUP_PREF_KEY);
    return raw === "home" ? "home" : "last";
  } catch {
    return "last";
  }
}
/** 启动页偏好行：上次打开的页面（默认）/ 首页。 */

export function StartupPrefRow() {
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

// ── 地址覆盖凭据（公网网关 Basic 门 / API key 门）──
// 编辑草稿（每地址一份；提交时 buildAuthEntry 组装条目，无凭据=纯 URL 串）。
// stored=「该类型原有已保存凭据」。
// 输入框协议：秘密字段**永不预填脱敏字面量**（*** 回显进框 = 用户不清空直接
// 输入 → 拼接串覆盖真凭据；状态也不透明）。空框 = 保持不变，提交时按 stored
// 语义发 *** 占位（后端 merge 继承旧值）；显式清除=把类型切回「服务自身认证」。
export type AddrAuthDraft = {
  type: "none" | "basic" | "bearer";
  username: string;
  password: string;
  token: string;
  stored: boolean;
};
export const EMPTY_ADDR_AUTH: AddrAuthDraft = {
  type: "none",
  username: "",
  password: "",
  token: "",
  stored: false,
};
/** 地址条目（string | {url, auth?}）→ 编辑草稿（字符串/无效 = none）。
 * 脱敏值 *** 不进输入框（存 stored 标记）。 */
export function entryToAuthDraft(e: AddressEntry | undefined | null): AddrAuthDraft {
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
 * 秘密字段空 = 保持不变（stored → 发 *** 占位让后端
 * 继承；非 stored 且字段不全 = 降级纯 URL，诚实不装）。显式清除=类型切 none
 * （=纯 URL 条目，后端按显式清除处理）——旧「选了类型但密码空=纯 URL」会把
 * 已保存凭据误清除，已废。 */
export function buildAuthEntry(url: string, d: AddrAuthDraft): AddressEntry {
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

// 15.36 D：认证类型说明（label 精简后完整语义进 ? tooltip；
// 原选项文案逐字保留为 tooltip 文字，creds.ts 对应键继续登记）。
const AUTH_MODE_HELP: Record<AddrAuthDraft["type"], string> = {
  none: "使用服务自身认证（内网默认，留空即用；选此项=清除该地址已存凭据）",
  basic: "Basic 认证（公网网关 Basic 门，如 Caddy）",
  bearer: "API Key（Bearer，公网网关 API key 门，如 Higress）",
};

/** 地址行下方的公网凭据编辑（紧凑：选择器一行；选了才展开输入行）。 */
export function AddrAuthEditor({
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
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <antd.Select
          size="small"
          value={value.type}
          disabled={disabled}
          // 换类型=新类型无已存凭据（stored 清零，
          // 防把 A 类型的 stored 标记误带到 B 类型触发 *** 继承）。
          onChange={(t: "none" | "basic" | "bearer") =>
            onChange({ ...value, type: t, stored: false })
          }
          // 15.14：固定 300px → 流体（容器内全宽，上限 420 防宽屏拉太长）。
          // 15.36 D：label 精简（完整说明进右侧 ? tooltip）。
          style={{ flex: 1, minWidth: 0, maxWidth: 420 }}
          options={[
            { value: "none", label: tr("服务自身认证") },
            { value: "basic", label: tr("Basic 认证") },
            { value: "bearer", label: tr("API Key（Bearer）") },
          ]}
        />
        <HelpDot title={tr(AUTH_MODE_HELP[value.type])} />
      </div>
      {value.type === "basic" ? (
        // 15.14：固定 150/180 → 等宽流体（各 flex:1，窄容器同宽不挤破）。
        <div style={{ display: "flex", gap: 6, marginTop: 4, maxWidth: 420 }}>
          <antd.Input
            size="small"
            placeholder={tr("用户名（与网关一致）")}
            value={value.username}
            disabled={disabled}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              onChange({ ...value, username: e.target.value })
            }
            style={{ flex: 1, minWidth: 0 }}
          />
          {/* 已存密码不回显字面量——空框+占位提示
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
            style={{ flex: 1, minWidth: 0 }}
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
          // 15.14：固定 330px → 流体（同认证类型选择器，上限 420）。
          style={{ marginTop: 4, width: "100%", maxWidth: 420 }}
        />
      ) : null}
    </div>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
