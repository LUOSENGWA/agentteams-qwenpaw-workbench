/**
 * ClusterMetaCard — 集群页顶「控制器」卡：Controller /api/v1/status 计数 +
 * /api/v1/version 版本（P1）。
 *
 * 取数：挂载时并行拉一次（域层 60s 缓存，无轮询）；失败静默降级——状态/
 * 版本各自失败只让对应格显 "—"，页面其余内容不受影响；/status 401/403
 * = 当前身份不可见控制器视图 → 整卡隐藏（不报错、不占位）。
 *
 * 版本 "dev" = 老控制器镜像未注入 build version（上游 StatusHandler
 * 硬编码），显式标注「dev（镜像未注入版本）」，避免看起来像真实版本。
 */
import type * as ReactNS from "react";

import { httpErrorStatus } from "../api/shared";
import {
  fetchClusterStatus,
  fetchControllerVersion,
  type ClusterStatus,
  type ControllerVersion,
} from "../api/domains/cluster";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export type ClusterMetaState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | {
      kind: "ready";
      status: ClusterStatus | null;
      version: ControllerVersion | null;
    };

/** 并行取两端点（互不牵连；永不 reject）。401/403 的 /status → 整卡隐藏。 */
export async function loadClusterMeta(): Promise<ClusterMetaState> {
  const [status, version] = await Promise.allSettled([
    fetchClusterStatus(),
    fetchControllerVersion(),
  ]);
  if (status.status === "rejected") {
    const st = httpErrorStatus(status.reason);
    if (st === 401 || st === 403) return { kind: "hidden" };
  }
  return {
    kind: "ready",
    status: status.status === "fulfilled" ? status.value : null,
    version: version.status === "fulfilled" ? version.value : null,
  };
}

/** 单格（与 OpsOverview 版本卡同视觉）。 */
function MetaTile({
  label,
  value,
  sub,
  title,
  t,
}: {
  label: string;
  value: string;
  sub?: string;
  title?: string;
  t: { border: string; cardBg: string; textSecondary: string };
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${t.border}`,
        background: t.cardBg,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 11, color: t.textSecondary }}>{label}</div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={title || value}
      >
        {value}
        {sub ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 400,
              color: t.textSecondary,
              marginLeft: 6,
            }}
          >
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 卡体（纯展示，可静态渲染测试）。 */
export function ClusterMetaCardBody({ state }: { state: ClusterMetaState }) {
  const t = useThemeColors();
  const tr = useT();
  if (state.kind === "hidden") return null;

  const status = state.kind === "ready" ? state.status : null;
  const version = state.kind === "ready" ? state.version : null;
  const dev = version?.controller === "dev";

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15 }}>{tr("控制器")}</span>
        <span
          style={{ fontSize: 11, color: t.textSecondary, cursor: "help" }}
          title={tr("Controller 实时快照（60s 缓存）")}
        >
          {tr("Controller 实时快照（60s 缓存）")}
        </span>
      </div>
      {state.kind === "loading" ? (
        <antd.Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: 10,
          }}
        >
          <MetaTile
            label={tr("部署模式")}
            value={status?.kubeMode || version?.kubeMode || "—"}
            t={{ border: t.border, cardBg: t.cardBg, textSecondary: t.textSecondary }}
          />
          <MetaTile
            label="Workers"
            value={status ? String(status.totalWorkers) : "—"}
            t={{ border: t.border, cardBg: t.cardBg, textSecondary: t.textSecondary }}
          />
          <MetaTile
            label="Teams"
            value={status ? String(status.totalTeams) : "—"}
            t={{ border: t.border, cardBg: t.cardBg, textSecondary: t.textSecondary }}
          />
          <MetaTile
            label="Humans"
            value={status ? String(status.totalHumans) : "—"}
            t={{ border: t.border, cardBg: t.cardBg, textSecondary: t.textSecondary }}
          />
          <MetaTile
            label={tr("Controller 版本")}
            value={
              version
                ? version.controller || "—"
                : "—"
            }
            sub={dev ? tr("dev（镜像未注入版本）") : undefined}
            title={version?.controller || undefined}
            t={{ border: t.border, cardBg: t.cardBg, textSecondary: t.textSecondary }}
          />
        </div>
      )}
    </div>
  );
}

/** 挂载即取一次；卸载后丢弃结果（域层缓存 60s 兜住重进）。 */
export default function ClusterMetaCard() {
  const [state, setState] = React.useState<ClusterMetaState>({
    kind: "loading",
  });
  React.useEffect(() => {
    let alive = true;
    void loadClusterMeta().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  return <ClusterMetaCardBody state={state} />;
}
