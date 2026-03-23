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

// ======================== DEBUG CONFIG ========================
const DBG_ENABLED = true;
const DBG_REPORT_MS = 3_000;

interface DbgCounters {
  deltaCount: number;
  dupDeltaCount: number;
  bidZero: number;
  askZero: number;
  bidUpsert: number;
  askUpsert: number;
  flushCount: number;
  flushCallbackCount: number;
  flushSkipEqualCount: number;
  flushSkipCleanCount: number;
  lastReportAt: number;
  prevBidRows: number;
  prevAskRows: number;
}

function makeDbgCounters(): DbgCounters {
  return {
    deltaCount: 0,
    dupDeltaCount: 0,
    bidZero: 0,
    askZero: 0,
    bidUpsert: 0,
    askUpsert: 0,
    flushCount: 0,
    flushCallbackCount: 0,
    flushSkipEqualCount: 0,
    flushSkipCleanCount: 0,
    lastReportAt: performance.now(),
    prevBidRows: -1,
    prevAskRows: -1,
  };
}
// ==============================================================

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

  // ---- DEBUG ----
  private _d: DbgCounters = makeDbgCounters();

  private constructor() {}

  configure(depth: number, flushIntervalMs?: number, tickSize?: number): this {
    this.depth = depth;
    if (flushIntervalMs !== undefined) this.flushIntervalMs = flushIntervalMs;
    if (tickSize !== undefined) this.tickSize = tickSize;
    return this;
  }

  bindFlush(
    onFlush: (bids: PriceLevel[], asks: PriceLevel[]) => void,
  ): this {
    this.onFlush = onFlush;
    return this;
  }

  start(): this {
    this.stopTimer();
    this._d = makeDbgCounters();
    const loop = () => {
      const now = performance.now();

      if (DBG_ENABLED && now - this._d.lastReportAt >= DBG_REPORT_MS) {
        this.dbgReport(now);
      }

      if (now - this.lastFlushTime >= this.flushIntervalMs) {
        this.lastFlushTime = now;
        this.flush();
      }
      this.flushTimer = requestAnimationFrame(loop);
    };
    this.flushTimer = requestAnimationFrame(loop);
    return this;
  }

  stop(): this {
    this.stopTimer();
    return this;
  }

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

  clearLastSeq(): this {
    this.lastSeq = -1;
    return this;
  }

  getSyncState(): OrderBookSyncState {
    return this.syncState;
  }

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
      if (DBG_ENABLED) this._d.dupDeltaCount++;
      return false;
    }

    const now = Date.now();

    if (DBG_ENABLED) {
      this._d.deltaCount++;
      if (Array.isArray(delta.bids)) {
        for (const raw of delta.bids) {
          const s = extractSize(raw);
          if (s === 0) this._d.bidZero++;
          else if (s > 0) this._d.bidUpsert++;
        }
      }
      if (Array.isArray(delta.asks)) {
        for (const raw of delta.asks) {
          const s = extractSize(raw);
          if (s === 0) this._d.askZero++;
          else if (s > 0) this._d.askUpsert++;
        }
      }
    }

    if (Array.isArray(delta.bids) && delta.bids.length > 0) {
      this.bidSide.applyLevels(delta.bids as unknown[]);
      this.lastBidDeltaAt = now;
    }
    if (Array.isArray(delta.asks) && delta.asks.length > 0) {
      this.askSide.applyLevels(delta.asks as unknown[]);
      this.lastAskDeltaAt = now;
    }

    // 更新 EMA 参考价
    this.updateRefPrice(delta);

    this.lastSeq = delta.seq;
    this.lastDeltaAt = now;
    this.lastAppliedDeltaAt = now;
    this.dirty = true;
    return true;
  }

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
   * 0. 条件性清理延迟删除（上一帧行数 >= depth 才执行）
   * 1. 用 refPrice 过滤 bid → 得到 bestBid（真实最优买价）
   * 2. 用 bestBid 作为 ask 的边界 → 边界由实际数据决定，不随 EMA 波动
   * 3. 如 bid 不足，用 bestAsk 扩展 bid 边界
   *
   * 结构性保证：bids < bestAsk ≤ asks，不可能交叉。
   */
  private flush() {
    if (!this.onFlush) return;
    if (!this.dirty) {
      if (DBG_ENABLED) this._d.flushSkipCleanCount++;
      return;
    }
    this.dirty = false;

    // 延迟删除：不在 flush 中主动清理 pending deletes
    // 自然清理机制：
    //   1. applyLevels: 同价位 size>0 数据到来 → 自动取消 pending 标记
    //   2. trimToMax: Map 超限时裁剪远端条目（含 pending 条目）
    //   3. writeSnapshot: 快照重建时全量清理
    // 仅在 pending 过多时强制清理（防止极端情况内存泄漏）
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

    // Stage 1: bid 用 refPrice 过滤
    let bids = this.bidSide.top(this.depth, this.tickSize, refBound);
    const s1BidCount = bids.length;

    // Stage 2: ask 用 bestBid 作边界
    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const askBound = bestBid > 0 ? bestBid : refBound;
    const asks = this.askSide.top(this.depth, this.tickSize, askBound);

    // Stage 3: 如 bid 不足，用 bestAsk 作扩展边界
    let s3Expanded = false;
    if (bids.length < this.depth && asks.length > 0) {
      const bestAsk = asks[0].price;
      const expanded = this.bidSide.top(this.depth, this.tickSize, bestAsk);
      if (expanded.length > bids.length) {
        bids = expanded;
        s3Expanded = true;
      }
    }

    if (levelsEqual(bids, this.prevBids) && levelsEqual(asks, this.prevAsks)) {
      if (DBG_ENABLED) {
        this._d.flushCount++;
        this._d.flushSkipEqualCount++;
      }
      return;
    }

    if (DBG_ENABLED) {
      this._d.flushCount++;
      this._d.flushCallbackCount++;

      const pb = this._d.prevBidRows;
      const pa = this._d.prevAskRows;
      const bidChanged = pb >= 0 && bids.length !== pb;
      const askChanged = pa >= 0 && asks.length !== pa;

      if (bidChanged || askChanged) {
        const bestAskPrice = asks.length > 0 ? asks[0].price.toFixed(1) : "-";
        console.log(
          `[OB flush 行数变化]` +
            ` bid ${pb}->${bids.length} (s1=${s1BidCount}${s3Expanded ? " s3扩展" : ""})` +
            ` | ask ${pa}->${asks.length}` +
            ` | ref=${this.refPrice.toFixed(1)} bestBid=${bestBid.toFixed(1)} askBound=${askBound?.toFixed(1) ?? "none"} bestAsk=${bestAskPrice}` +
            ` | pend: bid=${this.bidSide.pendingDeleteCount} ask=${this.askSide.pendingDeleteCount}` +
            ` | map: bid=${this.bidSide.size} ask=${this.askSide.size}`,
        );
      }

      this._d.prevBidRows = bids.length;
      this._d.prevAskRows = asks.length;
    }

    this.prevBids = bids;
    this.prevAsks = asks;
    this.lastUiFlushAt = Date.now();
    this.onFlush(bids, asks);
  }

  private dbgReport(now: number) {
    const d = this._d;
    const sec = ((now - d.lastReportAt) / 1000).toFixed(1);
    const deltaRate = (d.deltaCount / parseFloat(sec)).toFixed(1);

    const bestBid = this.prevBids.length > 0 ? this.prevBids[0].price.toFixed(1) : "-";
    const bestAsk = this.prevAsks.length > 0 ? this.prevAsks[0].price.toFixed(1) : "-";
    console.log(
      `[OB ${sec}s]\n` +
        `  Delta: ${d.deltaCount} (${deltaRate}/s) | dup: ${d.dupDeltaCount}\n` +
        `  Bid: +${d.bidUpsert} upsert, -${d.bidZero} del(size=0) | Ask: +${d.askUpsert} upsert, -${d.askZero} del(size=0)\n` +
        `  refPrice: ${this.refPrice.toFixed(1)} | bestBid: ${bestBid} | bestAsk: ${bestAsk}\n` +
        `  Flush: ${d.flushCount}x (toUI ${d.flushCallbackCount}, skip:equal ${d.flushSkipEqualCount}, skip:clean ${d.flushSkipCleanCount})\n` +
        `  UI rows: bid=${d.prevBidRows}, ask=${d.prevAskRows} | Map: bid=${this.bidSide.size}, ask=${this.askSide.size} | pend: bid=${this.bidSide.pendingDeleteCount}, ask=${this.askSide.pendingDeleteCount} | seq=${this.lastSeq}`,
    );

    d.deltaCount = 0;
    d.dupDeltaCount = 0;
    d.bidZero = 0;
    d.askZero = 0;
    d.bidUpsert = 0;
    d.askUpsert = 0;
    d.flushCount = 0;
    d.flushCallbackCount = 0;
    d.flushSkipEqualCount = 0;
    d.flushSkipCleanCount = 0;
    d.lastReportAt = now;
  }

  private stopTimer() {
    if (this.flushTimer !== null) {
      cancelAnimationFrame(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

function extractSize(raw: unknown): number {
  if (Array.isArray(raw)) return Number(raw[1]);
  if (typeof raw === "object" && raw !== null)
    return Number((raw as Record<string, unknown>).size);
  return -1;
}

function levelsEqual(a: PriceLevel[], b: PriceLevel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].price !== b[i].price || a[i].size !== b[i].size) return false;
  }
  return true;
}
