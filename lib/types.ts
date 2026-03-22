// ==================== 基础枚举类型 ====================

/** 支持的市场 ID */
export type MarketId = "BTC-PERP" | "SOL-PERP";

/** 交易方向 */
export type Side = "buy" | "sell";

/** 成交流展示模式 */
export type TradeDisplayMode = "raw" | "readable";

/** 订单类型：限价 / 市价 */
export type OrderType = "limit" | "market";

/** K线时间间隔 */
export type CandleInterval = "1s" | "1m" | "5m" | "15m";

/** WebSocket 连接状态 */
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

/** 订单簿同步状态（独立于 WebSocket 连接状态） */
export type OrderBookSyncState = "init" | "syncing" | "live" | "resyncing";

// ==================== REST API 响应类型 ====================

/** GET /health 响应 */
export interface HealthResponse {
  ok: boolean;
  /** 服务器时间戳（毫秒） */
  serverTime: number;
  /** 可用市场列表 */
  markets: string[];
  /** WebSocket 端点 URL */
  wsUrl: string;
}

/** 市场基本信息 */
export interface Market {
  marketId: MarketId;
  /** 基础资产，如 BTC / SOL */
  base: string;
  /** 计价资产，如 USDT */
  quote: string;
}

/** GET /markets 响应 */
export interface MarketsResponse {
  markets: Market[];
}

/** 订单簿价格档位 */
export interface PriceLevel {
  /** 价格 */
  price: number;
  /** 该价格档位的挂单量，0 表示删除该档位 */
  size: number;
}

/** 成交记录 */
export interface Trade {
  tradeId: string;
  /** 成交时间戳（毫秒） */
  ts: number;
  price: number;
  size: number;
  side: Side;
  /** readable 模式下短窗聚合笔数（原始成交默认为 1） */
  aggCount?: number;
}

/** GET /markets/:marketId/snapshot 响应 — 订单簿快照 */
export interface OrderBookSnapshot {
  marketId: MarketId;
  ts: number;
  /**
   * 可选快照序列锚点（若后端支持）
   * 当前公开 API 可能不返回此字段。
   */
  snapshotSeq?: number;
  /** 中间价 (bestBid + bestAsk) / 2 */
  midPrice: number;
  /** 买盘档位（降序） */
  bids: PriceLevel[];
  /** 卖盘档位（升序） */
  asks: PriceLevel[];
  /** 最近成交列表 */
  recentTrades: Trade[];
}

/** POST /orders 请求体 */
export interface OrderRequest {
  marketId: MarketId;
  side: Side;
  type: OrderType;
  /** 限价单价格，市价单可省略 */
  price?: number;
  size: number;
}

/** POST /orders 响应 */
export interface OrderResponse {
  accepted: boolean;
  orderId: string;
  ts: number;
}

/** 单个市场的吞吐统计 */
export interface MarketStats {
  /** 每秒订单簿更新数 */
  bookUpdatesPerSecond: number;
  /** 每秒成交数 */
  tradesPerSecond: number;
  /** 当前序列号 */
  currentSeq: number;
}

/** GET /stats 响应 */
export interface StatsResponse {
  /** 按 marketId 索引的各市场统计 */
  markets: Record<string, MarketStats>;
  /** 当前连接的客户端数 */
  connectedClients: number;
}

/** K线（OHLCV）数据 */
export interface Candle {
  /** Unix 时间戳（秒级） */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 该根K线内的成交笔数 */
  trades: number;
}

/** GET /markets/:marketId/candles 响应 */
export interface CandlesResponse {
  marketId: string;
  interval: string;
  candles: Candle[];
}

// ==================== WebSocket 市场行情消息类型 ====================

/** 连接建立后服务端发送的 hello 消息 */
export interface WsHelloMessage {
  type: "hello";
  serverTime: number;
  marketId: string;
}

/** 订单簿增量更新，seq 严格递增 */
export interface WsBookDeltaMessage {
  type: "book_delta";
  marketId: string;
  ts: number;
  /** 序列号，用于检测消息缺失 */
  seq: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

/** 实时成交消息 */
export interface WsTradeMessage {
  type: "trade";
  marketId: string;
  ts: number;
  tradeId: string;
  price: number;
  size: number;
  side: Side;
}

/** 服务端要求客户端重新获取快照 */
export interface WsResetMessage {
  type: "reset";
  reason: string;
  ts: number;
}

/** 心跳响应 */
export interface WsPongMessage {
  type: "pong";
  ts: number;
}

/** 所有 WebSocket 消息的联合类型 */
export type WsMessage =
  | WsHelloMessage
  | WsBookDeltaMessage
  | WsTradeMessage
  | WsResetMessage
  | WsPongMessage;

// ==================== Solana 交易流消息类型（Bonus） ====================

/** /ws/stream 连接建立后的 hello 消息 */
export interface StreamHelloMessage {
  type: "stream_hello";
  serverTime: number;
  /** 当前生效的过滤条件 */
  filters: {
    programs: string[];
    accounts: string[];
  };
}

/** Solana 交易中的单条指令 */
export interface StreamInstruction {
  /** 执行该指令的程序 ID */
  programId: string;
  /** 传入的账户地址列表 */
  accounts: string[];
  /** base58 编码的指令数据 */
  data: string;
}

/** Solana 交易消息 */
export interface StreamTransactionMessage {
  type: "transaction";
  /** 交易签名（base58） */
  signature: string;
  /** 确认所在的 slot */
  slot: number;
  /** 区块时间（Unix 秒），可能为 null */
  blockTime: number | null;
  /** 交易手续费（lamports） */
  fee: number;
  /** 消耗的计算单元 */
  computeUnitsConsumed: number;
  /** 交易错误对象，成功则为 null */
  err: object | null;
  /** 涉及的所有账户 */
  accounts: string[];
  /** 调用的程序 ID 列表 */
  programIds: string[];
  /** 执行的指令列表 */
  instructions: StreamInstruction[];
  /** 每个客户端严格递增的序列号 */
  seq: number;
}

/** 链重组消息 — 客户端需丢弃该 slot 之后的交易 */
export interface StreamReorgMessage {
  type: "reorg";
  /** 回滚到此 slot，丢弃之后的交易 */
  rollbackSlot: number;
  ts: number;
}

/** Solana 交易流所有消息的联合类型 */
export type StreamMessage =
  | StreamHelloMessage
  | StreamTransactionMessage
  | StreamReorgMessage
  | WsPongMessage;
