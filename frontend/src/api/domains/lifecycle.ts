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

/**
 * POST /api/v1/workers/{name}/ensure-ready → 200 {name, phase}。
 * 拉起就绪（lifecycle_handler EnsureReady）：Stopped/Sleeping → 置 desired
 * Running 并直接拨号后端拉起；phase 已 Running 但容器实际停止 → 兜底拉起；
 * 已在运行 → no-op 返回当前 phase（worker 自报 ready 后为 "Ready"）。
 * authz：L1（admin/manager）全通；team leader / L2 403（按钮 L1-only 门控）。
 * 404 = 老控制器无该路由（→ 调用方回落 reportWorkerReady）/ worker 不存在。
 */
export async function ensureWorkerReady(
  name: string,
): Promise<{ name: string; phase: string }> {
  return (await postController(
    `/workers/${encodeURIComponent(name)}/ensure-ready`,
  )) as { name: string; phase: string };
}

/**
 * POST /workers/{name}/ready → 204。worker 自报 ready（置 ready flag，
 * 不拉起容器）——作为 ensure-ready 的旧控制器回落路径。
 * authz：L1 全通（admin/manager 可替任何 worker 上报，authorizer full access）。
 */
export async function reportWorkerReady(name: string): Promise<void> {
  await postController(`/workers/${encodeURIComponent(name)}/ready`);
}

/**
 * 拉起就绪 = ensure-ready，任意失败回落 ready（旧控制器只有 ready 路由，
 * ensure-ready 404 是预期的版本门形态）。回落再失败 → 抛回落的错误
 * （双 404 时 404 原样传出，UI 据此把入口降级隐藏，不当错误提示）。
 */
export async function ensureWorkerReadyWithFallback(name: string): Promise<void> {
  try {
    await ensureWorkerReady(name);
    return;
  } catch {
    // 任意失败（404 老控制器 / 502 后端不可达 / 其它）→ 回落 ready。
  }
  await reportWorkerReady(name);
}

/** 「拉起就绪」按钮显示条件：phase 不在 Running/Ready 才显（任务书口径）。
 * 纯函数（单测直测）：trim + lowercase 比较，兼容 "Running"/"running"/""。
 * 空 phase（未上报）视为非就绪 → 显示。 */
export function shouldShowEnsureReady(phase: string | undefined | null): boolean {
  const p = (phase || "").trim().toLowerCase();
  return p !== "running" && p !== "ready";
}
