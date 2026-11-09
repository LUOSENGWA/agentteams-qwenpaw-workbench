// Controller 管理员 token 门（双认证）：新 Controller（#1573+）Matrix L1
// 直接可用；旧 Controller 1.2.6 或 Matrix 身份被拒时才需要管理员 token。
// 自动弹出仅限 controllerAuth.tokenRequired；L2/L3 只给非阻塞提示，
// 网络失败只显示连接错误（绝不把网络错误伪装成 token 问题）。

import type * as ReactNS from "react";

import { verifyAdmin } from "../api";
import type { ControllerAuthStatus, WorkbenchConfig } from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const { message } = antd;

const DISMISS_KEY = "agentteams-qwenpaw-workbench:controller-token-dismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(v: boolean): void {
  try {
    if (v) window.sessionStorage.setItem(DISMISS_KEY, "1");
    else window.sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    /* storage 不可用：仅本次会话内存态 */
  }
}

export default function ControllerTokenGate({
  auth,
  config,
  onVerified,
  onRefresh,
}: {
  auth: ControllerAuthStatus | null;
  config: WorkbenchConfig | null;
  // 验证成功：清弹窗 + 刷新能力/配置（调用方负责 refetch）。
  onVerified: () => void;
  onRefresh: () => void;
}) {
  const tr = useT();
  const t = useThemeColors();
  const [manualOpen, setManualOpen] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(readDismissed);
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const state = auth?.state || "";
  const tokenRequired =
    !!auth && auth.tokenRequired && state !== "matrix_l1" && state !== "unreachable";
  // 已保存的 token 实测失效/无权限：弹框文案要说清「重新粘贴」，
  // 而不是复述旧版 Controller 的通用提示。
  const tokenInvalid =
    !!auth && auth.controllerTokenConfigured && auth.controllerTokenValid === false;
  // 换 Matrix 账号 = 重新判定能力：清掉本会话的「稍后」印记。
  // 首帧只记录当前身份，不重置（否则 sessionStorage 里的「稍后」白存）。
  const userId = config?.matrix?.user_id || "";
  const lastUserRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (lastUserRef.current === null) {
      lastUserRef.current = userId;
      return;
    }
    if (lastUserRef.current === userId) return;
    lastUserRef.current = userId;
    setDismissed(false);
    writeDismissed(false);
  }, [userId]);

  const open = manualOpen || (tokenRequired && !dismissed);

  const dismiss = React.useCallback(() => {
    setManualOpen(false);
    setDismissed(true);
    writeDismissed(true);
  }, []);

  const doVerify = React.useCallback(async () => {
    const value = token.trim();
    if (!value) {
      message.warning(tr("请粘贴 Controller 管理员 token"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await verifyAdmin({ controller_token: value });
      if (!res.ok) {
        setError(res.error || tr("验证失败"));
        return;
      }
      setToken("");
      setManualOpen(false);
      setDismissed(false);
      writeDismissed(false);
      message.success(
        res.message || tr("验证通过（{mode}）", { mode: tr("管理员 token") }),
      );
      onVerified();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [token, tr, onVerified]);

  if (!auth) return null;

  const scopedNote = state === "matrix_scoped";
  const showNote = scopedNote || (tokenRequired && dismissed) || state === "unreachable";

  return (
    <>
      {showNote ? (
        <antd.Alert
          type={state === "unreachable" || tokenInvalid ? "warning" : "info"}
          showIcon
          style={{ flex: "0 0 auto" }}
          message={
            state === "unreachable"
              ? tr("Controller 连接失败")
              : tokenInvalid
                ? tr("已保存的 Controller token 已失效或无权限")
                : scopedNote
                  ? tr("当前 Matrix 账号是 L2/L3；管理员功能需要 L1 或 Controller token")
                  : tr("管理功能需要 Controller 管理员 token")
          }
          description={
            state === "unreachable"
              ? tr(
                  "无法访问 Controller /api/v1/me——请检查 Controller 地址与网络后重试（这不是 token 问题，暂不弹出 token 输入）。",
                )
              : tokenInvalid
                ? tr("已保存的 Controller token 已失效或没有管理员权限；请重新粘贴。")
                : scopedNote
                  ? tr(
                      "只读数据面可继续使用；CRD 管理/全量视图/日志等管理员功能需要 L1 Matrix 账号或 Controller 管理员 token。",
                    )
                  : undefined
          }
          action={
            state === "unreachable" ? (
              <antd.Button size="small" onClick={onRefresh}>
                {tr("重试")}
              </antd.Button>
            ) : (
              <antd.Button size="small" onClick={() => setManualOpen(true)}>
                {tr("输入 Controller token")}
              </antd.Button>
            )
          }
        />
      ) : null}

      <antd.Modal
        open={open}
        title={tr("Controller 管理员 token")}
        okText={tr("验证并保存")}
        cancelText={tr("稍后")}
        confirmLoading={busy}
        onOk={() => void doVerify()}
        onCancel={() => {
          if (!busy) dismiss();
        }}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 10, fontSize: 12.5 }}>
          <span style={{ lineHeight: 1.7 }}>
            {tokenInvalid
              ? tr("已保存的 Controller token 已失效或没有管理员权限；请重新粘贴。")
              : state === "legacy"
                ? tr(
                    "Matrix 登录成功。当前 Controller 1.2.6 的管理功能仍需要 Controller 管理员 token。",
                  )
                : state === "matrix_invalid"
                  ? tr(
                      "Matrix 身份未被 Controller 接受；可输入 Controller 管理员 token 继续。",
                    )
                  : tr(
                      "当前 Matrix 账号是 L2/L3；管理员功能需要 L1 或 Controller token。",
                    )}
          </span>
          <antd.Input.Password
            value={token}
            placeholder={tr("粘贴 Controller 管理员 token")}
            aria-label={tr("Controller 管理员 token")}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setToken(e.target.value)
            }
            onPressEnter={() => void doVerify()}
          />
          {error ? (
            <span
              style={{
                color: t.mode === "dark" ? "#ff7875" : "#cf1322",
                lineHeight: 1.6,
              }}
            >
              {tr("验证失败：{err}", { err: error })}
            </span>
          ) : null}
          <span style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.6 }}>
            {tr("获取命令（在 Controller 宿主机执行，复制输出粘贴到上方）：")}
            <code
              style={{
                display: "block",
                marginTop: 4,
                padding: "3px 6px",
                background: t.mode === "dark" ? "rgba(255,255,255,0.08)" : "#f5f5f5",
                borderRadius: 4,
                fontSize: 11,
                userSelect: "all",
                overflowWrap: "anywhere",
              }}
            >
              docker exec agentteams-controller cat /var/run/agentteams/cli-token
            </code>
          </span>
        </div>
      </antd.Modal>
    </>
  );
}
