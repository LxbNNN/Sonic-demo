/**
 * 类型化事件总线（mitt）
 *
 * 全局唯一实例，作为 WebSocket 消息 → 各消费者的解耦桥梁。
 * 所有事件 payload 均有 TypeScript 类型约束。
 */

import mitt from "mitt";
import type {
  ConnectionStatus,
  OrderBookSyncState,
  WsBookDeltaMessage,
  WsTradeMessage,
  WsResetMessage,
  Trade,
} from "./types";

export type MarketEvents = {
  book_delta: WsBookDeltaMessage;
  trade: WsTradeMessage;
  reset: WsResetMessage;
  status_change: ConnectionStatus;
  snapshot_loaded: { bids: unknown[]; asks: unknown[]; trades: Trade[] };
  request_snapshot: void;
  rate_tick: { bookRate: number; tradeRate: number };
  orderbook_state_change: {
    state: OrderBookSyncState;
    reason?: string;
    at: number;
  };
  orderbook_resync_reason: { reason: string; seq?: number; at: number };
  orderbook_stall_detected: {
    kind: "global_stale" | "side_imbalance";
    bidAgeMs: number;
    askAgeMs: number;
    deltaAgeMs: number;
    at: number;
  };
};

export const marketBus = mitt<MarketEvents>();
