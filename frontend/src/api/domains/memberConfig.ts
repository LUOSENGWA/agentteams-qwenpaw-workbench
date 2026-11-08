// 成员配置 / 运行时 surface 域（#1493 实测契约）。全部端点挂在
// /agentteams-proxy/controller/api/ 下（不是 /api/v1/ —— controllerRequest
// 系自带前缀不适用，此处拼全路径）。请求走 chat 域 fetchFile
//（host.fetch 自动注入 Authorization，与 humanFiles 域同路）；
// 非 2xx 全量解析 body 抛 MemberConfigError（requestJson 错误路径会丢弃
// 纯文本 body 与 JSON body 的非 detail 字段，本域错误契约要求完整保留）。
//
// 路由：
//   GET  /api/runtimes/{runtime}/surface         surface 声明（仅认证）
//   GET  /api/members/{name}/config              当前配置
//   PUT  /api/members/{name}/config?if-rev=<rev> 写入
//   POST /api/members/{name}/config/rollback?rev=<64位hex> 回滚
//
// GET /config：rev = 磁盘 sha256 hex（乐观锁 token）；values 为嵌套文档，
// sensitive 已脱敏为 "***" 或原样 ref。PUT body = {patch}，必须嵌套对象
//（扁平点号键 → 422 unknown_field）。
//
// 非 2xx 错误 body（全部 → MemberConfigError{status, code, detail}）：
//   409 {error:"stale_rev", current, expected}        乐观锁冲突
//   409 {error:"runtime_unknown", runtime, supported}
//   422 {error:"unknown_field", fields}
//   422 {error:"no_writable_keys", unsupported}
//   422 {error:"invalid_value", key, detail}
//   403/404/502 → 纯文本 body
//
// 敏感字段红线（后端 #1493）：sensitive: true 字段（即使 type:"object"）
// 整体一个值写入 —— 敏感对象下的嵌套写被后端拒绝（422）；调用方不许拆
// 子键写（见 surfaceForm.isSensitiveUnchanged）。
// #1493 合并后契约对齐：SurfaceFieldType 增补真实 type 成员；normalizeSurface 定义在 lib/surfaceForm（node 直测）并在此 re-export。

import { fetchFile, resolvePluginUrl } from "./chat";

// 归一入口（定义在 lib/surfaceForm：本域值依赖 ./chat，node strip-types
// 下不可直导；O2 起 fetchRuntimeSurface 返回前调用它，仍 re-export 供外）。
import { normalizeSurface } from "../../lib/surfaceForm";
export { normalizeSurface };

/** 字段 type 联合（#1493 合并后契约对齐）：增补真实契约成员
 * number/boolean/secret/array/record；保留旧别名 int/float/bool/
 * string-list/enum（SchemaField 等 UI 仍按旧字面量 switch/比较，删旧
 * 成员会新增 tsc 错误，O2 随 UI 改造一并收窄）。注意 enum 是字段属性
 *（enum?: string[]），不是 type。 */
export type SurfaceFieldType =
  | "string"
  | "number"
  | "boolean"
  | "secret"
  | "array"
  | "record"
  | "object"
  | "int"
  | "float"
  | "bool"
  | "string-list"
  | "enum";

/** 单个字段声明（type/applies/class 为字面量联合）。 */
export interface SurfaceField {
  key: string;
  label?: string;
  type: SurfaceFieldType;
  default?: unknown;
  unit?: string;
  applies: "hot" | "next-turn" | "restart";
  class?: "selection" | "definition" | "policy";
  sensitive?: boolean;
  group?: string;
  enum?: string[];
}

/** surface 单个 face。 */
export interface SurfaceFace {
  id: string;
  label?: string;
  fields: SurfaceField[];
}

/** surface 声明（GET /api/runtimes/{runtime}/surface）。 */
export interface RuntimeSurface {
  runtime: string;
  runtimeVersion?: string;
  surfaceVersion: string;
  faces: SurfaceFace[];
}

/** 当前配置（GET /api/members/{name}/config）。rev = 磁盘 sha256 hex（乐观锁 token）。 */
export interface ConfigState {
  runtime: string;
  rev: string;
  /** 嵌套文档；sensitive 已脱敏为 "***" 或原样 ref。 */
  values: Record<string, unknown>;
  applied: "applied" | "pending";
  /** 待重启（等重启才生效）的字段。 */
  pendingRestart: string[];
  inactive?: string[];
}

/** 写/回滚 200 body（WriteResult）。 */
export interface ConfigWriteResult {
  runtime: string;
  /** 写入后的新 rev（下次写的乐观锁 token）。 */
  rev: string;
  applied: "applied" | "pending";
  pendingRestart: string[];
  inactive?: string[];
  /** 运行时不接受回写的键（含原因）。 */
  unsupported?: Array<{ key: string; reason: string }>;
  snapshot: unknown;
}

/** 域统一错误。code = body.error；detail = 完整 JSON body 或纯文本 body。 */
export class MemberConfigError extends Error {
  /** HTTP 状态码。 */
  status: number;
  /** body 错误码（stale_rev / unknown_field / no_writable_keys / invalid_value / runtime_unknown）。 */
  code?: string;
  /** 完整 JSON body（UI 可读 current/fields/unsupported 等）或纯文本 body。 */
  detail?: unknown;
  constructor(status: number, message: string, code?: string, detail?: unknown) {
    super(message);
    this.name = "MemberConfigError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 非 2xx body → MemberConfigError（{error,...} JSON / 纯文本两种形状都解析）。 */
async function readHttpError(resp: Response): Promise<MemberConfigError> {
  let text = "";
  try {
    text = (await resp.text()).trim();
  } catch {
    /* body 读失败 → 按空处理 */
  }
  if (text) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const code = typeof body.error === "string" ? body.error : undefined;
      return new MemberConfigError(
        resp.status,
        code ? `HTTP ${resp.status}: ${code}` : `HTTP ${resp.status}`,
        code,
        body,
      );
    } catch {
      /* 非 JSON → 纯文本 body */
    }
  }
  return new MemberConfigError(
    resp.status,
    text ? `HTTP ${resp.status}: ${text}` : `HTTP ${resp.status}`,
    undefined,
    text || undefined,
  );
}

/** 统一请求：非 2xx 解析 body 后抛 MemberConfigError（原因见文件头）。
 * 缓存/重试由调用方负责，本层不做。 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetchFile(path, resolvePluginUrl(path), init);
  if (!resp.ok) throw await readHttpError(resp);
  return (await resp.json()) as T;
}

/** surface 声明（GET /api/runtimes/{runtime}/surface，仅认证）。
 * O2：返回前套 normalizeSurface 归一旧 type 别名（int/float→number、
 * bool→boolean、string-list→array、enum→string 且保留 enum 属性）——
 * 面板控件只按真实契约成员 switch。 */
export async function fetchRuntimeSurface(runtime: string): Promise<RuntimeSurface> {
  const surface = await call<RuntimeSurface>(
    `/agentteams-proxy/controller/api/runtimes/${encodeURIComponent(runtime)}/surface`,
  );
  return normalizeSurface(surface);
}

/** 当前配置（GET /api/members/{name}/config）。 */
export async function fetchMemberConfig(name: string): Promise<ConfigState> {
  return call<ConfigState>(
    `/agentteams-proxy/controller/api/members/${encodeURIComponent(name)}/config`,
  );
}

/** 写入（PUT /api/members/{name}/config?if-rev=<rev>；body {patch} 必须
 * 嵌套对象；rev 为空时省略 ?if-rev）。 */
export async function putMemberConfig(
  name: string,
  patch: Record<string, unknown>,
  ifRev?: string,
): Promise<ConfigWriteResult> {
  const q = ifRev ? `?if-rev=${encodeURIComponent(ifRev)}` : "";
  return call<ConfigWriteResult>(
    `/agentteams-proxy/controller/api/members/${encodeURIComponent(name)}/config${q}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch }),
    },
  );
}

/** 回滚（POST /api/members/{name}/config/rollback?rev=<64位hex>）。 */
export async function rollbackMemberConfig(
  name: string,
  rev: string,
): Promise<ConfigWriteResult> {
  return call<ConfigWriteResult>(
    `/agentteams-proxy/controller/api/members/${encodeURIComponent(name)}/config/rollback?rev=${encodeURIComponent(rev)}`,
    { method: "POST" },
  );
}
