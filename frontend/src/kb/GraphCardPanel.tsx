/** GraphCard 子模块——自 GraphCard.tsx 纯搬移拆出
 * （行为零变化）。 */
import type * as ReactNS from "react";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import type { GraphNodeLike } from "./types";
import type { GraphModel } from "./GraphCardShared";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export function GraphDetailPanel({
  sel,
  nodeColor,
  isRoot,
  model,
  nameOf,
  onOpenNode,
  onPick,
}: {
  sel: GraphNodeLike;
  nodeColor: (n: GraphNodeLike) => string;
  isRoot: (n: GraphNodeLike) => boolean;
  model: GraphModel | null;
  nameOf: (id: string) => string;
  onOpenNode: (node: GraphNodeLike) => void;
  onPick: (id: string) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (

              <div
                style={{
                  marginTop: 8,
                  border: `1px solid ${t.border}`,
                  borderRadius: 8,
                  padding: "8px 12px",
                  background: t.hoverBg,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: nodeColor(sel),
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10.5,
                      lineHeight: "18px",
                      padding: "0 7px",
                      borderRadius: 9,
                      border: `1px solid ${
                        isRoot(sel)
                          ? "#722ed1"
                          : sel.resolved === false
                          ? "#faad14"
                          : "#52c41a"
                      }`,
                      color: isRoot(sel)
                        ? "#722ed1"
                        : sel.resolved === false
                        ? "#faad14"
                        : "#52c41a",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isRoot(sel)
                      ? tr("分类根")
                      : sel.resolved === false
                      ? tr("未解析链接")
                      : tr("已索引文件")}
                  </span>
                  <span
                    style={{ fontWeight: 600, fontSize: 12.5 }}
                    title={sel.id}
                  >
                    {sel.name}
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
                    {sel.id}
                  </span>
                  <span style={{ flex: 1 }} />
                  {!isRoot(sel) && sel.resolved !== false ? (
                    <antd.Button
                      size="small"
                      onClick={() => onOpenNode(sel)}
                    >
                      {tr("打开 Markdown")}
                    </antd.Button>
                  ) : null}
                  <antd.Button
                    size="small"
                    type="text"
                    onClick={() => onPick("")}
                  >
                    {tr("关闭")}
                  </antd.Button>
                </div>
                {sel.description ? (
                  <div
                    style={{
                      fontSize: 12,
                      color: t.textSecondary,
                      marginBottom: 6,
                    }}
                  >
                    {sel.description}
                  </div>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    gap: 24,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        marginBottom: 3,
                      }}
                    >
                      {tr("出链 · {n}", {
                        n: (model?.outbound.get(sel.id) || []).length,
                      })}
                    </div>
                    {(model?.outbound.get(sel.id) || []).map((it) => (
                      <div
                        key={`${it.id}:${it.anchor ?? ""}`}
                        onClick={() => onPick(it.id)}
                        style={{
                          cursor: "pointer",
                          fontSize: 12,
                          lineHeight: "20px",
                        }}
                        title={it.id}
                    >
                      {nameOf(it.id)} →
                        {it.anchor ? (
                          <span
                            style={{
                              fontSize: 11,
                              color: t.textSecondary,
                            }}
                          >
                            #{it.anchor}
                          </span>
                        ) : null}
                    </div>
                    ))}
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textSecondary,
                        marginBottom: 3,
                      }}
                    >
                      {tr("入链 · {n}", {
                        n: (model?.inbound.get(sel.id) || []).length,
                      })}
                    </div>
                    {(model?.inbound.get(sel.id) || []).map((it) => (
                      <div
                        key={it.id}
                        onClick={() => onPick(it.id)}
                        style={{
                          cursor: "pointer",
                          fontSize: 12,
                          lineHeight: "20px",
                        }}
                        title={it.id}
                      >
                        ← {nameOf(it.id)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
  );
}
