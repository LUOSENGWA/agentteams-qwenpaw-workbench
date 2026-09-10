import type * as ReactNS from "react";
import { fetchApprovalList, setApprovalLevel } from "../api";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const ReloadIcon = pick("ReloadOutlined");

// ── 8/29 re16：Worker 工具执行安全（QwenPaw 原生四模式对接）────────
// QwenPaw 设置页「工具执行安全」同款四模式（ToolExecutionLevelCard）：
//   关闭 OFF / 自动 AUTO / 智能 SMART / 严格 STRICT。
// 数据源：容器 agent.json（archive 直读，与远端 KB 同通道）；
// 写入：容器内 PUT /api/workspace/running-config（GET→改→整 PUT，
// live 热加载，push_loop 同步 MinIO）。
// 5.0.0-beta.3：抽为共享组件（Worker 管理树 + 聊天房间成员卡两处用）
// + 官方描述块整套搬 + L2 权限提示（401/403 橙色提示不报错）。
// 5.0.0-beta.4：官方 ToolExecutionLevelCard 逐件对齐——
//   ① 四模式图标整套搬（官方 lucide-react：STRICT=Ban / SMART=
//      AlertTriangle / AUTO=Shield / OFF=CircleCheck，ISC，内联 SVG
//      零新依赖，THIRD-PARTY-NOTICES 已注）
//   ② 卡片式选择器（官方 Radio 卡：图标+粗体标签+次级描述，选中
//      边框=模式色 2px，可点整卡）
//   ③ 顶部官方 info 提示行（alertMessage 原文）
//   ④ 描述表 Tag 框重叠修（固定 width:62 装不下「严格（STRICT）」
//      溢出压描述 → 自适应宽度 + nowrap）
// 5.0.0-beta.5：⑤ 删「说明（官方）」折叠块 + 官方控制台演示截图（四档卡片
//   选择器已含官方图标+文案，说明块重复，故去掉）

/** 官方 lucide 图标（ISC，路径逐字取自 lucide：Ban/AlertTriangle/
 *  Shield/CircleCheck）——内联 SVG 避免引入 lucide-react 依赖。 */
function LucideIcon({
  d,
  circle,
  size = 18,
  color,
}: {
  d: string;
  circle?: boolean;
  size?: number;
  color: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {circle ? <circle cx="12" cy="12" r="10" /> : null}
      <path d={d} />
    </svg>
  );
}

const ICON_D: Record<string, { d: string; circle?: boolean }> = {
  // lucide Ban（严格=无条件拦截）
  STRICT: { circle: true, d: "m4.9 4.9 14.2 14.2" },
  // lucide AlertTriangle（智能=中高风险需审批）
  SMART: {
    d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z M12 9v4 M12 17h.01",
  },
  // lucide Shield（自动=默认守护）
  AUTO: {
    d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
  },
  // lucide CircleCheck（关闭=全放行）
  OFF: { circle: true, d: "m9 12 2 2 4-4" },
};

const APPROVAL_LABEL: Record<string, string> = {
  OFF: "关闭",
  AUTO: "自动",
  SMART: "智能",
  STRICT: "严格",
};
// 官方 ToolExecutionLevelCard 四档文案（console/src/locales zh/en 原文）。
const APPROVAL_CARD_LABEL: Record<string, string> = {
  OFF: "关闭模式",
  AUTO: "自动模式",
  SMART: "智能模式",
  STRICT: "严格模式",
};
const APPROVAL_DESC: Record<string, string> = {
  OFF: "关闭所有工具审批，所有工具自动执行",
  AUTO: "仅被明确标记为需要审批的工具才会要求审批（默认）",
  SMART: "低风险工具自动放行，中高风险工具需要审批",
  STRICT: "所有工具调用都需要审批，最高安全级别",
};
const APPROVAL_COLOR: Record<string, string> = {
  OFF: "#52c41a",
  AUTO: "#1890ff",
  SMART: "#faad14",
  STRICT: "#ff4d4f",
};
const LEVEL_ORDER = ["STRICT", "SMART", "AUTO", "OFF"] as const;

function LevelIcon({ lv, size = 18 }: { lv: string; size?: number }) {
  const spec = ICON_D[lv];
  if (!spec) return null;
  return (
    <LucideIcon
      d={spec.d}
      circle={spec.circle}
      size={size}
      color={APPROVAL_COLOR[lv]}
    />
  );
}

/** 官方卡片式四档选择器（ToolExecutionLevelCard Radio 卡同款：
 *  图标+粗体标签+次级描述，整卡可点，选中=模式色 2px 边框）。 */
function LevelCardGrid({
  sel,
  onPick,
}: {
  sel: string;
  onPick: (lv: string) => void;
}) {
  const tr = useT();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
      {LEVEL_ORDER.map((lv) => {
        const active = sel === lv;
        return (
          <div
            key={lv}
            onClick={() => onPick(lv)}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "7px 9px",
              borderRadius: 8,
              border: `1px solid ${
                active ? APPROVAL_COLOR[lv] : "rgba(0,0,0,0.1)"
              }`,
              borderWidth: active ? 2 : 1,
              background: active ? "rgba(0,0,0,0.015)" : "transparent",
              cursor: "pointer",
              transition: "all 0.2s",
              minWidth: 0,
            }}
          >
            <div style={{ marginTop: 2 }}>
              <LevelIcon lv={lv} size={17} />
            </div>
            <div style={{ minWidth: 0, fontSize: 11.5, lineHeight: 1.45 }}>
              <div style={{ fontWeight: 700, fontSize: 12 }}>
                {tr(APPROVAL_CARD_LABEL[lv])}
              </div>
              <div style={{ color: "rgba(0,0,0,0.55)" }}>
                {tr(APPROVAL_DESC[lv])}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ApprovalControl({ workerName }: { workerName: string }) {
  const tr = useT();
  const [level, setLevel] = React.useState<string | null>(null);
  const [readError, setReadError] = React.useState("");
  const [sel, setSel] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // L2 权限提示判定：401/403 = 无 Controller 管理员凭据（上游 docker
  // 代理仅 L1 放行；L2 写路径 = G3 PR 池，合并前只读提示不报错）。
  const isPermError = /401|403|forbidden|unauthorized/i.test(readError);

  const load = React.useCallback(() => {
    setReadError("");
    void fetchApprovalList(workerName)
      .then((d) => {
        const it = d.items.find((x) => x.agent === workerName);
        if (it?.approval_level) {
          setLevel(it.approval_level);
          setSel(it.approval_level);
        } else if (it?.error) {
          setReadError(it.error);
        } else {
          setReadError(tr("该 Worker 未读到 approval_level（容器布局差异）"));
        }
      })
      .catch((e) =>
        setReadError(
          e instanceof Error ? e.message : String(e),
        ),
      );
  }, [workerName, tr]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const apply = React.useCallback(
    async (v: string) => {
      if (!v || v === level) return;
      setBusy(true);
      try {
        const r = await setApprovalLevel(workerName, v);
        setLevel(r.level);
        setSel(r.level);
        antd.message.success(
          `${tr("「{name}」工具执行安全已设为 {lv}（live 生效）", {
            name: workerName,
            lv: APPROVAL_LABEL[r.level] || r.level,
          })}`,
        );
      } catch (e) {
        antd.message.error(
          `${tr("设置失败")}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [level, tr, workerName],
  );

  return (
    <div>
      <div
        style={{
          padding: "8px 10px",
          border: `1px solid rgba(0,0,0,0.06)`,
          borderRadius: 8,
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 6,
          }}
        >
          <span title={tr("QwenPaw 原生「工具执行安全」四模式（设置页同款）")}>
            <LevelIcon lv="AUTO" size={15} />{" "}
            {tr("工具执行安全")}
          </span>
          <span
            style={{
              color: "#1890ff",
              fontSize: 11,
              flexBasis: "100%",
            }}
          >
            ℹ️ {tr("配置工具调用的审批策略，控制智能体执行工具时的安全级别")}
          </span>
        </div>

        {level ? (
          <>
            <LevelCardGrid
              sel={sel || level}
              onPick={(v) => setSel(v)}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              <antd.Tag
                color={APPROVAL_COLOR[level]}
                style={{ margin: 0, fontSize: 11, whiteSpace: "nowrap" }}
              >
                {tr("当前模式")}: {APPROVAL_LABEL[level] || level}（{level}）
              </antd.Tag>
              {sel && sel !== level ? (
                <antd.Button
                  size="small"
                  type="primary"
                  loading={busy}
                  onClick={() => void apply(sel)}
                >
                  {tr("应用")}: {APPROVAL_CARD_LABEL[sel] || sel}
                </antd.Button>
              ) : (
                <span style={{ color: "rgba(0,0,0,0.35)", fontSize: 11 }}>
                  {sel === level ? tr("无变更") : ""}
                </span>
              )}
            </div>
          </>
        ) : readError ? (
          <div
            style={{
              color: isPermError ? "#faad14" : "#ff4d4f",
              fontSize: 11.5,
              padding: "4px 0",
            }}
          >
            {isPermError
              ? tr("L2 账号无权限读取（需 L1 管理员凭据；上游 L2 写路径 PR 合并后自动开放）")
              : `⚠ ${readError}`}
          </div>
        ) : (
          <antd.Spin size="small" />
        )}

        <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
          <antd.Button
            size="small"
            type="text"
            icon={<ReloadIcon />}
            onClick={() => void load()}
          />
        </div>
      </div>
    </div>
  );
}

export default ApprovalControl;
