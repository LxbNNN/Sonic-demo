/**
 * OrderBookManager — 订单簿核心引擎（单例）
 *
 * 关键原则：
 * - 增量驱动剪枝：每条 delta 的价格隐含地标定当前市场范围，
 *   对侧超出该范围的条目即为陈旧，实时删除，无需快照补偿
 * - 快照仅用于初始加载/重连/大 seq 缺口，正常运行期间不依赖快照
 * - 序列连续性由 MarketService 严格校验后再写入引擎
 */

import type {
  OrderBookSyncState,
  PriceLevel,
  WsBookDeltaMessage,
} from "./types";
import { marketBus } from "./market-events";

interface BookEntry {
  price: number;
  size: number;
}

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
const STALE_DATA_MS = 8_000;
const SIDE_STALE_MS = 5_000;
const SIDE_ACTIVE_MS = 2_000;

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
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private bidMap = new Map<string, BookEntry>();
  private askMap = new Map<string, BookEntry>();
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
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    return this;
  }

  stop(): this {
    this.stopTimer();
    return this;
  }

  reset(): this {
    this.bidMap.clear();
    this.askMap.clear();
    this.lastSeq = -1;
    this.dirty = false;
    this.lastDeltaAt = 0;
    this.lastAppliedDeltaAt = 0;
    this.lastUiFlushAt = 0;
    this.lastBidDeltaAt = 0;
    this.lastAskDeltaAt = 0;
    this.prevBids = [];
    this.prevAsks = [];
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

  /** 重置 seq 锚点——新 WS 连接或检测到 seq 倒跳时调用 */
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

  /**
   * 快照作为权威基准：全量替换本地簿
   * snapshotSeq 仅在后端支持时使用。
   */
  replaceSnapshot(
    rawBids: unknown[],
    rawAsks: unknown[],
    snapshotSeq?: number,
  ) {
    this.bidMap.clear();
    this.askMap.clear();
    writeSnapshot(this.bidMap, rawBids);
    writeSnapshot(this.askMap, rawAsks);

    const now = Date.now();
    this.lastSeq = Number.isFinite(snapshotSeq) ? Number(snapshotSeq) : -1;
    this.lastDeltaAt = now;
    this.lastBidDeltaAt = now;
    this.lastAskDeltaAt = now;
    this.prevBids = [];
    this.prevAsks = [];
    this.dirty = true;
  }

  /**
   * 在 MarketService 完成序列校验后应用增量。
   * 返回 false 表示重复或过期序列（不会写入）。
   *
   * 关键机制——delta 驱动剪枝：
   * 每条 delta 携带的价格隐式标定当前市场范围。
   * 例如收到 ask delta 最低价 68,650，则 bidMap 中 > 68,650 的条目
   * 在真实市场中已被撮合消化，属于陈旧数据，立即删除。
   * 效果等同于服务端发送 size=0，但完全在客户端完成，不影响业务数据。
   */
  applyDelta(delta: WsBookDeltaMessage): boolean {
    if (this.lastSeq >= 0 && delta.seq <= this.lastSeq) {
      return false;
    }

    const now = Date.now();
    let highestNewBid = -1;
    let lowestNewAsk = Infinity;

    if (Array.isArray(delta.bids) && delta.bids.length > 0) {
      applyLevels(this.bidMap, delta.bids as unknown[]);
      this.lastBidDeltaAt = now;
      highestNewBid = maxActivePrice(delta.bids as unknown[]);
    }
    if (Array.isArray(delta.asks) && delta.asks.length > 0) {
      applyLevels(this.askMap, delta.asks as unknown[]);
      this.lastAskDeltaAt = now;
      lowestNewAsk = minActivePrice(delta.asks as unknown[]);
    }

    if (lowestNewAsk < Infinity) {
      pruneAbove(this.bidMap, lowestNewAsk);
    }
    if (highestNewBid > 0) {
      pruneBelow(this.askMap, highestNewBid);
    }

    this.lastSeq = delta.seq;
    this.lastDeltaAt = now;
    this.lastAppliedDeltaAt = now;
    this.dirty = true;
    return true;
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

  private flush() {
    if (!this.onFlush) return;
    const now = Date.now();

    if (this.lastDeltaAt > 0) {
      const deltaAge = now - this.lastDeltaAt;
      if (deltaAge > STALE_DATA_MS) {
        this.lastDeltaAt = now;
        marketBus.emit("orderbook_stall_detected", {
          kind: "global_stale",
          bidAgeMs: this.lastBidDeltaAt > 0 ? now - this.lastBidDeltaAt : 0,
          askAgeMs: this.lastAskDeltaAt > 0 ? now - this.lastAskDeltaAt : 0,
          deltaAgeMs: deltaAge,
          at: now,
        });
        marketBus.emit("request_snapshot");
      }
    }

    if (this.lastBidDeltaAt > 0 && this.lastAskDeltaAt > 0) {
      const bidAge = now - this.lastBidDeltaAt;
      const askAge = now - this.lastAskDeltaAt;
      if (
        (bidAge < SIDE_ACTIVE_MS && askAge > SIDE_STALE_MS) ||
        (askAge < SIDE_ACTIVE_MS && bidAge > SIDE_STALE_MS)
      ) {
        this.lastBidDeltaAt = now;
        this.lastAskDeltaAt = now;
        marketBus.emit("orderbook_stall_detected", {
          kind: "side_imbalance",
          bidAgeMs: bidAge,
          askAgeMs: askAge,
          deltaAgeMs: this.lastDeltaAt > 0 ? now - this.lastDeltaAt : 0,
          at: now,
        });
        marketBus.emit("request_snapshot");
      }
    }

    if (!this.dirty) return;
    this.dirty = false;

    trimMap(this.bidMap, MAX_MAP_ENTRIES, "desc");
    trimMap(this.askMap, MAX_MAP_ENTRIES, "asc");

    let bids = groupSortSlice(this.bidMap, "desc", this.depth, this.tickSize);
    let asks = groupSortSlice(this.askMap, "asc", this.depth, this.tickSize);

    if (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price) {
      this.pruneCrossedEntries(bids, asks);
      bids = groupSortSlice(this.bidMap, "desc", this.depth, this.tickSize);
      asks = groupSortSlice(this.askMap, "asc", this.depth, this.tickSize);
    }

    if (levelsEqual(bids, this.prevBids) && levelsEqual(asks, this.prevAsks)) {
      return;
    }

    this.prevBids = bids;
    this.prevAsks = asks;
    this.lastUiFlushAt = now;
    this.onFlush(bids, asks);
  }

  /**
   * 倒挂簿修复：根据两侧最近 delta 时间戳判定哪侧陈旧，
   * 从 map 中删除明显越界的条目（bid ≥ bestAsk 或 ask ≤ bestBid）。
   */
  private pruneCrossedEntries(
    bids: PriceLevel[],
    asks: PriceLevel[],
  ) {
    if (bids.length === 0 || asks.length === 0) return;

    if (this.lastAskDeltaAt >= this.lastBidDeltaAt) {
      const bestAsk = asks[0].price;
      for (const [key, entry] of this.bidMap) {
        if (entry.price >= bestAsk) this.bidMap.delete(key);
      }
    } else {
      const bestBid = bids[0].price;
      for (const [key, entry] of this.askMap) {
        if (entry.price <= bestBid) this.askMap.delete(key);
      }
    }
  }

  private stopTimer() {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

function pkey(price: number): string {
  return price.toFixed(10);
}

function parseLevel(raw: unknown): BookEntry | null {
  let p: number;
  let s: number;
  if (Array.isArray(raw)) {
    p = Number(raw[0]);
    s = Number(raw[1]);
  } else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    p = Number(obj.price);
    s = Number(obj.size);
  } else {
    return null;
  }
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!Number.isFinite(s) || s < 0) return null;
  return { price: p, size: s };
}

function writeSnapshot(map: Map<string, BookEntry>, rawLevels: unknown[]) {
  if (!Array.isArray(rawLevels)) return;
  for (const raw of rawLevels) {
    const entry = parseLevel(raw);
    if (!entry) continue;
    const key = pkey(entry.price);
    if (entry.size > 0) {
      map.set(key, entry);
    }
  }
}

function applyLevels(map: Map<string, BookEntry>, levels: unknown[]) {
  for (const raw of levels) {
    const entry = parseLevel(raw);
    if (!entry) continue;
    const key = pkey(entry.price);
    if (entry.size === 0) {
      map.delete(key);
    } else {
      map.set(key, entry);
    }
  }
}

function groupSortSlice(
  map: Map<string, BookEntry>,
  order: "asc" | "desc",
  depth: number,
  tickSize: number,
): PriceLevel[] {
  const side: "bid" | "ask" = order === "desc" ? "bid" : "ask";
  const buckets = new Map<number, number>();
  for (const { price, size } of map.values()) {
    const groupedPrice = snapToTick(price, tickSize, side);
    buckets.set(groupedPrice, (buckets.get(groupedPrice) ?? 0) + size);
  }

  const entries = Array.from(buckets.entries()).map(([price, size]) => ({
    price,
    size,
  }));
  if (order === "desc") {
    entries.sort((a, b) => b.price - a.price);
  } else {
    entries.sort((a, b) => a.price - b.price);
  }
  return entries.slice(0, depth);
}

function snapToTick(
  price: number,
  tickSize: number,
  side: "bid" | "ask",
): number {
  const dp = tickSize >= 1 ? 0 : Math.ceil(-Math.log10(tickSize));
  const factor = Math.pow(10, dp);
  const scaled = Math.round(price * factor);
  const scaledTick = Math.round(tickSize * factor);
  const fn = side === "bid" ? Math.floor : Math.ceil;
  const grouped = fn(scaled / scaledTick) * scaledTick;
  return grouped / factor;
}

/** delta 中有效（size>0）条目的最高价 */
function maxActivePrice(levels: unknown[]): number {
  let max = -1;
  for (const raw of levels) {
    const entry = parseLevel(raw);
    if (entry && entry.size > 0 && entry.price > max) max = entry.price;
  }
  return max;
}

/** delta 中有效（size>0）条目的最低价 */
function minActivePrice(levels: unknown[]): number {
  let min = Infinity;
  for (const raw of levels) {
    const entry = parseLevel(raw);
    if (entry && entry.size > 0 && entry.price < min) min = entry.price;
  }
  return min;
}

/** 删除 map 中价格严格高于 threshold 的条目 */
function pruneAbove(map: Map<string, BookEntry>, threshold: number) {
  for (const [key, entry] of map) {
    if (entry.price > threshold) map.delete(key);
  }
}

/** 删除 map 中价格严格低于 threshold 的条目 */
function pruneBelow(map: Map<string, BookEntry>, threshold: number) {
  for (const [key, entry] of map) {
    if (entry.price < threshold) map.delete(key);
  }
}

function trimMap(
  map: Map<string, BookEntry>,
  maxSize: number,
  keepOrder: "asc" | "desc",
) {
  if (map.size <= maxSize) return;
  const entries = Array.from(map.entries());
  if (keepOrder === "desc") {
    entries.sort((a, b) => b[1].price - a[1].price);
  } else {
    entries.sort((a, b) => a[1].price - b[1].price);
  }
  for (let i = maxSize; i < entries.length; i++) {
    map.delete(entries[i][0]);
  }
}

function levelsEqual(a: PriceLevel[], b: PriceLevel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].price !== b[i].price || a[i].size !== b[i].size) return false;
  }
  return true;
}
