// CrdManage 拆分（QC-196 方案 §5.2）· A 簇 hook：员工入职（Human CRD
// 创建/删除 + 一次性 initialPassword）+ 权限管理（Human CRD spec →
// merge-patch 命令生成）。函数体逐字自 components/CrdManage.tsx 搬移
//（零改写）。

import type * as ReactNS from "react";

import {
  createHuman,
  deleteHuman,
  type HumanInfo,
} from "../api";
import { invalidateTags } from "../requestCache";
import { copyText } from "../util";
import { EMPTY_HUMAN_FORM, type CrdManageProps, type TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface UseHumanCrdArgs {
  onRefresh: CrdManageProps["onRefresh"];
  tr: TrFn;
}

export function useHumanCrd({ onRefresh, tr }: UseHumanCrdArgs) {
  // ── 员工入职（Human CRD 创建）──
  const [hForm, setHForm] = React.useState(EMPTY_HUMAN_FORM);
  const [hBusy, setHBusy] = React.useState(false);
  /** 创建成功且拿到 initialPassword（只显示一次）。 */
  const [created, setCreated] = React.useState<{
    name: string;
    password: string;
  } | null>(null);

  const doCreateHuman = React.useCallback(async () => {
    const name = hForm.name.trim();
    if (!name || /[@\s:]/.test(name)) {
      antd.message.warning(tr("账号名不能为空，且不能含 @、冒号、空格"));
      return;
    }
    setHBusy(true);
    try {
      const resp = await createHuman({
        name,
        displayName: hForm.displayName.trim() || undefined,
        email: hForm.email.trim() || undefined,
        permissionLevel: hForm.permissionLevel,
        accessibleTeams: hForm.accessibleTeams.length
          ? hForm.accessibleTeams
          : undefined,
        accessibleWorkers: hForm.accessibleWorkers.length
          ? hForm.accessibleWorkers
          : undefined,
        note: hForm.note.trim() || undefined,
      });
      setHForm(EMPTY_HUMAN_FORM);
      if (resp?.initialPassword) {
        setCreated({ name, password: resp.initialPassword });
      } else {
        antd.message.success(tr("入职成功"));
      }
      // 人 CRD 变更 → 失效 admin 缓存再刷。
      invalidateTags(["teams", "admin"]);
      onRefresh?.(true);
    } catch (e) {
      antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
    } finally {
      setHBusy(false);
    }
  }, [hForm, onRefresh, tr]);

  const copyPassword = React.useCallback(() => {
    if (!created) return;
    const text = `${created.name} / ${created.password}`;
    copyText(text, (ok) => {
      if (ok) antd.message.success(tr("已复制"));
      else antd.message.warning(text);
    });
  }, [created, tr]);

  const doDeleteHuman = React.useCallback(
    async (name: string) => {
      try {
        await deleteHuman(name);
        antd.message.success(tr("已删除"));
        // 人 CRD 变更 → 失效 admin 缓存再刷。
        invalidateTags(["teams", "admin"]);
        onRefresh?.(true);
      } catch (e) {
        antd.message.error(e instanceof Error ? e.message : tr("操作失败"));
      }
    },
    [onRefresh, tr],
  );

  // ── 权限管理（Human CRD spec 编辑）──
  // 上游 Controller REST 无 PUT /humans/{name}（dashboard updateHuman=死代码，
  // agt update 无 human 子命令）→ 生成 embedded apiserver merge-patch 命令
  // （标准姿势：token.csv 第一列 + 127.0.0.1:6443 + application/merge-patch+json）。
  const [permHuman, setPermHuman] = React.useState<HumanInfo | null>(null);
  const [permForm, setPermForm] = React.useState({
    permissionLevel: 2,
    accessibleTeams: [] as string[],
    accessibleWorkers: [] as string[],
  });
  const [permCmd, setPermCmd] = React.useState("");

  const openPerm = React.useCallback((h: HumanInfo) => {
    setPermHuman(h);
    setPermForm({
      permissionLevel: h.permissionLevel ?? 2,
      accessibleTeams: h.accessibleTeams ?? [],
      accessibleWorkers: h.accessibleWorkers ?? [],
    });
    setPermCmd("");
  }, []);

  const generatePermCmd = React.useCallback(() => {
    if (!permHuman) return;
    const spec: Record<string, unknown> = {
      permissionLevel: permForm.permissionLevel,
      accessibleTeams: permForm.accessibleTeams,
      accessibleWorkers: permForm.accessibleWorkers,
    };
    const json = JSON.stringify({ spec });
    setPermCmd(
      [
        "# 在运行 agentteams-controller 的宿主机执行",
        "# 生效：reconcile 周期（约 5 分钟）内把此人拉入/移出团队房间",
        "docker exec agentteams-controller sh -c '",
        "TOKEN=$(cut -d, -f1 /data/agentteams-controller/pki/token.csv)",
        `curl -sk -X PATCH "https://127.0.0.1:6443/apis/agentteams.io/v1beta1/namespaces/default/humans/${permHuman.name}" \\`,
        '  -H "Authorization: Bearer $TOKEN" \\',
        '  -H "Content-Type: application/merge-patch+json" \\',
        `  -d "${json.replace(/"/g, '\\"')}"`,
        "'",
      ].join("\n"),
    );
  }, [permHuman, permForm]);

  const copyPermCmd = React.useCallback(() => {
    if (!permCmd) return;
    copyText(permCmd, (ok) => {
      if (ok) antd.message.success(tr("已复制"));
      else antd.message.warning(tr("复制失败——请手动全选复制"));
    });
  }, [permCmd, tr]);
  return {
    hForm,
    setHForm,
    hBusy,
    created,
    setCreated,
    doCreateHuman,
    copyPassword,
    doDeleteHuman,
    permHuman,
    setPermHuman,
    permForm,
    setPermForm,
    permCmd,
    openPerm,
    generatePermCmd,
    copyPermCmd,
  };
}
