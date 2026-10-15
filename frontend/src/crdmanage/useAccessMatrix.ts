// CrdManage 拆分（QC-196 方案 §5.2）· E 簇 hook：团队访问配置矩阵
//（员工 × 团队本地 overlay + 批量 merge-patch 命令生成——上游无 PUT
// humans，生成命令走 Controller 宿主机执行）。函数体逐字自
// components/CrdManage.tsx 搬移（零改写）。

import type * as ReactNS from "react";

import type { AdminData, HumanInfo } from "../api";
import { copyText } from "../util";
import type { TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface UseAccessMatrixArgs {
  /** 当前人员列表（矩阵行源 = CRD 原值）。 */
  humans: AdminData["humans"];
  tr: TrFn;
}

export function useAccessMatrix({ humans, tr }: UseAccessMatrixArgs) {
  // ── 团队访问配置（员工 × 团队矩阵）──
  // 需求——「可以配置哪些员工可以访问哪些团队」。
  // 勾选只改本地 overlay（不直写）——上游 Controller REST 无 PUT humans
  // （三重实锤同权限管理）→ 「生成命令」把全部变更汇成一条批量
  // merge-patch 脚本（每变更员工一行 patch 调用），在 Controller 宿主机
  // 执行。P-HUMANS-PUT 合并后此处零改动升级为一键 PUT（通用代理已支持）。
  const [accessOverlay, setAccessOverlay] = React.useState<
    Record<string, string[]>
  >({});
  const [accessCmd, setAccessCmd] = React.useState("");

  /** 当前生效值 = overlay 覆盖层，未覆盖 = CRD 原值。 */
  const accessOf = React.useCallback(
    (h: HumanInfo): string[] => accessOverlay[h.name] ?? h.accessibleTeams ?? [],
    [accessOverlay],
  );

  /** 有变更的员工：name → 目标 accessibleTeams（排序后与原值不等即变更）。 */
  const accessChanged = React.useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const h of humans) {
      const cur = accessOf(h);
      const orig = h.accessibleTeams ?? [];
      if (
        JSON.stringify([...cur].sort()) !== JSON.stringify([...orig].sort())
      ) {
        map[h.name] = cur;
      }
    }
    return map;
  }, [humans, accessOf]);

  const toggleAccess = React.useCallback(
    (name: string, team: string, on: boolean) => {
      const h = humans.find((x) => x.name === name);
      if (!h) return;
      const cur = accessOverlay[name] ?? h.accessibleTeams ?? [];
      const next = on ? [...cur, team] : cur.filter((x) => x !== team);
      setAccessOverlay((prev) => ({ ...prev, [name]: next }));
      setAccessCmd(""); // 数据变了，旧命令作废
    },
    [humans, accessOverlay],
  );

  const generateAccessCmd = React.useCallback(() => {
    const names = Object.keys(accessChanged);
    if (!names.length) return;
    const patchLines = names.map((n) => {
      const json = JSON.stringify({
        spec: { accessibleTeams: accessChanged[n] },
      }).replace(/"/g, '\\"');
      return `patch "${n}" "${json}"`;
    });
    setAccessCmd(
      [
        "# 在运行 agentteams-controller 的宿主机执行",
        `# 团队访问变更：${names.length} 名员工（reconcile 周期约 5 分钟生效）`,
        "docker exec agentteams-controller sh -c '",
        "TOKEN=$(cut -d, -f1 /data/agentteams-controller/pki/token.csv)",
        "patch() {",
        '  curl -sk -X PATCH "https://127.0.0.1:6443/apis/agentteams.io/v1beta1/namespaces/default/humans/$1" \\',
        '    -H "Authorization: Bearer $TOKEN" \\',
        '    -H "Content-Type: application/merge-patch+json" \\',
        '    -d "$2" && echo "  OK $1" || echo "  FAIL $1"',
        "}",
        ...patchLines,
        "'",
      ].join("\n"),
    );
  }, [accessChanged]);

  const copyAccessCmd = React.useCallback(() => {
    if (!accessCmd) return;
    copyText(accessCmd, (ok) => {
      if (ok) antd.message.success(tr("已复制"));
      else antd.message.warning(tr("复制失败——请手动全选复制"));
    });
  }, [accessCmd, tr]);
  return {
    accessOf,
    accessChanged,
    toggleAccess,
    generateAccessCmd,
    copyAccessCmd,
    accessCmd,
  };
}
