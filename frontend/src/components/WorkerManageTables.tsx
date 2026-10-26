import type * as ReactNS from "react";

import { imageTag, requestJson, restartManager, updateManagerModel } from "../api";
import type { AdminData, ManagerInfo, WorkerTreeTeam } from "../api";
import { HistoryIcon, MessageIcon as ChatIcon, SettingsIcon, TeamIcon, WarnIcon } from "./icons";
import {
  modelVerdictText,
  useModelUnionOptions,
  validateModelValue,
} from "../modelUnion";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { useWbViewport } from "../WbViewportContext";
import WbTableFade from "./WbTableFade";
import type { WorkerSessionState } from "../workerSessionState";
import { WbTooltip } from "./WbTooltip";
import { phaseMeta, RUNTIME_TAG_COLOR } from "./WorkerManageShared";
import { WorkerRow } from "./WorkerManageTree";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function TeamNode({
  team,
  onDm,
  adminByWorker,
  onLifecycle,
  acting,
  sessionByName,
  l1,
  onOpenSettings,
  onTeamConfig,
}: {
  team: WorkerTreeTeam;
  onDm?: (mxid: string) => void;
  adminByWorker: Map<string, AdminData["workers"][number]>;
  onLifecycle?: (name: string, action: "wake" | "sleep" | "restart") => void;
  acting: string | null;
  /** worker_name → session 状态（行内圆点）。 */
  sessionByName?: Record<string, WorkerSessionState>;
  /** 当前账号 L1（controller token）→ 运行配置面板的
 * L1-only 字段（并发限流/上下文管理/shell 组/auto_title）可编辑。 */
  l1?: boolean;
  /** L1 只读 Alert「去设置」跳转透传。 */
  onOpenSettings?: () => void;
  /** 「N人」右侧齿轮 → 配置团队弹窗（CrdManage 同一
 * 入口）。未传（L1 未登录/管理数据未就绪）= 不渲染齿轮。 */
  onTeamConfig?: (teamName: string) => void;
}) {
  const tr = useT();
  const { narrow } = useWbViewport();
  const [expanded, setExpanded] = React.useState(true);
  const workerCount = team.workers.length;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          // 触屏：整行可点的行高 = 内容 ~22 + 上下 padding——narrow 下
          // 11×2 把行扩到 ≥44px（手指稳定命中展开/收起）；宽屏 6px
          // 原值不变。
          padding: narrow ? "11px 0" : "6px 0",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ width: 14, fontSize: 11, color: "#888" }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ marginRight: 6, display: "inline-flex" }}><TeamIcon size={15} /></span>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{team.team_name}</span>
        <antd.Tag style={{ margin: "0 0 0 8px", fontSize: 11 }}>
          {workerCount} 人
        </antd.Tag>
        {/* 团队配置入口上移——「N人」右侧齿轮，
 打开 CrdManage「配置团队」弹窗（名称/描述/心跳/成员模型，
 与团队表「配置」按钮同一入口）。stopPropagation：点齿轮
 不触发行展开/收起。 */}
        {onTeamConfig ? (
          <WbTooltip
            title={tr("配置团队（名称 / 描述 / 心跳间隔 / 成员模型）")}
           tap={false} >
            <span
              role="button"
              aria-label={tr("配置团队")}
              onClick={(e) => {
                e.stopPropagation();
                onTeamConfig(team.team_name);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                marginLeft: 2,
                color: "#999",
                cursor: "pointer",
                // 触屏：13px 图标 + padding 2 仅 17px 热区——narrow 下
                // 扩到 ~25px（WCAG 2.5.8 下限）；宽屏 2 原值不变。
                padding: narrow ? 6 : 2,
              }}
            >
              <SettingsIcon size={13} />
            </span>
          </WbTooltip>
        ) : null}
        <WbTooltip title={team.room_id}>
          <span
            style={{
              color: "#999",
              fontSize: 11,
              marginLeft: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 260,
            }}
          >
            {team.room_id}
          </span>
        </WbTooltip>
      </div>
      {expanded
        ? team.workers.map((g) => (
            <WorkerRow
              key={g.mxid}
              group={g}
              depth={1}
              onDm={onDm}
              adminWorker={g.worker_name ? adminByWorker.get(g.worker_name) : undefined}
              onLifecycle={onLifecycle}
              acting={acting}
              sessionState={g.worker_name ? sessionByName?.[g.worker_name] : undefined}
              // l1 此前在此层丢失——
              // TeamNode 拿到 l1 却没传给 WorkerRow，运行配置面板恒
              // l1=undefined → 恒「只读」Alert（L1 登录仍见只读）。
              l1={l1}
              onOpenSettings={onOpenSettings}
            />
          ))
        : null}
    </div>
  );
}

/** 长文本单元格：单行截断，点击展开完整内容到 Modal（
 * tableLayout auto 窄屏撑破 → fixed 约束 + 点击展开弹窗）。 */
function ExpandableText({
  items,
  text,
  title,
}: {
  items?: string[];
  text?: string;
  title: string;
}) {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const value = items ? items.join("、") : text || "";
  return (
    <>
      <WbTooltip title={tr("点击展开")} tap={false} >
        <span
          onClick={() => setOpen(true)}
          style={{
            display: "block",
            width: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          {value || "—"}
        </span>
      </WbTooltip>
      <antd.Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={560}
        title={title}
      >
        {items ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {items.map((n) => (
              <antd.Tag key={n}>{n}</antd.Tag>
            ))}
          </div>
        ) : (
          <div style={{ wordBreak: "break-all", lineHeight: 1.8 }}>{text}</div>
        )}
      </antd.Modal>
    </>
  );
}

export function TeamTable({ teams }: { teams: AdminData["teams"] }) {
  const tr = useT();
  // 单一判定：容器可见宽 < 800 = 卡片化（与聊天单栏同源同步，非 window 575 断点）
  const { narrow } = useWbViewport();
  if (narrow) {
    // 窄屏卡片降级（P2）：5 列表格在 390px 挤压不可读 →
    // 每队一张卡（名+状态一行、Leader/Worker 一行、成员 Tag 换行）。
    // 数据层零改动，纯渲染分支。
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(teams || []).map((t) => (
          <div
            key={t.name}
            style={{
              border: "1px solid rgba(128,128,128,0.24)",
              borderRadius: 8,
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <b style={{ fontSize: 13.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.name}
              </b>
              <antd.Tag color={phaseMeta(t.phase).color} style={{ margin: 0 }}>
                {phaseMeta(t.phase).label}
              </antd.Tag>
            </div>
            <div style={{ fontSize: 12, color: "rgba(128,128,128,0.88)" }}>
              {tr("Leader")}: {t.leaderName || "–"} · {tr("Worker")}{" "}
              {t.readyWorkers}/{t.totalWorkers}
            </div>
            {(t.workerNames || []).length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(t.workerNames || []).map((n: string) => (
                  <antd.Tag key={n} style={{ margin: 0, fontSize: 11 }}>
                    {n}
                  </antd.Tag>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }
  return (
    <antd.Table
      rowKey="name"
      size="small"
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: 620 }}
      dataSource={teams}
      columns={[
        {
          title: tr("团队"),
          dataIndex: "name",
          width: 110,
          render: (v: string) => <b>{v}</b>,
        },
        {
          title: tr("状态"),
          dataIndex: "phase",
          width: 90,
          render: (v: string) => (
            <antd.Tag color={phaseMeta(v).color} style={{ margin: 0 }}>
              {phaseMeta(v).label}
            </antd.Tag>
          ),
        },
        { title: "Leader", dataIndex: "leaderName", width: 110 },
        {
          title: tr("Worker"),
          render: (_: unknown, r: AdminData["teams"][number]) =>
            `${r.readyWorkers}/${r.totalWorkers}`,
        
        },
        {
          title: tr("成员"),
          dataIndex: "workerNames",
          width: 240,
          render: (names: string[]) => (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(names || []).map((n) => (
                <antd.Tag key={n} style={{ margin: 0, fontSize: 11 }}>
                  {n}
                </antd.Tag>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

export function HumanTable({ humans }: { humans: AdminData["humans"] }) {
  const tr = useT();
  return (
    <WbTableFade>
    <antd.Table
      rowKey="name"
      size="small"
      pagination={false}
      tableLayout="fixed"
      scroll={{ x: 620 }}
      dataSource={humans}
      columns={[
        {
          title: tr("用户"),
          dataIndex: "name",
          width: 130,
          render: (v: string) => <b>{v}</b>,
        },
        { title: tr("显示名"), dataIndex: "displayName", width: 100 },
        {
          title: tr("状态"),
          dataIndex: "phase",
          width: 80,
          render: (v: string) => (
            <antd.Tag color={phaseMeta(v).color} style={{ margin: 0 }}>
              {phaseMeta(v).label}
            </antd.Tag>
          ),
        },
        {
          title: tr("权限"),
          dataIndex: "permissionLevel",
          width: 90,
          render: (v: number) => (v === 1 ? tr("L1 管理员") : v === 2 ? "L2" : String(v ?? "")),
        },
        {
          title: tr("可访问团队"),
          dataIndex: "accessibleTeams",
          width: 220,
          render: (teams: string[]) => (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(teams || []).map((t) => (
                <antd.Tag key={t} style={{ margin: 0, fontSize: 11 }}>
                  {t}
                </antd.Tag>
              ))}
            </div>
          ),
        },
      ]}
    />
    </WbTableFade>
  );
}

/** Manager 模型选择——与 CrdManage 三入口同一候选并集
 * （SGLang 在服 ∪ 在用 ∪ 网关 alias，../modelUnion）+ 同一写前校验。
 * 写路径 = PUT /managers/{name} {model}（Controller 合并语义，provider 不动）。
 * 面板 hasToken 门控（L1 only）——L2 结构上不可达（插件侧零改动）。 */
/** Manager 详情面板（表格展开行）——image/version/个人房间
 + 私聊直跳（roomID，同款逻辑）+ L1 日志（docker-logs 既有代理，
 零新端点）。wake/sleep = dashboard/插件两端都没有（轮 3 实锤），不做。 */
function ManagerDetail({
  mgr,
  hasToken,
  onDm,
}: {
  mgr: ManagerInfo;
  hasToken?: boolean;
  onDm?: (mxid: string, roomId?: string) => void;
}) {
  const tr = useT();
  const [logs, setLogs] = React.useState<string[] | null>(null);
  const [logsErr, setLogsErr] = React.useState("");
  const [logsLoading, setLogsLoading] = React.useState(false);

  const loadLogs = React.useCallback(async () => {
    setLogsLoading(true);
    setLogsErr("");
    try {
      const data = (await requestJson(
        `/agentteams-proxy/docker-logs/${encodeURIComponent(mgr.name)}?tail=300`,
      )) as {
        lines?: { timestamp: string; level: string; message: string }[];
      };
      setLogs(
        (data.lines || []).map(
          (l) => `${l.timestamp || ""} ${l.level === "error" ? "❌ " : ""}${l.message}`,
        ),
      );
    } catch (e) {
      setLogs(null);
      setLogsErr(
        (e instanceof Error ? e.message : tr("日志拉取失败")) +
          `（容器名按 Manager 名解析，如不符请在运维页查实际容器名）`,
      );
    } finally {
      setLogsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mgr.name]);

  return (
    <div style={{ display: "grid", gap: 10, padding: "4px 8px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          fontSize: 12,
        }}
      >
        <span style={{ color: "#999" }}>{tr("镜像")}</span>
        <ExpandableText text={mgr.image || "—"} title={tr("镜像")} />
        <span style={{ color: "#999" }}>{tr("版本")}</span>
        <ExpandableText text={mgr.version || "—"} title={tr("版本")} />
        <span style={{ color: "#999" }}>MXID</span>
        <ExpandableText text={mgr.matrixUserID || "—"} title="MXID" />
        <span style={{ color: "#999" }}>{tr("个人房间")}</span>
        <ExpandableText text={mgr.roomID || "—"} title={tr("个人房间")} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {onDm && mgr.matrixUserID ? (
          <antd.Button
            size="small"
            onClick={() => onDm(mgr.matrixUserID, mgr.roomID || undefined)}
          >
            <ChatIcon size={13} style={{ verticalAlign: "-2px", marginRight: 3 }} /> {tr("私聊（个人房间）")}
          </antd.Button>
        ) : null}
        {hasToken ? (
          <antd.Button
            size="small"
            loading={logsLoading}
            onClick={() => void loadLogs()}
          >
            <HistoryIcon size={13} style={{ verticalAlign: "-2px", marginRight: 3 }} /> {tr("日志（最近 300 行）")}
          </antd.Button>
        ) : null}
      </div>
      {logsErr ? (
        <div style={{ fontSize: 12, color: "#cf1322" }}>{logsErr}</div>
      ) : null}
      {logs ? (
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: "rgba(0,0,0,0.04)",
            borderRadius: 4,
            fontSize: 11,
            maxHeight: 260,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {logs.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}

/** （竖屏 Manager 表模型列太宽——894px 总宽下 240 模型列
 * 要滚到底才见）：≤700px 视口紧凑列宽（总宽 894→664，模型列 240→180）。 */
function useIsPortrait(): boolean {
  const q = "(max-width: 700px)";
  const [p, setP] = React.useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(q).matches : false,
  );
  React.useEffect(() => {
    const m = window.matchMedia(q);
    const fn = () => setP(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return p;
}

/** 导出供渲染审计（dev-overflow.html）与未来复用。 */
export function ManagerTable({
  managers,
  usedModels,
  onRefreshAdmin,
  l1TokenMode,
  onDm,
  hasToken,
}: {
  managers: AdminData["managers"];
  usedModels: string[];
  onRefreshAdmin?: (silent?: boolean) => void;
  l1TokenMode?: boolean;
  /** 详情面板私聊按钮。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** L1 门控（日志按钮）。 */
  hasToken?: boolean;
}) {
  const tr = useT();
  const t = useThemeColors(); 
  const portrait = useIsPortrait();
  /** 竖屏紧凑列宽（模型列 240→180，总宽 894→664）。 */
  const W = portrait
    ? { mgr: 110, phase: 64, runtime: 72, model: 180, version: 110, tail: 128 }
    : { mgr: 150, phase: 88, runtime: 96, model: 240, version: 150, tail: 170 };
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);
  const [restarting, setRestarting] = React.useState<string | null>(null);
  const union = useModelUnionOptions(usedModels, tr);

  const saveModel = React.useCallback(
    async (name: string, value: string) => {
      const verdict = validateModelValue(value, union.candidates);
      if (verdict.level === "error") {
        antd.message.error(modelVerdictText(tr, verdict, value, union.candidates));
        return;
      }
      setSaving(name);
      try {
        await updateManagerModel(name, value.trim());
        antd.message.success(
          verdict.level === "warn"
            ? tr("已保存（提示：{t}）", { t: modelVerdictText(tr, verdict, value, union.candidates) })
            : tr("Manager 模型已保存（重启容器后生效）"),
        );
        setDrafts((p) => {
          const n = { ...p };
          delete n[name];
          return n;
        });
        onRefreshAdmin?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("保存失败"));
      } finally {
        setSaving(null);
      }
    },
    [union.candidates, onRefreshAdmin, tr],
  );

  return (
    <div>
      {/* token 模式无 Higress Console 会话 → 网关 alias 层不可见（显式提示）。 */}
      {l1TokenMode && union.gatewayLoaded && !union.gatewayAvailable ? (
        <div
          style={{
            fontSize: 12,
            // 深色档亮黄底+深琥珀字在暗页=亮斑+不可读
            // → 半透明琥珀底+亮琥珀字（antd warning 亮向）。
            color: t.mode === "dark" ? "#faad14" : "#ad6800",
            background: t.mode === "dark" ? "rgba(250,173,20,0.10)" : "#fffbe6",
            border: `1px solid ${t.mode === "dark" ? "rgba(250,173,20,0.35)" : "#ffe58f"}`,
            borderRadius: 4,
            padding: "4px 8px",
            marginBottom: 8,
          }}
        >
 <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 5 }}><WarnIcon size={13} style={{ marginTop: 2, flexShrink: 0 }} /> {tr("token 模式无 Higress Console 会话——「Higress alias」分组当前不可见。配置 admin 账号密码后可读；或等待上游支持 controller_token 直连 Higress Console 的 PR 合入。")}</span>
        </div>
      ) : null}
      <WbTableFade>
      <antd.Table
        rowKey="name"
        size="small"
        pagination={false}
        tableLayout="fixed"
 /* （模型列定宽 262 后「左边列被严重
 挤压」——fixed 布局下剩余空间只够喂一个浮动列，列间互相抢宽。
 设计=全列显式定宽 + 横向滚动兜底：谁也不挤压，窄屏出滚动条。
 ≤700px 紧凑列宽（竖屏少滚 230px，模型列提前可见）。 */
        scroll={{ x: W.mgr + W.phase + W.runtime + W.model + W.version + W.tail + 90 }}
        dataSource={managers}
        /* 展开行 = Manager 详情面板（零新端点）。 */
        expandable={{
          expandedRowRender: (mgr: ManagerInfo) => (
            <ManagerDetail mgr={mgr} hasToken={hasToken} onDm={onDm} />
          ),
        }}
        columns={[
          {
            title: tr("Manager"),
            dataIndex: "name",
            width: W.mgr,
            render: (v: string) => <b>{v}</b>,
          },
          {
            title: tr("状态"),
            dataIndex: "phase",
            width: W.phase,
            render: (v: string) => (
              <antd.Tag color={phaseMeta(v).color} style={{ margin: 0 }}>
                {phaseMeta(v).label}
              </antd.Tag>
            ),
          },
 /* ：每个 Manager
 直接显示自己的 runtime（ManagerResponse.runtime，零新端点）。 */
          {
            title: tr("运行时"),
            dataIndex: "runtime",
            width: W.runtime,
            render: (v: string) =>
              v ? (
                <antd.Tag
                  color={RUNTIME_TAG_COLOR[v] ?? "default"}
                  style={{ margin: 0, fontSize: 11 }}
                >
                  {v}
                </antd.Tag>
              ) : (
                "–"
              ),
          },
          /* （纠偏：单列定宽 262 后
 左列反被挤压）：全列定宽方案下模型列=240（170 输入框+保存按钮）。 */
          {
            title: tr("模型"),
            dataIndex: "model",
            width: W.model,
            render: (v: string, mgr: { name: string }) => {
              const draft = drafts[mgr.name] ?? v ?? "";
              const dirty = draft !== (v || "");
              return (
                <antd.Space size={4} wrap={false}>
                  <antd.AutoComplete
                    size="small"
                    style={{ width: 170 }}
                    value={draft}
                    options={union.options}
                    allowClear
                    placeholder={tr("留空=跟随集群默认")}
                    onChange={(val: string) =>
                      setDrafts((p) => ({ ...p, [mgr.name]: val || "" }))
                    }
                  />
                  {dirty ? (
                    <antd.Button
                      size="small"
                      type="link"
                      style={{ padding: 0, height: "auto" }}
                      loading={saving === mgr.name}
                      onClick={() => void saveModel(mgr.name, draft)}
                    >
                      {tr("保存")}
                    </antd.Button>
                  ) : null}
                </antd.Space>
              );
            },
          },
          {
            title: tr("AgentTeams 版本"),
            dataIndex: "version",
            width: W.version,
            /* 10/17 用户纠偏：ManagerResponse.version 实为镜像全串——
  列名改「AgentTeams 版本」+ 显 tag（imageTag 去 registry 前缀），
  悬停看完整镜像。容器内运行时版本在展开详情面板。 */
            render: (v: string) => (
              <WbTooltip
                title={
                  <span style={{ fontFamily: "monospace", wordBreak: "break-all", maxWidth: 320 }}>
                    {v}
                  </span>
                }
              >
                <span style={{ fontFamily: "monospace", fontSize: 11, cursor: "help" }}>
                  {v ? imageTag(v) : "—"}
                </span>
              </WbTooltip>
            ),
          },
          {
            title: tr("操作"),
            key: "actions",
            width: 90,
            render: (_: unknown, mgr: { name: string }) => (
              <antd.Button
                size="small"
                type="link"
                style={{ padding: 0 }}
                loading={restarting === mgr.name}
                onClick={async () => {
                  setRestarting(mgr.name);
                  try {
                    await restartManager(mgr.name);
                    antd.message.success(
                      tr("{name} 重启中（容器重建，约 10-30 秒）", {
                        name: mgr.name,
                      }),
                    );
                    onRefreshAdmin?.(true);
                  } catch (e) {
                    antd.message.error(
                      e instanceof Error ? e.message : tr("操作失败"),
                    );
                  } finally {
                    setRestarting(null);
                  }
                }}
              >
                {tr("重启")}
              </antd.Button>
            ),
          },
          {
            title: "MXID",
            dataIndex: "matrixUserID",
            width: W.tail,
            render: (v: string) => <ExpandableText text={v} title="MXID" />,
          },
        ]}
      />
      </WbTableFade>
    </div>
  );
}

// AgentTeams 集群版本徽章已迁至运维页「集群状态」卡（/cluster-info 统一
// 正源，15.25 用户定案）——此处不再重复显示，避免双显源漂移（W7）。
// per-node 版本仍见 Worker 详情「AgentTeams 版本」列（节点镜像 tag）。

