// 建队表单千锻段（任务书 B 的包装层）——useMillforgeCore 实例 + 启用开关
// + preCreate（提交建队前置：编译（若未编译）→ 注入 → 返回覆盖成员行）+
// postCreate（建队成功复位）。workerMembers = 选中/新建的 worker 名。

import type * as ReactNS from "react";

import type { WorkerInfo } from "../api";
import type { TrFn, WorkerRow } from "../crdmanage/types";
import { useMillforgeCore } from "./useMillforgeCore";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;

export function useMillforgeCreate(tr: TrFn, workers: WorkerInfo[]) {
  const core = useMillforgeCore(tr);
  const [enabled, setEnabled] = React.useState(false);

  /** 提交建队前置：未启用 → null（表单行原样走）；启用 → 编译+注入后
   * 返回成员行覆盖表单行。失败抛错（调用方 toast 并中止建队；注入部分
   * 失败同样抛——结果表已在折叠区渲染，用户可看逐项状态）。 */
  const preCreate = React.useCallback(
    async (teamName: string): Promise<WorkerRow[] | null> => {
      if (!enabled) return null;
      // 1) 编译（本会话已编译则复用 build）
      let build = core.build;
      if (!build) {
        const out = await core.compileWithTemplate(teamName);
        if (!out.build) throw new Error(out.error || tr("编译失败"));
        build = out.build;
      }
      // 2) 注入（mapping / create；部分失败抛）
      const res = await core.doInject(teamName);
      if (!res) throw new Error(core.injectError || tr("注入失败"));
      if (res.partial) {
        throw new Error(tr("注入部分失败——失败项见结果表，修正后再提交建队"));
      }
      // 3) 成员行（workerMembers = 选中/新建的 worker 名）
      if (core.injectMode === "mapping") {
        const rows: WorkerRow[] = [];
        const seen = new Set<string>();
        for (const [role, raw] of Object.entries(core.mapping)) {
          const n = (raw || "").trim();
          if (!n || seen.has(n)) continue;
          seen.add(n);
          const w = workers.find((x) => x.name === n);
          const kind = build.roles.find((r) => r.role === role)?.kind;
          const isLeader = w?.role === "team_leader" || (!w && kind === "leader");
          rows.push({ name: n, role: isLeader ? "team_leader" : "worker" });
        }
        return rows;
      }
      const rows: WorkerRow[] = [];
      for (const c of res.created) {
        if (c.status !== "ok") continue;
        const src = core.createRows.find((r) => r.name.trim() === (c.name || ""));
        rows.push({
          name: c.name || "",
          role: src?.role || "worker",
          model: (src?.model || "").trim() || undefined,
        });
      }
      return rows;
    },
    [enabled, core, workers, tr],
  );

  /** 建队成功：复位千锻段（清 build/注入结果/自定义；源/pack/spec 保留）。 */
  const postCreate = React.useCallback(() => {
    core.resetAfterCreate();
    setEnabled(false);
  }, [core]);

  return { core, enabled, setEnabled, preCreate, postCreate };
}

export type MfCreate = ReturnType<typeof useMillforgeCreate>;
