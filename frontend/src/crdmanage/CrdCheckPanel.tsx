// CrdManage 拆分（QC-196 方案 §5.2）· 创建自检面板（建队成功自动跑：CRD 回读
// + 阶段轮询 5s×3min；LLM 冒烟/SOUL 检查=插件无网关 key/容器通道，如实标注不装）——
// 原主组件 JSX 三元 div 逐字搬移；props = 原闭包变量名（零改写）。

import type * as ReactNS from "react";

import { CheckIcon, SearchIcon, RefreshIcon, ClockIcon, CloseIcon, WarnIcon } from "../components/icons";
import type { ThemeColors } from "../theme";
import type { TCheckState, TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


export interface CrdCheckPanelProps {
  tCheck: TCheckState | null;
  startTeamCheck: (rows: { name: string; sentModel: string }[]) => void;
  tr: TrFn;
  t: ThemeColors;
}

export default function CrdCheckPanel({
tCheck,
startTeamCheck,
tr,
t,
}: CrdCheckPanelProps) {
  return tCheck ? (
    <div
      style={{
        border: `1px solid ${tCheck.done ? t.border : "color-mix(in srgb, var(--app-accent, #FF7F16) 45%, transparent)"}`,
        borderRadius: 10,
        padding: 10,
        background: t.cardBg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 }}>
          <SearchIcon size={12} /> {tr("创建自检")}
        </span>
        {tCheck.running ? (
          <antd.Tag color="processing">{tr("进行中（5s 轮询，最长 3 分钟）")}</antd.Tag>
        ) : (
          <antd.Tag color="green">{tr("已完成")}</antd.Tag>
        )}
        <span style={{ flex: 1 }} />
        <antd.Button
          size="small"
          onClick={() =>
            startTeamCheck(
              tCheck.rows.map((r) => ({
                name: r.name,
                sentModel: r.sentModel,
              })),
            )
          }
        >
          <RefreshIcon size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} /> {tr("重新检查")}
        </antd.Button>
      </div>
      <div style={{ display: "grid", gap: 5, fontSize: 12 }}>
        {tCheck.rows.map((r) => (
          <div
            key={r.name}
            style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
          >
            <span style={{ fontWeight: 600, minWidth: 150 }}>
              {r.ready ? <CheckIcon size={12} style={{ color: "#52c41a", verticalAlign: "-1px", marginRight: 3 }} /> : <ClockIcon size={12} style={{ verticalAlign: "-1px", marginRight: 3 }} />} {r.name}
            </span>
            <span style={{ color: r.modelOk ? t.textSecondary : "#f5222d" }}>
              {r.sentModel ? (
                r.crdModel === r.sentModel ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    model <CheckIcon size={10} style={{ color: "#52c41a" }} /> {r.sentModel}
                  </span>
                ) : r.crdModel ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    model <CloseIcon size={10} style={{ color: "#f5222d" }} /> {tr("期望")} {r.sentModel}，CRD={r.crdModel}
                  </span>
                ) : (
                  `model … 已提交 ${r.sentModel}（CRD 尚未回读）`
                )
              ) : (
                <>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    model <WarnIcon size={10} style={{ color: "#fa8c16" }} /> {tr("无显式模型（跟随集群默认；若集群无默认，该 Worker 无模型）")}
                  </span>
                </>
              )}
            </span>
            <span style={{ color: t.textSecondary }}>
              phase: {r.phase || tr("等待调和")} · container: {r.container || "—"}
            </span>
            {r.message ? (
              <span style={{ color: "#fa8c16" }}>{r.message}</span>
            ) : null}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: t.textSecondary, lineHeight: 1.8 }}>
        ◌ LLM 冒烟（网关实弹）：{tr("当前版本暂不支持（插件无网关 key 通道，待上游 API）")}
        <br />
        ◌ SOUL stub 检查（容器内行数）：{tr("当前版本暂不支持（无容器通道；创建后请到团队房间发一条消息验证 Worker 应答）")}
      </div>
    </div>
  ) : null;
}
