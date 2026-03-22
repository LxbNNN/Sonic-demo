// ==================== API / WebSocket 端点 ====================

/** SMFS REST API 基础地址 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://interviews-api.sonic.game";

/** 市场行情 WebSocket 地址 */
export const WS_MARKET_URL =
  process.env.NEXT_PUBLIC_WS_MARKET_URL ||
  "wss://interviews-api.sonic.game/ws";

/** Solana 交易流 WebSocket 地址 */
export const WS_STREAM_URL =
  process.env.NEXT_PUBLIC_WS_STREAM_URL ||
  "wss://interviews-api.sonic.game/ws/stream";

// ==================== 订单簿 ====================

/** 订单簿展示深度（买/卖各取前 N 档） */
export const ORDERBOOK_DEPTH = 20;

/** 订单簿单行高度（px） */
export const OB_ROW_HEIGHT = 22;

/** 订单簿刷新间隔（ms），200 ≈ 5fps，配合 300ms CSS 过渡实现平滑视觉 */
export const OB_FLUSH_INTERVAL_MS = 200;

/** 增量缓冲队列上限（用于快照同步窗口） */
export const DELTA_BUFFER_MAX = 1500;

/** 重同步触发的最小冷却时间，避免频繁重拉导致数据抖动 */
export const RESYNC_COOLDOWN_MS = 5_000;

/** 各市场可选价格聚合粒度（OKX 风格） */
export const TICK_SIZES: Record<string, number[]> = {
  "BTC-PERP": [0.1, 1, 10, 100],
  "SOL-PERP": [0.01, 0.1, 1, 10],
};

/** 各市场默认价格聚合粒度（最精细档位） */
export const DEFAULT_TICK_SIZE: Record<string, number> = {
  "BTC-PERP": 0.1,
  "SOL-PERP": 0.01,
};

// ==================== 数据容量限制 ====================

/** 最近成交列表最大保留条数 */
export const MAX_TRADES = 200;

/** 成交可读模式下的聚合窗口（ms） */
export const TRADE_AGG_WINDOW_MS = 150;

/** 单次刷新的最大成交条数（保护渲染） */
export const TRADE_BATCH_MAX_ITEMS = 40;

/** 默认成交流展示模式 */
export const DEFAULT_TRADE_DISPLAY_MODE = "readable" as const;

/** Solana 交易列表最大保留条数 */
export const MAX_TRANSACTIONS = 100;

// ==================== WebSocket 心跳 / 重连参数 ====================

/** ping 发送间隔（毫秒） */
export const PING_INTERVAL_MS = 20_000;

/** 发送 ping 后等待 pong 的超时时间，超时则视为断连 */
export const PONG_TIMEOUT_MS = 10_000;

/** 重连基础延迟（指数退避起点） */
export const RECONNECT_BASE_MS = 1_000;

/** 重连最大延迟上限 */
export const RECONNECT_MAX_MS = 30_000;

// ==================== K线 ====================

/** 支持的K线时间间隔 */
export const CANDLE_INTERVALS = ["1s", "1m", "5m", "15m"] as const;
