import { GlobeIcon, RobotIcon } from "./icons";
import type * as ReactNS from "react";

import { fetchKbAgents, fetchKbGraph, fetchKbTree, type KbAgent } from "../api";
import { useT } from "../i18n";
import { LocalKbView } from "../kb/LocalKbView";
import { RemoteKbView } from "../kb/RemoteKbView";
import { loadKbState } from "../kb/persist";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/**
 * 知识库 tab（用户定位）：
 * 主视图 = 远端团队知识库（自己团队的 Leader/Worker 的 knowledge base——
 * Controller Docker API 只读直读 Worker 容器工作区，需 Controller token）。
 * 降级视图 = 本机宿主 Agent（无 token / L2 用户）。
 */
function KnowledgeBase(props: { refreshTick?: number }) {
  const { refreshTick = 0 } = props;
  const tr = useT();
  const [mode, setMode] = React.useState<"remote" | "local">("local");
  const [probing, setProbing] = React.useState(true);
  const [remoteAvailable, setRemoteAvailable] = React.useState(false);
  const [agents, setAgents] = React.useState<KbAgent[]>([]);
  const [probeError, setProbeError] = React.useState("");

  // 探测：有 Controller token 且远端有 Agent → remote；否则 local。
  const probe = React.useCallback(() => {
    setProbing(true);
    setProbeError("");
    void fetchKbAgents()
      .then((list) => {
        setAgents(list);
        const ok = list.length > 0;
        setRemoteAvailable(ok);
        setMode(ok ? "remote" : "local");
        if (!ok) {
          setProbeError("no-agents");
          return;
        }
        // probe 成功后后台预热默认 agent 的 tree+graph。
        // 真冷路径实测（生产环境，外网 5M）：tree 冷算 ≈3.4-3.7s（单次 docker
        // exec 往返的物理成本，
        // 架构层不可再压）、graph ≈0.9s、温缓存 13-18ms。首帧可见时若恰好
        // 撞上冷算 = 用户等 3.7s；预热后首帧请求命中 SWR（盘+30s 内存）。
        // fire-and-forget：目标 = 首个 agent（无记忆回退值）+ 记忆 agent；
        // 失败静默（= 退回现状，下次访问冷算），绝不阻塞首帧。
        const remembered = loadKbState().agent;
        const targets = Array.from(
          new Set([list[0]?.name, remembered].filter((x): x is string => !!x)),
        ).slice(0, 2);
        for (const a of targets) {
          void fetchKbTree(a).catch(() => {});
          void fetchKbGraph(a).catch(() => {});
        }
      })
      .catch((e) => {
        setRemoteAvailable(false);
        setMode("local");
        setProbeError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setProbing(false));
  }, []);

  React.useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <antd.Space direction="vertical" size={10} style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <antd.Segmented
          value={mode}
          onChange={(v: string | number) => setMode(v as "remote" | "local")}
          options={[
            {
              label: <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><GlobeIcon size={12} /> {tr("远端团队知识库")}</span>,
              value: "remote",
              // 探测失败/无远端 Agent → remote 不可选（点「重新检测」再试）。
              disabled: !remoteAvailable || probing,
            },
            { label: <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><RobotIcon size={12} /> {tr("本机宿主 Agent")}</span>, value: "local" },
          ]}
        />
        <antd.Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {mode === "remote"
            ? tr("读集群 Worker 的远端知识库（只读；管理员见全部团队，L2 见自己团队）")
            : tr("读本机 QwenPaw Agent 的记忆库")}
        </antd.Typography.Text>
        <antd.Button
          size="small"
          type="link"
          onClick={() => void probe()}
          style={{ marginLeft: "auto" }}
        >
          {tr("重新检测")}
        </antd.Button>
      </div>
      {probeError ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("远端团队知识库不可用，当前为本机宿主知识库")}
          description={
            /401/.test(probeError)
              ? tr("远端团队知识库需要 L1（管理员）凭据——配置页填写 Controller 管理员 token 后点「重新检测」。L2 用户没有该 token，此视图不可用（保持本机知识库，或向管理员申请 L1 凭据）")
              : probeError === "no-agents"
                ? tr("远端未找到 Worker 容器（Controller 未接入？）")
                : probeError
          }
        />
      ) : null}
      {/* （14.17 「知识库一开始显示本机 agent，
 * 切 tab 才变 sysdev-team」）：初始 probing 期间 mode 默认 "local"，
 * LocalKbView（本机宿主 Agent）先闪一帧再切 RemoteKbView——首渲竞态。
 * 探测中一律 loading，探测结束才落 remote/local 视图（手动切 local
 * 不受影响：切时 probing 已 false）。 */}
      {probing ? (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <antd.Spin size="small" />
        </div>
      ) : mode === "remote" ? (
        <RemoteKbView agents={agents} refreshTick={refreshTick} />
      ) : (
        <LocalKbView refreshTick={refreshTick} />
      )}
    </antd.Space>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(KnowledgeBase);
