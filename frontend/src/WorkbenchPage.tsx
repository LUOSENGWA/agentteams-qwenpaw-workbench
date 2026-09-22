import type * as ReactNS from "react";

const PRIMARY = "#FF7F16"; // 品牌主色

import {
  fetchAdminData,
  fetchRoomMessages,
  enrichWorkflowRoomNames,
  fetchTeamsStructure,
  fetchRoomPowerInfo,
  fetchTeamsSync,
  renameRoom,
  fetchWorkflowEvents,
  fetchWorkflowProjects,
  fetchWorkerSpawns,
  getCachedMessages,
  getCachedRooms,
  markAllRoomsRead,
  markRoomRead,
  openDm,
  redactRoomMessage,
  requestJson,
  leaveRoom,
  sendRoomMessage,
  sendApprovalCommand,
  sendRoomMessageEdit,
  sendRoomFile,
  sendReaction,
  setRoomMuted,
  testAddresses,
  uploadMedia,
  setCachedMessages,
  setCachedRooms,
  verifyAdmin,
  type AdminData,
  type VerifyAdminResult,
  type AddressTestResult,
  type ConfigTestResponse,
  type L3RoomResult,
  type ProbeDiag,
  type RoomMessage,
  type SelfCheckResult,
  type TeamRoom,
  type InviteRoom,
  type WorkbenchConfig,
  type WorkerTreeTeam,
  type WorkflowEvent,
} from "./api";
import RoomChat from "./components/RoomChat";

import TeamOverview from "./components/TeamOverview";
import LOGO_URL from "./lib/logo";
import HomePage from "./components/HomePage";
import WorkflowBoard, { WfView } from "./components/WorkflowBoard";
import Artifacts from "./components/Artifacts";
import OpsPanel from "./components/OpsPanel";
import MessageSearch from "./components/MessageSearch";
import ProjectFiles from "./components/ProjectFiles";
import NotificationCenter from "./components/NotificationCenter";
import { useThemeColors } from "./theme";
import { useT } from "./i18n";
import { useWorkerSessionStates } from "./workerSessionState";
import WorkerManage from "./components/WorkerManage";
import KnowledgeBase from "./components/KnowledgeBase";
import SkillsTab from "./components/SkillsTab";
import ModelsTab from "./ModelsTab";

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

function StatusIcon({ ok }: { ok: boolean }) {
  return (
    <span style={{ color: ok ? "#52c41a" : "#ff4d4f", fontWeight: 700 }}>
      {ok ? "✅" : "❌"}
    </span>
  );
}

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
            {s.ok ? "✓" : "✗"} {s.name} <span style={{ color: "#999" }}>{s.ms} ms</span>
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
}: {
  row: AddressTestResult;
  tag: string;
  active: boolean;
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
        <span style={{ flexShrink: 0 }}>{!row.ok ? "❌" : degraded ? "⚠️" : "✅"}</span>
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
          {row.ok && !degraded ? `${row.ms} ms` : row.detail}
        </span>
        {active ? (
          <antd.Tag color="orange" style={{ margin: 0, flexShrink: 0 }}>
            {tr("生效中")}
          </antd.Tag>
        ) : null}
      </div>
      {open && row.diag ? <ConnDiagPanel diag={row.diag} /> : null}
    </div>
  );
}

function CheckList({ result }: { result: SelfCheckResult | null }) {
  if (!result) return null;
  const levels: SelfCheckResult[] = result.levels ? result.levels : [result];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {levels.map((lv, i) => (
        <div
          key={`${lv.level}-${i}`}
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            padding: "12px 16px",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            <StatusIcon ok={lv.ok} /> {lv.level}
          </div>
          {(lv.checks || []).map((c, j) => (
            <div
              key={`${c.name}-${j}`}
              style={{
                display: "grid",
                gridTemplateColumns: "24px 1fr",
                gap: 4,
                padding: "4px 0",
                fontSize: 13,
              }}
            >
              <StatusIcon ok={c.ok} />
              <div>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                {c.detail ? (
                  <span style={{ color: "#666", marginLeft: 8 }}>{c.detail}</span>
                ) : null}
                {c.hint ? (
                  <div style={{ color: "#fa8c16", fontSize: 12, marginTop: 2 }}>
                    💡 {c.hint}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RoomResultTable({ rooms }: { rooms: L3RoomResult[] }) {
  const tr = useT();
  if (!rooms || rooms.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 700 }}>房间实测结果</div>
      {rooms.map((r) => (
        <div
          key={r.room_id}
          style={{
            border: "1px solid rgba(0,0,0,0.08)",
            borderRadius: 10,
            padding: "10px 14px",
            display: "grid",
            gap: 6,
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <StatusIcon ok={r.ping_ok && r.reply?.ok} />
            <span style={{ fontWeight: 600, wordBreak: "break-all" }}>
              {r.room_id}
            </span>
            {r.members != null ? (
              <antd.Tag style={{ margin: 0 }}>{r.members} 人</antd.Tag>
            ) : null}
            <antd.Tag color={r.ping_ok ? "green" : "red"} style={{ margin: 0 }}>
              发送{r.ping_ok ? "✅" : "❌"}
            </antd.Tag>
            <antd.Tag color={r.reply?.ok ? "green" : "orange"} style={{ margin: 0 }}>
              回复{r.reply?.ok ? "✅" : "❌"}
            </antd.Tag>
          </div>
          {r.ping_error ? (
            <div style={{ color: "#ff4d4f" }}>发送失败：{r.ping_error}</div>
          ) : null}
          {r.reply?.ok ? (
            <div style={{ color: "#666" }}>
              {r.reply.sender}：{r.reply.body}
            </div>
          ) : (
            <div style={{ color: "#fa8c16" }}>
              💡 {r.reply?.detail || tr("无回复")}
              —— 可能被权限墙静默拦截（allowlist 不含你），或 Agent 未响应
            </div>
          )}
          {r.artifact ? (
            <div style={{ color: r.artifact.ok ? "#52c41a" : "#888" }}>
              产物：{r.artifact.detail}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
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
        🖥️ {tr("启动页")}
        <span style={{ fontWeight: 400, color: "#888", marginLeft: 8, fontSize: 12 }}>
          {tr("下次打开插件时先看到哪里")}
        </span>
      </div>
      <antd.Segmented
        value={pref}
        onChange={(v: string | number) => apply(v as "last" | "home")}
        options={[
          { label: tr("上次打开的页面"), value: "last" },
          { label: `🏠 ${tr("首页")}`, value: "home" },
        ]}
        style={{ marginBottom: 12 }}
      />
    </div>
  );
}

function SettingsTab({
  config,
  onConfigChange,
  onLoginSuccess,
  chatForceWide,
  onChatForceWideChange,
}: {
  config: WorkbenchConfig | null;
  onConfigChange: () => void;
  // v0.5.0-beta.12: 登录（账号切换）成功后 → 清本地旧账号数据 + 全量刷新。
  onLoginSuccess?: () => void;
  // 12.14：聊天分栏强制开关（忽略宽度判定）。
  chatForceWide?: boolean;
  onChatForceWideChange?: (v: boolean) => void;
}) {
  const tr = useT();
  const [matrixLan, setMatrixLan] = React.useState("");
  const [matrixWan, setMatrixWan] = React.useState("");
  const [controllerLan, setControllerLan] = React.useState("");
  const [controllerWan, setControllerWan] = React.useState("");
  const [controllerToken, setControllerToken] = React.useState("");
  // v0.5.0-beta.12: token 文件路径字段已删（用户反馈：「文件路径可以删掉了，
  // 留个命令就行」）——获取方式=下方命令提示 + 粘贴；env 作部署期注入兜底。
  // v0.5.0-beta.12: L1 二选一——admin 账号+密码（Higress Console 面，验证通过才
  // 由 verify-admin 持久化；普通保存不提交凭据）。密码不回填（脱敏），
  // 留空=保持已存值。
  const [adminUsername, setAdminUsername] = React.useState("");
  const [adminPassword, setAdminPassword] = React.useState("");
  const [gatewayAdminUrl, setGatewayAdminUrl] = React.useState("");
  const [verifying, setVerifying] = React.useState(false);
  const [verifyRes, setVerifyRes] = React.useState<VerifyAdminResult | null>(null);
  // 可选模块：集群负载（L1 专属）
  const [sglangEnabled, setSglangEnabled] = React.useState(false);
  // v0.5.0-beta.12: SGLang 双地址（内网/外网）——与 matrix/controller 同构。
  const [sglangLan, setSglangLan] = React.useState("");
  const [sglangWan, setSglangWan] = React.useState("");
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

  React.useEffect(() => {
    if (!config) return;
    setMatrixLan(config.matrix_homeservers?.[0] || "");
    setMatrixWan(config.matrix_homeservers?.[1] || "");
    setControllerLan(config.controller_urls?.[0] || "");
    setControllerWan(config.controller_urls?.[1] || "");
    setControllerToken(config.controller_token || "");
    // v0.5.0-beta.12: admin 账号 / 网关地址回填；密码只标记「已配置」不回填。
    setAdminUsername(config.admin_username || "");
    setGatewayAdminUrl(config.gateway_admin_url || "");
    setAdminPassword("");
    setSglangEnabled(config.sglang?.enabled || false);
    // v0.5.0-beta.12: 双地址读取；旧配置单地址 url 回退（后端亦会迁移）。
    setSglangLan(config.sglang?.urls?.[0] || config.sglang?.url || "");
    setSglangWan(config.sglang?.urls?.[1] || "");
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
            matrix_homeservers: [matrixLan, matrixWan].filter((v) => v.trim()),
            controller_urls: [controllerLan, controllerWan].filter((v) =>
              v.trim(),
            ),
            controller_token: controllerToken,
            sglang: {
              enabled: sglangEnabled,
              urls: [sglangLan, sglangWan].filter((v) => v.trim()),
            },
          },
        }),
      });
      message.success(tr("配置已保存（已自动探测生效地址）"));
      onConfigChange();
      // v0.5.0-beta.12: 保存后立即连通性测试——用户当场看到两条路径的延迟与状态。
      void runConnTest(
        [matrixLan, matrixWan].filter((v) => v.trim()),
        [controllerLan, controllerWan].filter((v) => v.trim()),
        [sglangLan, sglangWan].filter((v) => v.trim()),
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("保存失败"));
    } finally {
      setSaving(false);
    }
  };

  // v0.5.0-beta.12: 连通性测试——测表单当前值（可未保存）；后端并行探测测延迟，
  // 列表与已配置一致时顺手按最快可达重排生效地址（applied）。
  const runConnTest = React.useCallback(
    async (matrix?: string[], controller?: string[], sglang?: string[]) => {
      setTesting(true);
      try {
        const res = await testAddresses(matrix, controller, sglang);
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

  // v0.5.0-beta.12: L1 管理员验证（二选一，验证通过才持久化凭据）。
  const runVerify = React.useCallback(
    async (body: {
      admin_username?: string;
      admin_password?: string;
      controller_token?: string;
      gateway_admin_url?: string;
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
      <div style={{ fontSize: 12, color: "#888" }}>
        内网和外网是同一服务器的两条访问路径（家里用内网 IP，外出用公网域名），
        无需手动切换——插件每 2 分钟自动重测全部地址（测延迟），自动切到
        最快可达的一条，外网/内网切换自动识别。
      </div>

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

      <div style={{ display: "grid", gap: 12 }}>
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
          <antd.Input
            placeholder={tr("外网：https://你的域名:6867（可留空）")}
            value={matrixWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setMatrixWan(e.target.value)
            }
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
          <antd.Input
            placeholder={tr("外网：https://你的域名:8090（可留空）")}
            value={controllerWan}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setControllerWan(e.target.value)
            }
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
                  [matrixLan, matrixWan].filter((v) => v.trim()),
                  [controllerLan, controllerWan].filter((v) => v.trim()),
                  sglangEnabled
                    ? [sglangLan, sglangWan].filter((v) => v.trim())
                    : [],
                )
              }
            >
              🔍 {tr("连通性测试")}
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
                  active={connTest.effective.matrix === r.url}
                />
              ))}
              {connTest.controller.map((r) => (
                <ConnRow
                  key={`c-${r.url}`}
                  row={r}
                  tag="Controller"
                  active={connTest.effective.controller === r.url}
                />
              ))}
              {connTest.sglang
                ? connTest.sglang.map((r) => (
                    <ConnRow
                      key={`s-${r.url}`}
                      row={r}
                      tag="SGLang"
                      active={false}
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
                    🔄 {tr("已自动切换到最快可达")}：
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
                    ✅ {tr("当前生效地址已是最快，无变化")}
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
              { label: tr("L1 管理员（token / 账号密码）"), value: "token" },
            ]}
          />
          {ctlMode === "token" ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 12, color: "#888" }}>
                {tr("L1 凭据两种方式（二选一）：")}
                <div>
                  {tr("① Controller 管理员 token——Controller 管理 API 全量（CRD 管理/全量视图）；部署管理员提供，粘贴一次永久记住；")}
                </div>
                <div>
                  {tr("② admin 账号+密码——验证身份并持有 Higress Console 会话（Higress 面模型 alias 可用）；Controller 管理 API 仍需①。")}
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
                    {tr("✓ 当前使用 QwenPaw 宿主环境变量 AGENTTEAMS_CONTROLLER_TOKEN（手动粘贴的值优先。）")}
                  </div>
                ) : config?.controllerTokenSource === "invalid" ? (
                  <div style={{ fontSize: 12, color: "#cf1322" }}>
                    {tr("⚠ token 内容含非法字符（复制时混入不可见字符）——重新复制纯 ASCII 内容，或改用 env 注入。")}
                  </div>
                ) : null}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {tr("② admin 账号+密码（Higress 面）")}
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
                <antd.Input
                  placeholder={tr("Higress 地址（Console 管理面，必填；宿主端口部署时自选，默认 18001）")}
                  value={gatewayAdminUrl}
                  onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                    setGatewayAdminUrl(e.target.value)
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
                        gateway_admin_url: gatewayAdminUrl.trim() || undefined,
                      })
                    }
                  >
                    {tr("验证")}
                  </antd.Button>
                  <span style={{ fontSize: 11.5, color: "#888", marginLeft: 8 }}>
                    {tr("验证通过后自动保存（与 token 二选一，密码模式不替代 token）")}
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
            {tr("Matrix 登录（L2）：查看本账号可访问的团队 + 项目操作（启动/暂停/产物），日常够用。L1（二选一）：① Controller 管理员 token——额外获得 CRD 管理（入职/建队/改配/删除）、全部 Worker/Team 状态视图；② admin 账号+密码——验证身份 + 持有 Higress Console 会话，模型下拉的 Higress alias 可用。token 无接口可获取（上游安全设计），由部署管理员提供——粘贴一次永久记住；密码模式不替代 token（Controller 管理 API 仍需①）。")}
          </div>
        </div>
        <StartupPrefRow />
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            ⚡ 集群负载（可选模块）
            <span style={{ fontWeight: 400, color: "#888", marginLeft: 8, fontSize: 12 }}>
              L1 专属——只有部署了本地 SGLang 推理集群才需要开启
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
            <antd.Input
              placeholder={tr("外网：https://你的域名:30000（可留空）")}
              value={sglangWan}
              disabled={!sglangEnabled}
              onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                setSglangWan(e.target.value)
              }
            />
          </div>
          <div style={{ fontSize: 12, color: "#888" }}>
            开启后首页/运维页显示各 DP rank 的排队/运行/显存负载（SGLang
            /v1/loads）。内网/外网是同一集群的两条访问路径，插件自动探测
            最快可达的一条。没有本地部署模型的用户保持关闭——零痕迹。
          </div>
        </div>
        <div>
          <antd.Button
            type="primary"
            loading={saving}
            onClick={() => void save()}
          >
            {tr("保存配置")}
          </antd.Button>
        </div>
      </div>

      <antd.Divider />

      <div style={{ display: "grid", gap: 12 }}>
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
        <div style={{ fontSize: 12, color: "#888" }}>
          导出配置含全部地址但不含密码/token（显示为 ***）——导入不会覆盖现有
          凭据。诊断包 = 脱敏配置 + 自检结果，用于排查问题时交给管理员。
        </div>
      </div>

      <antd.Divider />

      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>
          Matrix 登录
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
      {/* v0.5.0-beta.12 ：宿主技能从顶层 tab 收编（本机 Agent 技能池
          属实例级配置面，归配置页）。 */}
      <SkillsTab />
    </div>
  );
}

/** 12.14：聊天布局客户端诊断（自检页）——分栏/滚动问题的数字现场。 */
function ChatLayoutDiagCard({
  layout,
}: {
  layout?: { wide: boolean; forced: boolean; threshold: number };
}) {
  const tr = useT();
  const [lines, setLines] = React.useState<string[]>([]);
  const measure = React.useCallback(() => {
    const out: string[] = [];
    out.push(`window.innerWidth = ${window.innerWidth}px`);
    const main = document.querySelector(".wb-main") as HTMLElement | null;
    if (main) {
      out.push(`容器 .wb-main = ${main.clientWidth} × ${main.clientHeight}px`);
    }
    if (layout) {
      out.push(
        `模式 = ${layout.wide ? "宽屏分栏" : "窄屏单列"}（横屏且≥${layout.threshold}px 才分栏${layout.forced ? "；已强制分栏" : ""}）`,
      );
    }
    if (main) {
      out.push(
        `长宽比 = ${(main.clientHeight / Math.max(main.clientWidth, 1)).toFixed(2)}（${main.clientWidth >= main.clientHeight ? "横屏" : "竖屏"}）`,
      );
    }
    const left = document.querySelector(
      '.wb-main div[style*="overscroll"]',
    ) as HTMLElement | null;
    if (left && left.clientHeight > 0) {
      out.push(
        `左栏: 可视高 ${left.clientHeight}px / 内容高 ${left.scrollHeight}px / overflowY=${getComputedStyle(left).overflowY} → ${left.scrollHeight > left.clientHeight ? "内容超限（应可滚动）" : "内容未超限"}`,
      );
    } else {
      out.push(
        "左栏未渲染或聊天 tab 未激活（先点「聊天」tab 再回自检点「重新测量」可测左栏滚动数据）",
      );
    }
    setLines(out);
  }, [layout]);
  React.useEffect(() => {
    measure();
  }, [measure]);
  return (
    <antd.Card
      size="small"
      title={tr("聊天布局诊断（客户端）")}
      extra={
        <antd.Button size="small" onClick={measure}>
          {tr("重新测量")}
        </antd.Button>
      }
    >
      <pre
        style={{
          margin: 0,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          lineHeight: 1.7,
        }}
      >
        {lines.join("\n") || "…"}
      </pre>
      <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
        {tr("排查「聊天分栏/滚动」问题时：把上面几行原样发我（数字即现场）。")}
      </div>
    </antd.Card>
  );
}

function SelfCheckTab({
  config,
  layout,
}: {
  config: WorkbenchConfig | null;
  layout?: { wide: boolean; forced: boolean; threshold: number };
}) {
  const tr = useT();
  const [result, setResult] = React.useState<SelfCheckResult | null>(null);
  const [running, setRunning] = React.useState<string | null>(null);

  const run = async (level: string) => {
    setRunning(level);
    try {
      const payload = await requestJson(`/agentteams-proxy/selfcheck/${level}`, {
        method: "POST",
      });
      setResult(payload as SelfCheckResult);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("自检失败"));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
      <ChatLayoutDiagCard layout={layout} />
      <antd.Space wrap>
        <antd.Button loading={running === "l0"} onClick={() => void run("l0")}>
          L0 本地环境
        </antd.Button>
        <antd.Button loading={running === "l1"} onClick={() => void run("l1")}>
          L1 连通性
        </antd.Button>
        <antd.Button loading={running === "l2"} onClick={() => void run("l2")}>
          L2 认证/API
        </antd.Button>
        <antd.Button
          type="primary"
          loading={running === "all"}
          onClick={() => void run("all")}
        >
          全部自检
        </antd.Button>
      </antd.Space>
      <antd.Space wrap>
        <antd.Button
          loading={running === "l3"}
          onClick={() => void run("l3")}
        >
          L3 房间实测（会发 [selfcheck] ping）
        </antd.Button>
        <antd.Button loading={running === "l4"} onClick={() => void run("l4")}>
          L4 端到端（L3 + 产物检查）
        </antd.Button>
      </antd.Space>
      {!config?.matrix_homeservers?.length ? (
        <div style={{ color: "#fa8c16" }}>
          💡 尚未配置 Matrix 地址——先去「配置」tab 填写并保存，再跑自检。
        </div>
      ) : null}
      <CheckList result={result} />
      <RoomResultTable rooms={result?.rooms || []} />
      <div style={{ fontSize: 12, color: "#888" }}>
        L0=插件环境 / L1=连通性（自动探测生效地址） / L2=登录与 API 权限 /
        L3=每个房间发一条 [selfcheck] ping 并等回复（约 45 秒，检测权限墙静默拦截）/
        L4=端到端 + 产物检查。
      </div>
    </div>
  );
}

// 启动页偏好（用户反馈）：开关存 localStorage，默认"上次打开的页面"。
const STARTUP_PREF_KEY = "agentteams-qwenpaw-workbench:startup-pref";
function readStartupPref(): "last" | "home" {
  try {
    const raw = window.localStorage.getItem(STARTUP_PREF_KEY);
    return raw === "home" ? "home" : "last";
  } catch {
    return "last";
  }
}

/** 12.14：聊天分栏最小容器宽——1024→600（宿主内嵌面板/窄窗场景
 *  1024 下判定窄屏、装验多轮复报「无分栏」；600 以下=手机竖屏语义）。
 *  12.16：宽窄判定「长宽比优先」——竖屏（高>宽）一律单列，横屏且 ≥600 才分栏。 */
const CHAT_SPLIT_MIN_CONTAINER_W = 600;
/** 12.16：宽窄判定——横屏（宽≥高）且容器 ≥600px 才用分栏。 */
function isWideLayout(w: number, h: number): boolean {
  return w >= CHAT_SPLIT_MIN_CONTAINER_W && w >= h;
}

export default function WorkbenchPage() {
  const t = useThemeColors();
  const tr = useT();
  // 插件版本：从后端 /health 读（单一真相源 = agentteams_connector/__init__.py）。
  const [pluginVersion, setPluginVersion] = React.useState("…");
  React.useEffect(() => {
    let cancelled = false;
    void requestJson("/agentteams-proxy/health")
      .then((d) => {
        const v = (d as { version?: string })?.version;
        if (!cancelled && v) setPluginVersion(v);
      })
      .catch(() => {
        /* 后端不可达时保持占位 */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [config, setConfig] = React.useState<WorkbenchConfig | null>(null);
  // ── 状态记忆（用户反馈）：重开插件恢复上次 tab + 房间 + 话题 + 面板宽度 ──
  // v0.5.0-beta.12: tab key 随名字归位（房间 team→chat、管理 spawn→team）——
  // storage key 升 v2 区分新旧格式：否则新版写入的 "team"（管理）会被
  // 旧迁移表误判成 "chat"（房间）。旧 key 只读一次做迁移，迁完即删。
  const UI_STATE_KEY = "agentteams-qwenpaw-workbench:ui-state-v2";
  const UI_STATE_KEY_LEGACY = "agentteams-qwenpaw-workbench:ui-state";
  /** 旧 tab key 迁移：v0.5.0-beta.12 管理 admin→spawn；v0.5.0-beta.12 spawn→team（管理）、team（旧=房间）→chat。 */
  const UI_TAB_MIGRATION: Record<string, string> = {
    admin: "team",
    spawn: "team",
    team: "chat",
  };
  // v0.5.0-beta.12 ：v2 已存 key 的收编迁移（与 legacy 表不同——legacy 里
  // "team"=旧房间语义，v2 里 "team"=团队管理现行 key，不能共表）。
  const UI_TAB_MIGRATION_V2: Record<string, string> = {
    "skill-center": "team",
    skills: "settings",
  };
  const readUiState = (
    key: string,
  ): {
    tab?: string;
    roomId?: string;
    wfView?: string;
    wfTopo?: string;
    // P6：聊天分栏宽度（string 存储，读取时 Number 化）+ 房间列折叠状态。
    chatSplitW?: string;
    chatListHidden?: string;
    // 12.14：强制左右分栏开关（忽略宽度判定）。
    chatForceWide?: string;
  } => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as ReturnType<typeof readUiState>;
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  };
  // v0.5.0-beta.12 ：合并写——对象扩了 wfView/wfTopo 字段，切大 tab 不能把
  // 工作流页记忆冲掉（读旧值→合并→写回；storage 不可用静默跳过）。
  const mergeUiState = React.useCallback(
    (patch: Record<string, string>) => {
      try {
        const prev = readUiState(UI_STATE_KEY);
        window.localStorage.setItem(
          UI_STATE_KEY,
          JSON.stringify({ ...prev, ...patch }),
        );
      } catch {
        /* storage 不可用则跳过 */
      }
    },
    [],
  );
  const writeUiState = React.useCallback(
    (tabKey: string, roomId: string | null) => {
      mergeUiState({ tab: tabKey, roomId: roomId || "" });
    },
    [mergeUiState],
  );
  const initialUi = React.useRef<
    { tab?: string; roomId?: string; wfView?: string; wfTopo?: string } | null
  >(null);
  if (initialUi.current === null) {
    initialUi.current = readUiState(UI_STATE_KEY);
    // v0.5.0-beta.12 ：v2 已存的被收编 tab key 迁移（否则 activeKey 无
    // 匹配项 = 空白内容区）。
    const staleTab = initialUi.current.tab;
    if (staleTab && UI_TAB_MIGRATION_V2[staleTab]) {
      initialUi.current = {
        ...initialUi.current,
        tab: UI_TAB_MIGRATION_V2[staleTab],
      };
      try {
        window.localStorage.setItem(
          UI_STATE_KEY,
          JSON.stringify(initialUi.current),
        );
      } catch {
        /* storage 不可用则忽略 */
      }
    }
    if (!initialUi.current.tab) {
      // 升级后首次：读旧 key 迁移（admin/spawn=管理→team，team=房间→chat），
      // 立即写回 v2 再删旧 key，防下次启动回退首页。
      const legacy = readUiState(UI_STATE_KEY_LEGACY);
      if (legacy.tab) {
        const migrated = {
          ...legacy,
          tab: UI_TAB_MIGRATION[legacy.tab] ?? legacy.tab,
        };
        initialUi.current = migrated;
        try {
          window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(migrated));
          window.localStorage.removeItem(UI_STATE_KEY_LEGACY);
        } catch {
          /* storage 不可用则跳过（回退首页兜底） */
        }
      }
    }
  }
  const [activeRoom, setActiveRoom] = React.useState<TeamRoom | null>(null);
  // 启动偏好："home" → 强制首页；"last"（默认）→ 恢复上次 tab（无记忆回退首页）。
  const [tab, setTabState] = React.useState(
    readStartupPref() === "home" ? "home" : initialUi.current.tab || "home",
  );
  const setTab = React.useCallback(
    (next: string) => {
      setTabState(next);
      writeUiState(next, activeRoom?.room_id || null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, writeUiState],
  );
  // v0.5.0-beta.12 ：工作流页 tab 记忆（用户「点开过的 tab 加上记忆，参考大
  // tab」）——与大 tab 同一 ui-state 对象（wfView/wfTopo 字段，合并写），
  // 不新造 storage key。WorkflowBoard 改受控（view/topoRun 由此下发）。
  const WF_VIEW_VALUES = ["list", "card", "board", "topo"];
  const [wfMem, setWfMemState] = React.useState<{
    view: string;
    topoRun: string;
  }>(() => {
    const u = initialUi.current ?? {};
    return {
      view: WF_VIEW_VALUES.includes(u.wfView || "")
        ? (u.wfView as string)
        : "list",
      topoRun: typeof u.wfTopo === "string" ? u.wfTopo : "",
    };
  });
  const setWfMem = React.useCallback(
    (patch: { view?: string; topoRun?: string }) => {
      setWfMemState((cur) => {
        const next = { ...cur, ...patch };
        mergeUiState({ wfView: next.view, wfTopo: next.topoRun });
        return next;
      });
    },
    [mergeUiState],
  );
  // 恢复房间（rooms 加载后自动定位；找不到静默回退聊天页）。
  const restoredRoomRef = React.useRef(false);
  // Team tab state
  const [rooms, setRooms] = React.useState<TeamRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = React.useState(false);
  /** v0.5.0-beta.12 ：待接受邀请（/sync rooms.invite 段；接受/拒绝后 force 重同步）。 */
  const [invites, setInvites] = React.useState<InviteRoom[]>([]);
  /** v0.5.0-beta.12 ：已静音房间（m.muted_room account data 聚合）。 */
  const [mutedRooms, setMutedRooms] = React.useState<string[]>([]);
  const [messages, setMessages] = React.useState<RoomMessage[]>([]);
  // messages 的 ref 镜像（pollMessages 去重用，避免闭包过期）。
  const messagesRef = React.useRef<RoomMessage[]>([]);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [messagesLoading, setMessagesLoading] = React.useState(false);
  const [messagesEnd, setMessagesEnd] = React.useState(""); // 分页 token
  const [hasMore, setHasMore] = React.useState(false);
  const [roomError, setRoomError] = React.useState("");
  const [sending, setSending] = React.useState(false);
  // Workflow tab state
  const [workflowEvents, setWorkflowEvents] = React.useState<WorkflowEvent[]>([]);
  const [workflowLoading, setWorkflowLoading] = React.useState(false);
  // v0.5.0-beta.12: 正源状态——降级时工作流 tab 顶部横幅提示（不静默）。
  const [workflowSource, setWorkflowSource] = React.useState<
    "controller" | "rooms"
  >("controller");
  const [workflowFailReason, setWorkflowFailReason] = React.useState<
    "auth" | "not_deployed" | "error"
  >("error");
  // error 分支的真实上游错误（横幅展示，不再只显示「正源不可用」）。
  const [workflowFailDetail, setWorkflowFailDetail] = React.useState("");
  // workflow 卡片点击 → 工作流 tab 选中该项目。
  const [selectedRunId, setSelectedRunId] = React.useState("");
  const handleOpenProject = React.useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
      setTabState("workflow");
      writeUiState("workflow", activeRoom?.room_id || null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, writeUiState],
  );
  // 项目文件面板（v0.5.0-beta.12）：聊天室 📁 → 抽屉。
  const [projectFilesRoom, setProjectFilesRoom] = React.useState<TeamRoom | null>(null);
  const openProjectFiles = React.useCallback(
    (room: TeamRoom) => setProjectFilesRoom(room),
    [],
  );
  // Spawn tab state — Worker-dimension groups from teams/rooms (design).
  // spawn lists stay empty until the spawn endpoint merges; adapter swaps the data source.
  const [workerTree, setWorkerTree] = React.useState<WorkerTreeTeam[]>([]);
  // v0.5.0-beta.12: 团队结构来源（"controller-workers" 正源 / "room-fallback" 房间聚合）
  // ——room-fallback 时 WorkerManage 出警示横幅、首页发起任务弹窗只留 Manager 入口。
  const [treeSource, setTreeSource] = React.useState<string>("");
  const [spawnLoading, setSpawnLoading] = React.useState(false);
  // L1 admin view state.
  const [adminData, setAdminData] = React.useState<AdminData | null>(null);
  const [adminLoading, setAdminLoading] = React.useState(false);

  const refreshConfig = React.useCallback(async () => {
    try {
      const payload = await requestJson("/agentteams-proxy/config");
      setConfig(payload as WorkbenchConfig);
    } catch {
      /* backend unreachable — selfcheck will surface it */
    }
  }, []);

  const refreshRooms = React.useCallback(async (silent = false, force = false) => {
    // 静默刷新（用户反馈：自动/切换刷新不闪页）——保留旧数据在屏，新数据到达才换；
    // 仅手动刷新/首载显示 loading 骨架。
    // v0.5.0-beta.12 ：force=绕过 60s 服务端缓存（邀请接受/拒绝后立即重同步，
    // 否则缓存期邀请区/房间列表不更新）。
    if (!silent) setRoomsLoading(true);
    try {
      const payload = await fetchTeamsSync(force);
      // diff 跳过：数据无变化 → 返回原引用 → React 跳过重渲染（零闪）
      setRooms((prev) => (JSON.stringify(prev) === JSON.stringify(payload.rooms) ? prev : payload.rooms));
      const nextInvites = payload.invites || [];
      setInvites((prev) => (JSON.stringify(prev) === JSON.stringify(nextInvites) ? prev : nextInvites));
      const nextMuted = payload.muted_rooms || [];
      setMutedRooms((prev) => (JSON.stringify(prev) === JSON.stringify(nextMuted) ? prev : nextMuted));
      setCachedRooms(payload);
      setActiveRoom((current) =>
        current
          ? payload.rooms.find((r) => r.room_id === current.room_id) || current
          : null,
      );
      // 状态记忆恢复：首次加载完成后自动打开上次房间。
      if (!restoredRoomRef.current) {
        restoredRoomRef.current = true;
        const savedRoomId = initialUi.current?.roomId || "";
        if (savedRoomId) {
          const saved = payload.rooms.find(
            (r) => r.room_id === savedRoomId,
          );
          if (saved) {
            setActiveRoom(saved);
            setCachedRooms(payload);
            void (async () => {
              try {
                const page = await fetchRoomMessages(saved.room_id, 50);
                setMessages(page.messages);
                setMessagesEnd(page.end);
                setHasMore(!!page.end);
                setCachedMessages(saved.room_id, page);
                void markCurrentRead(
                  saved.room_id,
                  page.messages[page.messages.length - 1]?.event_id,
                );
              } catch {
                /* 静默——恢复失败回到空房间，用户可返回重选 */
              }
            })();
          }
        }
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取房间列表失败"));
    } finally {
      if (!silent) setRoomsLoading(false);
    }
  }, []);

  // Worker 树数据源 = 真实团队结构（Team/Worker CRD）+ spawn 正源填充
  // （端点已合并；apiOk=false → spawns 保持空，UI 显示占位文案）。
  const refreshTree = React.useCallback(async (silent = false) => {
    if (!silent) setSpawnLoading(true);
    try {
      const [payload, spawns] = await Promise.all([
        fetchTeamsStructure(),
        fetchWorkerSpawns(),
      ]);
      setTreeSource(payload.source);
      if (spawns.apiOk) {
        const tree = payload.tree.map((team) => ({
          ...team,
          workers: team.workers.map((w) => ({
            ...w,
            spawns: spawns.byWorker[w.worker_name] || [],
          })),
        }));
        setWorkerTree((prev) => (JSON.stringify(prev) === JSON.stringify(tree) ? prev : tree));
      } else {
        setWorkerTree((prev) => (JSON.stringify(prev) === JSON.stringify(payload.tree) ? prev : payload.tree));
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取团队结构失败"));
    } finally {
      if (!silent) setSpawnLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // 缓存即时显示（页面重开不空白），后台静默刷新。
    const cached = getCachedRooms();
    if (cached) {
      setRooms(cached.rooms);
      setInvites(cached.invites || []);
      setMutedRooms(cached.muted_rooms || []);
    }
    void refreshRooms();
    void refreshTree();
    void refreshConfig();
  }, [refreshConfig, refreshRooms, refreshTree]);

  // ── 已读回执（m.read + m.fully_read 双写）──────────
  // 打开房间/轮询到新消息 → 对最新消息发回执 → Element 侧不再显示未读。
  // 去重：同一 (room, event) 只发一次；本地未读 badge 同步清零。
  const lastReadRef = React.useRef<{ roomId: string; eventId: string } | null>(null);
  const markCurrentRead = React.useCallback(
    async (roomId: string, latestEventId?: string) => {
      const eventId = (latestEventId || "").trim();
      if (!roomId || !eventId) return;
      const last = lastReadRef.current;
      if (last && last.roomId === roomId && last.eventId === eventId) return;
      const res = await markRoomRead(roomId, eventId);
      if (res && res.ok) {
        lastReadRef.current = { roomId, eventId };
        setRooms((prev) =>
          prev.map((r) =>
            r.room_id === roomId
              ? { ...r, unread: 0, unread_highlight: 0 }
              : r,
          ),
        );
      }
    },
    [],
  );

  // 一键全部已读（聊天页工具条按钮）。
  const [markingAllRead, setMarkingAllRead] = React.useState(false);
  const handleMarkAllRead = React.useCallback(async () => {
    const unreadIds = rooms
      .filter((r) => (r.unread || 0) > 0 || (r.unread_highlight || 0) > 0)
      .map((r) => r.room_id);
    if (unreadIds.length === 0) return;
    setMarkingAllRead(true);
    const res = await markAllRoomsRead(unreadIds);
    if (res && res.ok) {
      setRooms((prev) =>
        prev.map((r) =>
          unreadIds.includes(r.room_id)
            ? { ...r, unread: 0, unread_highlight: 0 }
            : r,
        ),
      );
    }
    setMarkingAllRead(false);
  }, [rooms]);

  const refreshMessages = React.useCallback(async (room: TeamRoom, silent = false) => {
    if (!silent) setMessagesLoading(true);
    try {
      // 缓存即时显示，后台拉新。
      const cached = getCachedMessages(room.room_id);
      if (cached) {
        setMessages(cached.messages);
        setMessagesEnd(cached.end);
        setHasMore(Boolean(cached.end));
      }
      const page = await fetchRoomMessages(room.room_id, 50);
      setMessages((prev) => (JSON.stringify(prev) === JSON.stringify(page.messages) ? prev : page.messages));
      setMessagesEnd(page.end);
      setHasMore(Boolean(page.end));
      setRoomError(page.error === "not_found" ? "not_found" : "");
      setCachedMessages(room.room_id, page);
      // 已读：messages 升序，末条 = 最新。
      void markCurrentRead(room.room_id, page.messages[page.messages.length - 1]?.event_id);
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取消息失败"));
    } finally {
      if (!silent) setMessagesLoading(false);
    }
  }, []);

  // 分页：加载更早的消息（dir=b，from=end token），前插。
  const loadMore = React.useCallback(async () => {
    if (!activeRoom || !messagesEnd) return;
    try {
      const page = await fetchRoomMessages(activeRoom.room_id, 50, messagesEnd);
      setMessages((prev) => [...page.messages, ...prev]);
      setMessagesEnd(page.end);
      setHasMore(Boolean(page.end));
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("加载更早消息失败"));
    }
  }, [activeRoom, messagesEnd]);

  // 长轮询：增量拉新消息（dir=b 前 10 条），按 event_id 去重合并。
  const pollMessages = React.useCallback(async () => {
    if (!activeRoom) return;
    try {
      const page = await fetchRoomMessages(activeRoom.room_id, 10);
      const known = new Set(
        messagesRef.current.map((m) => m.event_id),
      );
      const fresh = page.messages.filter((m) => !known.has(m.event_id));
      if (fresh.length) {
        setMessages((prev) => {
          const stillFresh = fresh.filter(
            (m) => !prev.some((p) => p.event_id === m.event_id),
          );
          return stillFresh.length ? [...prev, ...stillFresh] : prev;
        });
        // 已读：正在看的房间来了新消息 → 对最新一条发回执。
        void markCurrentRead(
          activeRoom.room_id,
          fresh[fresh.length - 1].event_id,
        );
      }
    } catch {
      /* 静默——轮询失败不打扰用户 */
    }
  }, [activeRoom, markCurrentRead]);

  const openRoom = React.useCallback(
    (roomId: string): boolean => {
      const room = rooms.find((r) => r.room_id === roomId);
      if (!room) return false;
      setActiveRoom(room);
      // 开房间必落 chat tab（用户反馈：首页最近动态点行不跳转——
      // 此前 writeUiState(tab=home) + 调用方漏 setTab → 房间开了但停在首页）。
      writeUiState("chat", room.room_id);
      void refreshMessages(room);
      return true;
    },
    [rooms, refreshMessages, writeUiState],
  );

  // 跨房间搜索：全局面板 + 跳转定位事件（传给 RoomChat）。
  const [globalSearchOpen, setGlobalSearchOpen] = React.useState(false);
  const [jumpToEventId, setJumpToEventId] = React.useState<string | null>(null);

  const handleGlobalSearchOpenRoom = React.useCallback(
    (roomId: string, eventId: string) => {
      openRoom(roomId);
      setJumpToEventId(eventId);
    },
    [openRoom],
  );

  // 通知中心「去房间」：@提到你 等通知带 room_id → 切聊天 tab + 打开房间
  //（跳转修复：此前通知条目只有展开/已读，没有任何跳转）。
  // ：eventId 可选 → 跳房间并定位到该条消息（房间通知 @你 跳转）。
  const handleGotoRoom = React.useCallback(
    (roomId: string, eventId?: string) => {
      setTab("chat");
      const ok = openRoom(roomId);
      if (eventId) setJumpToEventId(eventId);
      if (ok) return;
      // 房间不在缓存（新加入/缓存过期）→ 此前静默失败
      //（真机反馈「点击消息跳转还不行」的另一根因：openRoom 找不到
      // 直接 return）。强制刷新一次重试，仍无 → 明确提示。
      void (async () => {
        try {
          const payload = await fetchTeamsSync(true);
          const fresh = payload.rooms.find((r) => r.room_id === roomId);
          if (fresh) {
            setRooms(
              (prev) =>
                prev.some((r) => r.room_id === roomId)
                  ? prev.map((r) => (r.room_id === roomId ? fresh : r))
                  : [...prev, fresh],
            );
            setActiveRoom(fresh);
            writeUiState("chat", roomId);
            void refreshMessages(fresh);
          } else {
            message.warning(
              tr("未找到该房间（可能尚未加入）——可先在聊天 tab 列表手动打开"),
            );
          }
        } catch {
          /* 刷新失败——用户可手动打开 */
        }
      })();
    },
    [openRoom, refreshMessages, writeUiState, tr],
  );

  // 成员角色表（成员详情卡）：MXID → 领/工/审/unknown（Worker 树推断）。
  const memberRoles = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.role) map[w.mxid] = w.role;
      }
    }
    return map;
  }, [workerTree]);

  // MXID → Worker 容器名（v0.5.0-beta.12：聊天房间成员卡的「工具执行安全」
  // 审批卡需要容器名寻址 agent.json；L2 房间降级树无容器名 → 不显示）。
  const memberWorkerNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.mxid && w.worker_name) map[w.mxid] = w.worker_name;
      }
    }
    return map;
  }, [workerTree]);

  // v0.5.0-beta.12（A8b）：room_id → Worker phase/runtime 徽章（聊天头注入）。
  // 数据 = Worker CR 字段：admin 数据优先（全量），tree 兜底（L2/未配 token）。
  const workerBadgeMap = React.useMemo(() => {
    const map: Record<string, { phase?: string; runtime?: string }> = {};
    for (const w of adminData?.workers || []) {
      if (w.roomID)
        map[w.roomID] = {
          phase: w.phase || undefined,
          runtime: w.runtime || undefined,
        };
    }
    for (const team of workerTree || []) {
      for (const w of team.workers || []) {
        if (w.room_id && !map[w.room_id])
          map[w.room_id] = {
            phase: w.phase || undefined,
            runtime: w.runtime || undefined,
          };
      }
    }
    return map;
  }, [adminData, workerTree]);

  // v0.5.0-beta.12.4（A17）：Worker session 运行指示——统一派生（四落点共用：
  // 房间卡列表 / Worker 行 / 1:1 聊天头 / 聊天主列表发送者行）。
  // v0.5.0-beta.12.9：心跳优先（adminData.workers 的 agentStatus/runningTaskCount/
  // lastFinishAt，GET /workers 既有通道零新请求；旧版 controller 无 → 降级
  // typing+last_ts），60s 老化。
  const workerSessionStates = useWorkerSessionStates(
    rooms,
    workerTree,
    adminData?.workers,
  );

  // 通知未读计数（通知 tab badge）。
  const [inboxUnread, setInboxUnread] = React.useState(0);

  // P6（装验 9/18 ⑨「自动刷新有点蠢，即时信息」）：/sync 事件驱动主路。
  // ref 镜像——SSE effect deps 为空（一次连接），闭包必须走 ref 取最新。
  const activeRoomRef = React.useRef<TeamRoom | null>(null);
  React.useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);
  const pollMessagesRef = React.useRef<() => Promise<void>>(async () => {});
  React.useEffect(() => {
    pollMessagesRef.current = pollMessages;
  }, [pollMessages]);
  // 房间列表预览刷新节流（room_message 事件高频 → ≥10s 一次 /teams/sync）。
  const roomListRefreshAt = React.useRef(0);
  const scheduleRoomListRefresh = React.useCallback(() => {
    const now = Date.now();
    if (now - roomListRefreshAt.current < 10000) return;
    roomListRefreshAt.current = now;
    void refreshRooms();
  }, [refreshRooms]);

  // ── IM 式事件触发（用户反馈「30s 轮询太笨」）────────────────────
  // 后端 sync watcher：Matrix /sync 长轮询检测 @提到我 / 任务状态变化 →
  // 写宿主收件箱 + SSE 广播（GET /agentteams-proxy/events）。前端订阅：
  // 收到 mention → 刷新房间 + 通知 tab；task_status → 刷新工作流。
  // EventSource 不支持自定义 auth header（宿主启用 auth 时 401）——
  // 用 fetch + ReadableStream 手动解析 SSE（宿主 PawApp SDK 同款方案，
  // console/src/plugins/pawapp-sdk/task.ts），带 Bearer token。
  const [notifyTick, setNotifyTick] = React.useState(0);
  const [opsTick, setOpsTick] = React.useState(0);
  const [knowledgeTick, setKnowledgeTick] = React.useState(0);
  React.useEffect(() => {
    let abort: AbortController | null = null;
    let fallback: number | null = null;
    let closed = false;
    let retryDelay = 1000;

    const bootFallback = () => {
      if (!fallback) {
        fallback = window.setInterval(() => {
          void refreshRooms();
          setNotifyTick((t) => t + 1);
        }, 60000);
      }
    };
    const clearFallback = () => {
      if (fallback) {
        window.clearInterval(fallback);
        fallback = null;
      }
    };

    const connect = async () => {
      if (closed) return;
      try {
        abort = new AbortController();
        const url = window.QwenPaw.host.getApiUrl
          ? window.QwenPaw.host.getApiUrl("/agentteams-proxy/events")
          : "/api/agentteams-proxy/events";
        const token = window.QwenPaw.host.getApiToken
          ? window.QwenPaw.host.getApiToken()
          : "";
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(url, { headers, signal: abort.signal });
        if (!res.ok || !res.body) {
          // 401（auth 未通过）等：退轮询兜底并停 SSE 重试（避免打爆日志）。
          if (res.status === 401 || res.status === 403) {
            bootFallback();
            return;
          }
          throw new Error(`SSE ${res.status}`);
        }
        clearFallback();
        retryDelay = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6)) as {
                type?: string;
              };
              if (data.type === "mention") {
                void refreshRooms();
                setNotifyTick((t) => t + 1);
              } else if (data.type === "task_status") {
                // 任务状态变化 → 刷新工作流三视图 + 通知中心。
                void refreshWorkflow();
                setNotifyTick((t) => t + 1);
              } else if (
                // v0.5.0-beta.12：新邀请 / 审批请求 / 审批解决 → 刷新房间
                // 列表（邀请进 teams/sync）+ 通知中心立即更新（IM 式）。
                data.type === "invite" ||
                data.type === "approval_request" ||
                data.type === "approval_resolved"
              ) {
                void refreshRooms();
                setNotifyTick((t) => t + 1);
              } else if (data.type === "room_message") {
                // P6：/sync 事件驱动消息刷新（IM 式主路；RoomChat 12s 轮询
                // 降为断连兜底）。当前房间 → 立即拉新（内容源=拉取，附件/
                // 工作流渲染路径零改动）；房间列表预览 10s 节流刷新。
                const rid = String((data as { room_id?: string }).room_id || "");
                if (rid && rid === activeRoomRef.current?.room_id) {
                  void pollMessagesRef.current();
                }
                scheduleRoomListRefresh();
              }
            } catch {
              /* 忽略非法帧 */
            }
          }
        }
      } catch {
        /* 网络抖动 → 重连 */
      }
      // 流结束（连接被断开）→ 指数退避重连；连续失败由轮询兜底接管。
      if (closed) return;
      if (retryDelay >= 60000) {
        bootFallback();
        return;
      }
      window.setTimeout(() => {
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    };

    void connect();
    return () => {
      closed = true;
      abort?.abort();
      clearFallback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = React.useCallback(
    async (
      text: string,
      replyTo?: { event_id: string; sender: string; body: string },
      threadRoot?: string,
    ) => {
      if (!activeRoom) return;
      // 乐观回显：先本地插入 pending 消息，成功后 refresh 拉正式事件替换；
      // 失败标记 failed（红叹号徽标）保留在列表里可识别。
      const pendingId = `pending-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const pendingMsg: RoomMessage = {
        event_id: pendingId,
        sender: config?.matrix?.user_id || "",
        body: text,
        msgtype: "m.text",
        origin_server_ts: Date.now(),
        pending: true,
        ...(replyTo?.event_id
          ? { reply: replyTo }
          : threadRoot
            ? { reply: { event_id: threadRoot, sender: "", body: "" } }
            : {}),
      };
      setMessages((prev) => [...prev, pendingMsg]);
      setSending(true);
      try {
        await sendRoomMessage(activeRoom.room_id, text, replyTo, threadRoot);
        await refreshMessages(activeRoom);
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.event_id === pendingId ? { ...m, pending: false, failed: true } : m,
          ),
        );
        message.error(e instanceof Error ? e.message : tr("发送失败"));
      } finally {
        setSending(false);
      }
    },
    [activeRoom, config?.matrix?.user_id, refreshMessages],
  );

  // v0.5.0-beta.12 ：审批命令带 @Worker（裸文本群内不被 Worker 消费）。
  const handleSendApproval = React.useCallback(
    async (
      targetMxid: string,
      cmd: string,
      replyTo?: { event_id: string; sender: string; body: string },
    ) => {
      if (!activeRoom || !targetMxid) return;
      try {
        await sendApprovalCommand(
          activeRoom.room_id,
          targetMxid,
          cmd,
          replyTo,
        );
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("发送失败"));
        throw e;
      }
    },
    [activeRoom, refreshMessages],
  );

  // 表情反应：发 m.reaction 后刷新消息（聚合计数更新）。
  const handleReact = React.useCallback(
    async (eventId: string, emoji: string) => {
      if (!activeRoom) return;
      try {
        await sendReaction(activeRoom.room_id, eventId, emoji);
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("反应发送失败"));
      }
    },
    [activeRoom, refreshMessages],
  );

  // 文件发送：上传 → mxc → 发 m.file/m.image（反向交付通道）。
  const handleSendFiles = React.useCallback(
    async (files: File[]) => {
      if (!activeRoom || files.length === 0) return;
      setSending(true);
      try {
        for (const f of files) {
          const mxc = await uploadMedia(f);
          const msgtype = f.type.startsWith("image/") ? "m.image" : "m.file";
          await sendRoomFile(activeRoom.room_id, {
            mxcUri: mxc,
            filename: f.name || "file",
            msgtype,
            mimetype: f.type,
            size: f.size,
          });
        }
        message.success(tr("已发送 {n} 个文件", { n: files.length }));
        await refreshMessages(activeRoom);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("文件发送失败"));
      } finally {
        setSending(false);
      }
    },
    [activeRoom, refreshMessages],
  );

  // ── v0.5.0-beta.12 ：Element 对齐四件（编辑/撤回/退出/静音）──────────
  /** 编辑自己的消息（m.replace 标注替换，Element 同款）。 */
  const handleSendEdit = React.useCallback(
    async (originalEventId: string, body: string) => {
      if (!activeRoom) return;
      try {
        await sendRoomMessageEdit(activeRoom.room_id, originalEventId, body);
        await refreshMessages(activeRoom, true);
      } catch (e) {
        throw e; // RoomChat 编辑态保留草稿
      }
    },
    [activeRoom, refreshMessages],
  );

  /** 撤回自己的消息（redaction；他人事件 403 透传 toast）。 */
  const handleRedact = React.useCallback(
    async (eventId: string) => {
      if (!activeRoom) return;
      try {
        await redactRoomMessage(activeRoom.room_id, eventId);
        message.success(tr("已撤回"));
        await refreshMessages(activeRoom, true);
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("撤回失败"));
      }
    },
    [activeRoom, refreshMessages],
  );

  /** 退出房间（leave；scope 房间会被 Controller 调和器重新邀请）。 */
  const handleLeaveRoom = React.useCallback(async () => {
    if (!activeRoom) return;
    const roomName = activeRoom.name;
    try {
      await leaveRoom(activeRoom.room_id);
      message.success(tr("已退出「{name}」", { name: roomName }));
      setActiveRoom(null);
      void refreshRooms(true, true); // force：房间立即从列表消失
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("退出房间失败"));
    }
  }, [activeRoom, refreshRooms]);

  /** 房间重命名（m.room.name state 事件）。
   * 团队房间权限表普遍为 null（平台侧已知问题）→ 403 时展示
   * fetchRoomPowerInfo 诊断 + 修复指引，而非裸错误。 */
  const handleRenameRoom = React.useCallback(
    async (name: string) => {
      if (!activeRoom) return;
      const nm = name.trim();
      if (!nm) {
        message.warning(tr("房间名不能为空"));
        return;
      }
      try {
        await renameRoom(activeRoom.room_id, nm);
        const rid = activeRoom.room_id;
        setRooms((prev) =>
          prev.map((r) => (r.room_id === rid ? { ...r, name: nm } : r)),
        );
        setActiveRoom((prev) =>
          prev && prev.room_id === rid ? { ...prev, name: nm } : prev,
        );
        message.success(tr("已重命名为「{n}」", { n: nm }));
        void refreshRooms(true, true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/403|FORBIDDEN|power/i.test(msg)) {
          void (async () => {
            let detail = "";
            try {
              const info = await fetchRoomPowerInfo(
                activeRoom.room_id,
                config?.matrix?.user_id || "",
              );
              detail = info.content
                ? tr(
                    "你的权限 {a}/{b}（需 ≥ {b}）——找房间管理员（Manager）在房间内提权后重试。",
                    { a: String(info.myLevel), b: String(info.nameRequired) },
                  )
                : tr(
                    "该房间没有有效的权限设置（平台侧已知问题）。请管理员修复房间的权限设置后重试。",
                  );
            } catch {
              /* 诊断失败用默认文案 */
            }
            antd.Modal.error({
              title: tr("改名失败：权限不足"),
              content: detail || msg,
            });
          })();
          return;
        }
        message.error(msg || tr("改名失败"));
      }
    },
    [activeRoom, config, refreshRooms, tr],
  );

  /** 房间静音切换（m.muted_room account data；通知引擎 sync_watcher
   * 同数据源消费——静音房间不再触发 @/任务状态通知）。 */
  const handleToggleMute = React.useCallback(async () => {
    if (!activeRoom) return;
    const userId = config?.matrix?.user_id;
    if (!userId) return;
    const nowMuted = !mutedRooms.includes(activeRoom.room_id);
    try {
      await setRoomMuted(activeRoom.room_id, userId, nowMuted);
      setMutedRooms((prev) =>
        nowMuted
          ? [...prev, activeRoom.room_id]
          : prev.filter((r) => r !== activeRoom.room_id),
      );
      message.success(
        nowMuted ? tr("已静音该房间（@/任务通知不再推送）") : tr("已取消静音"),
      );
      // force 重同步（自审：60s 服务端缓存会让下一轮背景刷新用旧值
      // 覆盖乐观更新的静音状态——force 立即拿到新 account_data）。
      void refreshRooms(true, true);
    } catch (e) {
      message.error(e instanceof Error ? e.message : tr("静音设置失败"));
    }
  }, [activeRoom, config, mutedRooms]);

  // Phase 2: DM entry — click a member → create-or-reuse DM → open room.
  const handleDm = React.useCallback(
    async (mxid: string, roomId?: string) => {
      // v0.5.0-beta.12（用户反馈）：Worker 个人房间（CR roomID）
      // 直跳——Worker 容器无法接受 Matrix 邀请，新建 DM 房间 Worker 进不来
      // （房间建了、消息发不出去）= 死路。room_id 存在且房间在列表 → 直跳；
      // 房间不在列表（已退房/数据未同步）→ fallthrough 走 openDm 兜底。
      if (roomId) {
        try {
          const p0 = await fetchTeamsSync(true);
          setRooms(p0.rooms);
          setCachedRooms(p0);
          const direct = p0.rooms.find((r) => r.room_id === roomId);
          if (direct) {
            setTabState("chat");
            writeUiState("chat", roomId);
            setActiveRoom(direct);
            void refreshMessages(direct);
            message.success(tr("已打开 {target} 的个人房间", { target: mxid }));
            return;
          }
        } catch (e) {
          message.warning(
            tr("个人房间打开失败（{e}），回退新建 DM", {
              e: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
      try {
        const dm = await openDm(mxid);
        // v0.5.0-beta.12: 先验证房间真的出现在房间列表，再报成功——
        // 修「Worker 管理点私聊说已创建、实际没有」的假成功（房间未落地/
        // homeserver 错位时静默吞掉）。
        const payload = await fetchTeamsSync(true);
        setRooms(payload.rooms);
        setCachedRooms(payload);
        let room = payload.rooms.find((r) => r.room_id === dm.room_id);
        if (!room) {
          // New DM may not appear in joined_rooms instantly; retry once.
          await new Promise((res) => setTimeout(res, 1500));
          const p2 = await fetchTeamsSync(true);
          setRooms(p2.rooms);
          setCachedRooms(p2);
          room = p2.rooms.find((r) => r.room_id === dm.room_id);
        }
        if (room) {
          const members = room.member_count ?? 0;
          message.success(
            dm.created && members <= 1
              ? tr("已创建私聊，等待对方接受邀请")
              : dm.created
                ? tr("已创建与 {target} 的私聊", { target: dm.target })
                : tr("打开已有私聊"),
          );
          // v0.5.0-beta.12: 开 DM 必切聊天 tab——从团队管理/首页发起时此前房间
          // 在后台打开、屏幕停在原地，用户视角「说已创建实际没有」（与
          // openRoom「开房间必落聊天 tab」同模式，跳转修复的私聊版）。
          setTabState("chat");
          writeUiState("chat", dm.room_id);
          setActiveRoom(room);
          void refreshMessages(room);
        } else {
          message.error(
            tr("房间创建返回成功但未出现在房间列表（homeserver 配置可能错位），请检查配置后重试"),
          );
        }
      } catch (e) {
        message.error(e instanceof Error ? e.message : tr("打开私聊失败"));
      }
    },
    [refreshMessages],
  );

  // Workflow adapter 双轨：正源 = Controller projects/workflow API（端点已合并）；
  // apiOk=false（端点未部署/网络失败）→ 降级 Matrix agentteams.workflow 事件聚合。
  // 首页「任务进展」卡需要 workflow 数据——启动时也拉一次（定义后置，独立 effect）。
  React.useEffect(() => {
    void refreshWorkflow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refreshWorkflow = React.useCallback(async (silent = false) => {
    if (!silent) setWorkflowLoading(true);
    try {
      const { events, apiOk, failReason, failDetail } =
        await fetchWorkflowProjects();
      if (apiOk) {
        const enriched = enrichWorkflowRoomNames(events);
        setWorkflowEvents((prev) =>
          JSON.stringify(prev) === JSON.stringify(enriched) ? prev : enriched
        );
        setWorkflowSource("controller");
        setWorkflowFailDetail("");
      } else {
        // v0.5.0-beta.12: 记录降级原因——横幅提示「只看已加入房间的项目」+
        // 可操作指引（此前静默降级，正源 401 时用户以为数据就是这样）。
        // 同时记录真实错误 detail（5xx 上游故障不再被通用文案掩盖）。
        setWorkflowSource("rooms");
        setWorkflowFailReason(failReason || "error");
        setWorkflowFailDetail(failDetail || "");
        const payload = await fetchWorkflowEvents();
        setWorkflowEvents((prev) => (JSON.stringify(prev) === JSON.stringify(payload.events) ? prev : payload.events));
      }
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取工作流失败"));
    } finally {
      if (!silent) setWorkflowLoading(false);
    }
  }, []);

  // v0.5.0-beta.12.5（P1-7）：工作流 tab 自动刷新（15s，仅可见期活跃）——
  // 对齐 dashboard 15s 轮询（useProjectWorkflow refetchInterval:15000）。
  // 此前插件只在挂载/手动刷新/登录时拉取，任务推进时看板不自动更新
  // （P1-7 半链接缺口）。切走 tab 立即停（cleanup 清 interval）。
  // 第 11 轮（装验反馈 9/18「聊天工作流卡片 live 刷新要，两边都要」）：聊天 tab 激活
  // 且当前房间消息含 workflow 载荷时同样轮询——聊天内卡片 live overlay
  // 复用 workflowEvents 正源（controller projects/workflow 双轨）。
  const chatHasWfCards = tab === "chat" && messages.some((m) => m.workflow != null);
  React.useEffect(() => {
    if (tab !== "workflow" && !chatHasWfCards) return;
    const id = window.setInterval(() => void refreshWorkflow(true), 15000);
    return () => window.clearInterval(id);
  }, [tab, chatHasWfCards, refreshWorkflow]);

  // v0.5.0-beta.12: L1 数据面可用 = 本地配置 token 或宿主 env
  // （AGENTTEAMS_CONTROLLER_TOKEN，env 不落盘——config.controller_token 为空
  // 但 controllerTokenSource="env" 时数据面同样可用，门控以此为准）。
  const hasCtlToken = Boolean(
    config?.controller_token || config?.controllerTokenSource === "env",
  );

  // L1 admin view: only when a Controller token is available (config or env).
  const refreshAdmin = React.useCallback(async (silent = false) => {
    if (!hasCtlToken) return;
    if (!silent) setAdminLoading(true);
    try {
      const data = await fetchAdminData();
      setAdminData((prev) => (prev && JSON.stringify(prev) === JSON.stringify(data) ? prev : data));
    } catch (e) {
      if (!silent) message.error(e instanceof Error ? e.message : tr("获取管理视图失败"));
    } finally {
      if (!silent) setAdminLoading(false);
    }
  }, [hasCtlToken]);

  // v0.5.0-beta.12: 账号切换（登录成功）= 数据源全切——清本地旧账号数据 + 全量重取。
  // 与后端联动：/login 已同步清 60s 聚合缓存（rooms/workflow/artifacts/
  // structure）+ 重置 sync 游标；前端本地状态不清的话，切完账号屏幕还挂着
  // 上一个账号的房间/树/管理数据，要等下一轮静默刷新（用户反馈 真机反馈：
  // 「点刷新看起来是刷新了，但团队管理和产物没有刷新」）。
  const onLoginSuccess = React.useCallback(() => {
    setRooms([]);
    setWorkerTree([]);
    setTreeSource("");
    setAdminData(null);
    setWorkflowEvents([]);
    void refreshConfig();
    void refreshRooms();
    void refreshTree();
    void refreshAdmin();
    void refreshWorkflow();
  }, [refreshConfig, refreshRooms, refreshTree, refreshAdmin, refreshWorkflow]);

  // 点 Tab 即刷新（用户要求，所有 top tab）：rc-tabs 内容挂载后保活不卸载，
  // 切回不会自动重取——这里按 tab 显式触发对应数据刷新。
  const prevTabRef = React.useRef("");
  React.useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (prev === "" || prev === tab) return;
    switch (tab) {
      case "home":
        // 静默刷新（用户反馈：切 tab/自动刷新不闪页——rc-tabs 保活有旧数据在屏）
        void refreshRooms(true);
        void refreshConfig();
        void refreshWorkflow(true);
        void refreshTree(true);
        break;
      case "chat":
        void refreshRooms(true);
        if (activeRoom) void refreshMessages(activeRoom, true);
        break;
      case "inbox":
        setNotifyTick((n) => n + 1);
        break;
      case "workflow":
        void refreshWorkflow(true);
        break;
      case "artifacts":
        void refreshRooms(true);
        break;
      case "team":
        void refreshTree(true);
        void refreshAdmin(true);
        break;
      case "knowledge":
        setKnowledgeTick((n) => n + 1);
        break;
      case "selfcheck":
        void refreshConfig();
        break;
      case "ops":
        setOpsTick((n) => n + 1);
        break;
      case "settings":
        void refreshConfig();
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // v0.5.0-beta.12（对齐 dashboard refetchInterval:15000）：workflow
  // 15s 自动刷新——仅 workflow tab 激活时轮询（rc-tabs 保活，切走即停），
  // 静默刷新不闪页。审计就标记的缺口（插件 WorkflowBoard 零 tick）。
  React.useEffect(() => {
    if (tab !== "workflow") return;
    const id = setInterval(() => void refreshWorkflow(true), 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // 自己的显示名：从房间成员里找 display_name，fallback MXID localpart。
  const selfDisplayName = React.useMemo(() => {
    const me = config?.matrix?.user_id;
    if (!me) return "";
    for (const room of rooms) {
      const member = room.members?.[me];
      if (member?.display_name) return member.display_name;
    }
    return "";
  }, [config?.matrix?.user_id, rooms]);

  // ── P6 聊天 tab（装验 9/18 ⑤）：宽屏 Element 式分栏 / 窄屏微信式单屏 ──
  // 宽屏：左房间/DM 列表（宽度可拖 220-560，持久化）+ 右聊天（未选房间显占位）。
  // 窄屏（<1024px，竖屏/手机）：保持微信移动版语义——列表页点击进全屏聊天，
  // 左上角 ← 返回退出（RoomChat onBack 既有按钮）。列表可隐藏（宽屏）。
  const [chatWideMeasured, setChatWideMeasured] = React.useState(
    () => isWideLayout(window.innerWidth, window.innerHeight),
  );
  // 12.14：强制分栏开关（配置页）——忽略宽度判定，持久化 ui-state。
  const [chatForceWide, setChatForceWide] = React.useState<boolean>(
    () => readUiState(UI_STATE_KEY).chatForceWide === "true",
  );
  const setChatForceWidePersist = React.useCallback(
    (v: boolean) => {
      setChatForceWide(v);
      mergeUiState({ chatForceWide: v ? "true" : "false" });
    },
    [mergeUiState],
  );
  // 12.13→12.14：判定改「容器实际宽度」（宿主内嵌面板可能窄于窗口），
  // 阈值 1024→600；强制开关优先。ResizeObserver 跟随容器；无 RO 回退窗口宽。
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = mainRef.current;
    const measure = (w: number, h: number) => setChatWideMeasured(isWideLayout(w, h));
    if (el && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (r && r.width > 0 && r.height > 0) measure(r.width, r.height);
      });
      ro.observe(el);
      measure(el.clientWidth, el.clientHeight);
      return () => ro.disconnect();
    }
    const onResize = () =>
      measure(
        el ? el.clientWidth : window.innerWidth,
        el ? el.clientHeight : window.innerHeight,
      );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // v0.5.0-beta.13.4（9/22 第二轮反馈·滚动真根因重构）：shell 高度改为
  // 容器相对（Element 模型）——12.x 起用 calc(100vh-64px) 经验值，但宿主
  // 是 Desktop OS 窗口（OsAppHost .content：flex:1 + overflow:auto 定高
  // 容器，可拖拽任意大小，100vh=浏览器视口≠窗口内容高）：窗口小于屏幕时
  // shell 溢出 → .content 整页滚 →「聊天框带着整个页面滚」。
  // 实测优先，三级判定：
  // ① iframe 宿主（PawApps iframe 模式）→ iframe 视口=全部可用区；
  // ② 父容器定高且小于视口（OS 窗口 .content / 任何定高内嵌容器）→ 用父
  //    容器 clientHeight（窗口拖拽/宿主重排时 ResizeObserver 跟随）；
  // ③ 父容器不定高（经典页面挂载）→ 回退 calc(100vh - 64px) 旧经验值。
  const [shellH, setShellH] = React.useState<number | null>(null);
  React.useEffect(() => {
    const measure = () => {
      const el = mainRef.current;
      if (!el) return;
      try {
        if (window.self !== window.top) {
          setShellH(window.innerHeight);
          return;
        }
      } catch {
        /* 跨域 iframe 访问异常——按非 iframe 处理 */
      }
      const p = el.parentElement;
      if (
        p &&
        p.clientHeight > 0 &&
        p.clientHeight < window.innerHeight - 4
      ) {
        setShellH(p.clientHeight);
        return;
      }
      setShellH(null);
    };
    measure();
    const p = mainRef.current?.parentElement;
    if (p && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(p);
      window.addEventListener("resize", measure);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", measure);
      };
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const chatWide = chatForceWide || chatWideMeasured;
  const [chatSplitW, setChatSplitW] = React.useState<number>(() => {
    const v = Number(readUiState(UI_STATE_KEY).chatSplitW);
    return Number.isFinite(v) && v >= 160 && v <= 480 ? v : 300;
  });
  const [chatListHidden, setChatListHidden] = React.useState<boolean>(
    () => readUiState(UI_STATE_KEY).chatListHidden === "true",
  );
  const setChatListHiddenPersist = React.useCallback(
    (hidden: boolean) => {
      setChatListHidden(hidden);
      mergeUiState({ chatListHidden: hidden ? "true" : "false" });
    },
    [mergeUiState],
  );
  const closeChatRoom = React.useCallback(() => {
    setActiveRoom(null);
    setRoomError("");
    writeUiState(tab, null);
  }, [tab, writeUiState]);
  const startChatSplitDrag = React.useCallback(
    (e: ReactNS.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = chatSplitW;
      const clamp = (w: number) => Math.min(480, Math.max(160, w));
      const onMove = (ev: globalThis.MouseEvent) => {
        setChatSplitW(clamp(startW + (ev.clientX - startX)));
      };
      const onUp = (ev: globalThis.MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // 落点一次写 localStorage（拖动中不写——高频写盘无谓）。
        mergeUiState({
          chatSplitW: String(clamp(startW + (ev.clientX - startX))),
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSplitW, mergeUiState],
  );

  // P6：聊天双元素提取（宽/窄屏两分支共用一份 JSX——props 长，禁止复制）。
  const chatRoomEl = activeRoom ? (
    <RoomChat
      room={activeRoom}
      messages={messages}
      liveWorkflows={workflowSource === "controller" ? workflowEvents : []}
      loading={messagesLoading}
      sending={sending}
      hasMore={hasMore}
      user_id={config?.matrix?.user_id}
      errorNote={
        roomError === "not_found"
          ? tr("该房间历史暂时无法加载——可能是房间已失效，也可能是权限或服务端问题。可返回聊天页换其他房间。")
          : ""
      }
      onSend={(text, replyTo, threadRoot) =>
        void handleSend(text, replyTo, threadRoot)
      }
      onSendApproval={(mxid, cmd, replyTo) =>
        void handleSendApproval(mxid, cmd, replyTo)
      }
      onSendFiles={(files) => void handleSendFiles(files)}
      onSendEdit={(eventId, body) => void handleSendEdit(eventId, body)}
      onRedact={(eventId) => void handleRedact(eventId)}
      onLeaveRoom={() => void handleLeaveRoom()}
      onRenameRoom={(name) => void handleRenameRoom(name)}
      muted={activeRoom ? mutedRooms.includes(activeRoom.room_id) : false}
      onToggleMute={() => void handleToggleMute()}
      onReact={(eventId, emoji) => void handleReact(eventId, emoji)}
      onDm={(mxid, roomId) => void handleDm(mxid, roomId)}
      onBack={() => {
        closeChatRoom();
        // 窄屏=微信式退出聊天（回列表页）；宽屏=关聊天回占位（列表恒显）。
        if (!chatWide) setChatListHiddenPersist(false);
      }}
      onNewTask={() => void 0}
      onLoadMore={() => void loadMore()}
      onPoll={() => void pollMessages()}
      jumpToEventId={jumpToEventId}
      onJumpHandled={() => setJumpToEventId(null)}
      memberRoles={memberRoles}
      memberWorkerNames={memberWorkerNames}
      workerBadge={
        activeRoom ? workerBadgeMap[activeRoom.room_id] : undefined
      }
      sessionState={
        activeRoom ? workerSessionStates.byRoom[activeRoom.room_id] : undefined
      }
      workerMxids={workerSessionStates.workerMxids}
      workerSessionByMxid={workerSessionStates.byMxid}
      workers={adminData?.workers ?? []}
      onOpenProject={(runId) => handleOpenProject(runId)}
      onWorkflowIntervened={() => void refreshWorkflow(true)}
      onOpenProjectFiles={(room) => void openProjectFiles(room)}
    />
  ) : null;
  const chatListEl = (
    <TeamOverview
      rooms={rooms}
      invites={invites}
      loading={roomsLoading}
      user_id={config?.matrix?.user_id}
      workerSessionByRoom={workerSessionStates.byRoom}
      workerMxids={workerSessionStates.workerMxids}
      onOpenRoom={(roomId) => void openRoom(roomId)}
      onRefresh={() => void refreshRooms()}
      onInviteSettled={() => void refreshRooms(true, true)}
      onDm={(mxid, roomId) => void handleDm(mxid, roomId)}
      onGlobalSearch={() => setGlobalSearchOpen(true)}
      onMarkAllRead={() => void handleMarkAllRead()}
      markingAllRead={markingAllRead}
    />
  );
  const chatTabChildren = chatWide ? (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {!chatListHidden ? (
        <>
          <div
            style={{
              position: "relative",
              width: chatSplitW,
              flexShrink: 0,
              minWidth: 0,
              // 装验反馈 9/19（P8a）：房间列表独立滚动（原先 overflow:hidden
              // 直接裁掉底部房间，列表无法滚动）；overscroll-contain 防
              // 滚动链传播到页面。
              overflowY: "auto",
              overscrollBehavior: "contain",
              borderRight: `1px solid ${t.border}`,
            }}
          >
            {chatListEl}
            <button
              type="button"
              onClick={() => setChatListHiddenPersist(true)}
              title={tr("隐藏房间列表")}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                zIndex: 10,
                border: `1px solid ${t.border}`,
                background: t.bg,
                color: t.textSecondary,
                borderRadius: 6,
                cursor: "pointer",
                padding: "2px 7px",
                fontSize: 12,
                lineHeight: "18px",
              }}
            >
              ⟨
            </button>
          </div>
          <div
            onMouseDown={startChatSplitDrag}
            title={tr("拖动调整房间列表宽度")}
            style={{
              width: 5,
              flexShrink: 0,
              cursor: "col-resize",
              background: "transparent",
            }}
          />
        </>
      ) : null}
      <div style={{ flex: 1, minWidth: 0, position: "relative", minHeight: 0 }}>
        {chatListHidden ? (
          <button
            type="button"
            onClick={() => setChatListHiddenPersist(false)}
            title={tr("显示房间列表")}
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              zIndex: 10,
              border: `1px solid ${t.border}`,
              background: t.bg,
              color: t.text,
              borderRadius: 6,
              cursor: "pointer",
              padding: "3px 9px",
              fontSize: 13,
            }}
          >
            ☰ {tr("房间列表")}
          </button>
        ) : null}
        {chatRoomEl || (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: t.textSecondary,
            }}
          >
            <div style={{ fontSize: 34 }}>💬</div>
            <div style={{ fontSize: 13 }}>
              {chatListHidden
                ? tr("房间列表已隐藏——点左上角 ☰ 显示")
                : tr("选择左侧房间开始聊天")}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : activeRoom ? (
    chatRoomEl
  ) : (
    chatListEl
  );

  return (
    <antd.ConfigProvider
      theme={{
        algorithm:
          t.mode === "dark" ? [antd.theme.darkAlgorithm] : undefined,
        token: { colorPrimary: "#FF7F16" },
      }}
    >
    <main
      ref={mainRef}
      className="wb-main"
      style={{
        // v0.5.0-beta.13.4：容器相对高度（Element 模型）——shellH 实测：
        // ① iframe 宿主=iframe 视口 ② 定高父容器（OS 窗口 .content）=父
        // clientHeight ③ 不定高回退旧经验值 calc(100vh-64px)（经典页面：
        // 宿主 header 56px + 8px 边距，见宿主 layouts/index.module.less
        // .sider）。12.x 的纯 vh 经验值在 OS 窗口小于屏幕时溢出 → 整页滚。
        height: shellH != null ? `${shellH}px` : "calc(100vh - 64px)",
        maxWidth: 1160,
        margin: "0 auto",
        padding: "12px 20px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {/* 竖屏窄视口优化（用户反馈：团队管理竖屏用有点宽）——inline style
          无媒体查询能力，scoped CSS 注入；700px 断点=竖屏手机/窄窗。 */}
      <style>{`
        /* 宽元素防撑链（全视口，v0.5.0-beta.12）：flex/grid 项默认 min-width:auto，
           不可收缩内容（长 Tag/长占位符）会把 Col→Row→容器撑宽 → min-width:0
           断链：内容自行换行/内滚，容器恒宽、顶屏刚刚好。 */
        .wb-main .ant-row,
        .wb-main .ant-row .ant-col,
        .wb-main .ant-card,
        .wb-main .ant-card-body,
        .wb-main .qwenpaw-row,
        .wb-main .qwenpaw-row .qwenpaw-col,
        .wb-main .qwenpaw-card,
        .wb-main .qwenpaw-card-body { min-width: 0; max-width: 100%; }
        /* v0.5.0-beta.12：行内 Select 默认 min-width:auto=内容宽（长占位符撑行）
           → 强制可收缩（内容自行裁剪），断「创建团队卡溢出」最后一条链。 */
        .wb-main .ant-select,
        .wb-main .qwenpaw-select { min-width: 0; }
        /* 装验反馈 9/19（P8a）：聊天分栏左右独立滚动——antd Tabs 内部
           content 链默认无高度（auto 跟随内容）→ 分栏容器 height:100%
           塌陷、房间列表撑高被 wb-main overflow:hidden 裁掉。锁定
           content holder/content/tabpane 高度链（chatWide 分栏专用；
           其他 tab 内容自身有高度约束；12.11 起 tabpane 加 overflow-y:auto
           回退滚动、内容区容器 flex 化——整链真正接通）。 */
        /* 12.15 真机复现（真实宿主实测）：QwenPaw 宿主是自家前缀的 antd 分支
           （qwenpaw-tabs-*，无 .ant-tabs-*）——上面整条链在真宿主从未命中
           （左栏被撑到 8193px、整页滚动 4 轮复报的确证根因）。双前缀双写。 */
        .wb-main .ant-tabs-content-holder,
        .wb-main .qwenpaw-tabs-content-holder { flex: 1; min-height: 0; }
        .wb-main .ant-tabs-content,
        .wb-main .qwenpaw-tabs-content { height: 100%; }
        .wb-main .ant-tabs-tabpane-active,
        .wb-main .qwenpaw-tabs-tabpane-active { height: 100%; min-height: 0; overflow-y: auto; }
        /* v0.5.0-beta.12（390px 审计真根因）：antd 断点最小档 xs=576px——
           390px 手机低于一切断点，Col 无任何断点样式 → 基础 width:100%
           + flex-shrink 把「员工入职/创建团队」两卡挤成 50/50（各 174px，
           内容需 330+ → 整条溢出链的源头）。<576px 强制单列通宽。 */
        @media (max-width: 575px) {
          .wb-main .ant-row > .ant-col,
          .wb-main .qwenpaw-row > .qwenpaw-col {
            flex: 0 0 100% !important;
            max-width: 100% !important;
          }
        }
        /* v0.5.0-beta.12（390px 实测审计实锤）：无列模板的 display:grid
           单 auto 列宽=max-min-content（创建团队表单被撑到 490px>390 视口）
           → minmax(0,1fr) 锁轨道=容器宽、item 可收缩。内联
           gridTemplateColumns 的网格不受影响（inline 优先级更高）。 */
        .wb-main [style*="display:grid"],
        .wb-main [style*="display: grid"] { grid-template-columns: minmax(0, 1fr); }
        /* 卡片标题：flex item min-width:auto 撑宽（"员工入职（Human CRD）"
           166>136 溢出）→ 允许收缩换行。 */
        .wb-main .ant-card-head-title { min-width: 0; }
        @media (max-width: 700px) {
          .wb-main { padding: 8px 10px 12px !important; gap: 8px !important; }
          .wb-main .ant-card-body { padding: 10px !important; }
          .wb-main .ant-table-cell { padding-left: 6px !important; padding-right: 6px !important; }
          .wb-main .ant-table-thead > tr > th { padding-left: 6px !important; padding-right: 6px !important; }
          .wb-main .ant-tag { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
          .wb-main pre, .wb-main code { white-space: pre-wrap; word-break: break-all; }
        }
      `}</style>
      <header
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingBottom: 10,
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        {/* v0.5.0-beta.12.2：AgentTeams logo 替代 🏢（同 dashboard 侧边栏）。 */}
        <img
          src={LOGO_URL}
          width={28}
          height={28}
          alt="AgentTeams"
          style={{ display: "block" }}
        />
        <div>
          <antd.Typography.Title level={3} style={{ margin: 0 }}>
            AgentTeams 团队工作台
          </antd.Typography.Title>
          <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
            v{pluginVersion} —— 多团队工作台（聊天/工作流/产物/运维/管理）
          </antd.Typography.Text>
        </div>
        <div style={{ flex: 1 }} />
        {config?.matrix?.user_id ? (
          <antd.Tooltip title={tr("点击进入配置页")}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                padding: "4px 10px",
                borderRadius: 20,
                background: "rgba(255,127,22,0.06)",
              }}
              onClick={() => setTab("settings")}
            >
              <antd.Avatar
                size="small"
                style={{ backgroundColor: "#FF7F16", fontSize: 13 }}
              >
                {(selfDisplayName || config.matrix.user_id.split(":")[0].replace(/^@/, "")).slice(0, 1).toUpperCase()}
              </antd.Avatar>
              <span style={{ fontSize: 12, color: t.textSecondary }}>
                {selfDisplayName ||
                  config.matrix.user_id.split(":")[0].replace(/^@/, "")}
              </span>
            </div>
          </antd.Tooltip>
        ) : (
          <antd.Button size="small" onClick={() => setTab("settings")}>
            {tr("登录")}
          </antd.Button>
        )}
      </header>

      {/* 自定义 tab 栏（用户反馈：布局自控——antd Tabs 内部 DOM 不可控，
          高度链断导致头部不固定。自写 tab bar + 内容容器 flex 布局） */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          gap: 2,
          borderBottom: `1px solid ${t.border}`,
          overflowX: "auto",
          scrollbarWidth: "none",
        }}
      >
        {[
          { key: "home", label: `🏠 ${tr("首页")}` },
          { key: "chat", label: `💬 ${tr("聊天")}` },
          { key: "inbox", label: `🔔 ${tr("通知")}` },
          { key: "workflow", label: `🔀 ${tr("工作流")}` },
          { key: "artifacts", label: `📦 ${tr("产物")}` },
          { key: "team", label: `👷 ${tr("团队管理")}` },
          { key: "knowledge", label: `📚 ${tr("知识库")}` },
          { key: "selfcheck", label: `🔍 ${tr("自检")}` },
          { key: "ops", label: `🛠️ ${tr("运维")}` },
          { key: "models", label: `🧠 ${tr("模型")}` },

          { key: "settings", label: `⚙️ ${tr("配置")}` },
        ].map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "9px 14px",
                fontSize: 13.5,
                whiteSpace: "nowrap",
                color: active ? PRIMARY : t.textSecondary,
                fontWeight: active ? 700 : 400,
                borderBottom: `2px solid ${active ? PRIMARY : "transparent"}`,
                transition: "color 0.15s, border-color 0.15s",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => {
                if (!active)
                  (e.currentTarget as HTMLElement).style.color = PRIMARY;
              }}
              onMouseLeave={(e) => {
                if (!active)
                  (e.currentTarget as HTMLElement).style.color =
                    t.textSecondary;
              }}
            >
              {item.label}
              {item.key === "inbox" && inboxUnread > 0 ? (
                <span
                  style={{
                    background: PRIMARY,
                    color: "#fff",
                    borderRadius: 10,
                    fontSize: 10.5,
                    padding: "0 6px",
                    lineHeight: "16px",
                    fontWeight: 700,
                  }}
                >
                  {inboxUnread > 99 ? "99+" : inboxUnread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 内容区：flex 1 + 内部滚动——头部与 tab 栏固定，只有这里滚 */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          /* v0.5.0-beta.12.11（P8a 真修复·最后一跳）：本容器必须 flex 化——
             否则 Tabs 的 flex:1 空转 → content-holder 的 flex:1 整链塌陷，
             分栏左右仍不能独立滚动（12.10 只锁了 CSS 链，漏了这里）。 */
          display: "flex",
          flexDirection: "column",
          /* v0.5.0-beta.12（用户反馈第二轮：容器过宽）：overflowX 锁死——宽叶子不撑出横向滚动，容器恒=视口宽；
             配合 scoped CSS min-width:0 断 flex/grid 撑宽链。 */
          overflowY: "auto",
          overflowX: "hidden",
          maxWidth: "100%",
          paddingTop: 12,
        }}
      >
      <antd.Tabs
        renderTabBar={() => null}
        activeKey={tab}
        onChange={setTab}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        items={[
          {
            key: "home",
            label: `🏠 ${tr("首页")}`,
            children: (
              <HomePage
                rooms={rooms}
                config={config}
                workflowEvents={workflowEvents}
                workerTree={workerTree}
                // 首页是 chat tab 之外：点房间必须 setTab("chat")+openRoom
                //（与通知中心 handleGotoRoom 同模式，跳转修复）。
                onOpenRoom={(roomId) => {
                  setTab("chat");
                  void openRoom(roomId);
                }}
                onGotoTab={(tabKey) => setTab(tabKey)}
                managers={adminData?.managers}
                onDm={(mxid, roomId) => void handleDm(mxid, roomId)}
                treeSource={treeSource}
                inboxUnread={inboxUnread}
                onGlobalSearch={() => setGlobalSearchOpen(true)}
              />
            ),
          },
          {
            key: "chat",
            label: `💬 ${tr("聊天")}`,
            children: chatTabChildren,
          },
          {
            key: "inbox",
            label: (
              <span>
                🔔 {tr("通知")}
                {inboxUnread > 0 ? (
                  <antd.Badge
                    count={inboxUnread}
                    overflowCount={99}
                    size="small"
                    style={{ marginLeft: 6, backgroundColor: "#FF7F16" }}
                  />
                ) : null}
              </span>
            ),
            children: (
              <NotificationCenter
                onUnreadCount={setInboxUnread}
                onGotoApprovals={() => setTab("home")}
                onGotoRoom={(roomId) => handleGotoRoom(roomId)}
                refreshTick={notifyTick}
                // v0.5.0-beta.12：邀请区数据 + 跳团队概览（邀请接受/拒绝
                // UI 在那里；chat tab 需无激活房间才显示 TeamOverview）。
                invites={invites}
                onGotoInvites={() => {
                  setActiveRoom(null);
                  setTab("chat");
                }}
              />
            ),
          },
          {
            key: "workflow",
            label: `🔀 ${tr("工作流")}`,
            children: (
              <WorkflowBoard
                events={workflowEvents}
                loading={workflowLoading}
                onRefresh={() => void refreshWorkflow()}
                highlightRunId={selectedRunId}
                source={workflowSource}
                failReason={workflowFailReason}
                failDetail={workflowFailDetail}
                view={wfMem.view as WfView}
                onViewChange={(v) => setWfMem({ view: v })}
                topoRun={wfMem.topoRun}
                onTopoRunChange={(runId) => setWfMem({ topoRun: runId })}
              />
            ),
          },
          {
            key: "artifacts",
            label: `📦 ${tr("产物")}`,
            children: <Artifacts rooms={rooms} />,
          },
          {
            key: "team",
            label: `👷 ${tr("团队管理")}`,
            children: (
              <WorkerManage
                teams={workerTree}
                admin={adminData}
                treeLoading={spawnLoading}
                adminLoading={adminLoading}
                onRefreshTree={(silent) => void refreshTree(silent)} /* v0.5.0-beta.12 参数透传：`() =>` 会吃掉 30s 自动刷新的 silent */
                onRefreshAdmin={(silent) => void refreshAdmin(silent)}
                onDm={(mxid, roomId) => void handleDm(mxid, roomId)}
                hasToken={hasCtlToken}
                active={tab === "team"}
                treeSource={treeSource}
                workerSessionByName={workerSessionStates.byName}
                myUserId={config?.matrix?.user_id || ""}
                /* L1 走 controller token（config 或 env）且未配 admin 账号密码 = 无 Higress Console 会话 */
                l1TokenMode={hasCtlToken && !config?.admin_username}
              />
            ),
          },
          {
            key: "knowledge",
            label: `📚 ${tr("知识库")}`,
            children: <KnowledgeBase refreshTick={knowledgeTick} />,
          },
          {
            key: "selfcheck",
            label: `🔍 ${tr("自检")}`,
            children: (
              <SelfCheckTab
                config={config}
                layout={{
                  wide: chatWide,
                  forced: chatForceWide,
                  threshold: CHAT_SPLIT_MIN_CONTAINER_W,
                }}
              />
            ),
          },
          {
            key: "ops",
            label: `🛠️ ${tr("运维")}`,
            children: (
              <OpsPanel refreshTick={opsTick} />
            ),
          },
          {
            key: "models",
            label: `🧠 ${tr("模型")}`,
            children: <ModelsTab />,
          },
          {
            key: "settings",
            label: `⚙️ ${tr("配置")}`,
            children: (
              <SettingsTab
                onLoginSuccess={onLoginSuccess}
                config={config}
                onConfigChange={() => void refreshConfig()}
                chatForceWide={chatForceWide}
                onChatForceWideChange={setChatForceWidePersist}
              />
            ),
          },
        ]}
      />
      </div>
      {/* 跨房间消息搜索：点击结果 → 打开房间 + 定位事件；
          ：群名搜索（微信式）→ 点击直达房间 */}
      <MessageSearch
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        onOpenRoom={(roomId, eventId) =>
          handleGlobalSearchOpenRoom(roomId, eventId)
        }
        rooms={rooms}
        onOpenRoomOnly={(roomId) => {
          setTab("chat");
          openRoom(roomId);
        }}
      />
      {/* 项目文件面板（产物端点 版：任务结果/任务书/交付物） */}
      <antd.Drawer
        title={tr("项目文件")}
        open={projectFilesRoom !== null}
        onClose={() => setProjectFilesRoom(null)}
        width={440}
        destroyOnClose
      >
        <ProjectFiles
          room={projectFilesRoom}
          workflowEvents={workflowEvents}
          onClose={() => setProjectFilesRoom(null)}
        />
      </antd.Drawer>
    </main>
    </antd.ConfigProvider>
  );
}
