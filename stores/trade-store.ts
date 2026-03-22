/**
 * 成交记录状态仓库
 * 维护最近 N 条成交列表（新成交插入头部，超出上限的尾部丢弃）
 */

import { create } from "zustand";
import { MAX_TRADES } from "@/lib/constants";
import type { Trade, TradeDisplayMode } from "@/lib/types";

interface TradeStoreState {
  /** 最近成交列表（最新在前） */
  trades: Trade[];
  /** 成交流展示模式：原始 / 可读 */
  displayMode: TradeDisplayMode;
  /** 追加一条新成交 */
  addTrade: (trade: Trade) => void;
  /** 批量设置（用于从快照初始化） */
  setTrades: (trades: Trade[]) => void;
  setDisplayMode: (displayMode: TradeDisplayMode) => void;
  /** 清空所有成交（切换市场时调用） */
  clear: () => void;
}

export const useTradeStore = create<TradeStoreState>((set) => ({
  trades: [],
  displayMode: "readable",
  addTrade: (trade) =>
    set((s) => ({
      trades: [trade, ...s.trades].slice(0, MAX_TRADES),
    })),
  setTrades: (trades) => set({ trades: trades.slice(0, MAX_TRADES) }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  clear: () => set({ trades: [] }),
}));
