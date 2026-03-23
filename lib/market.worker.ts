/**
 * Market Data Worker — WebSocket + OrderBookEngine 在独立线程运行
 *
 * 主线程零计算开销：
 * - WebSocket 连接、JSON.parse 在此线程
 * - OrderBookManager 的 applyDelta + flush（Map 排序、tick 聚合）在此线程
 * - 成交聚合在此线程
 * - 仅预计算好的快照通过 postMessage 发送到主线程
 */

import { OrderBookManager } from "./order-book-engine";
import { WebSocketManager } from "./websocket-manager";
import { marketBus } from "./market-events";
import {
  API_BASE_URL,
  WS_MARKET_URL,
  MAX_TRADES,
  RESYNC_COOLDOWN_MS,
  TRADE_AGG_WINDOW_MS,
  TRADE_BATCH_MAX_ITEMS,
} from "./constants";
import type {
  MarketId,
  ConnectionStatus,
  OrderBookSyncState,
  Trade,
  TradeDisplayMode,
  WsMessage,
  WsBookDeltaMessage,
  WsTradeMessage,
  OrderBookSnapshot,
} from "./types";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./worker-messages";
import { WorkerCmd, WorkerEvent } from "./enums";

/** Worker 全局上下文类型声明（避免依赖 DedicatedWorkerGlobalScope） */
declare const self: {
  postMessage(msg: WorkerToMainMessage): void;
  onmessage: ((e: MessageEvent<MainToWorkerMessage>) => void) | null;
};

// ---- 超时与阈值常量 ----

/** 快照请求超时（毫秒） */
const SNAPSHOT_TIMEOUT_MS = 10_000;
/** 快照重试最大延迟（毫秒，指数退避上限） */
const SNAPSHOT_RETRY_MAX_MS = 30_000;
/** fetch 卡死保护超时 */
const FETCH_GUARD_MS = 15_000;
/** 健康检查间隔（毫秒） */
const HEALTH_CHECK_MS = 5_000;
/** 无消息超时阈值，超过判定连接假死 */
const SILENT_DEATH_MS = 30_000;
/** 同步状态停留过久阈值 */
const SYNC_TIMEOUT_MS = 15_000;
/** 全局数据过期阈值 */
const STALE_DATA_MS = 8_000;
/** 单侧数据过期阈值 */
const SIDE_STALE_MS = 5_000;
/** 单侧活跃判定阈值 */
const SIDE_ACTIVE_MS = 2_000;
/** 序列号跳跃容忍上限 */
const SEQ_GAP_TOLERANCE = 20;
/** 快照请求防抖间隔 */
const SNAPSHOT_DEBOUNCE_MS = 3_000;

/** 类型安全的主线程消息推送 */
function post(msg: WorkerToMainMessage) {
  self.postMessage(msg);
}

// ---- Worker 状态 ----

/** WebSocket 连接实例 */
let ws: WebSocketManager | null = null;
/** 当前订阅的市场 ID */
let currentMarketId: MarketId | null = null;
/** 订单簿引擎（单例） */
const obManager = OrderBookManager.getInstance();

/** 快照请求锁 */
let isFetching = false;
/** 当前快照请求的开始时间 */
let fetchStartedAt = 0;
/** 快照重试定时器 */
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前连续重试次数 */
let retryAttempt = 0;
/** 上次快照请求时间 */
let lastFetchAt = 0;
/** 上次触发重同步时间 */
let lastResyncAt = 0;

/** 吞吐统计定时器 */
let rateTimer: ReturnType<typeof setInterval> | null = null;
/** 当前周期内订单簿消息计数 */
let bookCount = 0;
/** 当前周期内成交消息计数 */
let tradeCount = 0;

/** 成交缓冲区 */
let tradeBuf: Trade[] = [];
/** 成交刷新定时器 */
let tradeFlushTimer: ReturnType<typeof setInterval> | null = null;
/** 当前成交展示模式 */
let tradeDisplayMode: TradeDisplayMode = "readable";

/** 健康检查定时器 */
let healthTimer: ReturnType<typeof setInterval> | null = null;

/** 已累计的成交列表（完整列表，每次推送给主线程） */
let accumulatedTrades: Trade[] = [];

// ---- 主线程指令处理 ----

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case WorkerCmd.SwitchMarket:
      switchMarket(msg.marketId, msg.defaultTick, msg.depth, msg.flushIntervalMs);
      break;
    case WorkerCmd.Stop:
      cleanup();
      break;
    case WorkerCmd.SetTickSize:
      obManager.setTickSize(msg.tick);
      break;
    case WorkerCmd.SetTradeDisplayMode:
      tradeDisplayMode = msg.mode;
      break;
  }
};

// ---- 事件总线监听 ----

marketBus.on("book_delta", handleBookDelta);
marketBus.on("trade", handleTrade);
marketBus.on("reset", () => ensureSnapshotFetch("server_reset"));
marketBus.on("status_change", handleStatusChange);
marketBus.on("request_snapshot", () => ensureSnapshotFetch("watchdog_request"));

/** 切换市场：重置引擎 → 建立 WebSocket → 启动各周期任务 */
function switchMarket(marketId: MarketId, defaultTick: number, depth: number, flushIntervalMs: number) {
  cleanup();
  currentMarketId = marketId;
  accumulatedTrades = [];

  obManager
    .reset()
    .configure(depth, flushIntervalMs, defaultTick)
    .bindFlush((bids, asks) => {
      post({ type: WorkerEvent.BookUpdate, bids, asks });
    })
    .start();
  setSyncState("syncing", "market_switch");

  const wsUrl = `${WS_MARKET_URL}?marketId=${marketId}`;
  ws = new WebSocketManager({
    url: wsUrl,
    onMessage: dispatchWsMessage,
    onStatusChange: (status) => marketBus.emit("status_change", status),
  });
  ws.connect();

  startRateCounter();
  startTradeFlush();
  startHealthCheck();
}

/** 将原始 WebSocket 消息按类型分发到事件总线 */
function dispatchWsMessage(raw: unknown) {
  const msg = raw as WsMessage;
  switch (msg.type) {
    case "book_delta":
      marketBus.emit("book_delta", msg as WsBookDeltaMessage);
      break;
    case "trade":
      marketBus.emit("trade", msg as WsTradeMessage);
      break;
    case "reset":
      marketBus.emit("reset", msg);
      break;
  }
}

/**
 * 处理订单簿增量：
 * 过滤非当前市场 → 序列号连续性检查 → 写入引擎
 */
function handleBookDelta(msg: WsBookDeltaMessage) {
  if (msg.marketId !== currentMarketId) return;
  bookCount++;

  const lastSeq = obManager.getLastSeq();
  if (lastSeq >= 0) {
    if (msg.seq <= lastSeq) {
      // 序列号回退：小幅容忍，超出阈值重拉
      if (lastSeq - msg.seq > SEQ_GAP_TOLERANCE) {
        obManager.clearLastSeq();
        ensureSnapshotFetch(`seq_backward_${lastSeq}_to_${msg.seq}`);
      } else {
        return;
      }
    } else {
      // 序列号跳跃：可能丢失中间消息
      const gap = msg.seq - lastSeq - 1;
      if (gap > SEQ_GAP_TOLERANCE) {
        ensureSnapshotFetch(`seq_gap_expected_${lastSeq + 1}_got_${msg.seq}`);
      }
    }
  }
  obManager.applyDelta(msg);
}

/** 缓存实时成交到 tradeBuf */
function handleTrade(msg: WsTradeMessage) {
  if (msg.marketId !== currentMarketId) return;
  tradeCount++;
  tradeBuf.push({
    tradeId: msg.tradeId,
    ts: msg.ts,
    price: msg.price,
    size: msg.size,
    side: msg.side,
    aggCount: 1,
  });
}

/** WebSocket 连接状态变化 → 推送到主线程，连上后拉取快照 */
function handleStatusChange(status: ConnectionStatus) {
  post({ type: WorkerEvent.ConnectionStatus, status });
  if (status === "connected") {
    obManager.clearLastSeq();
    setSyncState("syncing", "ws_connected");
    fetchSnapshot(true);
  }
}

// ---- 快照拉取 ----

/** 带冷却的快照重拉入口 */
function ensureSnapshotFetch(reason: string) {
  const now = Date.now();
  if (now - lastResyncAt < RESYNC_COOLDOWN_MS) return;
  lastResyncAt = now;
  fetchSnapshot(true);
}

/**
 * 拉取订单簿快照（Worker 内直接使用 fetch）：
 * - 防抖 + fetch 锁 + 超时 abort
 * - 成功后替换引擎数据、推送成交列表、切换到 live
 * - 失败后指数退避重试
 */
async function fetchSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastFetchAt < SNAPSHOT_DEBOUNCE_MS) return;

  if (isFetching) {
    if (now - fetchStartedAt > FETCH_GUARD_MS) {
      isFetching = false;
    } else {
      return;
    }
  }

  if (!currentMarketId) return;

  isFetching = true;
  fetchStartedAt = now;
  lastFetchAt = now;

  const abortCtrl = new AbortController();
  const timeout = setTimeout(() => abortCtrl.abort(), SNAPSHOT_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}/markets/${currentMarketId}/snapshot`, {
      signal: abortCtrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = (await res.json()) as OrderBookSnapshot;

    if (snap.marketId !== currentMarketId) return;
    obManager.replaceSnapshot(
      snap.bids as unknown[],
      snap.asks as unknown[],
      snap.snapshotSeq,
    );

    // 快照中的成交列表作为初始数据
    const normalizedTrades = normalizeTrades(snap.recentTrades);
    accumulatedTrades = normalizedTrades.slice(0, MAX_TRADES);
    post({ type: WorkerEvent.TradeUpdate, trades: accumulatedTrades });

    setSyncState("live");
    retryAttempt = 0;
  } catch {
    retryAttempt++;
    scheduleSnapshotRetry();
  } finally {
    clearTimeout(timeout);
    isFetching = false;
  }
}

/** 指数退避重试 */
function scheduleSnapshotRetry() {
  cancelScheduledFetch();
  const delay = Math.min(2_000 * Math.pow(2, retryAttempt), SNAPSHOT_RETRY_MAX_MS);
  snapshotTimer = setTimeout(() => fetchSnapshot(true), delay);
}

/** 取消已计划的快照重试 */
function cancelScheduledFetch() {
  if (snapshotTimer !== null) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
}

// ---- 成交刷新 ----

/** 定时刷新成交缓冲区，聚合后推送完整列表到主线程 */
function flushTrades() {
  if (tradeBuf.length === 0) return;
  const buf = tradeBuf;
  tradeBuf = [];

  const latest = tradeDisplayMode === "raw" ? toRawTrades(buf) : toReadableTrades(buf);
  accumulatedTrades = [...latest, ...accumulatedTrades].slice(0, MAX_TRADES);
  post({ type: WorkerEvent.TradeUpdate, trades: accumulatedTrades });
}

/** 原始模式：逆序截取最新 N 条 */
function toRawTrades(buf: Trade[]): Trade[] {
  return [...buf].reverse().slice(0, TRADE_BATCH_MAX_ITEMS);
}

/**
 * 可读模式成交聚合：
 * 相同方向+价格且时间差 ≤ TRADE_AGG_WINDOW_MS 的成交合并为一条
 */
function toReadableTrades(buf: Trade[]): Trade[] {
  const ordered = [...buf].sort((a, b) => b.ts - a.ts);
  const agg = new Map<string, Trade>();
  const out: Trade[] = [];

  for (const t of ordered) {
    const key = `${t.side}:${t.price}`;
    const existing = agg.get(key);
    if (existing && Math.abs(existing.ts - t.ts) <= TRADE_AGG_WINDOW_MS) {
      existing.size += t.size;
      existing.aggCount = (existing.aggCount ?? 1) + (t.aggCount ?? 1);
      if (t.ts > existing.ts) {
        existing.ts = t.ts;
        existing.tradeId = t.tradeId;
      }
      continue;
    }

    const stableKey = `${t.side}:${t.price}:${t.tradeId}`;
    const next: Trade = {
      tradeId: t.tradeId,
      ts: t.ts,
      price: t.price,
      size: t.size,
      side: t.side,
      aggCount: t.aggCount ?? 1,
      stableKey,
    };
    agg.set(key, next);
    out.push(next);
    if (out.length >= TRADE_BATCH_MAX_ITEMS) break;
  }

  return out;
}

/** 标准化成交记录 */
function normalizeTrades(trades: Trade[]): Trade[] {
  return trades.map((t) => ({
    tradeId: t.tradeId,
    ts: t.ts,
    price: t.price,
    size: t.size,
    side: t.side,
    aggCount: t.aggCount ?? 1,
  }));
}

// ---- 健康检查 ----

/**
 * 定期健康检查：
 * 1. 连接假死检测（长时间无消息 → 重连）
 * 2. 同步状态超时（非 live 停留过久 → 恢复并重拉）
 * 3. 全局数据过期 / 单侧失衡 → 重拉快照
 */
function checkHealth() {
  if (!ws || !currentMarketId) return;
  const now = Date.now();

  // 连接假死
  const lastMsg = ws.getLastMessageAt();
  if (lastMsg > 0 && now - lastMsg > SILENT_DEATH_MS && ws.isOpen()) {
    const wsUrl = `${WS_MARKET_URL}?marketId=${currentMarketId}`;
    ws.reconnect(wsUrl);
    return;
  }

  // 同步状态超时
  const syncState = obManager.getSyncState();
  if (syncState !== "live" && syncState !== "init") {
    const diag = obManager.getDiagnostics();
    if (diag.stateDurationMs > SYNC_TIMEOUT_MS) {
      setSyncState("live");
      fetchSnapshot(true);
      return;
    }
  }

  const diag = obManager.getDiagnostics();

  // 全局数据过期
  if (diag.lastDeltaAt > 0) {
    const deltaAge = now - diag.lastDeltaAt;
    if (deltaAge > STALE_DATA_MS) {
      ensureSnapshotFetch("global_stale");
      return;
    }
  }

  // 单侧失衡
  if (diag.lastBidDeltaAt > 0 && diag.lastAskDeltaAt > 0) {
    const bidAge = now - diag.lastBidDeltaAt;
    const askAge = now - diag.lastAskDeltaAt;
    if (
      (bidAge < SIDE_ACTIVE_MS && askAge > SIDE_STALE_MS) ||
      (askAge < SIDE_ACTIVE_MS && bidAge > SIDE_STALE_MS)
    ) {
      ensureSnapshotFetch("side_imbalance");
    }
  }
}

// ---- 同步状态 ----

/** 更新订单簿同步状态（引擎 + 推送主线程双写） */
function setSyncState(state: OrderBookSyncState, reason?: string) {
  obManager.setSyncState(state, reason);
  post({ type: WorkerEvent.SyncState, state, reason });
}

// ---- 定时器管理 ----

/** 启动吞吐速率统计（每秒上报一次） */
function startRateCounter() {
  stopRateCounter();
  bookCount = 0;
  tradeCount = 0;
  rateTimer = setInterval(() => {
    post({ type: WorkerEvent.Rates, bookRate: bookCount, tradeRate: tradeCount });
    bookCount = 0;
    tradeCount = 0;
  }, 1000);
}

function stopRateCounter() {
  if (rateTimer !== null) {
    clearInterval(rateTimer);
    rateTimer = null;
  }
}

/** 启动成交缓冲区定时刷新 */
function startTradeFlush() {
  stopTradeFlush();
  tradeBuf = [];
  tradeFlushTimer = setInterval(flushTrades, TRADE_AGG_WINDOW_MS);
}

function stopTradeFlush() {
  if (tradeFlushTimer !== null) {
    clearInterval(tradeFlushTimer);
    tradeFlushTimer = null;
  }
  flushTrades();
}

/** 启动定期健康检查 */
function startHealthCheck() {
  stopHealthCheck();
  healthTimer = setInterval(checkHealth, HEALTH_CHECK_MS);
}

function stopHealthCheck() {
  if (healthTimer !== null) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

/** 清理所有资源：引擎、定时器、WebSocket */
function cleanup() {
  obManager.stop();
  obManager.reset();
  stopRateCounter();
  cancelScheduledFetch();
  stopTradeFlush();
  stopHealthCheck();
  retryAttempt = 0;
  lastFetchAt = 0;
  lastResyncAt = 0;
  accumulatedTrades = [];
  if (ws) {
    ws.disconnect();
    ws = null;
  }
}
