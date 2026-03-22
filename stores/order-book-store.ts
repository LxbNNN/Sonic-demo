/**
 * 订单簿状态仓库
 *
 * 存储排序后的 top-N 档位供 UI 消费。
 * 中间价、价差使用 BigNumber 精确计算。
 * prevMidPrice 用于判断价格涨跌方向。
 * tickSize 供 UI 读取当前聚合粒度。
 */

import { create } from "zustand";
import { BN, ZERO, TWO, HUNDRED } from "@/lib/bn";
import type { PriceLevel } from "@/lib/types";

interface OrderBookStoreState {
  bids: PriceLevel[];
  asks: PriceLevel[];
  midPrice: number;
  prevMidPrice: number;
  spreadPercent: number;
  /** 当前价格聚合粒度（OKX 风格） */
  tickSize: number;
  setBook: (bids: PriceLevel[], asks: PriceLevel[]) => void;
  setTickSize: (tickSize: number) => void;
}

function calcMidAndSpread(bids: PriceLevel[], asks: PriceLevel[]) {
  const bestBid = BN(bids[0]?.price ?? 0);
  const bestAsk = BN(asks[0]?.price ?? 0);

  let midPrice: number;
  let spreadPercent: number;

  if (bestBid.gt(0) && bestAsk.gt(0)) {
    const mid = bestBid.plus(bestAsk).div(TWO);
    midPrice = mid.toNumber();
    spreadPercent = bestAsk.minus(bestBid).div(mid).times(HUNDRED).toNumber();
  } else {
    midPrice = bestBid.gt(0) ? bestBid.toNumber() : bestAsk.toNumber();
    spreadPercent = ZERO.toNumber();
  }

  return { midPrice, spreadPercent };
}

export const useOrderBookStore = create<OrderBookStoreState>((set) => ({
  bids: [],
  asks: [],
  midPrice: 0,
  prevMidPrice: 0,
  spreadPercent: 0,
  tickSize: 0.1,
  setBook: (bids, asks) =>
    set((s) => {
      const calc = calcMidAndSpread(bids, asks);
      return {
        bids,
        asks,
        prevMidPrice: s.midPrice > 0 ? s.midPrice : calc.midPrice,
        ...calc,
      };
    }),
  setTickSize: (tickSize) => set({ tickSize }),
}));
