/** HomePage 子模块——自 HomePage.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { type SglangRank } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { CARD_RADIUS } from "./HomePageShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

export function SglangCard({
  sglang,
  sgLocalAt,
  onOpen,
}: {
  sglang: { loaded: boolean; ranks: SglangRank[] };
  sgLocalAt: number;
  onOpen: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const cardStyle: ReactNS.CSSProperties = {
    borderRadius: CARD_RADIUS,
    background: t.cardBg,
    borderColor: t.border,
  };
  const cardBody: ReactNS.CSSProperties = { padding: 14 };
  return (
  <antd.Card style={cardStyle} styles={{ body: cardBody }}>
                <div
                  style={{ cursor: "pointer" }}
                  onClick={onOpen}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: t.text }}>
                      集群负载
                    </span>
                    {/* 刷新脉冲（14.34）——每收到一帧快照亮一次
  （remount key=sgLocalAt 重放动画）：空闲数值不变时也能
  肉眼看出「正在刷新」，取代恒显 0 的 age 文字。 */}
                    {sglang.loaded ? (
                      <span
                        key={sgLocalAt}
                        title={tr("每收到一帧负载快照亮一次——正在实时刷新")}
                        style={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "#52c41a",
                          animation: "wbSgTick 0.9s ease-out",
                        }}
                      />
                    ) : null}
                  </div>
                  {!sglang.loaded ? (
                    <div
                      style={{ fontSize: 11, color: t.textSecondary, marginTop: 6 }}
                    >
                      {tr("暂无负载数据")}
                    </div>
                  ) : (
                    <>
                    <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
                      {sglang.ranks.map((r) => {
                        const busy = r.num_running_reqs + r.num_waiting_reqs;
                        return (
                        <div
                          key={r.dp_rank}
                          style={{
                            border: `1px solid ${t.border}`,
                            borderRadius: 8,
                            padding: "8px 12px",
                            minWidth: 140,
                            maxWidth: "100%",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: t.text }}>
                              DP {r.dp_rank}
                            </span>
                            {/* 状态标签——空闲/运行/排队一眼分辨（对齐 OpsPanel 卡）。 */}
                            <antd.Tag
                              color={busy === 0 ? "green" : r.num_waiting_reqs > 0 ? "orange" : "blue"}
                              style={{ margin: 0, fontSize: 10, lineHeight: "16px", padding: "0 5px" }}
                            >
                              {busy === 0
                                ? tr("空闲")
                                : r.num_waiting_reqs > 0
                                  ? tr("排队")
                                  : tr("运行中")}
                            </antd.Tag>
                          </div>
                          <div style={{ fontSize: 11, color: t.textSecondary, marginTop: 2 }}>
                            {tr("运行 {a} · 排队 {b}", {
                              a: r.num_running_reqs,
                              b: r.num_waiting_reqs,
                            })}
                          </div>
                          {/* 吞吐——请求数不变时推理仍可能在全速跑，
  tok/s 跳动=「在干活」的第二重可感知信号。0 显「—」。 */}
                          <div style={{ fontSize: 10, color: t.textSecondary, marginTop: 1 }}>
                            {tr("吞吐")}{" "}
                            {r.gen_throughput > 0
                              ? `${Math.round(r.gen_throughput)} tok/s`
                              : "—"}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 10, color: t.textSecondary, marginTop: 4 }}>
                      {tr("自动刷新（活跃 1s / 稳定 5s）")}
                    </div>
                    </>
                  )}
                </div>
              </antd.Card>
  );
}
