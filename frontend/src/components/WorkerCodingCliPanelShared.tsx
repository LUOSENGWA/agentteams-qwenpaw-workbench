import type * as ReactNS from "react";

import type {
  CodingCliId,
  CodingCliProbeItem,
  SettingsObject,
  SettingsValue,
} from "../api";
import {
  CODING_CLI_IDS,
  isRedacted,
} from "../codingCliPresets";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export const CLI_LABEL: Record<CodingCliId, string> = {
  "qwen-code": "Qwen Code",
  opencode: "OpenCode",
  qoder: "Qoder",
};

export interface LatestInfo {
  checking: boolean;
  latest?: string;
  error?: string;
}

/** 宽松版本号比较（仅数字段；prerelease 视为低于同号）。解析失败=0（未知）。 */
function compareVersions(a?: string, b?: string): number {
  const parse = (v?: string): number[] | null => {
    if (!v) return null;
    const core = v.split("-")[0].split("+")[0];
    const parts = core.split(".").map((x) => parseInt(x, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  // 同号：prerelease 低于正式版。
  const aPre = a && a.indexOf("-") >= 0 ? 1 : 0;
  const bPre = b && b.indexOf("-") >= 0 ? 1 : 0;
  return bPre - aPre;
}

/** 已装 CLI 的 registry latest 指示徽标（best-effort；不可达优雅降级）。 */
export function LatestBadge({
  info,
  installed,
  tr,
}: {
  info?: LatestInfo;
  installed?: string;
  tr: (k: string, v?: Record<string, string | number>) => string;
}) {
  if (!info) return null;
  if (info.checking) {
    return (
      <antd.Tag
        color="processing"
        style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
      >
        {tr("检查更新中…")}
      </antd.Tag>
    );
  }
  if (info.error) {
    return (
      <antd.Tag
        style={{
          marginInlineEnd: 0,
          fontSize: 10,
          lineHeight: "16px",
          opacity: 0.7,
        }}
      >
        {tr("registry 不可达（手动填 tag 仍可升级）")}
      </antd.Tag>
    );
  }
  if (!info.latest) return null;
  const cmp = compareVersions(installed, info.latest);
  if (cmp < 0) {
    return (
      <antd.Tag
        color="gold"
        style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
      >
        {tr("有更新 → {v}", { v: info.latest })}
      </antd.Tag>
    );
  }
  if (cmp === 0) {
    return (
      <antd.Tag
        color="success"
        style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
      >
        {tr("已是最新")}
      </antd.Tag>
    );
  }
  // 无法比较（版本号非标准）→ 仅提示 registry latest。
  return (
    <antd.Tag
      style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: "16px" }}
    >
      {tr("registry 最新 {v}", { v: info.latest })}
    </antd.Tag>
  );
}

const SENTINEL = "***";
export const POLL_MS = 1500;
/** R4（16.23）：任务轮询慢档——面板不可见（卡片收起）或页面隐藏时的
 * 兜底间隔（任务本身不停，只降观察频率；5min 上限语义不变）。 */
export const POLL_HIDDEN_MS = 30 * 1000;
export const POLL_MAX_MS = 5 * 60 * 1000;

/**
 * R4（16.23）：任务轮询间隔选档（纯函数，可 node 单测）。
 * 面板可见（卡片展开/sheet）且页面可见 → 快档 1.5s（安装体验：进度
 * 秒级反馈）；任一不可见 → 慢档 30s 兜底（后台 tab 不再 1.5s 打点）。
 */
export function taskPollDelayMs(
  panelVisible: boolean,
  pageVisible: boolean,
): number {
  return panelVisible && pageVisible ? POLL_MS : POLL_HIDDEN_MS;
}

export type LoadState = "loading" | "ready" | "unavailable" | "error";

export interface CliRowState {
  id: CodingCliId;
  installed: boolean;
  version?: string;
  authConfigured: boolean;
}

/** api 层已把 map 转数组；这里按白名单固定序归一（未知 CLI 静默丢弃）。 */
export function rowsFromItems(items: CodingCliProbeItem[]): CliRowState[] {
  const byId = new Map<string, CodingCliProbeItem>();
  for (const it of items) if (it && typeof it === "object") byId.set(it.cli, it);
  return (CODING_CLI_IDS as readonly string[]).map((id) => {
    const f = byId.get(id);
    return {
      id: id as CodingCliId,
      installed: f?.installed === true,
      version: f?.version,
      authConfigured: f?.auth?.configured === true,
    };
  });
}

function collectRedacted(
  obj: SettingsObject,
  path: string[] = [],
): Array<{ path: string[]; has_value: boolean }> {
  const out: Array<{ path: string[]; has_value: boolean }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const next = [...path, key];
    if (isRedacted(value)) out.push({ path: next, has_value: value.has_value });
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...collectRedacted(value as SettingsObject, next));
    }
  }
  return out;
}

/** 按路径读 settings 值（assignPath 的对称只读版）。 */
export function getAtPath(obj: SettingsObject | null | undefined, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 15.29：超时错误识别（requestJson 标记 isTimeout）。 */
export function isTimeoutError(e: unknown): boolean {
  return !!(e && typeof e === "object" && "isTimeout" in e && (e as { isTimeout?: boolean }).isTimeout);
}

/** 15.29：patch 的 model 值（字符串格式 / 兼容旧 {name} 对象）。 */
export function modelOfPatch(patch: SettingsObject): string | undefined {
  const m = patch.model;
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const n = (m as Record<string, unknown>).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}

/** 15.29：读回验证——patch 各顶层键是否已反映在回读 settings 中。
 *  secret 哨兵（"***"=保留）与回读脱敏值不可比 → 跳过；env 子树同
 * 深比较（值相等才算反映）。宁可判「未反映」（报错重试）也不假成功。 */
export function patchReflectedInSettings(
  patch: SettingsObject,
  settings: SettingsObject | undefined | null,
): boolean {
  if (!settings || typeof settings !== "object") return false;
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string" && v === "***") continue; // 保留哨兵
    const cur = settings[k];
    if (k === "model") {
      const cm =
        typeof cur === "string" ? cur
        : cur && typeof cur === "object" && typeof (cur as Record<string, unknown>).name === "string"
          ? ((cur as Record<string, unknown>).name as string)
          : "";
      const pm = modelOfPatch({ model: v });
      if (cm !== (pm ?? "")) return false;
      continue;
    }
    if (JSON.stringify(cur) !== JSON.stringify(v)) return false;
  }
  return true;
}

/** AutoComplete options（modelUnion 的三组或平铺；结构类型避免耦合）。 */
export type ModelOptions =
  | Array<{ value: string; label?: ReactNS.ReactNode }>
  | Array<{
      value: string;
      label: ReactNS.ReactNode;
      options: Array<{ value: string; label?: ReactNS.ReactNode }>;
    }>;

export function assignPath(target: SettingsObject, path: string[], value: SettingsValue) {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const child = cursor[key];
    // 15.31：穿过数组的路径（modelProviders.openai[i].field）——原实现把
    // Array 当「非 object」腐蚀成 {}（路由卡编辑 → openai:{"0":{...}}，丢数组
    // 结构）。数组是合法容器，保留；仅当 child 缺失/非法时按下一键创建
    // （数字索引→数组，其余→对象）。
    const isContainer = !!child && typeof child === "object" && !isRedacted(child);
    if (!isContainer) {
      cursor[key] = /^\d+$/.test(path[i + 1]) ? [] : {};
    }
    cursor = cursor[key] as SettingsObject;
  }
  cursor[path[path.length - 1]] = value;
}

/** 深拷贝（settings 是纯 JSON，含 redacted 哨兵对象，JSON 往返安全）。 */
export function deepCopySettings(obj: SettingsObject): SettingsObject {
  return JSON.parse(JSON.stringify(obj)) as SettingsObject;
}

/** 读模型名（双向兼容：qwen-code 对象 {name} / opencode·qoder 扁平串）。
 * 15.31：提取为共享助手——模型行的 dirty 判定与 handleSave 的 base 比对
 * 必须同口径（15.27 模型行漏接 dirty → 只改模型名时保存钮恒 disabled，改不动）。 */
export function modelNameOf(settings: SettingsObject | null | undefined): string {
  if (!settings) return "";
  const m = (settings as Record<string, unknown>).model;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const n = (m as Record<string, unknown>).name;
    if (typeof n === "string") return n;
  }
  return "";
}

/** 叶子级 diff（draft vs base）→ merge-patch。跳过 redacted（secret 另行
 * 处理）；object 递归下钻；array/标量按 JSON 比较，变更则整节点替换。 */
export function diffSettings(base: SettingsObject, draft: SettingsObject): SettingsObject {
  const patch: SettingsObject = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(draft)]);
  for (const key of keys) {
    const b = base[key];
    const d = draft[key];
    if (isRedacted(b) || isRedacted(d)) continue;
    const bIsObj = !!b && typeof b === "object" && !Array.isArray(b);
    const dIsObj = !!d && typeof d === "object" && !Array.isArray(d);
    if (bIsObj && dIsObj) {
      const sub = diffSettings(b as SettingsObject, d as SettingsObject);
      if (Object.keys(sub).length > 0) patch[key] = sub;
    } else if (JSON.stringify(b) !== JSON.stringify(d)) {
      patch[key] = d;
    }
  }
  return patch;
}

/** secret 补丁：每个 redacted 路径 → 用户新值 / "***"（保留现有）/ 省略（无值）。 */
export function buildSecretPatch(
  base: SettingsObject,
  secretDraft: Record<string, string>,
): SettingsObject {
  const patch: SettingsObject = {};
  for (const { path, has_value } of collectRedacted(base)) {
    const joined = path.join(".");
    const edited = secretDraft[joined] ?? "";
    if (edited !== "") assignPath(patch, path, edited);
    else if (has_value) assignPath(patch, path, SENTINEL);
  }
  return patch;
}
