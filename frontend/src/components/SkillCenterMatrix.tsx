/** SkillCenter 子模块——自 SkillCenter.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { isQwenpawOnlyDisabled } from "../runtimeGuard";
import {
  type WorkerInfo,
  type SkillCatalogItem,
  type WorkerRuntimeSkill,
} from "../api";
import { WbTooltip } from "./WbTooltip";
import { groupWorkersByTeam } from "./SkillCenterShared";
import type { SkillDetail } from "./SkillCenterShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function SkillMatrix({
  l2,
  onlyWorker,
  onlyTeam,
  workersView,
  workers,
  loading,
  matrix,
  setMatrix,
  baseMatrix,
  expandedWorker,
  setExpandedWorker,
  matByWorker,
  skillColumns,
  catalogByName,
  toggleSkill,
  onDetail,
  preloadBusy,
  togglePreload,
  savingRow,
  onSave,
  onRefresh,
}: {
  l2: boolean;
  onlyWorker: string | undefined;
  onlyTeam: string | undefined;
  workersView: WorkerInfo[];
  workers: WorkerInfo[];
  loading: boolean;
  matrix: Record<string, string[]>;
  setMatrix: ReactNS.Dispatch<ReactNS.SetStateAction<Record<string, string[]>>>;
  baseMatrix: Record<string, string[]>;
  expandedWorker: string | null;
  setExpandedWorker: (v: string | null) => void;
  matByWorker: Record<string, WorkerRuntimeSkill[] | "loading" | "err" | null>;
  skillColumns: string[];
  catalogByName: Map<string, SkillCatalogItem>;
  toggleSkill: (worker: string, skill: string, on: boolean) => void;
  onDetail: (s: SkillDetail | null) => void;
  preloadBusy: Record<string, boolean>;
  togglePreload: (workerName: string, s: WorkerRuntimeSkill, next: boolean) => void;
  savingRow: string;
  onSave: (worker: string) => void;
  onRefresh: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
      <antd.Card
        size="small"
        extra={
          onlyWorker ? (
            <antd.Button
              size="small"
              onClick={onRefresh}
              loading={loading}
            >
              {tr("刷新")}
            </antd.Button>
          ) : undefined
        }
        title={
          l2
            ? tr("② Worker 技能分配（L2 我的团队 · 仅 skills 可写 · PUT 合并语义）")
            : tr("② Worker 技能分配矩阵（L1 可写 · PUT 合并语义 · skills 整字段替换）")
        }
      >
        {workersView.length ? (
          <div style={{ display: "grid", gap: 6 }}>
            {/* ：onlyTeam（团队配置弹窗内嵌）
 矩阵只渲染该团队 Worker——旧分支误用 st.workers 全量=跨团队泄漏
 （「团队技能（目录/分配矩阵/MCP）就只管这个团队的」）。 */}
            {(onlyWorker
              ? [{ team: "", workers: workersView }]
              : groupWorkersByTeam(onlyTeam ? workersView : workers)
            ).map((tg) => (
              <div key={tg.team || "ungrouped"}>
                {/* 团队分组头（组内 Worker 卡原渲染）。
 拓扑嵌入（onlyWorker）→ 组头不出。
 团队配置嵌入（onlyTeam）→ 单团队组头冗余不出。 */}
                {!onlyWorker && !onlyTeam ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 2px 0",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 12, color: t.text }}>
                    {tg.team ? tg.team : tr("未分组")}
                  </span>
                  <span style={{ color: t.textSecondary, fontSize: 11 }}>
                    {tr("{n} Worker", { n: tg.workers.length })}
                  </span>
                  <div style={{ flex: 1, height: 1, background: t.border }} />
                </div>
                ) : null}
                <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                {tg.workers.map((w) => {
              const assigned = matrix[w.name] || [];
              const base = baseMatrix[w.name] || [];
              const dirty =
                assigned.length !== base.length ||
                assigned.some((s) => !base.includes(s));
              const expanded = expandedWorker === w.name;
              const mat = matByWorker[w.name];
              return (
                <div
                  key={w.name}
                  style={{
                    border: `1px solid ${t.border}`,
                    borderRadius: 8,
                    background: t.cardBg,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      flexWrap: "wrap",
                      cursor: "pointer",
                    }}
                    onClick={() => setExpandedWorker(expanded ? null : w.name)}
                    title={tr("点行展开/收起该 Worker 的技能编辑")}
                  >
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>{w.name}</span>
                    <span style={{ color: t.textSecondary, fontSize: 11 }}>
                      {w.team || "—"} · {w.role || "worker"}
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        gap: 4,
                        flexWrap: "wrap",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      {assigned.length ? (
                        assigned.slice(0, 3).map((s) => (
                          <antd.Tag key={s} style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                            {s}
                          </antd.Tag>
                        ))
                      ) : Array.isArray(mat) && mat.length ? (
                        // 分配层空但物化层非空——
                        // 「未分配但可调用」的可视化真相（团队层自动物化/
                        // builtin 恢复/镜像自带不写 spec.skills）。
                        <WbTooltip
                          title={tr(
                            "未显式分配（CRD 分配层为空），但运行时已装载 {n} 个技能（团队层物化/内置恢复/镜像自带）——展开行查看明细",
                            { n: mat.length },
                          )}
                        >
                          <antd.Tag color="cyan" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                            {tr("运行时已装载 {n}", { n: mat.length })}
                          </antd.Tag>
                        </WbTooltip>
                      ) : (
                        <span style={{ color: t.textSecondary, fontSize: 11 }}>
                          {tr("暂无技能分配")}
                        </span>
                      )}
                      {assigned.length > 3 ? (
                        <antd.Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                          +{assigned.length - 3}
                        </antd.Tag>
                      ) : null}
                    </span>
                    {dirty ? (
                      <antd.Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                        {tr("未保存")}
                      </antd.Tag>
                    ) : null}
                    <antd.Button
                      size="small"
                      type="text"
                      style={{ flexShrink: 0 }}
                      onClick={(e: ReactNS.MouseEvent) => {
                        e.stopPropagation();
                        setExpandedWorker(expanded ? null : w.name);
                      }}
                    >
                      {expanded ? tr("收起") : tr("编辑技能")} {expanded ? "▴" : "▾"}
                    </antd.Button>
                  </div>
                  {expanded ? (
                    <div
                      style={{
                        border: `1px solid ${t.border}`,
                        borderTop: "none",
                        padding: 10,
                        background: t.popoverBg,
                      }}
                    >
                      {/* 物化层明细（runtime 实际
 装载，懒加载首展即拉；404/403 版本/权限门占位）。 */}
                      {mat === "loading" ? (
                        <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 8 }}>
                          {tr("运行时技能加载中…")}
                        </div>
                      ) : mat === "err" ? (
                        <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 8 }}>
                          {tr(
                            "运行时技能列表不可用（Controller 未含该端点或当前身份无权限——分配层不受影响）",
                          )}
                        </div>
                      ) : Array.isArray(mat) && mat.length ? (
                        <div
                          style={{
                            marginBottom: 10,
                            padding: "6px 8px",
                            borderRadius: 6,
                            background: t.cardBg,
                            border: `1px solid ${t.border}`,
                          }}
                        >
                          <div style={{ fontSize: 11, color: t.textSecondary, marginBottom: 4 }}>
                            {tr(
                              "运行时已装载（物化层——实际可调用；分配层空而这里非空 = 团队层自动物化/内置恢复/镜像自带）",
                            )}
                          </div>
                          {/* per-worker 技能一等公民——
 光杆 Tag → 逐技能行：来源 / 描述 / 启用态 /
 分配态 / **预加载开关**（PUT preload，worker
 侧热加载）。 */}
                          <div style={{ display: "grid", gap: 4 }}>
                            {mat.map((s) => {
                              const inAssigned = assigned.includes(s.name);
                              const busy = !!preloadBusy[`${w.name}::${s.name}`];
                              const disabled = s.enabled === false;
                              return (
                                <div
                                  key={s.name}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "3px 6px",
                                    borderRadius: 6,
                                    border: `1px solid ${t.border}`,
                                    background: t.cardBg,
                                  }}
                                >
                                  <span
                                    title={disabled ? tr("已禁用") : tr("启用中")}
                                    style={{
                                      width: 6,
                                      height: 6,
                                      borderRadius: 3,
                                      flexShrink: 0,
                                      background: disabled ? "#bbb" : "#52c41a",
                                    }}
                                  />
                                  {s.emoji ? (
                                    <span style={{ fontSize: 12, flexShrink: 0 }}>
                                      {s.emoji}
                                    </span>
                                  ) : null}
                                  <span
                                    style={{
                                      fontWeight: 600,
                                      fontSize: 11.5,
                                      flex: 1,
                                      minWidth: 0,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                    title={s.name}
                                  >
                                    {s.name}
                                  </span>
                                  {/* 行内描述已去（376 竖屏）——完整详情走「详情」弹窗。 */}
                                  <antd.Button
                                    size="small"
                                    type="text"
                                    style={{ flexShrink: 0, padding: "0 4px", fontSize: 11 }}
                                    onClick={(e: ReactNS.MouseEvent) => {
                                      e.stopPropagation();
                                      onDetail({
                                        name: s.name,
                                        description: s.description,
                                        source: s.source,
                                        version: s.version_text,
                                        channels: s.channels,
                                      });
                                    }}
                                  >
                                    {tr("详情")}
                                  </antd.Button>
                                  {s.source ? (
                                    <antd.Tag
                                      style={{ marginInlineEnd: 0, fontSize: 10 }}
                                      title={tr("物化来源（worker 实际装载渠道）")}
                                    >
                                      {s.source}
                                    </antd.Tag>
                                  ) : null}
                                  <antd.Tag
                                    color={inAssigned ? "blue" : "cyan"}
                                    style={{ marginInlineEnd: 0, fontSize: 10 }}
                                    title={
                                      inAssigned
                                        ? tr("已分配 + 已物化")
                                        : tr("仅物化（未显式分配）")
                                    }
                                  >
                                    {inAssigned ? tr("已分配") : tr("仅物化")}
                                  </antd.Tag>
                                  {/* ：preload 是物化层
  QwenPaw 独有面（常驻 system prompt，仅 qwenpaw 装载）——非 qwenpaw 禁用开关
  + 说明；分配层 CRD 视图（已分配/物化标签）照读不受影响。 */}
                                  <WbTooltip
                                    title={
                                      isQwenpawOnlyDisabled(w.runtime)
                                        ? tr("预加载仅支持 QwenPaw 运行时的 Worker（当前：{rt}）", { rt: w.runtime })
                                        : tr(
                                            "预加载：技能全文常驻该 Worker 每个会话的 system prompt（有 per-session token 成本；QwenPaw ≥ 2.2.1；worker 侧热加载无需重启）",
                                          )
                                    }
                                  >
                                    <span
                                      style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
                                    >
                                      <span style={{ fontSize: 10.5, color: t.textSecondary }}>
                                        {tr("预加载")}
                                      </span>
                                      <antd.Switch
                                        size="small"
                                        checked={!!s.preload}
                                        loading={busy}
                                        disabled={busy || isQwenpawOnlyDisabled(w.runtime)}
                                        onChange={(v: boolean) =>
                                          void togglePreload(w.name, s, v)
                                        }
                                      />
                                    </span>
                                  </WbTooltip>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                          gap: 6,
                        }}
                      >
                        {skillColumns.map((s) => {
                          const on = assigned.includes(s);
                          const item = catalogByName.get(s);
                          return (
                            <div
                              key={s}
                              onClick={() => toggleSkill(w.name, s, !on)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "5px 8px",
                                borderRadius: 6,
                                border: `1px solid ${on ? "rgba(22,119,255,0.5)" : t.border}`,
                                background: on ? "rgba(22,119,255,0.06)" : t.cardBg,
                                cursor: "pointer",
                                minWidth: 0,
                              }}
                            >
                              <antd.Checkbox
                                checked={on}
                                style={{ flexShrink: 0 }}
                                onClick={(e: ReactNS.MouseEvent) => e.stopPropagation()}
                                onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
                                  toggleSkill(w.name, s, e.target.checked)
                                }
                              />
                              <div
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                <span
                                  style={{ fontWeight: 600, fontSize: 12 }}
                                  title={s}
                                >
                                  {s}
                                </span>
                                <antd.Tag
                                  color={item?.source === "builtin" ? "blue" : "purple"}
                                  style={{
                                    marginInlineEnd: 0,
                                    fontSize: 10,
                                    lineHeight: "16px",
                                    marginLeft: 4,
                                  }}
                                >
                                  {item?.source || "custom"}
                                </antd.Tag>
                              </div>
                              {/* 卡面描述已去（376 竖屏）——完整详情走弹窗。 */}
                              <antd.Button
                                size="small"
                                type="text"
                                style={{ flexShrink: 0, padding: "0 4px", fontSize: 11 }}
                                onClick={(e: ReactNS.MouseEvent) => {
                                  e.stopPropagation();
                                  onDetail(item || null);
                                }}
                              >
                                {tr("详情")}
                              </antd.Button>
                            </div>
                          );
                        })}
                        {!skillColumns.length ? (
                          <div
                            style={{
                              color: t.textSecondary,
                              fontSize: 12,
                              gridColumn: "1 / -1",
                            }}
                          >
                            {tr("暂无可用技能列表（目录未点亮且尚无已分配技能）")}
                          </div>
                        ) : null}
                      </div>
                      {dirty ? (
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            marginTop: 10,
                            justifyContent: "flex-end",
                          }}
                        >
                          <antd.Button
                            size="small"
                            onClick={() =>
                              setMatrix((prev) => ({ ...prev, [w.name]: [...base] }))
                            }
                          >
                            {tr("重置为当前值")}
                          </antd.Button>
                          <antd.Button
                            size="small"
                            type="primary"
                            loading={savingRow === w.name}
                            onClick={() => void onSave(w.name)}
                          >
                            {tr("保存")}
                          </antd.Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
                })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <antd.Empty
            description={
              loading
                ? tr("加载中…")
                : l2
                  ? tr("无 Worker（L2 可见范围=我的团队）")
                  : tr("无 Worker（admin token 未配置？）")
            }
          />
        )}
      </antd.Card>
  );
}
