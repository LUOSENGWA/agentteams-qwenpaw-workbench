import type * as ReactNS from "react";

import { postController } from "../api";
import type { AdminData, WorkerTreeTeam } from "../api";
import { TeamIcon } from "./icons";
import CrdManage, { type CrdManageHandle } from "./CrdManage";
import MyScopeCard from "./MyScopeCard";
import SkillCenter from "./SkillCenter";
import WorkerChannels from "./WorkerChannels";
import { StandaloneWorkerModels } from "./StandaloneWorkerModels";
import WorkerTools from "./WorkerTools";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import type { WorkerSessionState } from "../workerSessionState";
import { usePoller } from "../usePoller";
import { invalidateTags } from "../requestCache";
import { WbTooltip } from "./WbTooltip";
import { ReloadIcon } from "./WorkerManageShared";
import { HumanTable, ManagerTable, TeamNode, TeamTable } from "./WorkerManageTables";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface WorkerManageProps {
  teams: WorkerTreeTeam[];
  admin: AdminData | null;
  treeLoading?: boolean;
  adminLoading?: boolean;
  /** admin 取数连续失败次数（≥2 且无数据时显 Alert+重试）。 */
  adminFailCount?: number;
 /** 刷新拓扑树/管理数据。silent=true = 静默刷新（不闪 loading， 要求）。 */
  onRefreshTree?: (silent?: boolean) => void;
  onRefreshAdmin?: (silent?: boolean) => void;
  /** 点击 Worker 的"私聊"按钮 → 优先直跳 Worker 个人房间（roomId=CR roomID），
 * 无 roomId 才 fallback 新建 DM。。 */
  onDm?: (mxid: string, roomId?: string) => void;
  /** 是否已配置 Controller 管理员 token（决定管理信息面板/三表是否可用）。 */
  hasToken?: boolean;
  /** 当前 tab 是否激活（rc-tabs 保活：不激活时自动刷新跳过）。
 * boolean prop 每次切 tab 翻转 →
 * 本组件（1784 行、全树行渲染）整树重渲，落进切换帧（实测
 * 无 fetch 的 →团队 切换帧 61ms）。改传稳定 ref——prop 引用不变，
 * React.memo 命中零重渲；tick 时读 ref 当前值门控。 */
  activeRef?: { current: boolean };
  /**
 * 团队结构数据来源（）："controller-workers"=正源；
 * "room-fallback"=Controller 未接入的房间聚合（群聊冒充团队——警示横幅）。
 */
  treeSource?: string;
  /** 当前 Matrix 登录账号 MXID → 「我的团队/权限」卡。 */
  myUserId?: string;
  /** L1 走 controller_token（无 Console 会话 → 网关 alias 层不可见提示）。 */
  l1TokenMode?: boolean;
  /** worker_name → session 状态（行内圆点）。 */
  workerSessionByName?: Record<string, WorkerSessionState>;
  /** 运行配置 L1 只读 Alert 的「去设置」跳转。 */
  onOpenSettings?: () => void;
}

/**
 * 👷 Worker 管理（合并原「Worker 树」+「管理」两 tab）。
 * 主视图 = 拓扑树（团队 → Worker → spawns）；Worker 行展开 = 管理信息面板
 * （状态/团队/角色/模型/容器 + 唤醒/休眠）+ spawn 子任务树 + 检查点；
 * 底部折叠区 = 团队/用户/Manager 三表（原管理页无损下沉）。
 */
function WorkerManage(props: WorkerManageProps) {
  const t = useThemeColors();
  const tr = useT();
  const {
    teams,
    admin,
    treeLoading,
    adminLoading,
    adminFailCount = 0,
    onRefreshTree,
    onRefreshAdmin,
    onDm,
    hasToken,
    activeRef,
    treeSource = "",
    myUserId = "",
    l1TokenMode,
    workerSessionByName,
  } = props;
  const [acting, setActing] = React.useState<string | null>(null);
  // 「未分组」伪团队 → 独立 Worker 模型弹窗（不是 Team CR，不能走 openConfig）。
  const [standaloneOpen, setStandaloneOpen] = React.useState(false);
  // 底部折叠区受控（默认全收起）。技能/MCP 已并入拓扑
  // 资源管理（就地编辑），此折叠区保留为跨 Worker 全量视图，不再被程序化展开。
  const [collapseKeys, setCollapseKeys] = React.useState<string[]>([]);

  // 自动刷新（30s）：拓扑 + 管理数据。rc-tabs 保活（切走不卸载），
  // 所以用 tab 激活门控：仅当前 tab 激活时才轮询。
  // 门控走稳定 ref（activeRef）——
  // tick 时读当前值，tab 翻转不再触发本组件重渲（memo 零重渲）。
  const refreshRef = React.useRef({
    tree: onRefreshTree,
    admin: onRefreshAdmin,
  });
  refreshRef.current = { tree: onRefreshTree, admin: onRefreshAdmin };
  // 旧定时器 → usePoller（30s；tab 门控在 fn 内
  // 读 activeRef 双保险；!document.hidden 内置——后台零负载）。
  // 不传 active：poller 常 tick（inactive tab 时 fn 内 no-op，零负载）；
  // 切回 team 的即时刷新由「点 Tab 即刷新」effect 覆盖（refreshTree+
  // refreshAdmin force 路径），不依赖 poller poke。
  usePoller({
    fn: () => {
      if (activeRef && !activeRef.current) return;
      // 静默刷新：30s 自动刷不闪页——旧数据在屏，diff 无变化零重渲染
      void refreshRef.current.tree?.(true);
      void refreshRef.current.admin?.(true);
    },
    intervalMs: 30000,
  });

  const handleLifecycle = React.useCallback(
    async (name: string, action: "wake" | "sleep" | "restart") => {
      setActing(`${action}:${name}`);
      try {
        await postController(`/workers/${encodeURIComponent(name)}/${action}`);
        antd.message.success(
          action === "wake"
            ? tr("{name} 已唤醒", { name })
            : action === "sleep"
              ? tr("{name} 已休眠", { name })
              : tr("{name} 重启中（容器重建，约 10-30 秒）", { name }),
        );
        // 唤醒/休眠=Worker 运行态变更 → 失效缓存
        // （否则 30s TTL 内 admin/拓扑读旧心跳）。
        invalidateTags(["teams", "admin"]);
        void onRefreshAdmin?.();
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      } finally {
        setActing(null);
      }
    },
    [onRefreshAdmin],
  );

  const adminByWorker = React.useMemo(() => {
    const m = new Map<string, AdminData["workers"][number]>();
    for (const w of admin?.workers ?? []) m.set(w.name, w);
    return m;
  }, [admin]);

  const refresh = onRefreshTree || onRefreshAdmin;
  const refreshLoading = Boolean(treeLoading) || Boolean(adminLoading);

  // 拓扑齿轮 → CrdManage「配置团队」弹窗（注册式
  // handle——CrdManage 只渲染于 hasToken && admin，齿轮同步受同门控；
  // 弹窗打开瞬间若 admin 已卸载，openConfig 内查无团队会 toast 不炸）。
  const crdRef = React.useRef<CrdManageHandle | null>(null);
  const registerCrd = React.useCallback((h: CrdManageHandle) => {
    crdRef.current = h;
  }, []);
  // CrdManage 卸载（L1 退出/admin 清空）→ 清 handle，防齿轮调到
  // 已卸载组件的 setState（React 警告 + 无效操作）。
  React.useEffect(() => {
    if (!(hasToken && admin)) crdRef.current = null;
  }, [hasToken, admin]);

  const items =
    hasToken && admin
      ? [
          {
            key: "teams",
            label: tr("团队（{n}）", { n: admin.teams.length }),
            children: <TeamTable teams={admin.teams} />,
          },
          {
            key: "humans",
            label: tr("用户（{n}）", { n: admin.humans.length }),
            children: <HumanTable humans={admin.humans} />,
          },
          {
            key: "managers",
            label: `Manager（${admin.managers.length}）`,
            children: (
              <ManagerTable
                managers={admin.managers}
                usedModels={[
                  ...admin.workers.map((w) => w.model || ""),
                  ...admin.managers.map((m) => m.model || ""),
                ]}
                onRefreshAdmin={onRefreshAdmin}
                l1TokenMode={l1TokenMode}
                onDm={onDm}
                hasToken={hasToken}
              />
            ),
          },
          // 频道接入（调研结论——「👷 团队管理」下，
          // 不独立成 tab；Controller 频道端点未合时整节 404 版本门占位）。
          {
            key: "channels",
            label: tr("频道"),
            // 显式 active 门——折叠面板收起时
            // 30s 轮询停（rc-tabs 保活下组件不卸载，此前默认 active=true 恒跑）。
            children: (
              <WorkerChannels
                workers={admin.workers}
                active={collapseKeys.includes("channels")}
              />
            ),
          },
          // 内置工具（#1255 消费；与频道接入同款版本门
          // ——Controller 未含该端点时 404 占位，不炸 tab）。
          {
            key: "tools",
            label: tr("工具"),
            children: <WorkerTools workers={admin.workers} />,
          },
 // 会话入口 迁移：群内 worker 头像点击（RoomChat 抽屉）——
 // 不在团队管理出 tab（会话属于聊天上下文，且要看完整
          // session，不是最后活动列表）。
          // 技能中心从顶层 tab 收编（设计结论——团队级
          // 技能/MCP 资源管理归团队管理，不独立顶层 tab）。
          {
            key: "skills-center",
            label: tr("技能中心"),
            children: <SkillCenter />,
          },
        ]
      : myUserId
        ? [
 // （L2 双模式——调研 P0 + 上游
            // l2-worker-scoped-write.md/team-skills.md/skill-catalog-api.md
            // 已合 main）：L2 身份（Matrix token、无 admin token）只出技能
            // 中心（我的团队 scope）：目录 ?team= + skills 可写 + MCP 只读。
            // 团队/用户/Manager/频道/工具是 L1 管理面，L2 不显示。
            {
              key: "skills-center",
              label: tr("技能中心（我的团队）"),
              children: <SkillCenter l2 />,
            },
          ]
        : [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15, display: "inline-flex", alignItems: "center", gap: 6 }}><TeamIcon size={15} /> {tr("团队管理")}</span>
        <WbTooltip
          title={tr(
            "拓扑树（团队 → Worker → spawn）；点 Worker 行展开管理信息（Worker 状态[CRD] / 容器状态[docker，不一致时标红] / 模型 / 唤醒休眠）与检查点；底部团队/用户/Manager 全量表；自动刷新不闪页（静默+diff）",
          )}
        >
          <span style={{ color: t.textSecondary, cursor: "help", fontSize: 12 }}>ⓘ</span>
        </WbTooltip>
        <span style={{ color: "#bbb", fontSize: 11 }}>{tr("自动刷新 30 秒")}</span>
        <div style={{ flex: 1 }} />
        {refresh ? (
          <WbTooltip title={tr("刷新")}>
            <antd.Button
              type="text"
              size="small"
              icon={<ReloadIcon />}
              loading={refreshLoading}
              onClick={() => {
                void onRefreshTree?.();
                void onRefreshAdmin?.();
              }}
            />
          </WbTooltip>
        ) : null}
      </div>
      {/* 我的团队/我的权限——员工视角只读半边
 （管理员半边 = CrdManage 团队访问配置矩阵）。登录即显示。 */}
      <MyScopeCard
        myUserId={myUserId}
        hasToken={!!hasToken}
        humans={admin?.humans ?? []}
        teams={teams}
        treeSource={treeSource}
      />
      {treeSource === "room-fallback" ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr(
            "团队数据未接通——以下为房间聚合（群聊），不是真实团队结构",
          )}
          description={tr(
            "到配置页填 Controller 地址 + 管理员 token（L1），或用 Human permissionLevel=2 的账号 Matrix 登录（L2），即可看到真实团队结构。",
          )}
        />
      ) : null}
      <antd.Card
        size="small"
        loading={treeLoading}
        styles={{ body: { padding: "12px 16px" } }}
      >
        {teams.length ? (
          <div style={{ display: "grid", gap: 2 }}>
            {teams.map((team) => (
              <TeamNode
                key={team.room_id}
                team={team}
                onDm={onDm}
                adminByWorker={adminByWorker}
                onLifecycle={hasToken ? handleLifecycle : undefined}
                acting={acting}
                sessionByName={workerSessionByName}
                l1={!!hasToken}
                onOpenSettings={props.onOpenSettings}
                onTeamConfig={
                  hasToken && admin
                    ? (name: string) => {
                        // 「未分组」是后端为无 team Worker 造的伪团队
                        // （teams_api.py: w.team or "未分组"），不是 Team CR
                        // → openConfig 在 CRD 团队列表查无 → 弹
                        // 「团队数据未加载或团队不存在」。
                        // 改开独立 Worker 模型弹窗（PUT /workers/{name}
                        // 只传 model，合并语义）。
                        if (name === "未分组") {
                          setStandaloneOpen(true);
                          return;
                        }
                        crdRef.current?.openConfig(name);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <antd.Empty
            image={antd.Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              hasToken
                ? tr("未获取到团队数据——检查 Controller 地址与 token")
                : tr("暂未发现团队房间——加入团队房间后这里显示你的团队结构")
            }
          />
        )}
      </antd.Card>
      {hasToken && !admin ? (
        <antd.Card size="small">
          {/* ：静默失败不再
 无感空面板——连续失败 ≥2 次显 Alert+重试（此前失败被 silent 吞掉，
 面板恒显「加载中」，用户只能手动点刷新）。 */}
          {adminFailCount >= 2 ? (
            <antd.Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={tr("管理数据获取失败（连续 {n} 次）", { n: adminFailCount })}
              description={tr("拓扑来自公开接口；CRD 管理表需要 Controller 管理接口——检查 Controller 地址与 token 后重试。")}
              action={
                <antd.Button size="small" onClick={() => onRefreshAdmin?.(false)}>
                  {tr("重试")}
                </antd.Button>
              }
            />
          ) : null}
          <antd.Spin spinning={adminLoading}>
            <div style={{ color: "#999", fontSize: 12, padding: 12 }}>
              {tr("管理数据加载中——团队/用户/Manager 全量状态")}
            </div>
          </antd.Spin>
        </antd.Card>
      ) : null}
      {hasToken && admin ? (
        <CrdManage
          admin={admin}
          onRefresh={onRefreshAdmin}
          l1TokenMode={l1TokenMode}
          registerHandle={registerCrd}
        />
      ) : null}
      {hasToken && admin ? (
        <StandaloneWorkerModels
          workers={admin.workers}
          open={standaloneOpen}
          onClose={() => setStandaloneOpen(false)}
          onRefreshAdmin={onRefreshAdmin}
        />
      ) : null}
      {items.length ? (
        <antd.Card size="small" styles={{ body: { padding: "4px 16px" } }}>
          <antd.Collapse
            size="small"
            items={items}
            ghost
            activeKey={collapseKeys}
            onChange={(keys: string | string[]) =>
              setCollapseKeys(
                Array.isArray(keys) ? keys : [keys],
              )
            }
          />
        </antd.Card>
      ) : null}
    </div>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(WorkerManage);
