/**
 * 市场选择状态仓库
 * 管理当前用户选中的交易市场（BTC-PERP / SOL-PERP）
 */

import { create } from "zustand";
import type { MarketId } from "@/lib/types";

interface MarketState {
  /** 当前选中的市场 ID */
  marketId: MarketId;
  /** 切换市场 */
  setMarketId: (id: MarketId) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  marketId: "BTC-PERP",
  setMarketId: (marketId) => set({ marketId }),
}));
