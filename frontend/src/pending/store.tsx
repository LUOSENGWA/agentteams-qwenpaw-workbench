// P0 人工介入闭环 — 待处理 store（任务书 §3 Stage 1）。
//
// 宿主桥模式（本项目不可 `import React from "react"`）：React Context +
// useState + localStorage（键 agentteams-pending-v1，version 1）。
// 只持久化 items + resolutions；深链指针（pendingChatRoomId /
// pendingProjectKey）是一次性导航指令，留在内存——刷新后重放会把用户
// 弹回上一个房间（dashboard hitl-inbox partialize 同一决策）。
//
// 纪律（任务书 §5）：
// - 待办 items **不截断**——只能被答复/过期/登录切换弄出去
//   （dashboard 方案 v3 C-4：静默丢条 = 任务永远卡阻塞态）；
// - resolutions 保留上限 50（它只是「这个 id 处理过了」的去重集，
//   旧条目掉出去无损失），超限时按 at 最旧逐出；
// - 已 resolved 的 id 不再 upsert 复活。

import type * as ReactNS from "react";
import type { PendingItem, PendingResolution } from "./types";

const host = window.QwenPaw.host;
const React = host.React;

export const PENDING_STORAGE_KEY = "agentteams-pending-v1";
export const RESOLUTIONS_CAP = 50;
const NAV_EVENT = "agentteams-pending-nav";

interface PersistedData {
  v: 1;
  items: PendingItem[];
  resolutions: PendingResolution[];
}

const EMPTY: PersistedData = { v: 1, items: [], resolutions: [] };

function loadStored(): PersistedData {
  try {
    const raw = window.localStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<PersistedData> | null;
    if (
      !parsed ||
      parsed.v !== 1 ||
      !Array.isArray(parsed.items) ||
      !Array.isArray(parsed.resolutions)
    ) {
      return EMPTY;
    }
    return { v: 1, items: parsed.items, resolutions: parsed.resolutions };
  } catch {
    return EMPTY;
  }
}

function persist(data: PersistedData): void {
  try {
    window.localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* 存储满/隐私模式——内存态继续工作，刷新后回源 */
  }
}

// ── 深链指针（内存，不持久化）─────────────────────────────────────

let _pendingChatRoomId: string | null = null;
let _pendingProjectKey: string | null = null;

export function setPendingChatRoomId(roomId: string | null): void {
  _pendingChatRoomId = roomId;
}
export function setPendingProjectKey(key: string | null): void {
  _pendingProjectKey = key;
}
/** 原子读清（读一次后立刻置空，防重复深链）。 */
export function takePendingChatRoomId(): string | null {
  const cur = _pendingChatRoomId;
  _pendingChatRoomId = null;
  return cur;
}
export function takePendingProjectKey(): string | null {
  const cur = _pendingProjectKey;
  _pendingProjectKey = null;
  return cur;
}

/** 通知 UI 层有深链待应用（系统通知点击 / 跨组件跳转）。 */
export function emitPendingNav(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(NAV_EVENT));
  } catch {
    /* noop */
  }
}
export function onPendingNav(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(NAV_EVENT, fn);
  return () => window.removeEventListener(NAV_EVENT, fn);
}

// ── store ─────────────────────────────────────────────────────────

export interface PendingResolveInput {
  status: "sent" | "answered" | "expired";
  actor?: string;
  answer?: string;
}

export interface PendingStore {
  items: PendingItem[];
  resolutions: PendingResolution[];
  /** 已裁决 id 集合（去重用；O(1)）。 */
  resolvedIds: ReadonlySet<string>;
  /** 新待办/更新。已 resolved 的 id 不复活；同 id 更新保留最初
   * createdAt（列表排序稳定）。 */
  upsert(item: PendingItem): void;
  /** 批量 upsert（attention / workflow 轮询整表刷新）。 */
  upsertMany(list: PendingItem[]): void;
  /** 静默移除（不记 resolution；如「该 id 已从上游消失且非答复」
   * 由 expire 处理，remove 留给调用方明确的丢弃场景）。 */
  remove(id: string): void;
  /** 答复/过期：移出 items + 记 resolution（同 id 只记一次）。 */
  resolve(id: string, input: PendingResolveInput): void;
  /** 批量过期（上游消失：interrupt 不再返回、@我 未读清零）。 */
  expire(ids: string[]): void;
  /** 全清（onLoginSuccess——换账号，旧待办不带走）。 */
  clear(): void;
}

function capResolutions(list: PendingResolution[]): PendingResolution[] {
  if (list.length <= RESOLUTIONS_CAP) return list;
  return [...list]
    .sort((a, b) => b.at - a.at)
    .slice(0, RESOLUTIONS_CAP);
}

function applyResolution(
  data: PersistedData,
  id: string,
  input: PendingResolveInput,
): PersistedData {
  if (data.resolutions.some((r) => r.id === id)) {
    // 已记过——只确保 items 里没有残留。
    return {
      ...data,
      items: data.items.some((it) => it.id === id)
        ? data.items.filter((it) => it.id !== id)
        : data.items,
    };
  }
  const resolution: PendingResolution = {
    id,
    status: input.status,
    at: Date.now(),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    ...(input.answer !== undefined ? { answer: input.answer } : {}),
  };
  return {
    ...data,
    items: data.items.filter((it) => it.id !== id),
    resolutions: capResolutions([...data.resolutions, resolution]),
  };
}

const PendingCtx = React.createContext<PendingStore | null>(null);

export function PendingProvider({ children }: { children: ReactNS.ReactNode }) {
  const [data, setData] = React.useState<PersistedData>(loadStored);

  React.useEffect(() => {
    persist(data);
  }, [data]);

  const store = React.useMemo<PendingStore>(() => {
    const resolvedIds = new Set<string>();
    for (const r of data.resolutions) resolvedIds.add(r.id);

    const upsertOne = (cur: PersistedData, item: PendingItem): PersistedData => {
      // 只有 answered/expired 才永久跳过；sent（已提交待处理）允许重新出现——
      // Controller 仍报同一 interrupt 说明还没真处理，UI 必须能再提示。
      if (
        cur.resolutions.some(
          (r) => r.id === item.id && (r.status === "answered" || r.status === "expired"),
        )
      )
        return cur;
      const prev = cur.items.find((it) => it.id === item.id);
      if (prev) {
        // m.replace 修订 / 轮询刷新：字段更新，createdAt 保持最初。
        return {
          ...cur,
          items: cur.items.map((it) =>
            it.id === item.id ? { ...item, createdAt: prev.createdAt } : it,
          ),
        };
      }
      return { ...cur, items: [...cur.items, item] }; // 不截断
    };

    return {
      items: data.items,
      resolutions: data.resolutions,
      resolvedIds,
      upsert: (item) => setData((cur) => upsertOne(cur, item)),
      upsertMany: (list) =>
        setData((cur) => {
          let next = cur;
          for (const item of list) next = upsertOne(next, item);
          return next;
        }),
      remove: (id) =>
        setData((cur) =>
          cur.items.some((it) => it.id === id)
            ? { ...cur, items: cur.items.filter((it) => it.id !== id) }
            : cur,
        ),
      resolve: (id, input) => setData((cur) => applyResolution(cur, id, input)),
      expire: (ids) =>
        setData((cur) => {
          if (ids.length === 0) return cur;
          let next = cur;
          for (const id of ids) {
            if (!next.items.some((it) => it.id === id)) continue; // 不在池 = 无痕迹
            next = applyResolution(next, id, { status: "expired" });
          }
          return next;
        }),
      clear: () => setData(EMPTY),
    };
  }, [data]);

  return <PendingCtx.Provider value={store}>{children}</PendingCtx.Provider>;
}

export function usePendingStore(): PendingStore {
  const store = React.useContext(PendingCtx);
  if (!store) {
    throw new Error("usePendingStore must be used within <PendingProvider>");
  }
  return store;
}
