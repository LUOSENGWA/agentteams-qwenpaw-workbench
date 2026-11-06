// Model Access 数据面域（#1513）：worker 级模型配置授权/继承/锁定展示。
//
// 契约（#1513 已合，正文逐字）：
//   GET /api/v1/model-access?worker=<name>
//   {
//     "capabilities": {
//       "main":   { "canEdit": bool, "writeVia"?: string, "inheritedFrom"?: string },
//       "spawn":  { "canEdit": bool, "inherit": bool, "writeVia"?: string, "inheritedFrom"?: string },
//       "codingCli": { "<cli>": { "canEdit": bool, "inherit": bool, "inheritedFrom"?: string,
//                                "writeVia"?: string, "status"?: "cli_not_granted"|"not_granted"|"byok_unsupported" } }
//     },
//     "surfaces": {
//       "main":   { "entries": [{"provider": "…", "model": "…"}] },
//       "spawn":  { "entries": [...] },
//       "codingCli": { "<cli>": { "entries": [...] } }
//     },
//     "current": { "model": "…", "modelProvider": "…", "subagentModel": "…" },
//     "locked": bool,
//     "catalogUnavailable"?: bool
//   }
// 语义：
// - 授权轴只有 role + coding CLI（无 team / 无 per-worker 列表）；
// - (provider, model) 是成对的；目录方向 = provider → models，不反向映射；
// - inherit 是授权：spawn 空 → 继承主模型；CLI 空 → 继承 worker 的 spawn 模型
//   （spawn 空再回落主模型）；继承中的 surface 只读；
// - 缺 modelAccess → fail-closed（locked: true）。
// 部署现状（实测）：集群 controller 仍是旧版 → 本端点 404 → 调用方降级为
// { access: null, unsupported: true } =「无授权信息」（= 现有行为，不显示授权 UI）。
import { httpErrorStatus, requestJson } from "../shared";

/** 一条授予的 (provider, model) 对（成对；目录方向 = provider → models）。 */
export interface ModelAccessPair {
  provider: string;
  model: string;
}

/** 单 surface 授权能力。main 无 inherit（主模型不继承上游）；
 * spawn / codingCli 有 inherit（空值 = 继承上游）；status 为 CLI surface 特有。 */
export interface ModelAccessCapability {
  canEdit: boolean;
  inherit?: boolean;
  writeVia?: string;
  inheritedFrom?: string;
  status?: "cli_not_granted" | "not_granted" | "byok_unsupported";
}

export interface ModelAccessSurfaceEntries {
  entries?: ModelAccessPair[];
}

export interface ModelAccessSurfaces {
  main?: ModelAccessSurfaceEntries;
  spawn?: ModelAccessSurfaceEntries;
  codingCli?: Record<string, ModelAccessSurfaceEntries | undefined>;
}

export interface ModelAccessPayload {
  capabilities: {
    main?: ModelAccessCapability;
    spawn?: ModelAccessCapability;
    codingCli?: Record<string, ModelAccessCapability | undefined>;
  };
  surfaces: ModelAccessSurfaces;
  current?: {
    model?: string;
    modelProvider?: string;
    subagentModel?: string;
  };
  /** fail-closed：缺 modelAccess → controller 置 locked true（整弹窗只读）。 */
  locked: boolean;
  catalogUnavailable?: boolean;
}

/**
 * 取 worker 的 Model Access 授权信息。
 * 404（旧版 controller 无此端点）→ `{ access: null, unsupported: true }`
 *（不抛错；调用方降级为「无授权信息」= 现有行为）；其它错误照抛。
 */
export async function fetchModelAccess(
  worker: string,
): Promise<{ access: ModelAccessPayload | null; unsupported: boolean }> {
  try {
    const body = (await requestJson(
      `/agentteams-proxy/controller/api/v1/model-access?worker=${encodeURIComponent(
        worker,
      )}`,
      undefined,
      30000,
    )) as ModelAccessPayload | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      // 空 body / 形状非法 → 同按「无授权信息」降级（不炸 UI）。
      return { access: null, unsupported: true };
    }
    return { access: body, unsupported: false };
  } catch (e) {
    if (httpErrorStatus(e) === 404) return { access: null, unsupported: true };
    throw e;
  }
}
