// Worker/角色选择行体（「配置团队」弹窗 CrdCfgModal 与建队卡 CrdTeamForm
// 共用）。Worker Select（40% 基线 + flex wrap）/角色 Select（132 定宽）/
// extra slot/删除钮两处同几何（CrdTeamForm 行容器注释「与 cfgRows 同几何」
// 自认），抽此收敛防漂移；行容器 div 留各自文件（两容器
// alignItems:"center" 有/无差异保留在消费方）。
// worker/role 选择逻辑差异（换 Worker 重新基线 vs 预填 CR 现值）由
// onWorkerPick 回调留在消费方；extra slot 承载 9A 的「不存在」Tag。
import type * as ReactNS from "react";
import type { AdminData } from "../api";
import type { TrFn } from "./types";
import { roleSelectOptions, workerOptionLabel } from "./helpers";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

/** 行结构类型（只读 name/role；两文件行类型结构兼容）。 */
interface WorkerRowLike {
  name?: string;
  role: string;
}

export function WorkerRowSelects({
  tr,
  row,
  workers,
  workerNames,
  taken,
  placeholder,
  extra,
  canRemove,
  onWorkerPick,
  onRolePick,
  onRemove,
}: {
  tr: TrFn;
  row: WorkerRowLike;
  workers: AdminData["workers"];
  workerNames: string[];
  taken: Set<string>;
  /** 消费方已 tr 的 Worker 选择占位文案。 */
  placeholder: string;
  /** 角色 Select 之后的附加内容（如「不存在」Tag）。 */
  extra?: ReactNS.ReactNode;
  canRemove: boolean;
  onWorkerPick: (v: string) => void;
  onRolePick: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <antd.Select
        size="small"
        showSearch
        style={{ flex: "1 1 40%", minWidth: 0 }}
        placeholder={placeholder}
        value={row.name || undefined}
        onChange={onWorkerPick}
        options={workerNames
          .filter((n) => !taken.has(n))
          .map((n) => ({
            value: n,
            label: workerOptionLabel(n, workers),
          }))}
      />
      <antd.Select
        size="small"
        style={{ width: 132 }}
        value={row.role}
        onChange={onRolePick}
        options={roleSelectOptions(tr)}
      />
      {extra}
      {canRemove ? (
        <antd.Button size="small" type="text" danger onClick={onRemove}>
          ×
        </antd.Button>
      ) : null}
    </>
  );
}
