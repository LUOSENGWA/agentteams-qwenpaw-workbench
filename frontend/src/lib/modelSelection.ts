// modelSelection — 模型授权多选的选择态与提交门（纯逻辑，可脱离 host 测试）。
//
// 背景：「先选 provider 再选 model」的两级多选中，只选中 provider 属于
// 编辑中间态。如果这时就把 (provider, model) 对写回上层，pairs 会变成空，
// 上层按「空 = 无授权」把该 CLI 块整条删掉——表现就是「一选 Provider，
// 授权项消失」。因此提交必须等模型也选完，或用户明确清空。

export interface PairSelection {
  providers: string[];
  models: string[];
}

/** 是否可以把当前选择写回（models 非空，或两边都空 = 清空授权）。 */
export function selectionReadyToCommit(sel: PairSelection): boolean {
  if (sel.models.length > 0) return true;
  return sel.providers.length === 0;
}
