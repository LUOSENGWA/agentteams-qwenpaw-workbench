// surface 写回辅助（纯逻辑，无 React）：点号路径读写 + sensitive-object 解析。
// 契约来源：#1493 member_config.go —— patch 必须是**嵌套对象**；sensitive 叶子整体写入，
// 读回值已脱敏为 "***"（严禁回写）；sensitive 且 type=object 的输入是文本，需 JSON.parse。

import type { SurfaceField } from "../api/domains/memberConfig";
import { isSensitiveUnchanged } from "./surfaceForm";

/** 点号键读嵌套值（段缺失/中途非对象 → undefined）。 */
export function getPath(obj: Record<string, unknown>, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** 点号键写嵌套值（中间段缺失/非对象 → 建空对象）。 */
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export interface SensitiveParseResult {
  patch: Record<string, unknown>;
  /** key → 错误文案键（调用方 tr） */
  errors: Record<string, string>;
}

/**
 * 把草稿里 sensitive+object 的文本值解析成对象写回 patch。
 * - 脱敏值/空值 → 视为未改（红线，不回写）
 * - 解析失败 → 记错误、停止后续字段（避免半截 patch 上送）
 */
export function applySensitiveObjectText(
  surfaceFields: SurfaceField[],
  draft: Record<string, unknown>,
  patch: Record<string, unknown>,
): SensitiveParseResult {
  const errors: Record<string, string> = {};
  for (const field of surfaceFields) {
    if (!(field.sensitive && field.type === "object")) continue;
    const raw = draft[field.key];
    if (isSensitiveUnchanged(field, raw)) continue;
    if (getPath(patch, field.key) === undefined) continue;
    if (typeof raw !== "string") continue;
    try {
      setPath(patch, field.key, JSON.parse(raw));
    } catch {
      errors[field.key] = "JSON 格式不对";
      break;
    }
  }
  return { patch, errors };
}
