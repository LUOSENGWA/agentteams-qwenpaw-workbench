/**
 * PeopleSection.tsx — 「管理」页人员管理域（方案 §4.3，P5）。
 *
 * 栏职责（方案 §4.3，15.35 迭代）：
 * - mid:   人员列表（搜索：名字/MXID）；行 = 头像 + 名字 + 可访问团队数
 * - right: 选中人员 → 单入口卡「访问与权限」（HumanAccessModal chips
 *          单模态：权限档位 + 可访问团队/Worker chips，一次保存全字段；
 *          旧团队访问矩阵与旧权限弹窗随 15.35 退役——两者同改
 *          accessibleTeams 的重叠已消除）
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

import type { TeamMember, TeamRoom } from "../api";
import { useThemeColors, type ThemeColors } from "../theme";
import { useT } from "../i18n";
import HumanAccessModal, {
  computeStandaloneWorkers,
} from "../crdmanage/HumanAccessModal";
import { useHumanCrd } from "../crdmanage/useHumanCrd";
import { LEVEL_META } from "../crdmanage/types";
import { MxcAvatar } from "../MxcAvatar";
import TruncatedId from "../components/TruncatedId";
import { SearchIcon, ShieldIcon, UsersIcon } from "../components/icons";
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

export default function PeopleSection({ nav, data, variant }: ManageSectionProps) {
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
  if (variant === "mid") {
    return <PeopleList nav={nav} data={data} t={t} tr={tr} />;
  }
  if (variant === "right") {
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

// ── right：选中人员 → 单入口卡（「访问与权限」打开 HumanAccessModal）──

function PeopleDetail({ nav, data, t, tr }: SubProps) {
  const humans = data.admin?.humans ?? [];
  const teams = data.admin?.teams ?? [];
  const workers = data.admin?.workers ?? [];
  const onRefresh = data.onRefreshAdmin ?? (() => undefined);

  // 弹窗状态源（仅本域 active 时挂载；useHumanCrd 无挂载拨号，
  // HumanAccessModal 自持草稿/保存/命令，human=null 时渲染 null）。
  const crd = useHumanCrd({ onRefresh, tr });

  const roomAvatars = React.useMemo(
    () => buildRoomAvatars(data.rooms),
    [data.rooms],
  );

  const human = nav.selectedHuman
    ? (humans.find((h) => h.name === nav.selectedHuman) ?? null)
    : null;

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

      {/* 单入口卡（15.35：原「团队访问配置 + 权限设置」两卡合并） */}
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
      </div>

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
