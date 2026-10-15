// 审计（A7）——Controller 持久审计事件只读面板。
//
// 数据面 = 上游 #1270 `GET /api/v1/audit`（Controller MinIO JSONL 追加式
// 持久存储读侧，覆盖全部入口：dashboard / CLI / API；keyset 分页，
// 时间倒序）。插件无 BFF 层——前端经连接器 catch-all 直透传，作用域
// 由 Controller 服务端强制（L1 全量 / L2 ?team= 必填且跨团队 404 反探测）。
//
// 与 dashboard B6（audit-section）语义对齐但数据路径不同：dashboard 走
// 自家 BFF（controller + 本地 JSONL 双源归一化）；插件只有 controller
// 单源（无本地 JSONL），故无 source 徽标，404=旧 Controller 无端点的
// 版本门诚实占位（插件既有模式）。
import { HistoryIcon, RefreshIcon, WarnIcon } from "./icons";
import type * as ReactNS from "react";

import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import {
  fetchAuditEvents,
  fetchControllerJson,
  httpErrorStatus,
  httpErrorDetail,
  type AuditEvent,
} from "../api";
import { usePoller } from "../usePoller";
import { useTabActive } from "../tabActivity";
import { WbTooltip } from "./WbTooltip";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

// ── 事件类型（kind）过滤选项：四个已知类目 + 未知 action 透传为自身 ──
const KIND_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "capability", label: "能力授权" },
  { value: "approval_level", label: "审批级别" },
  { value: "channel", label: "频道" },
  { value: "source", label: "来源" },
];

// ── 时间范围（from=now−range，to=now；"all"=不带时间界）──
const RANGE_OPTIONS = [
  { value: "1d", label: "最近 1 天" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "all", label: "全部时间" },
];

const RANGE_MS: Record<string, number> = {
  "1d": 86400_000,
  "7d": 7 * 86400_000,
  "30d": 30 * 86400_000,
};

function rangeFrom(r: string): string | undefined {
  const ms = RANGE_MS[r];
  if (!ms) return undefined;
  return new Date(Date.now() - ms).toISOString();
}

// ── RFC3339 ts → 本地 MM-DD HH:mm:ss（审计看时间粒度到天秒足够）──
function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

// ── 严重度派生（controller 事件无 severity 字段——从 action 语义推导，
// 与 dashboard B6 归一化同思路）：失败/拒绝=错误，授权/级别/频道变更=
// 警告（治理变更），其余=信息。──
function severityOf(ev: AuditEvent): "info" | "warning" | "error" {
  const a = (ev.action || "").toLowerCase();
  // 失败/拒绝/撤销/删除 = 错误（治理破坏性动作）。
  if (
    a.endsWith("-failed") ||
    a.includes("deny") ||
    a.includes("revoke") ||
    a.includes("delete") ||
    a.includes("remove")
  )
    return "error";
  // 授权/增改/写入 = 警告（治理变更，如 capability grant、凭据写入、级别变更）。
  if (
    a.includes("grant") ||
    a.includes("add") ||
    a.includes("change") ||
    a.includes("set") ||
    a.includes("update") ||
    a.includes("create") ||
    a.includes("write") ||
    a.includes("edit")
  )
    return "warning";
  // 读取/回读等只读动作 = 信息。
  return "info";
}

function AuditLog({ hasToken }: { hasToken: boolean }) {
  const t = useThemeColors();
  const tr = useT();
  const active = useTabActive("audit");

  const [kind, setKind] = React.useState("");
  const [range, setRange] = React.useState("7d");
  const [team, setTeam] = React.useState("");
  const [teamOptions, setTeamOptions] = React.useState<string[]>([]);
  const [events, setEvents] = React.useState<AuditEvent[]>([]);
  // 分页游标走 ref（不进依赖链）：cursor 进 state 会让 fetchPage 身份变化
  // → 首屏 effect 重跑 → 「加载更多」后又被重置回首页。hasMore=纯 UI 触发器。
  const cursorRef = React.useRef<string | undefined>(undefined);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false); // 404=旧 Controller
  const [denied, setDenied] = React.useState(false); // 403=身份不允许
  const [errText, setErrText] = React.useState("");

  // 团队选项：controller 按调用者作用域返回可访问团队（L1=全部，L2=本团队）
  // ——同款「token 即作用域边界」语义，前端无需再判。
  const loadTeams = React.useCallback(async () => {
    try {
      const data = (await fetchControllerJson<unknown>("/teams")) as {
        teams?: { name?: string }[];
      };
      const names = (data.teams ?? [])
        .map((x) => x.name ?? "")
        .filter(Boolean);
      setTeamOptions(names);
      // L2 默认锁定首个可访问团队（服务端强制 ?team= 必填）；L1 留空=全部。
      setTeam((prev) => {
        if (prev && names.includes(prev)) return prev;
        if (!hasToken) return names[0] ?? "";
        return prev;
      });
    } catch {
      // 团队列表失败不阻塞——audit 本身按现有 team 值继续。
    }
  }, [hasToken]);

  const fetchPage = React.useCallback(
    async (isMore: boolean) => {
      if (isMore) setLoadingMore(true);
      else setLoading(true);
      setErrText("");
      try {
        const page = await fetchAuditEvents({
          team: team || undefined,
          kind: kind || undefined,
          from: rangeFrom(range),
          cursor: isMore ? cursorRef.current : undefined,
          limit: 50,
        });
        cursorRef.current = page.cursor;
        setHasMore(Boolean(page.cursor));
        setEvents((prev) => (isMore ? [...prev, ...(page.events ?? [])] : page.events ?? []));
        setNotFound(false);
        setDenied(false);
      } catch (e) {
        const st = httpErrorStatus(e);
        if (st === 404) {
          setNotFound(true);
          setEvents([]);
        } else if (st === 403) {
          setDenied(true);
          setEvents([]);
        } else {
          setErrText(httpErrorDetail(e) || `HTTP ${st ?? "?"}`);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [team, kind, range],
  );

  // 首次 + 过滤条件变化 → 重置游标 + 重取首页。
  React.useEffect(() => {
    void loadTeams();
  }, [loadTeams]);
  React.useEffect(() => {
    cursorRef.current = undefined;
    setHasMore(false);
    if (notFound || denied) return; // 版本门/权限门不再轮询
    void fetchPage(false);
  }, [fetchPage, notFound, denied]);

  // 30s 自动刷新（tab 激活门控，切走即停）。
  usePoller({
    fn: () => {
      if (!notFound && !denied) void fetchPage(false);
    },
    intervalMs: 30000,
    active,
  });

  if (notFound) {
    return (
      <div style={{ padding: 24 }}>
        <antd.Alert
          type="info"
          showIcon
          icon={<HistoryIcon size={15} style={{ transform: "translateY(2px)" }} />}
          message={tr("当前 Controller 版本暂无审计端点")}
          description={tr(
            "审计读取依赖上游 GET /api/v1/audit（#1270，MinIO 持久审计存储）。升级 Controller 后本页自动可用，无需插件改动。",
          )}
        />
      </div>
    );
  }

  if (denied) {
    return (
      <div style={{ padding: 24 }}>
        <antd.Alert
          type="warning"
          showIcon
          icon={<WarnIcon size={15} style={{ transform: "translateY(2px)" }} />}
          message={tr("当前身份无权读取审计事件")}
          description={tr(
            "审计读取要求 L1（admin/manager）或 L2（团队负责人/本团队 human）。worker 身份被 Controller 默认拒绝。",
          )}
        />
      </div>
    );
  }

  const SEV_META = {
    info: { label: tr("信息"), color: "#389e0d", bg: "rgba(82,196,26,.12)" },
    warning: { label: tr("警告"), color: "#d48806", bg: "rgba(250,173,20,.14)" },
    error: { label: tr("错误"), color: "#cf1322", bg: "rgba(255,77,79,.12)" },
  } as const;

  const columns = [
    {
      title: tr("时间"),
      dataIndex: "ts",
      width: 130,
      render: (v: string) => (
        <span style={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}>
          {fmtTs(v)}
        </span>
      ),
    },
    {
      title: tr("操作者"),
      dataIndex: "actor",
      width: 120,
      render: (v: string) => <span style={{ fontWeight: 600 }}>{v || "—"}</span>,
    },
    {
      title: tr("类型"),
      dataIndex: "kind",
      width: 100,
      render: (v: string) => (
        <antd.Tag style={{ marginInlineEnd: 0 }}>{v || "—"}</antd.Tag>
      ),
    },
    {
      title: tr("对象"),
      dataIndex: "target",
      width: 160,
      render: (_: unknown, ev: AuditEvent) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {ev.target || "—"}
          </div>
          {ev.targetTeam ? (
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("团队")}：{ev.targetTeam}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: tr("动作"),
      dataIndex: "action",
      width: 180,
      render: (v: string) => (
        <span style={{ fontFamily: "monospace", fontSize: 12 }}>
          {v || "—"}
        </span>
      ),
    },
    {
      title: tr("变更"),
      key: "diff",
      width: 200,
      render: (_: unknown, ev: AuditEvent) => {
        if (!ev.before && !ev.after) return <span style={{ color: t.textSecondary }}>—</span>;
        const b = (ev.before ?? []).join(", ");
        const a = (ev.after ?? []).join(", ");
        return (
          <WbTooltip title={`${b} → ${a}`}>
            <span style={{ fontSize: 12, color: t.textSecondary, overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>
              {ev.capability ? ev.capability + "：" : ""}
              {b || "∅"} → {a || "∅"}
            </span>
          </WbTooltip>
        );
      },
    },
    {
      title: tr("详情"),
      dataIndex: "detail",
      render: (v: string, ev: AuditEvent) => {
        const sev = SEV_META[severityOf(ev)];
        return (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                fontWeight: 600,
                color: sev.color,
                background: sev.bg,
                borderRadius: 10,
                padding: "1px 8px",
                lineHeight: "18px",
              }}
            >
              {sev.label}
            </span>
            <span
              style={{
                fontSize: 12,
                color: t.textSecondary,
                wordBreak: "break-word",
                whiteSpace: "pre-wrap",
              }}
            >
              {v || "—"}
            </span>
          </div>
        );
      },
    },
  ];

  return (
    <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12, minHeight: 0, height: "100%", boxSizing: "border-box" }}>
      {/* 过滤行 */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <HistoryIcon size={15} style={{ color: t.textSecondary }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>{tr("审计日志")}</span>
        {!hasToken ? (
          <antd.Tag color="blue" style={{ marginInlineEnd: 0 }}>
            {tr("视图限定本团队")}
          </antd.Tag>
        ) : null}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <antd.Select
            size="small"
            value={team}
            onChange={setTeam}
            style={{ minWidth: 140 }}
            options={[
              { value: "", label: tr("全部团队") },
              ...teamOptions.map((n) => ({ value: n, label: n })),
            ]}
            disabled={!hasToken && teamOptions.length > 1}
          />
          <antd.Select
            size="small"
            value={kind}
            onChange={setKind}
            style={{ minWidth: 110 }}
            options={KIND_OPTIONS.map((o) => ({
              value: o.value,
              label: tr(o.label),
            }))}
          />
          <antd.Select
            size="small"
            value={range}
            onChange={setRange}
            style={{ minWidth: 110 }}
            options={RANGE_OPTIONS.map((o) => ({
              value: o.value,
              label: tr(o.label),
            }))}
          />
          <antd.Button
            size="small"
            icon={<RefreshIcon size={13} />}
            loading={loading}
            onClick={() => void fetchPage(false)}
          >
            {tr("刷新")}
          </antd.Button>
        </div>
      </div>

      {errText ? (
        <antd.Alert type="error" showIcon message={errText} />
      ) : null}

      {/* 事件表 */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {loading && events.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: t.textSecondary }}>
            <antd.Spin />
          </div>
        ) : events.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: t.textSecondary, fontSize: 13 }}>
            {tr("暂无审计事件")}
            {!hasToken ? (
              <div style={{ fontSize: 12, marginTop: 6 }}>
                {tr("视图已限定为本团队范围内的治理事件")}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <antd.Table
              rowKey={(ev: AuditEvent) => `${ev.ts}-${ev.actor}-${ev.action}-${ev.target}`}
              size="small"
              pagination={false}
              columns={columns as never}
              dataSource={events}
              scroll={{ x: "max-content" }}
            />
            {hasMore ? (
              <div style={{ textAlign: "center", padding: "10px 0 4px" }}>
                <antd.Button
                  size="small"
                  loading={loadingMore}
                  onClick={() => void fetchPage(true)}
                >
                  {tr("加载更多")}
                </antd.Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export default AuditLog;
