// 生命周期动作（#1473 消费侧）：worker/manager 重启端点 +
// 主模型保存文案（qwenpaw 热应用 vs 其它 runtime 需重启）。

import { postController } from "../shared";

/** POST /api/v1/workers/{name}/restart（authz=wake）→ 200
 * {name, phase:"Restarting"}；停容器失败 → 502；容器不存在 → 仍返回
 * Restarting（控制器会在 reconcile 里拉起）。 */
export async function restartWorker(
  name: string,
): Promise<{ name: string; phase: string }> {
  return (await postController(
    `/workers/${encodeURIComponent(name)}/restart`,
  )) as { name: string; phase: string };
}

/** POST /api/v1/managers/{name}/restart（authz=update）→ 同款响应。 */
export async function restartManager(
  name: string,
): Promise<{ name: string; phase: string }> {
  return (await postController(
    `/managers/${encodeURIComponent(name)}/restart`,
  )) as { name: string; phase: string };
}

/** 主模型保存成功文案（#1473 热应用）：qwenpaw worker 改主模型
 * 进程内 reload（applyActiveModelHot）→ 「立即生效」；其它 runtime
 * 仍需重启容器。纯函数，导出供测试。
 *
 * 严格相等判定（与库内 `runtime === "qwenpaw"` 口径一致，
 * ModelEditModal / WorkerRuntimeConfigSurface 同款）。 */
export function modelSaveCopyKey(
  runtime: string,
): "模型已保存（立即生效）" | "模型已保存（重启 Worker 后生效）" {
  return runtime === "qwenpaw"
    ? "模型已保存（立即生效）"
    : "模型已保存（重启 Worker 后生效）";
}
