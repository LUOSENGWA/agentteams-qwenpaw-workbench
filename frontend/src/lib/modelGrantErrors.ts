/**
 * modelGrantErrors.ts — #1514 模型授权强制：错误分类 + 统一文案（纯函数，node 可直测）。
 *
 * 契约（docs/design/model-grant-enforcement.md，上游 main 已合 67f274d6d）：
 * 两写面 PUT /workers/{name}（model/modelProvider/subagentModel）与
 * PUT /workers/{name}/coding-cli/{cli}/settings（model）只检查变化值，
 * 错误体 = {"message": "<code>: <detail>"}（httputil.WriteError，无独立
 * code 字段）；传输层 requestJsonFull 包成 `HTTP {status}: {message}`。
 * 已知 code：
 *   403 model_pair_required / model_pair_unresolvable /
 *       model_not_allowed / inherit_not_granted / provider_config_l1_only
 *   409 model_grant_overflow（消息含计数，上限 32）
 *
 * 分类模式沿用 classifyMetaError（api/domains/meta.ts）：优先显式
 * .status/.code 属性（自定义 Error 子类可携带），回退消息文本解析。
 * 本模块只做分类与文案映射——不改错误体、不吞状态码（调用方保留原始
 * 错误对象与 httpErrorStatus 判定）。
 */
import { httpErrorDetail, httpErrorStatus } from "../api/shared";

/** #1514 错误五分类。 */
export type ModelGrantErrorKind =
  | "pair_required" // 403：model 与 provider 必须成对下发
  | "unresolvable" // 403：model 无法绑定到任何网关 Provider
  | "overflow" // 409：worker 携带的隐式授权超过上限（32）
  | "forbidden" // 403 且非上述 grant code（权限拒绝，含 Leader 只读）
  | "other"; // 其余（404/5xx/超时/网络/非 HTTP 错误）

/** 三个 grant 专属 code → 分类；其余 403 code（model_not_allowed 等）归 forbidden。 */
const GRANT_CODE_KIND: Record<string, ModelGrantErrorKind> = {
  model_pair_required: "pair_required",
  model_pair_unresolvable: "unresolvable",
  model_grant_overflow: "overflow",
};

/** 状态码：显式 .status(number) 优先，回退 "HTTP xxx" 消息前缀。 */
function statusOf(e: unknown): number | null {
  if (e !== null && typeof e === "object") {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return httpErrorStatus(e);
}

/** code：显式 .code(string) 优先；回退 detail 的 "token:" 前缀
 *（httputil 错误体 code 以 snake_case 前缀嵌在 message 开头）。 */
function codeOf(e: unknown): string | null {
  if (e !== null && typeof e === "object") {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && c) return c;
  }
  const m = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(httpErrorDetail(e));
  return m ? m[1] : null;
}

/** 错误五分类（纯函数，可测）。 */
export function classifyModelGrantError(e: unknown): ModelGrantErrorKind {
  const code = codeOf(e);
  if (code && GRANT_CODE_KIND[code]) return GRANT_CODE_KIND[code];
  if (statusOf(e) === 403) return "forbidden";
  return "other";
}

/**
 * 分类 → 统一文案（任务书 B 四条）；"other" 返回 null（调用方回退
 * 原有错误文本展示，不吞错）。
 */
export function modelGrantErrorText(
  e: unknown,
  tr: (text: string) => string,
): string | null {
  switch (classifyModelGrantError(e)) {
    case "pair_required":
      return tr("需同时选择 Provider 和模型");
    case "unresolvable":
      return tr("该模型无法绑定到网关 Provider（请选择具体 Provider 模型）");
    case "overflow":
      return tr("授权记录过多（>32），请联系管理员清理");
    case "forbidden":
      return tr("无权限修改该 Worker 的模型");
    case "other":
      return null;
  }
}
