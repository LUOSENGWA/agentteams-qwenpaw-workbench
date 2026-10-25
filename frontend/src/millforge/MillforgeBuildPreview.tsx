// 千锻编译预览（任务书 B4）——SOUL tabs（role/kind、行数/预算，超支红标、
// sha256、SOUL 全文）+ fragments/spawn-specs 清单 + provenance（SOUL 头
// 注释 MILLFORGE-COMPILED 解析）。数据 = POST /millforge/compile 响应
// （soul 全文仅在编译响应内，build 历史列表不含全文）。

import type * as ReactNS from "react";

import type { MillforgeBuildResult } from "../api";
import type { ThemeColors } from "../theme";
import type { TrFn } from "../crdmanage/types";
import { CheckIcon, CloseIcon } from "../components/icons";
import { WbTooltip } from "../components/WbTooltip";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface Props {
  build: MillforgeBuildResult;
  tr: TrFn;
  t: ThemeColors;
}

export default function MillforgeBuildPreview({ build, tr, t }: Props) {
  const copySha = React.useCallback((sha: string) => {
    const done = () => antd.message.success(tr("已复制"));
    try {
      void navigator.clipboard.writeText(sha).then(done).catch(done);
    } catch {
      done();
    }
  }, [tr]);

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {/* SOUL tabs（每角色一页） */}
      <antd.Tabs
        size="small"
        items={build.roles.map((r) => ({
          key: r.role,
          label: (
            <span>
              {r.role}
              <span style={{ color: t.textSecondary }}>（{r.kind}）</span>
            </span>
          ),
          children: (
            <div style={{ display: "grid", gap: 6 }}>
              {/* 行数/预算 + sha */}
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
                <span style={{ color: r.budget_ok ? t.text : "#f5222d", fontWeight: 700 }}>
                  {r.lines} / {r.budget} {tr("行")}
                  {!r.budget_ok ? (
                    <WbTooltip title={tr("超支：行数超出预算（须回模板层减片段或提预算走人审，否则不可注入）")}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 4 }}>
                        <CloseIcon size={11} /> {tr("超支")}
                      </span>
                    </WbTooltip>
                  ) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 4 }}>
                      <CheckIcon size={11} style={{ color: "#52c41a" }} /> {tr("预算内")}
                    </span>
                  )}
                </span>
                <span style={{ fontFamily: "monospace", color: t.textSecondary, cursor: "pointer" }} title={tr("点击复制完整 sha256")} onClick={() => copySha(r.soul_sha256)}>
                  {r.soul_sha256.slice(0, 12)}…
                </span>
              </div>
              {/* provenance（仅首角色携带，逐页同值——每页显示） */}
              {Object.keys(build.provenance || {}).length > 0 ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, color: t.textSecondary }}>
                  {Object.entries(build.provenance).map(([k, v]) => (
                    <antd.Tag key={k} style={{ marginInlineEnd: 0, fontFamily: "monospace" }}>
                      {k}={String(v)}
                    </antd.Tag>
                  ))}
                </div>
              ) : null}
              {/* SOUL 全文（只读） */}
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: t.mode === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                  border: `1px solid ${t.border}`,
                  borderRadius: 6,
                  fontFamily: "monospace",
                  fontSize: 12,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 380,
                  overflow: "auto",
                  color: t.text,
                }}
              >
                {r.soul}
              </pre>
            </div>
          ),
        }))}
      />
      {/* fragments / spawn-specs 清单 */}
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
          {tr("fragments 清单（{n}）", { n: build.fragments.length })}
        </div>
        {build.fragments.length ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {build.fragments.map((f) => (
              <antd.Tag key={f} style={{ marginInlineEnd: 0, fontFamily: "monospace", fontSize: 11 }}>
                {f}
              </antd.Tag>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("（无）")}</span>
        )}
        <div style={{ fontSize: 11, color: t.textSecondary, fontWeight: 600 }}>
          {tr("spawn-specs 清单（{n}）", { n: build.spawn_specs.length })}
        </div>
        {build.spawn_specs.length ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {build.spawn_specs.map((f) => (
              <antd.Tag key={f} style={{ marginInlineEnd: 0, fontFamily: "monospace", fontSize: 11 }}>
                {f}
              </antd.Tag>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: t.textSecondary }}>{tr("（无）")}</span>
        )}
      </div>
    </div>
  );
}
