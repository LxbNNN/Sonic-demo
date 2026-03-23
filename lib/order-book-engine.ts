/**
 * OrderBookManager — 订单簿核心引擎（单例）
 *
 * 架构：参考价分区（Reference-Price Partitioning）
 *
 * 核心原则：
 * 1. Map 忠实存储服务端数据，仅 size=0 删除，不做任何交叉剪枝
 * 2. 维护 EMA 参考价（refPrice），实时跟踪市场中枢
 * 3. 显示时用 refPrice 分区：bid 取 price < refPrice，ask 取 price > refPrice
 * 4. 结构性保证 bid < refPrice < ask，不可能交叉
 *
 * 为什么不剪枝：
 * - 服务端 bid/ask 天然有交叠（聚合源/AMM/延迟）
 * - 剪枝会销毁 Map 数据 → 高频场景必然导致一侧行数闪烁或冻结
 * - 参考价分区只做显示过滤，不修改 Map → 数据完整，显示稳定
 */

import type { OrderBookSyncState, PriceLevel, WsBookDeltaMessage } from "./types";
import { OrderBookSide, maxActivePrice, minActivePrice } from "./order-book-side";
import { marketBus } from "./market-events";

export interface OrderBookDiagnostics {
  syncState: OrderBookSyncState;
  stateDurationMs: number;
  lastSeq: number;
  lastDeltaAt: number;
  lastAppliedDeltaAt: number;
  lastUiFlushAt: number;
  lastBidDeltaAt: number;
  lastAskDeltaAt: number;
}

const MAX_MAP_ENTRIES = 2000;
const REF_ALPHA = 0.03;

export class OrderBookManager {
  private static instance: OrderBookManager | null = null;

  static getInstance(): OrderBookManager {
    if (!OrderBookManager.instance) {
      OrderBookManager.instance = new OrderBookManager();
    }
    return OrderBookManager.instance;
  }

  private depth = 20;
  private flushIntervalMs = 200;
  private tickSize = 0.1;
  private onFlush: ((bids: PriceLevel[], asks: PriceLevel[]) => void) | null =
    null;
  private flushTimer: number | null = null;
  private lastFlushTime = 0;

  private bidSide = new OrderBookSide("desc");
  private askSide = new OrderBookSide("asc");
  private lastSeq = -1;
  private dirty = false;
  private lastDeltaAt = 0;
  private lastAppliedDeltaAt = 0;
  private lastUiFlushAt = 0;
  private lastBidDeltaAt = 0;
  private lastAskDeltaAt = 0;
  private syncState: OrderBookSyncState = "init";
  private syncStateAt = 0;

  private prevBids: PriceLevel[] = [];
  private prevAsks: PriceLevel[] = [];

  /** EMA 参考价，用于分区 bid/ask 显示 */
  private refPrice = 0;

  private constructor() {}

  /** 配置引擎参数（链式调用） */
  configure(depth: number, flushIntervalMs?: number, tickSize?: number): this {
    this.depth = depth;
    if (flushIntervalMs !== undefined) this.flushIntervalMs = flushIntervalMs;
    if (tickSize !== undefined) this.tickSize = tickSize;
    return this;
  }

  /** 绑定 flush 回调：引擎每次输出新快照时调用 */
  bindFlush(
    onFlush: (bids: PriceLevel[], asks: PriceLevel[]) => void,
  ): this {
    this.onFlush = onFlush;
    return this;
  }

  /** 启动 rAF 循环，按 flushIntervalMs 节流调用 flush */
  start(): this {
    this.stopTimer();
    const loop = () => {
      const now = performance.now();
      if (now - this.lastFlushTime >= this.flushIntervalMs) {
        this.lastFlushTime = now;
        this.flush();
      }
      this.flushTimer = requestAnimationFrame(loop);
    };
    this.flushTimer = requestAnimationFrame(loop);
    return this;
  }

  /** 停止 flush 循环 */
  stop(): this {
    this.stopTimer();
    return this;
  }

  /** 重置所有状态（切换市场时调用） */
  reset(): this {
    this.bidSide.clear();
    this.askSide.clear();
    this.lastSeq = -1;
    this.dirty = false;
    this.lastDeltaAt = 0;
    this.lastAppliedDeltaAt = 0;
    this.lastUiFlushAt = 0;
    this.lastBidDeltaAt = 0;
    this.lastAskDeltaAt = 0;
    this.prevBids = [];
    this.prevAsks = [];
    this.refPrice = 0;
    this.setSyncState("init");
    return this;
  }

  /** 修改聚合粒度（清空缓存、标记脏位以触发重新 flush） */
  setTickSize(tick: number): this {
    if (tick > 0 && tick !== this.tickSize) {
      this.tickSize = tick;
      this.prevBids = [];
      this.prevAsks = [];
      this.dirty = true;
    }
    return this;
  }

  getTickSize(): number {
    return this.tickSize;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  /** 清除序列号锚点（重连/快照后需重新校准） */
  clearLastSeq(): this {
    this.lastSeq = -1;
    return this;
  }

  getSyncState(): OrderBookSyncState {
    return this.syncState;
  }

  /** 更新同步状态并通过事件总线广播 */
  setSyncState(state: OrderBookSyncState, reason?: string): this {
    if (this.syncState === state) return this;
    this.syncState = state;
    const now = Date.now();
    this.syncStateAt = now;
    if (state === "live") {
      this.lastDeltaAt = now;
      this.lastBidDeltaAt = now;
      this.lastAskDeltaAt = now;
    }
    marketBus.emit("orderbook_state_change", {
      state,
      reason,
      at: now,
    });
    return this;
  }

  /** 全量快照替换（清空旧数据 → 写入新数据 → 重置参考价） */
  replaceSnapshot(
    rawBids: unknown[],
    rawAsks: unknown[],
    snapshotSeq?: number,
  ) {
    this.bidSide.writeSnapshot(rawBids);
    this.askSide.writeSnapshot(rawAsks);

    const now = Date.now();
    this.lastSeq = Number.isFinite(snapshotSeq) ? Number(snapshotSeq) : -1;
    this.lastDeltaAt = now;
    this.lastBidDeltaAt = now;
    this.lastAskDeltaAt = now;
    this.prevBids = [];
    this.prevAsks = [];
    this.refPrice = 0;
    this.dirty = true;
  }

  /**
   * 应用增量：纯 Map 写入 + 更新 EMA 参考价。
   * 不做任何剪枝 — 交叉由 flush 的 refPrice 分区解决。
   */
  applyDelta(delta: WsBookDeltaMessage): boolean {
    if (this.lastSeq >= 0 && delta.seq <= this.lastSeq) {
      return false;
    }

    const now = Date.now();

    if (Array.isArray(delta.bids) && delta.bids.length > 0) {
      this.bidSide.applyLevels(delta.bids as unknown[]);
      this.lastBidDeltaAt = now;
    }
    if (Array.isArray(delta.asks) && delta.asks.length > 0) {
      this.askSide.applyLevels(delta.asks as unknown[]);
      this.lastAskDeltaAt = now;
    }

    this.updateRefPrice(delta);

    this.lastSeq = delta.seq;
    this.lastDeltaAt = now;
    this.lastAppliedDeltaAt = now;
    this.dirty = true;
    return true;
  }

  /** 从增量中提取最优买/卖价，更新 EMA 参考价 */
  private updateRefPrice(delta: WsBookDeltaMessage): void {
    let deltaBid = -1;
    let deltaAsk = Infinity;

    if (Array.isArray(delta.bids) && delta.bids.length > 0) {
      deltaBid = maxActivePrice(delta.bids as unknown[]);
    }
    if (Array.isArray(delta.asks) && delta.asks.length > 0) {
      deltaAsk = minActivePrice(delta.asks as unknown[]);
    }

    let newRef = 0;
    if (deltaBid > 0 && deltaAsk < Infinity) {
      newRef = (deltaBid + deltaAsk) / 2;
    } else if (deltaBid > 0) {
      newRef = deltaBid;
    } else if (deltaAsk < Infinity) {
      newRef = deltaAsk;
    }

    if (newRef > 0) {
      this.refPrice = this.refPrice > 0
        ? this.refPrice * (1 - REF_ALPHA) + newRef * REF_ALPHA
        : newRef;
    }
  }

  /** 返回引擎运行诊断信息（供健康检查使用） */
  getDiagnostics(): OrderBookDiagnostics {
    const now = Date.now();
    return {
      syncState: this.syncState,
      stateDurationMs: this.syncStateAt > 0 ? now - this.syncStateAt : 0,
      lastSeq: this.lastSeq,
      lastDeltaAt: this.lastDeltaAt,
      lastAppliedDeltaAt: this.lastAppliedDeltaAt,
      lastUiFlushAt: this.lastUiFlushAt,
      lastBidDeltaAt: this.lastBidDeltaAt,
      lastAskDeltaAt: this.lastAskDeltaAt,
    };
  }

  /**
   * 显示刷新：
   * 1. 用 refPrice 过滤 bid → 得到 bestBid（真实最优买价）
   * 2. 用 bestBid 作为 ask 的边界 → 边界由实际数据决定，不随 EMA 波动
   * 3. 如 bid 不足，用 bestAsk 扩展 bid 边界
   *
   * 结构性保证：bids < bestAsk ≤ asks，不可能交叉。
   */
  private flush() {
    if (!this.onFlush) return;
    if (!this.dirty) return;
    this.dirty = false;

    const MAX_PENDING = 200;
    if (this.bidSide.pendingDeleteCount > MAX_PENDING) {
      this.bidSide.flushPendingDeletes();
    }
    if (this.askSide.pendingDeleteCount > MAX_PENDING) {
      this.askSide.flushPendingDeletes();
    }

    this.bidSide.trimToMax(MAX_MAP_ENTRIES, this.refPrice || undefined);
    this.askSide.trimToMax(MAX_MAP_ENTRIES, this.refPrice || undefined);

    const refBound = this.refPrice > 0 ? this.refPrice : undefined;

    let bids = this.bidSide.top(this.depth, this.tickSize, refBound);

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const askBound = bestBid > 0 ? bestBid : refBound;
    const asks = this.askSide.top(this.depth, this.tickSize, askBound);

    if (bids.length < this.depth && asks.length > 0) {
      const bestAsk = asks[0].price;
      const expanded = this.bidSide.top(this.depth, this.tickSize, bestAsk);
      if (expanded.length > bids.length) {
        bids = expanded;
      }
    }

    if (levelsEqual(bids, this.prevBids) && levelsEqual(asks, this.prevAsks)) {
      return;
    }

    this.prevBids = bids;
    this.prevAsks = asks;
    this.lastUiFlushAt = Date.now();
    this.onFlush(bids, asks);
  }

  /** 取消 rAF 定时器 */
  private stopTimer() {
    if (this.flushTimer !== null) {
      cancelAnimationFrame(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/** 逐行比较两组档位是否完全一致（价格 + 数量），避免无变化时触发 UI 更新 */
function levelsEqual(a: PriceLevel[], b: PriceLevel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].price !== b[i].price || a[i].size !== b[i].size) return false;
  }
  return true;
}
