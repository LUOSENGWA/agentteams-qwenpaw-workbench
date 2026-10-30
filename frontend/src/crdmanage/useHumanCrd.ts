// CrdManage 拆分（QC-196 方案 §5.2）· A 簇 hook：员工入职（Human CRD
// 创建/删除 + 一次性 initialPassword）+ 访问与权限入口锚点
// （15.35：表单/保存/命令逻辑已移入 HumanAccessModal）。
// 函数体逐字自 components/CrdManage.tsx 搬移（零改写）。

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

interface UseHumanCrdArgs {
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

  // ── 访问与权限入口锚点（15.35：表单/命令逻辑已移入 HumanAccessModal）──
  // openPerm(human) = 打开该人的 HumanAccessModal；modal 自持草稿/保存/
  // 命令生成（一键 PUT，404/405 回落 merge-patch 命令）。
  const [permHuman, setPermHuman] = React.useState<HumanInfo | null>(null);

  const openPerm = React.useCallback((h: HumanInfo) => {
    setPermHuman(h);
  }, []);

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
    openPerm,
  };
}
