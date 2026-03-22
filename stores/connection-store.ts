/**
 * 连接状态仓库
 * 管理 WebSocket 连接状态和消息吞吐速率
 */

import { create } from "zustand";
import type { ConnectionStatus, OrderBookSyncState } from "@/lib/types";

interface ConnectionStoreState {
  /** 当前 WebSocket 连接状态 */
  status: ConnectionStatus;
  /** 订单簿同步状态（init/syncing/live/resyncing） */
  orderBookSyncState: OrderBookSyncState;
  /** 最近一次进入 resyncing 的原因 */
  orderBookResyncReason: string | null;
  /** 过去 1 秒收到的订单簿更新数（msg/s） */
  bookRate: number;
  /** 过去 1 秒收到的成交消息数（msg/s） */
  tradeRate: number;
  setStatus: (status: ConnectionStatus) => void;
  setOrderBookSyncState: (state: OrderBookSyncState, reason?: string) => void;
  setRates: (bookRate: number, tradeRate: number) => void;
}

export const useConnectionStore = create<ConnectionStoreState>((set) => ({
  status: "disconnected",
  orderBookSyncState: "init",
  orderBookResyncReason: null,
  bookRate: 0,
  tradeRate: 0,
  setStatus: (status) => set({ status }),
  setOrderBookSyncState: (orderBookSyncState, reason) =>
    set((s) => ({
      orderBookSyncState,
      orderBookResyncReason:
        orderBookSyncState === "resyncing"
          ? reason ?? s.orderBookResyncReason
          : null,
    })),
  setRates: (bookRate, tradeRate) => set({ bookRate, tradeRate }),
}));
