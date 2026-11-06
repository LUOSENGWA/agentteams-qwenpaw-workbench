/**
 * PeopleSection.tsx — 「管理」页人员管理域（方案 §4.3，P5）。
 *
 * 栏职责（方案 §4.3，15.35 迭代）：
 * - mid:   人员列表（搜索：名字/MXID）；行 = 头像 + 名字 + 可访问团队数
 * - right: 选中人员 → 入口卡「访问与权限」（HumanAccessModal chips
 *          单模态：权限档位 + 可访问团队/Worker chips，一次保存全字段；
 *          旧团队访问矩阵与旧权限弹窗随 15.35 退役——两者同改
 *          accessibleTeams 的重叠已消除）+ 入口卡「工作区容量配额」（Q：
 *          用量展示 + 设置/清除（admin）；选中人员才拉 getQuota，不预取）
 * - full:  本域不用（竖屏右栏内容走 right variant 推二级页）
 *
 * 权限：本域整体是 L1 管理面——人员列表/访问与权限都依赖 admin
 * 数据，admin 只在有 Controller 管理员 token 时取数 → L2 身份（Matrix
 * token、无 admin token）显引导 Alert，写入口天然
 * 隐藏（不存在"有 admin 数据但无 token"的稳态）。
 *
 * 复用（零逻辑分叉）：
 * - useHumanCrd（入口锚点 permHuman/openPerm）+ HumanAccessModal 与 CRD
 *   域（CrdSection）、CrdManage 各持一份实例（state 局部化，同一组件实现）。
 * - 头像源 = data.rooms 房间成员表（mxid → avatar_url，取不到首字母兜底，
 *   与团队域同源）。
 */
import type * as ReactNS from "react";

import {
  deleteHuman,
  getQuota,
  quotaBytesToMb,
  quotaMbToBytes,
  setQuota,
  type QuotaResponse,
  type TeamMember,
  type TeamRoom,
} from "../api";
import { useThemeColors, type ThemeColors } from "../theme";
import { useT } from "../i18n";
import HumanAccessModal, {
  computeStandaloneWorkers,
} from "../crdmanage/HumanAccessModal";
import { useHumanCrd } from "../crdmanage/useHumanCrd";
import { LEVEL_META } from "../crdmanage/types";
import { MxcAvatar } from "../MxcAvatar";
import TruncatedId from "../components/TruncatedId";
import { BoxIcon, SearchIcon, ShieldIcon, UsersIcon } from "../components/icons";
import { fmtBytes, hfErrorText } from "./FilesSection";
import type { ManageSectionProps } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

type SubProps = Omit<ManageSectionProps, "cols" | "variant"> & {
  t: ReturnType<typeof useThemeColors>;
  tr: (s: string, v?: Record<string, string | number>) => string;
};

/** 房间成员头像表（mxid → TeamMember）——与团队域 TeamSection 同源口径。 */
function buildRoomAvatars(rooms?: TeamRoom[]): Map<string, TeamMember> {
  const m = new Map<string, TeamMember>();
  for (const r of rooms ?? []) {
    for (const [mxid, mem] of Object.entries(r.members || {})) m.set(mxid, mem);
  }
  return m;
}

/** 右栏入口卡按钮样式（与 CRD 域入口卡同款）。 */
function entryStyle(t: ThemeColors): ReactNS.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    minHeight: 44,
    padding: "10px 12px",
    textAlign: "left",
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    background: t.cardBg,
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  };
}

export default function PeopleSection({ nav, cols, data, variant }: ManageSectionProps) {
  const t = useThemeColors();
  const tr = useT();
  // L1 门控（人员域整体 = L1 管理面，见头注）。
  if (!(data.hasToken && data.admin)) {
    return (
      <div style={{ display: "grid", gap: 8, padding: 12 }}>
        <antd.Alert
          type="info"
          showIcon
          message={tr("人员管理需要 Controller 管理员 token（L1）")}
          description={tr("到设置页填 Controller 地址 + 管理员 token 后可查看人员列表、配置团队访问与权限。")}
        />
      </div>
    );
  }
  if (variant === "l1") {
    // 四栏 L1：人员列表常驻（选中行高亮 = PeopleList 既有 sel 态）。
    return <PeopleList nav={nav} data={data} t={t} tr={tr} />;
  }
  if (variant === "mid") {
    // 四栏 mid：详情（列表已移 L1 列）；2/3 栏 mid = 列表。
    if (cols === 4) {
      if (nav.selectedHuman) {
        return <PeopleDetail nav={nav} data={data} t={t} tr={tr} />;
      }
      return (
        <div style={{ display: "grid", gap: 8, padding: 12, textAlign: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
            {tr("选择人员")}
          </span>
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("点左侧列表中的人员配置团队访问与权限")}
          </span>
        </div>
      );
    }
    return <PeopleList nav={nav} data={data} t={t} tr={tr} />;
  }
  if (variant === "right") {
    // 四栏 right：无更深一层（详情在中栏，访问与权限弹窗打开）。
    if (cols === 4) {
      return (
        <div style={{ display: "grid", gap: 8, padding: 12, textAlign: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
            {tr("无更深一层")}
          </span>
          <span style={{ fontSize: 12, color: t.textSecondary }}>
            {tr("人员详情在中栏（访问与权限弹窗打开）")}
          </span>
        </div>
      );
    }
    return <PeopleDetail nav={nav} data={data} t={t} tr={tr} />;
  }
  return null;
}

// ── mid：人员列表（搜索：名字/显示名/MXID；行 = 头像+名字+可访问团队数）──

function PeopleList({ nav, data, t, tr }: SubProps) {
  const [query, setQuery] = React.useState("");
  const humans = data.admin?.humans ?? [];
  const roomAvatars = React.useMemo(
    () => buildRoomAvatars(data.rooms),
    [data.rooms],
  );

  const q = query.trim().toLowerCase();
  const rows = React.useMemo(
    () =>
      q
        ? humans.filter(
            (h) =>
              h.name.toLowerCase().includes(q) ||
              (h.displayName || "").toLowerCase().includes(q) ||
              (h.matrixUserID || "").toLowerCase().includes(q),
          )
        : humans,
    [humans, q],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 4 }}>
      <antd.Input
        allowClear
        prefix={<SearchIcon size={14} />}
        placeholder={tr("搜索人员 / MXID…")}
        value={query}
        onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
          setQuery(e.target.value)
        }
        style={{ borderRadius: 8 }}
        aria-label={tr("搜索人员 / MXID")}
      />
      <span style={{ fontSize: 11, color: t.textSecondary }}>
        {tr("共 {n} 人", { n: humans.length })}
      </span>
      {rows.length ? (
        <div style={{ display: "grid", gap: 4 }}>
          {rows.map((h) => {
            const sel = nav.selectedHuman === h.name;
            return (
              <button
                key={h.name}
                type="button"
                onClick={() => nav.selectHuman(h.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 48,
                  padding: "6px 10px",
                  border: sel
                    ? `1px solid ${t.border}`
                    : "1px solid transparent",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: sel ? t.hoverBg : "transparent",
                  textAlign: "left",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  if (!sel) e.currentTarget.style.background = t.hoverBg;
                }}
                onMouseLeave={(e) => {
                  if (!sel) e.currentTarget.style.background = "transparent";
                }}
              >
                <MxcAvatar
                  url={roomAvatars.get(h.matrixUserID)?.avatar_url}
                  size={30}
                >
                  {h.name ? h.name.slice(0, 1) : "?"}
                </MxcAvatar>
                <span
                  style={{
                    minWidth: 0,
                    flex: 1,
                    display: "grid",
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 13,
                        color: t.text,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h.name}
                    </span>
                    {h.displayName ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: t.textSecondary,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h.displayName}
                      </span>
                    ) : null}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: t.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h.matrixUserID || "—"}
                  </span>
                </span>
                <antd.Tag style={{ margin: 0, flexShrink: 0 }}>
                  {tr("可访问 {n} 团队", { n: h.accessibleTeams?.length ?? 0 })}
                </antd.Tag>
              </button>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            padding: "18px 8px",
            textAlign: "center",
            fontSize: 12,
            color: t.textSecondary,
          }}
        >
          {q ? tr("无匹配人员") : tr("暂无人员记录")}
        </div>
      )}
    </div>
  );
}

// ── right：选中人员 → 入口卡（「访问与权限」打开 HumanAccessModal；
// 「工作区容量配额」用量展示 + 设置/清除（admin，Q 从文件区迁入））──

function PeopleDetail({ nav, data, t, tr }: SubProps) {
  const humans = data.admin?.humans ?? [];
  const teams = data.admin?.teams ?? [];
  const workers = data.admin?.workers ?? [];
  const onRefresh = data.onRefreshAdmin ?? (() => undefined);

  // 弹窗状态源（仅本域 active 时挂载；useHumanCrd 无挂载拨号，
  // HumanAccessModal 自持草稿/保存/命令，human=null 时渲染 null）。
  const crd = useHumanCrd({ onRefresh, tr });

  // 删除人员（危险区）——两步确认：Modal 内输入 human 名才放行。
  // hooks 必须在下方 early-return 之前声明（react-hooks/rules）。
  const [delOpen, setDelOpen] = React.useState(false);
  const [delName, setDelName] = React.useState("");
  const [delBusy, setDelBusy] = React.useState(false);

  const roomAvatars = React.useMemo(
    () => buildRoomAvatars(data.rooms),
    [data.rooms],
  );

  const human = nav.selectedHuman
    ? (humans.find((h) => h.name === nav.selectedHuman) ?? null)
    : null;

  // ── 工作区容量配额（Q：设置入口从文件区迁入人员详情）──
  // 选中人员才拉 getQuota（一次；不预取全部人员、无 N+1）；human 切换重置。
  // hooks 必须在下方 early-return 之前声明（react-hooks/rules）。
  const [quota, setQuotaState] = React.useState<QuotaResponse | null>(null);
  const [quotaFailed, setQuotaFailed] = React.useState(false);
  const [quotaOpen, setQuotaOpen] = React.useState(false);
  const [quotaMb, setQuotaMb] = React.useState<number | null>(null);
  const [quotaBusy, setQuotaBusy] = React.useState(false);
  const quotaReqRef = React.useRef(0);
  const selectedName = human ? human.name : null;

  const refreshQuota = React.useCallback(async () => {
    if (!selectedName) return;
    const req = ++quotaReqRef.current;
    try {
      const q = await getQuota(selectedName);
      if (req !== quotaReqRef.current) return; // 过期响应（人员已切换）
      setQuotaState(q);
      setQuotaFailed(false);
    } catch {
      if (req !== quotaReqRef.current) return;
      setQuotaFailed(true);
    }
  }, [selectedName]);

  React.useEffect(() => {
    // human 切换（含取消选中）→ 重置配额态并收起模态框；选中才拉一次。
    setQuotaState(null);
    setQuotaFailed(false);
    setQuotaOpen(false);
    if (selectedName) void refreshQuota();
  }, [selectedName, refreshQuota]);

  // 未选中（或选中项已不在最新数据）→ 占位。
  if (!human) {
    return (
      <div style={{ display: "grid", gap: 8, padding: 12, textAlign: "center" }}>
        <UsersIcon
          size={20}
          style={{ color: t.textSecondary, margin: "0 auto" }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
          {tr("选择人员")}
        </span>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {nav.selectedHuman
            ? tr("所选人员已不在最新数据中——回中栏人员列表重选")
            : tr("点中栏人员行后，这里可配置团队访问与权限")}
        </span>
      </div>
    );
  }

  const level = human.permissionLevel ?? 2;
  const levelMeta = LEVEL_META[level] ?? { label: `L${level}`, color: "default" };

  // 删除 = DELETE /humans/{name}（204）。Controller 侧语义：Matrix 账号
  // 停用 + 强离全部房间；文件区对象保留；不可撤销 → 输入名字二次确认。
  const doDeleteHuman = async () => {
    if (delName.trim() !== human.name) return;
    setDelBusy(true);
    try {
      await deleteHuman(human.name);
      antd.message.success(tr("人员 {name} 已删除", { name: human.name }));
      setDelOpen(false);
      nav.clearPeople();
      void onRefresh(true, true);
    } catch (e) {
      antd.message.error(
        tr("删除失败：{msg}", {
          msg: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        }),
      );
    } finally {
      setDelBusy(false);
    }
  };

  // admin 门（与 FilesSection 同源：hasToken = 已配置 Controller 管理员 token）。
  const isAdmin = !!data.hasToken;

  // 打开配额模态框（admin；点开 = 重试——失败副标题「可点开重试」）。
  const openQuota = () => {
    if (!isAdmin) return;
    setQuotaMb(quota ? quotaBytesToMb(quota.quotaBytes) : null);
    setQuotaOpen(true);
    void refreshQuota();
  };
  const saveQuota = async () => {
    if (!selectedName) return;
    if (typeof quotaMb !== "number" || !Number.isFinite(quotaMb) || quotaMb <= 0) {
      antd.message.warning(tr("请输入有效配额"));
      return;
    }
    setQuotaBusy(true);
    try {
      await setQuota(selectedName, quotaMbToBytes(quotaMb));
      antd.message.success(tr("已保存"));
      setQuotaOpen(false);
      void refreshQuota();
    } catch (e) {
      antd.message.error(hfErrorText(e, tr));
    } finally {
      setQuotaBusy(false);
    }
  };
  const clearQuota = () => {
    if (!selectedName) return;
    antd.Modal.confirm({
      title: tr("清除配额？"),
      content: tr("清除后该人员文件存储无限制。"),
      okText: tr("清除配额"),
      cancelText: tr("取消"),
      onOk: async () => {
        try {
          await setQuota(selectedName, null);
          antd.message.success(tr("已保存"));
          setQuotaOpen(false);
          void refreshQuota();
        } catch (e) {
          antd.message.error(hfErrorText(e, tr));
        }
      },
    });
  };

  // 入口卡副标题：有上限 → 已用/上限；无限制；加载中；失败（可点开重试）。
  const quotaSub = quotaFailed
    ? tr("配额读取失败（可点开重试）")
    : quota
      ? quota.quotaBytes
        ? tr("已用 {a} / 上限 {b}", {
            a: fmtBytes(quota.usedBytes),
            b: fmtBytes(quota.quotaBytes),
          })
        : tr("无限制 · 已用 {a}", { a: fmtBytes(quota.usedBytes) })
      : tr("读取中…");

  return (
    <div style={{ display: "grid", gap: 10, padding: 4 }}>
      {/* 人员头卡 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <MxcAvatar
          url={roomAvatars.get(human.matrixUserID)?.avatar_url}
          size={36}
        >
          {human.name ? human.name.slice(0, 1) : "?"}
        </MxcAvatar>
        <div
          style={{
            minWidth: 0,
            flex: 1,
            display: "grid",
            gap: 2,
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: t.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {human.name}
          </span>
          {human.displayName ? (
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {human.displayName}
            </span>
          ) : null}
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            <TruncatedId value={human.matrixUserID} label="MXID" />
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <antd.Tag color={levelMeta.color}>{levelMeta.label}</antd.Tag>
        <antd.Tag>
          {tr("可访问 {n} 团队", { n: human.accessibleTeams?.length ?? 0 })}
        </antd.Tag>
      </div>

      {/* 入口卡（15.35：原「团队访问配置 + 权限设置」两卡合并；Q：+ 工作区容量配额） */}
      <div style={{ display: "grid", gap: 8 }}>
        <button
          type="button"
          onClick={() => crd.openPerm(human)}
          style={entryStyle(t)}
        >
          <ShieldIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
              {tr("访问与权限")}
            </span>
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {tr("权限档位 / 可访问团队 / 可访问 Worker，一次保存；旧版 Controller 回落生成命令")}
            </span>
          </span>
          <span style={{ color: t.textSecondary, fontSize: 15, flexShrink: 0 }}>
            ›
          </span>
        </button>
        {/* 第二张入口卡：工作区容量配额（Q：用量展示 + 设置/清除；非 admin 只显用量） */}
        <button
          type="button"
          onClick={isAdmin ? openQuota : undefined}
          style={isAdmin ? entryStyle(t) : { ...entryStyle(t), cursor: "default" }}
        >
          <BoxIcon size={16} style={{ color: t.textSecondary, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
              {tr("工作区容量配额")}
            </span>
            <span
              style={{
                fontSize: 11,
                color: t.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {quotaSub}
            </span>
          </span>
          {isAdmin ? (
            <span style={{ color: t.textSecondary, fontSize: 15, flexShrink: 0 }}>
              ›
            </span>
          ) : null}
        </button>
      </div>

      {/* 危险区：删除人员（L1；Controller 仅 admin 放行）——输入名字确认。 */}
      <div style={{ display: "grid", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "red" }}>
          {tr("危险区")}
        </span>
        <antd.Button
          danger
          style={{ minHeight: 44, justifyContent: "flex-start" }}
          onClick={() => {
            setDelName("");
            setDelOpen(true);
          }}
        >
          {tr("删除人员")}
        </antd.Button>
        <span style={{ fontSize: 11, color: t.textSecondary }}>
          {tr("删除 Human CR：Matrix 账号停用并离开全部房间；文件区保留。不可撤销。")}
        </span>
      </div>

      <antd.Modal
        open={delOpen}
        title={tr("删除人员 {name}", { name: human.name })}
        okText={tr("删除")}
        cancelText={tr("取消")}
        okButtonProps={{
          danger: true,
          disabled: delName.trim() !== human.name,
          loading: delBusy,
        }}
        onCancel={() => {
          if (!delBusy) setDelOpen(false);
        }}
        onOk={() => void doDeleteHuman()}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
          <span>
            {tr("删除 Human CR「{name}」？Matrix 账号将停用并离开全部房间；其文件区对象保留。此操作不可撤销。", {
              name: human.name,
            })}
          </span>
          <span style={{ fontSize: 11, color: t.textSecondary }}>
            {tr("输入 {name} 以确认删除", { name: human.name })}
          </span>
          <antd.Input
            value={delName}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setDelName(e.target.value)
            }
            placeholder={human.name}
            onPressEnter={() => void doDeleteHuman()}
            aria-label={tr("输入 {name} 以确认删除", { name: human.name })}
          />
        </div>
      </antd.Modal>

      {/* 工作区容量配额模态框（复用文件区语义：MB 输入 + 保存 / 清除 confirm；admin only） */}
      <antd.Modal
        open={quotaOpen}
        title={tr("设置配额（MB）")}
        okText={tr("保存")}
        cancelText={tr("取消")}
        confirmLoading={quotaBusy}
        onOk={() => void saveQuota()}
        onCancel={() => setQuotaOpen(false)}
        destroyOnClose
      >
        <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
          <antd.InputNumber
            min={1}
            step={100}
            value={quotaMb}
            onChange={(v: unknown) => setQuotaMb(typeof v === "number" ? v : null)}
            addonAfter="MB"
            style={{ width: "100%" }}
            aria-label={tr("配额（MB）")}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <antd.Button danger size="small" onClick={clearQuota}>
              {tr("清除配额")}
            </antd.Button>
          </div>
        </div>
      </antd.Modal>

      {/* 访问与权限弹窗（chips 单模态；human=null 渲染 null = 零后台负载） */}
      <HumanAccessModal
        human={crd.permHuman}
        teamNames={teams.map((x) => x.name)}
        standaloneWorkers={computeStandaloneWorkers(teams, workers)}
        tr={tr}
        t={t}
        onClose={() => crd.setPermHuman(null)}
        onSaved={() => void onRefresh(true)}
      />
    </div>
  );
}
