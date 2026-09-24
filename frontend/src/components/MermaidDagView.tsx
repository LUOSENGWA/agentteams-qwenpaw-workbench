/**
 * A9 Mermaid 任务 DAG 视图（v0.5.0-beta.13.21，装验反馈「侧栏角色分组/活动轨/
 * mermaid/undo」批）。数据面=上游 `GET /api/v1/projects/{id}/workflow?format=mermaid`
 * （#1230 已合 main：纯渲染同一 workflow 快照，flowchart LR + 状态 classDef；
 * 节点标签/任务 ID 已在上游 sanitize，直接交给 mermaid 渲染）。
 *
 * 实现要点：
 *  - mermaid 库 ~2.6MB → `import("mermaid")` 动态导入（独立 chunk，只有
 *    首次打开 mermaid 视图才下载；vite build 不涨主包）；
 *  - 404 = Controller 未含该端点（版本门）→ 诚实占位，不当错误；
 *  - 渲染失败（理论不会，上游已消毒）→ 错误显形，不静默空图；
 *  - 主题跟随 app（light=neutral / dark=dark）。
 */
import type * as ReactNS from "react";

import { fetchWorkflowMermaid, type WorkflowEvent } from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;

type ViewState =
  | { kind: "loading" }
  | { kind: "ok"; svg: string }
  | { kind: "not_deployed" }
  | { kind: "error"; err: string };

export default function MermaidDagView({
  ev,
  onNodeInspect,
}: {
  ev: WorkflowEvent;
  /** 节点点击 → 任务巡检（svg 节点无 DOM 钩子，退化为提示去拓扑视图点节点）。 */
  onNodeInspect?: () => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [state, setState] = React.useState<ViewState>({ kind: "loading" });
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let dead = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const text = await fetchWorkflowMermaid(ev.runId, ev.team_id);
        if (dead) return;
        if (!text) {
          setState({ kind: "not_deployed" });
          return;
        }
        // 懒加载 mermaid（独立 chunk）
        const mod = await import("mermaid");
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme: t.mode === "dark" ? "dark" : "neutral",
          securityLevel: "strict",
          flowchart: { htmlLabels: true, curve: "basis" },
        });
        // 唯一 id 防 mermaid 残留 DOM 错误节点
        const id = `atw-mermaid-${Date.now()}`;
        const out = await mermaid.render(id, text);
        if (dead) return;
        setState({ kind: "ok", svg: out.svg });
      } catch (e) {
        if (dead) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("HTTP 404")) setState({ kind: "not_deployed" });
        else setState({ kind: "error", err: msg.slice(0, 200) });
      }
    })();
    return () => {
      dead = true;
    };
  }, [ev.runId, ev.team_id, t.mode, tick]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: t.textSecondary }}>
          {tr("Mermaid DAG（上游 workflow 快照直渲染；节点色=任务状态）")}
        </span>
        <div style={{ flex: 1 }} />
        <antd.Button
          size="small"
          type="text"
          onClick={() => setTick((x) => x + 1)}
        >
          ↻ {tr("刷新")}
        </antd.Button>
      </div>
      {state.kind === "loading" ? (
        <antd.Spin />
      ) : state.kind === "not_deployed" ? (
        <antd.Alert
          type="info"
          showIcon
          message={tr("Controller 未升级到含 mermaid 端点的版本（404）——拓扑视图不受影响")}
        />
      ) : state.kind === "error" ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("Mermaid 渲染失败")}
          description={state.err}
        />
      ) : (
        <div
          style={{
            overflow: "auto",
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            padding: 12,
            background: t.bg,
            // mermaid svg 自适应容器（maxWidth 100% 防超宽项目溢出）
          }}
        >
          <div
            // svg 由上游 sanitize 后生成（quote 实体化/换行 → <br>），strict 模式渲染。
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>
      )}
    </div>
  );
}
