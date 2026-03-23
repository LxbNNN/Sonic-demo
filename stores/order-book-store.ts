/**
 * 订单簿状态仓库
 *
 * 存储排序后的 top-N 档位供 UI 消费。
 * 所有派生数据（cumTotals、asksReversed、中间价、价差）在 setBook 时一次性预计算，
 * 组件直接消费，无需 useMemo，最小化渲染路径计算量。
 *
 * 精度说明：
 * - 中间价/价差使用原生浮点运算（float64 有效位 15+ 位，显示 2-4 位足够）
 * - 消除高频路径上的 BigNumber 对象创建
 */

import { create } from "zustand";
import type { PriceLevel } from "@/lib/types";
import { ORDERBOOK_DEPTH } from "@/lib/constants";

interface OrderBookStoreState {
  /** 买盘档位（降序，最优买价在前） */
  bids: PriceLevel[];
  /** 卖盘档位（升序，最优卖价在前） */
  asks: PriceLevel[];

  /** 卖盘反转后的数组（降序，最优卖价在末尾 = UI 底部） */
  asksReversed: PriceLevel[];
  /** 卖盘累计量（与 asksReversed 对应，从 UI 底部向上累加） */
  asksCumTotals: number[];
  /** 买盘累计量（与 bids 对应，从 UI 顶部向下累加） */
  bidsCumTotals: number[];
  /** 卖盘最大累计量（深度条归一化基准） */
  maxAskCum: number;
  /** 买盘最大累计量（深度条归一化基准） */
  maxBidCum: number;

  midPrice: number;
  prevMidPrice: number;
  spreadPercent: number;
  /** 当前价格聚合粒度（OKX 风格） */
  tickSize: number;

  setBook: (bids: PriceLevel[], asks: PriceLevel[]) => void;
  setTickSize: (tickSize: number) => void;
}

export const useOrderBookStore = create<OrderBookStoreState>((set) => ({
  bids: [],
  asks: [],
  asksReversed: [],
  asksCumTotals: [],
  bidsCumTotals: [],
  maxAskCum: 0,
  maxBidCum: 0,
  midPrice: 0,
  prevMidPrice: 0,
  spreadPercent: 0,
  tickSize: 0.1,

  setBook: (bids, asks) =>
    set((s) => {
      // ---- 中间价 & 价差（原生浮点运算） ----
      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 0;
      let midPrice: number;
      let spreadPercent: number;

      if (bestBid > 0 && bestAsk > 0) {
        midPrice = (bestBid + bestAsk) / 2;
        spreadPercent = ((bestAsk - bestBid) / midPrice) * 100;
      } else {
        midPrice = bestBid > 0 ? bestBid : bestAsk;
        spreadPercent = 0;
      }

      // ---- 预计算显示用数组（消除组件内 useMemo） ----
      const depth = ORDERBOOK_DEPTH;

      // 卖盘反转（UI 显示降序，最优卖价在底部）
      const slicedAsks = asks.length > depth ? asks.slice(0, depth) : asks;
      const asksReversed = slicedAsks.length > 0
        ? reverseArray(slicedAsks)
        : [];

      // 卖盘累计量：从 UI 底部（最优卖价）向上累加
      const asksCumTotals = new Array<number>(asksReversed.length);
      let askSum = 0;
      for (let i = asksReversed.length - 1; i >= 0; i--) {
        askSum += asksReversed[i].size;
        asksCumTotals[i] = askSum;
      }

      // 买盘累计量：从 UI 顶部（最优买价）向下累加
      const bidLen = Math.min(bids.length, depth);
      const bidsCumTotals = new Array<number>(bidLen);
      let bidSum = 0;
      for (let i = 0; i < bidLen; i++) {
        bidSum += bids[i].size;
        bidsCumTotals[i] = bidSum;
      }

      return {
        bids,
        asks,
        asksReversed,
        asksCumTotals,
        bidsCumTotals,
        maxAskCum: askSum,
        maxBidCum: bidSum,
        prevMidPrice: s.midPrice > 0 ? s.midPrice : midPrice,
        midPrice,
        spreadPercent,
      };
    }),

  setTickSize: (tickSize) => set({ tickSize }),
}));

/** 反转数组（不修改原数组） */
function reverseArray<T>(arr: T[]): T[] {
  const len = arr.length;
  const out = new Array<T>(len);
  for (let i = 0; i < len; i++) {
    out[i] = arr[len - 1 - i];
  }
  return out;
}
