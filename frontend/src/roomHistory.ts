/**
 * 房间消息历史窗口 —— 游标 / 预取槽 / 在飞闸 / 空页走查的单一权威
 *（v0.5.0-beta.13.20 收敛模块）。
 *
 * 收敛背景：13.10 / 13.16 / 13.17 / 13.18 / 13.19 五轮装验修复此前散落
 * 在 WorkbenchPage 的独立代码路径（状态恢复内联块 / refreshMessages /
 * prefetchNext / loadMore），窗口游标与预取槽散布在 windowRoomRef /
 * messagesEndRef / loadingMoreRef / prefetchRef 四个 ref 里，版本注释
 * 互相引用。本轮把「窗口游标 + 预取单槽 + 空页走查 + 页合并」收敛进
 * 本模块；组件层只剩 React 消息数组（渲染面 + 乐观回显/编辑/撤回的
 * 本地变更）与显示侧滚动逻辑（RoomChat 锚保持 / 0.6 视口触顶 / 驻顶
 * 接力——属呈现不属数据）。
 *
 * 职责切分（防双源）：
 *  - 本模块 = 窗口游标（end）、预取槽、在飞闸的**唯一权威**。
 *  - 组件 React state = 消息数组的唯一持有者（send 乐观回显 / m.replace
 *    编辑 / 撤回标记不经过本模块——模块不复制消息对象，杜绝双份对象
 *    引用漂移）。
 *  - 落盘（I6）由组件在每次窗口变更后显式调用 setCachedMessages(全量
 *    窗口, 窗口游标)——grep 可审的纪律点，不做隐式副作用。
 *
 * 不变量（验收语义，非降格——括注装验来源）：
 *  I1 游标单调：end 只在 loadOlder 沿更早方向推进，或切房/空窗时按
 *     「首窗」重建（= 缓存 end ?? 本页 end）；refresh 永不回退浅游标
 *     （13.19：游标回退 → 整页重复 → 零新增 → 假死）。
 *  I2 合并非替换：新页按 event_id 去重后追加（尾部新）/ 前插（头部旧），
 *     窗口只增不缩（13.10：全量替换把翻过的历史滚出窗口）。
 *  I3 预取单槽：至多一页在飞；(房间, 游标) 双键控——房间或游标不符即
 *     作废（绝不跨房取页）；预取失败静默，真正加载时直拉兜底（不能把
 *     历史加载搭在早先的失败上）（13.18）。
 *  I4 空页走查：去重后零新增的页立即续拉下一页（≤ WALK_CAP 页；游标不
 *     前进即停）；零新增不落盘（无渲染=无前插=不闪跳）（13.19：空页
 *     → 6s 锁 → 再触发的假死）。
 *  I5 在飞单发：同一房间 loadOlder 不同窗双发（滚动预载 + 手动按钮
 *     同游标双拉 = 重复前插同一页）（13.16/13.17）。
 *  I6 落盘一致：每次持久化 = 「全量窗口 + 窗口游标」，游标不回退
 *     （13.10/13.19：缓存只存浅页 → 切房回来历史蒸发 / 游标回退）。
 */
import type { RoomMessage, RoomMessagesPage } from "./api";

/** 取页：(roomId, limit, from?) → 页。from=undefined = 最新一页。 */
export type PageFetcher = (
  roomId: string,
  limit: number,
  from?: string,
) => Promise<RoomMessagesPage>;

export const PAGE_SIZE = 50;
/** I4 空页走查上限（防服务端分页异常时无尽空转）。 */
export const WALK_CAP = 8;

/**
 * I2 合并（升序口径）——13.10 原语。prev = 当前已加载全量（含 loadOlder
 * 前插历史），page = 最新一页（dir=b，窗口内升序）；page 的缺失项只可能
 * 出现在 prev 末尾之后（房间消息只增不改序）→ event_id 去重追加；prev
 * 空 = 直接取页。编辑（m.replace）由 fetchRoomMessages 聚合，不在此重复。
 */
export function mergeForward(
  prev: RoomMessage[],
  page: RoomMessage[],
): RoomMessage[] {
  if (prev.length === 0) return page;
  const known = new Set(prev.map((m) => m.event_id));
  const fresh = page.filter((m) => !known.has(m.event_id));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh];
}

interface PrefetchSlot {
  room: string;
  end: string;
  promise: Promise<RoomMessagesPage>;
}

/**
 * 群消息历史窗口状态机（纯 TS，无 React/宿主依赖——可在 node 里单测）。
 * 组件在每次窗口变更后调用 commit（I1）；loadOlder 前检查 busy（I5）。
 */
export class RoomHistory {
  private room: string | null = null;
  /** I1：窗口游标（只随 loadOlder 沿更早方向推进，或首窗重建）。 */
  private end = "";
  /** I5：loadOlder 在飞闸（组件侧 loadingMore 是它的 UI 镜像）。 */
  private inflight = false;
  /** I3：预取单槽。 */
  private pf: PrefetchSlot | null = null;

  constructor(private fetchPage: PageFetcher) {}

  /** 当前窗口游标（I1）。组件侧 messagesEnd 的镜像源。 */
  get cursor(): string {
    return this.end;
  }

  get busy(): boolean {
    return this.inflight;
  }

  setBusy(v: boolean): void {
    this.inflight = v;
  }

  /**
   * I1 判定：本次调用是否「首窗」——切房（room 不同）或当前窗为空。
   * 注意 curCount 必须是**调用瞬间**的已加载条数（组件传其 state ref），
   * 不能是 set 之后的新值。
   */
  isFresh(roomId: string, curCount: number): boolean {
    return this.room !== roomId || curCount === 0;
  }

  /**
   * I1 首窗游标语义：首窗 = 缓存 end ?? 本页 end（缓存更深则保缓存，
   * 防浅页回退）；非首窗 = 既有游标（loadOlder 单调推进的那个），
   * 缓存被逐出也不回退。
   */
  windowEnd(
    roomId: string,
    curCount: number,
    cachedEnd: string | undefined,
    pageEnd: string,
  ): string {
    return this.isFresh(roomId, curCount)
      ? (cachedEnd || pageEnd)
      : (this.end || pageEnd);
  }

  /** 窗口游标落账（I1）——sync / loadOlder 成功后组件调用。 */
  commit(roomId: string, end: string): void {
    this.room = roomId;
    this.end = end;
  }

  /**
   * I3 单槽预取（(房间, 游标) 双键控）。同槽在飞 = 不重复发；换房/换
   * 游标 = 旧槽作废（promise 不再被消费）。失败静默——真正需要这一
   * 页时 consumeOrFetch 走直拉兜底。
   */
  prefetch(roomId: string, cursor: string): void {
    if (!roomId || !cursor) return;
    const cur = this.pf;
    if (cur && cur.room === roomId && cur.end === cursor) return;
    const promise = this.fetchPage(roomId, PAGE_SIZE, cursor);
    this.pf = { room: roomId, end: cursor, promise };
    promise.catch(() => {
      if (this.pf?.promise === promise) this.pf = null;
    });
  }

  /**
   * I3 消费：同房间同游标的预取在飞 → 零网络等待取回；预取已失败 →
   * 直拉兜底；槽不符（换房/游标推进）→ 作废槽并直拉。
   */
  private async consumeOrFetch(
    roomId: string,
    cursor: string,
  ): Promise<RoomMessagesPage> {
    const pf = this.pf;
    if (pf && pf.room === roomId && pf.end === cursor) {
      this.pf = null;
      try {
        return await pf.promise;
      } catch {
        // I3：预取失败不拖累真实加载——直拉兜底（报错走正常路径）。
      }
    } else if (pf) {
      this.pf = null; // 槽已作废（游标推进/换房）
    }
    return this.fetchPage(roomId, PAGE_SIZE, cursor);
  }

  /**
   * I4 空页走查：从当前窗口游标拉页；若整页去重后零新增（历史边界
   * 重叠等），立即续拉下一页——直到出现新增 / 触底（end 空）/ 游标不
   * 前进 / 达到 WALK_CAP。返回最终页（其 end = 新的窗口游标）与去重
   * 后的更早消息（零新增 = 空数组 → 组件不前插、不落盘）。
   */
  async walkFrom(
    roomId: string,
    knownIds: ReadonlySet<string>,
  ): Promise<{ page: RoomMessagesPage; older: RoomMessage[] }> {
    let page = await this.consumeOrFetch(roomId, this.end);
    let older = page.messages.filter((m) => !knownIds.has(m.event_id));
    let walkedEnd = "";
    let walk = 0;
    while (
      older.length === 0 &&
      page.end &&
      page.end !== walkedEnd &&
      walk < WALK_CAP
    ) {
      walkedEnd = page.end;
      walk += 1;
      page = await this.fetchPage(roomId, PAGE_SIZE, page.end);
      older = page.messages.filter((m) => !knownIds.has(m.event_id));
    }
    return { page, older };
  }
}
