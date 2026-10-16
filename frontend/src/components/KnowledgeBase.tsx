import type * as ReactNS from "react";

import { fetchKbAgents, fetchKbGraph, fetchKbTree, type KbAgent } from "../api";
import { useT } from "../i18n";
import { RemoteKbView } from "../kb/RemoteKbView";
import { loadKbState } from "../kb/persist";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/**
 * 知识库 tab（用户定位）：
 * 主视图 = 远端团队知识库（自己团队的 Leader/Worker 的 knowledge base——
 * Controller Docker API 只读直读 Worker 容器工作区，需 Controller token）。
 * 15.18（产品定案）：删「本机宿主 Agent」降级视图 + 「重新检测」按钮——
 * 只留远端。远端不可用（无 token / L2 / 无 Worker）→ 顶部给配置指引，
 * 不再降级本机（本机视图已无必要，有远端即可）。
 * RemoteKbView 自包含（自带 Agent 选择器 + 团队聚合 + 图谱/文件树），
 * 故此处不再需要顶部 Segmented 切换头。
 */
function KnowledgeBase(props: { refreshTick?: number }) {
  const { refreshTick = 0 } = props;
  const tr = useT();
  const [probing, setProbing] = React.useState(true);
  const [remoteAvailable, setRemoteAvailable] = React.useState(false);
  const [agents, setAgents] = React.useState<KbAgent[]>([]);
  const [probeError, setProbeError] = React.useState("");

  // 探测：有 Controller token 且远端有 Agent → 可用；否则置 probeError 供指引。
  // （去掉 setMode——纯远端无 mode 概念。）
  const probe = React.useCallback(() => {
    setProbing(true);
    setProbeError("");
    void fetchKbAgents()
      .then((list) => {
        setAgents(list);
        const ok = list.length > 0;
        setRemoteAvailable(ok);
        if (!ok) {
          setProbeError("no-agents");
          return;
        }
        // probe 成功后后台预热默认 agent 的 tree+graph。
        // 真冷路径实测（生产环境，外网 5M）：tree 冷算 ≈3.4-3.7s（单次 docker
        // exec 往返的物理成本，架构层不可再压）、graph ≈0.9s、温缓存 13-18ms。
        // 首帧可见时若恰好撞上冷算 = 用户等 3.7s；预热后首帧请求命中 SWR
        // （盘+30s 内存）。fire-and-forget：目标 = 首个 agent（无记忆回退值）
        // + 记忆 agent；失败静默（= 退回现状，下次访问冷算），绝不阻塞首帧。
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
        setProbeError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setProbing(false));
  }, []);

  React.useEffect(() => {
    void probe();
  }, [probe]);

  // 远端不可用（probe 失败 / 空）→ 顶部指引；探测中 → loading；
  // 可用 → RemoteKbView（自包含）。不再渲染 LocalKbView。
  const showUnavailable = !remoteAvailable && !!probeError;
  return (
    <antd.Space direction="vertical" size={10} style={{ width: "100%" }}>
      {showUnavailable ? (
        <antd.Alert
          type="warning"
          showIcon
          message={tr("远端团队知识库不可用")}
          description={
            /401/.test(probeError)
              ? tr("远端团队知识库需要 L1（管理员）凭据——配置页填写 Controller 管理员 token 后重新进入知识库即可加载。L2 用户没有该 token，此视图不可用（向管理员申请 L1 凭据）。")
              : probeError === "no-agents"
                ? tr("远端未找到 Worker 容器（Controller 未接入？）")
                : probeError
          }
        />
      ) : null}
      {probing ? (
        <div style={{ padding: "40px 0", textAlign: "center" }}>
          <antd.Spin size="small" />
        </div>
      ) : remoteAvailable ? (
        <RemoteKbView agents={agents} refreshTick={refreshTick} />
      ) : null}
    </antd.Space>
  );
}

// 面板级 memo——父级（WorkbenchPage）重渲染
// 且 props 无变化时跳过（修复前全仓零 memo，切 tab 帧断 183-200ms）。
export default React.memo(KnowledgeBase);
