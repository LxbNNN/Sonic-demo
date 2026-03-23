/**
 * Worker ↔ 主线程消息协议
 *
 * 主线程 → Worker: 控制指令（切换市场、设置参数、停止）
 * Worker → 主线程: 数据快照（订单簿、成交、连接状态）
 *
 * 所有 type 字段均使用 WorkerCmd / WorkerEvent 枚举，
 * 消除硬编码字符串，保证发送端与接收端类型一致。
 */

import type {
  MarketId,
  PriceLevel,
  Trade,
  ConnectionStatus,
  OrderBookSyncState,
  TradeDisplayMode,
} from "./types";
import { WorkerCmd, WorkerEvent } from "./enums";

// ---- 主线程 → Worker 指令 ----

export type MainToWorkerMessage =
  | {
      type: WorkerCmd.SwitchMarket;
      marketId: MarketId;
      /** 默认价格聚合粒度 */
      defaultTick: number;
      /** 显示档位深度 */
      depth: number;
      /** 引擎 flush 间隔（毫秒） */
      flushIntervalMs: number;
    }
  | { type: WorkerCmd.Stop }
  | { type: WorkerCmd.SetTickSize; tick: number }
  | { type: WorkerCmd.SetTradeDisplayMode; mode: TradeDisplayMode };

// ---- Worker → 主线程推送 ----

export type WorkerToMainMessage =
  | { type: WorkerEvent.BookUpdate; bids: PriceLevel[]; asks: PriceLevel[] }
  | { type: WorkerEvent.TradeUpdate; trades: Trade[] }
  | { type: WorkerEvent.ConnectionStatus; status: ConnectionStatus }
  | { type: WorkerEvent.SyncState; state: OrderBookSyncState; reason?: string }
  | { type: WorkerEvent.Rates; bookRate: number; tradeRate: number };
