/**
 * OrderBookSide — 单侧订单簿数据结构
 *
 * 核心设计：
 * - Map 忠实存储服务端数据
 * - size=0 采用延迟删除：标记 pendingDeletes，不立即从 Map 移除
 *   → 保证 top() 在边界附近数据稀疏时仍能返回足够行数
 * - 同价位新数据到来时自动取消待删标记
 * - flushPendingDeletes() 由外部在显示行数充足时调用
 * - top(n, tickSize, bound) 通过参考价分区，结构性保证 bid/ask 不交叉
 * - trimToMax 按距离参考价裁剪，保留市场中枢附近数据
 */

import type { PriceLevel } from "./types";

export interface BookEntry {
  price: number;
  size: number;
}

// --------------- 工具函数 ---------------

export function pkey(price: number): string {
  return price.toFixed(10);
}

export function parseLevel(raw: unknown): BookEntry | null {
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

export function snapToTick(
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
export function maxActivePrice(levels: unknown[]): number {
  let max = -1;
  for (const raw of levels) {
    const entry = parseLevel(raw);
    if (entry && entry.size > 0 && entry.price > max) max = entry.price;
  }
  return max;
}

/** delta 中有效（size>0）条目的最低价 */
export function minActivePrice(levels: unknown[]): number {
  let min = Infinity;
  for (const raw of levels) {
    const entry = parseLevel(raw);
    if (entry && entry.size > 0 && entry.price < min) min = entry.price;
  }
  return min;
}

// --------------- OrderBookSide ---------------

export class OrderBookSide {
  private map = new Map<string, BookEntry>();
  private pendingDeletes = new Set<string>();
  private readonly snapSide: "bid" | "ask";

  constructor(private readonly order: "asc" | "desc") {
    this.snapSide = order === "desc" ? "bid" : "ask";
  }

  /**
   * 增量更新：
   * - size=0 → 标记为待删除（不从 Map 移除，保留最后已知 size）
   * - size>0 → 写入 Map，同时取消该价位的待删标记
   */
  applyLevels(levels: unknown[]): void {
    for (const raw of levels) {
      const entry = parseLevel(raw);
      if (!entry) continue;
      const key = pkey(entry.price);
      if (entry.size === 0) {
        this.pendingDeletes.add(key);
      } else {
        this.map.set(key, entry);
        this.pendingDeletes.delete(key);
      }
    }
  }

  /**
   * 执行待删除清理：从 Map 中移除所有已标记的条目。
   * 外部应在显示行数 >= depth 时调用。
   */
  flushPendingDeletes(): void {
    for (const key of this.pendingDeletes) {
      this.map.delete(key);
    }
    this.pendingDeletes.clear();
  }

  get pendingDeleteCount(): number {
    return this.pendingDeletes.size;
  }

  /** 全量快照替换 */
  writeSnapshot(rawLevels: unknown[]): void {
    this.map.clear();
    this.pendingDeletes.clear();
    if (!Array.isArray(rawLevels)) return;
    for (const raw of rawLevels) {
      const entry = parseLevel(raw);
      if (!entry || entry.size <= 0) continue;
      this.map.set(pkey(entry.price), entry);
    }
  }

  /**
   * 取前 n 档展示数据，通过 bound 参考价分区：
   * - bid (desc): 只取 price < bound → 排序 → tick 聚合 → top N
   * - ask (asc):  只取 price > bound → 排序 → tick 聚合 → top N
   * - bound 未传则无过滤（冷启动/快照场景）
   */
  top(n: number, tickSize: number, bound?: number): PriceLevel[] {
    let entries: BookEntry[];

    if (bound !== undefined) {
      const cmp = this.order === "desc"
        ? (p: number) => p < bound
        : (p: number) => p > bound;
      entries = [];
      for (const e of this.map.values()) {
        if (cmp(e.price)) entries.push(e);
      }
    } else {
      entries = Array.from(this.map.values());
    }

    if (this.order === "desc") {
      entries.sort((a, b) => b.price - a.price);
    } else {
      entries.sort((a, b) => a.price - b.price);
    }

    const result: PriceLevel[] = [];
    let currentTick = -1;
    let currentSize = 0;

    for (const { price, size } of entries) {
      const tick = snapToTick(price, tickSize, this.snapSide);
      if (tick !== currentTick) {
        if (currentTick >= 0) {
          result.push({ price: currentTick, size: currentSize });
          if (result.length >= n) return result;
        }
        currentTick = tick;
        currentSize = size;
      } else {
        currentSize += size;
      }
    }
    if (currentTick >= 0 && result.length < n) {
      result.push({ price: currentTick, size: currentSize });
    }
    return result;
  }

  clear(): void {
    this.map.clear();
    this.pendingDeletes.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * 容量裁剪：保留距 refPrice 最近的 maxEntries 条。
   * 若无 refPrice 则退化为保留最优侧。
   */
  trimToMax(maxEntries: number, refPrice?: number): void {
    if (this.map.size <= maxEntries) return;
    const entries = Array.from(this.map.entries());

    if (refPrice !== undefined) {
      entries.sort(
        (a, b) => Math.abs(a[1].price - refPrice) - Math.abs(b[1].price - refPrice),
      );
    } else if (this.order === "desc") {
      entries.sort((a, b) => b[1].price - a[1].price);
    } else {
      entries.sort((a, b) => a[1].price - b[1].price);
    }

    for (let i = maxEntries; i < entries.length; i++) {
      this.map.delete(entries[i][0]);
    }
  }
}
