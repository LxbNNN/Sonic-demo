/**
 * MarketService — 市场数据服务单例
 *
 * 双模式架构：
 * - Worker 模式（默认）：WebSocket + 引擎运行在 Web Worker，主线程零计算开销
 * - 主线程模式（降级）：浏览器不支持 Worker 或 Worker 加载失败时回退
 *
 * 主线程仅负责：接收 Worker 的预计算快照 → 写入 Zustand Store → UI 更新
 */

import { useOrderBookStore } from "@/stores/order-book-store";
import { useTradeStore } from "@/stores/trade-store";
import { useConnectionStore } from "@/stores/connection-store";
import {
  DEFAULT_TRADE_DISPLAY_MODE,
  ORDERBOOK_DEPTH,
  OB_FLUSH_INTERVAL_MS,
  DEFAULT_TICK_SIZE,
} from "./constants";
import type {
  MarketId,
  TradeDisplayMode,
} from "./types";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./worker-messages";
import { WorkerCmd, WorkerEvent } from "./enums";

export class MarketService {
  private static instance: MarketService | null = null;

  /** 获取全局唯一实例 */
  static getInstance(): MarketService {
    if (!MarketService.instance) {
      MarketService.instance = new MarketService();
    }
    return MarketService.instance;
  }

  /** Worker 线程实例（Worker 模式下有值） */
  private worker: Worker | null = null;
  /** 当前订阅的市场 ID */
  private currentMarketId: MarketId | null = null;
  /** 当前成交流展示模式 */
  private tradeDisplayMode: TradeDisplayMode = DEFAULT_TRADE_DISPLAY_MODE;
  /** 当前浏览器是否支持 Web Worker */
  private workerSupported = false;

  private constructor() {
    this.workerSupported = typeof Worker !== "undefined";
  }

  /**
   * 切换市场：清理旧连接 → 初始化 Store → 启动 Worker（或降级到主线程）
   * 若重复切换同一市场则忽略
   */
  switchMarket(marketId: MarketId) {
    if (this.currentMarketId === marketId && this.worker) return;

    this.cleanup();
    this.currentMarketId = marketId;

    // 初始化 Store 默认值
    const defaultTick = DEFAULT_TICK_SIZE[marketId] ?? 0.1;
    useOrderBookStore.getState().setTickSize(defaultTick);
    useTradeStore.getState().setDisplayMode(this.tradeDisplayMode);
    useConnectionStore.getState().setOrderBookSyncState("syncing", "market_switch");

    // 优先使用 Worker 模式
    if (this.workerSupported) {
      try {
        this.startWorker(marketId, defaultTick);
        return;
      } catch {
        this.workerSupported = false;
      }
    }

    // Worker 不可用，降级到主线程模式
    this.startMainThread(marketId, defaultTick);
  }

  /** 停止所有服务并清理资源 */
  stop() {
    this.cleanup();
  }

  /** 修改价格聚合粒度，同步通知 Worker 和 Store */
  setTickSize(tick: number) {
    if (this.worker) {
      this.postToWorker({ type: WorkerCmd.SetTickSize, tick });
    }
    useOrderBookStore.getState().setTickSize(tick);
  }

  /** 切换成交流展示模式（raw / readable），同步通知 Worker 和 Store */
  setTradeDisplayMode(mode: TradeDisplayMode) {
    this.tradeDisplayMode = mode;
    useTradeStore.getState().setDisplayMode(mode);
    if (this.worker) {
      this.postToWorker({ type: WorkerCmd.SetTradeDisplayMode, mode });
    }
  }

  // ---- Worker 模式 ----

  /** 创建 Worker 线程，注册消息回调，发送初始化指令 */
  private startWorker(marketId: MarketId, defaultTick: number) {
    this.worker = new Worker(
      new URL("./market.worker.ts", import.meta.url),
      { type: "module" },
    );

    // Worker → 主线程消息：写入对应 Zustand Store
    this.worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
      this.handleWorkerMessage(e.data);
    };

    // Worker 加载/运行异常 → 降级到主线程模式
    this.worker.onerror = () => {
      this.workerSupported = false;
      this.cleanup();
      this.startMainThread(marketId, defaultTick);
    };

    // 发送「切换市场」指令给 Worker
    this.postToWorker({
      type: WorkerCmd.SwitchMarket,
      marketId,
      defaultTick,
      depth: ORDERBOOK_DEPTH,
      flushIntervalMs: OB_FLUSH_INTERVAL_MS,
    });
  }

  /** 处理 Worker 推送的数据快照，分发到各 Zustand Store */
  private handleWorkerMessage(msg: WorkerToMainMessage) {
    switch (msg.type) {
      case WorkerEvent.BookUpdate:
        useOrderBookStore.getState().setBook(msg.bids, msg.asks);
        break;
      case WorkerEvent.TradeUpdate:
        useTradeStore.getState().setTrades(msg.trades);
        break;
      case WorkerEvent.ConnectionStatus:
        useConnectionStore.getState().setStatus(msg.status);
        break;
      case WorkerEvent.SyncState:
        useConnectionStore.getState().setOrderBookSyncState(msg.state, msg.reason);
        break;
      case WorkerEvent.Rates:
        useConnectionStore.getState().setRates(msg.bookRate, msg.tradeRate);
        break;
    }
  }

  /** 类型安全的 Worker 消息发送 */
  private postToWorker(msg: MainToWorkerMessage) {
    this.worker?.postMessage(msg);
  }

  // ---- 主线程降级模式 ----

  private mainThreadService: MainThreadMarketService | null = null;

  /** 创建主线程市场服务实例并启动 */
  private startMainThread(marketId: MarketId, defaultTick: number) {
    this.mainThreadService = new MainThreadMarketService();
    this.mainThreadService.switchMarket(marketId, defaultTick);
  }

  // ---- 清理 ----

  /** 终止 Worker / 主线程服务，重置所有状态 */
  private cleanup() {
    if (this.worker) {
      this.postToWorker({ type: WorkerCmd.Stop });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.mainThreadService) {
      this.mainThreadService.stop();
      this.mainThreadService = null;
    }
    this.currentMarketId = null;
    useConnectionStore.getState().setOrderBookSyncState("init");
  }
}

// ==================== 主线程降级实现 ====================

import { WebSocketManager } from "./websocket-manager";
import { OrderBookManager } from "./order-book-engine";
import { smfsClient } from "./smfs-client";
import { marketBus } from "./market-events";
import {
  WS_MARKET_URL,
  MAX_TRADES,
  RESYNC_COOLDOWN_MS,
  TRADE_AGG_WINDOW_MS,
  TRADE_BATCH_MAX_ITEMS,
} from "./constants";
import type {
  ConnectionStatus,
  OrderBookSyncState,
  Trade,
  WsMessage,
  WsBookDeltaMessage,
  WsTradeMessage,
} from "./types";

/** 快照请求超时（毫秒） */
const SNAPSHOT_TIMEOUT_MS = 10_000;
/** 快照重试最大延迟（毫秒，指数退避上限） */
const SNAPSHOT_RETRY_MAX_MS = 30_000;
/** fetch 卡死保护超时（超过此时间强制重置 isFetching） */
const FETCH_GUARD_MS = 15_000;
/** 健康检查间隔（毫秒） */
const HEALTH_CHECK_MS = 5_000;
/** 无消息超时阈值，超过判定连接假死并重连 */
const SILENT_DEATH_MS = 30_000;
/** 同步状态停留过久阈值，超过强制恢复到 live */
const SYNC_TIMEOUT_MS = 15_000;
/** 全局数据过期阈值（所有侧均无更新） */
const STALE_DATA_MS = 8_000;
/** 单侧数据过期阈值（配合 SIDE_ACTIVE_MS 检测买/卖失衡） */
const SIDE_STALE_MS = 5_000;
/** 单侧活跃判定阈值 */
const SIDE_ACTIVE_MS = 2_000;
/** 序列号跳跃容忍上限（超过则触发快照重拉） */
const SEQ_GAP_TOLERANCE = 20;
/** 快照请求防抖间隔（毫秒） */
const SNAPSHOT_DEBOUNCE_MS = 3_000;

/**
 * 主线程降级市场服务
 *
 * 当 Web Worker 不可用时，WebSocket + OrderBookEngine + 成交聚合
 * 全部在主线程运行。逻辑与 market.worker.ts 对称。
 */
class MainThreadMarketService {
  private ws: WebSocketManager | null = null;
  private currentMarketId: MarketId | null = null;
  private obManager = OrderBookManager.getInstance();

  /** 快照请求锁 */
  private isFetching = false;
  /** 当前快照请求的开始时间（用于 FETCH_GUARD 超时保护） */
  private fetchStartedAt = 0;
  /** 快照重试定时器 */
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前连续重试次数（用于指数退避） */
  private retryAttempt = 0;
  /** 上次快照请求时间（防抖） */
  private lastFetchAt = 0;
  /** 上次触发重同步时间（冷却） */
  private lastResyncAt = 0;

  /** 吞吐速率统计定时器 */
  private rateTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前周期内订单簿消息计数 */
  private bookCount = 0;
  /** 当前周期内成交消息计数 */
  private tradeCount = 0;

  /** 成交缓冲区（攒批后一次性刷新到 Store） */
  private tradeBuf: Trade[] = [];
  /** 成交刷新定时器 */
  private tradeFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** 健康检查定时器 */
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    marketBus.on("book_delta", this.handleBookDelta);
    marketBus.on("trade", this.handleTrade);
    marketBus.on("reset", this.handleReset);
    marketBus.on("status_change", this.handleStatusChange);
    marketBus.on("request_snapshot", this.handleRequestSnapshot);
  }

  /** 切换市场：重置引擎 → 建立 WebSocket → 启动各周期任务 */
  switchMarket(marketId: MarketId, defaultTick: number) {
    this.cleanup();
    this.currentMarketId = marketId;

    this.obManager
      .reset()
      .configure(ORDERBOOK_DEPTH, OB_FLUSH_INTERVAL_MS, defaultTick)
      .bindFlush((bids, asks) => {
        useOrderBookStore.getState().setBook(bids, asks);
      })
      .start();
    this.setOrderBookSyncState("syncing", "market_switch");

    const wsUrl = `${WS_MARKET_URL}?marketId=${marketId}`;
    this.ws = new WebSocketManager({
      url: wsUrl,
      onMessage: (raw) => this.dispatchWsMessage(raw),
      onStatusChange: (status) => marketBus.emit("status_change", status),
    });
    this.ws.connect();

    this.startRateCounter();
    this.startTradeFlush();
    this.startHealthCheck();
  }

  /** 停止服务并注销事件监听 */
  stop() {
    this.cleanup();
    marketBus.off("book_delta", this.handleBookDelta);
    marketBus.off("trade", this.handleTrade);
    marketBus.off("reset", this.handleReset);
    marketBus.off("status_change", this.handleStatusChange);
    marketBus.off("request_snapshot", this.handleRequestSnapshot);
  }

  /** 将原始 WebSocket 消息按类型分发到事件总线 */
  private dispatchWsMessage = (raw: unknown) => {
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
  };

  /**
   * 处理订单簿增量：
   * 1. 过滤非当前市场消息
   * 2. 检测序列号连续性（回退/跳跃 → 触发快照重拉）
   * 3. 写入引擎
   */
  private handleBookDelta = (msg: WsBookDeltaMessage) => {
    if (msg.marketId !== this.currentMarketId) return;
    this.bookCount++;

    const lastSeq = this.obManager.getLastSeq();
    if (lastSeq >= 0) {
      if (msg.seq <= lastSeq) {
        // 序列号回退：容忍小幅度回退（乱序），超出阈值则重拉快照
        if (lastSeq - msg.seq > SEQ_GAP_TOLERANCE) {
          this.obManager.clearLastSeq();
          this.ensureSnapshotFetch(`seq_backward_${lastSeq}_to_${msg.seq}`);
        } else {
          return;
        }
      } else {
        // 序列号跳跃：可能丢失中间消息，超出容忍则重拉快照
        const gap = msg.seq - lastSeq - 1;
        if (gap > SEQ_GAP_TOLERANCE) {
          this.ensureSnapshotFetch(`seq_gap_expected_${lastSeq + 1}_got_${msg.seq}`);
        }
      }
    }
    this.obManager.applyDelta(msg);
  };

  /** 缓存实时成交到 tradeBuf，由 flushTrades 定期批量写入 Store */
  private handleTrade = (msg: WsTradeMessage) => {
    if (msg.marketId !== this.currentMarketId) return;
    this.tradeCount++;
    this.tradeBuf.push({
      tradeId: msg.tradeId,
      ts: msg.ts,
      price: msg.price,
      size: msg.size,
      side: msg.side,
      aggCount: 1,
    });
  };

  /** 服务端要求重置 → 触发快照重拉 */
  private handleReset = () => {
    this.ensureSnapshotFetch("server_reset");
  };

  /** WebSocket 连接状态变化：连上后立即拉取快照 */
  private handleStatusChange = (status: ConnectionStatus) => {
    useConnectionStore.getState().setStatus(status);
    if (status === "connected") {
      this.obManager.clearLastSeq();
      this.setOrderBookSyncState("syncing", "ws_connected");
      this.fetchSnapshot(true);
    }
  };

  /** 看门狗请求快照 */
  private handleRequestSnapshot = () => {
    this.ensureSnapshotFetch("watchdog_request");
  };

  /** 带冷却的快照重拉入口（防止短时间内重复触发） */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private ensureSnapshotFetch(reason: string) {
    const now = Date.now();
    if (now - this.lastResyncAt < RESYNC_COOLDOWN_MS) return;
    this.lastResyncAt = now;
    this.fetchSnapshot(true);
  }

  /**
   * 拉取订单簿快照：
   * - 防抖 + fetch 锁 + 超时 abort
   * - 成功后替换引擎数据、初始化成交列表、切换到 live 状态
   * - 失败后指数退避重试
   */
  private async fetchSnapshot(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFetchAt < SNAPSHOT_DEBOUNCE_MS) return;

    // fetch 锁：防止并发请求，超时自动解锁
    if (this.isFetching) {
      if (now - this.fetchStartedAt > FETCH_GUARD_MS) {
        this.isFetching = false;
      } else {
        return;
      }
    }

    if (!this.currentMarketId) return;

    this.isFetching = true;
    this.fetchStartedAt = now;
    this.lastFetchAt = now;

    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), SNAPSHOT_TIMEOUT_MS);

    try {
      const snap = await smfsClient.getSnapshot(this.currentMarketId, abortCtrl.signal);
      if (snap.marketId !== this.currentMarketId) return;
      this.obManager.replaceSnapshot(
        snap.bids as unknown[],
        snap.asks as unknown[],
        snap.snapshotSeq,
      );
      useTradeStore.getState().setTrades(this.normalizeTrades(snap.recentTrades));
      this.setOrderBookSyncState("live");
      this.retryAttempt = 0;
    } catch {
      this.retryAttempt++;
      this.scheduleSnapshotRetry();
    } finally {
      clearTimeout(timeout);
      this.isFetching = false;
    }
  }

  /** 指数退避重试：delay = min(2s × 2^attempt, 30s) */
  private scheduleSnapshotRetry() {
    this.cancelScheduledFetch();
    const delay = Math.min(2_000 * Math.pow(2, this.retryAttempt), SNAPSHOT_RETRY_MAX_MS);
    this.snapshotTimer = setTimeout(() => this.fetchSnapshot(true), delay);
  }

  /** 取消已计划的快照重试 */
  private cancelScheduledFetch() {
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /**
   * 定时刷新成交缓冲区：
   * - raw 模式：逆序截取最新 N 条
   * - readable 模式：按价格+方向聚合同窗口内成交
   */
  private flushTrades = () => {
    if (this.tradeBuf.length === 0) return;
    const buf = this.tradeBuf;
    this.tradeBuf = [];

    const tradeDisplayMode = useTradeStore.getState().displayMode;
    const latest = tradeDisplayMode === "raw"
      ? [...buf].reverse().slice(0, TRADE_BATCH_MAX_ITEMS)
      : this.toReadableTrades(buf);

    const store = useTradeStore.getState();
    const merged = [...latest, ...store.trades].slice(0, MAX_TRADES);
    store.setTrades(merged);
  };

  /**
   * 可读模式成交聚合：
   * 相同方向+价格且时间差 ≤ TRADE_AGG_WINDOW_MS 的成交合并为一条，
   * 生成 stableKey 保证虚拟列表 key 稳定
   */
  private toReadableTrades(buf: Trade[]): Trade[] {
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
        tradeId: t.tradeId, ts: t.ts, price: t.price,
        size: t.size, side: t.side, aggCount: t.aggCount ?? 1,
        stableKey,
      };
      agg.set(key, next);
      out.push(next);
      if (out.length >= TRADE_BATCH_MAX_ITEMS) break;
    }

    return out;
  }

  /**
   * 定期健康检查：
   * 1. 连接假死检测（长时间无消息 → 强制重连）
   * 2. 同步状态超时（非 live 停留过久 → 恢复并重拉）
   * 3. 全局数据过期（所有侧均无更新 → 重拉快照）
   * 4. 单侧失衡检测（一侧活跃另一侧过期 → 重拉快照）
   */
  private checkHealth = () => {
    if (!this.ws || !this.currentMarketId) return;
    const now = Date.now();

    // 连接假死：长时间无消息但 WebSocket 仍处于 OPEN
    const lastMsg = this.ws.getLastMessageAt();
    if (lastMsg > 0 && now - lastMsg > SILENT_DEATH_MS && this.ws.isOpen()) {
      const wsUrl = `${WS_MARKET_URL}?marketId=${this.currentMarketId}`;
      this.ws.reconnect(wsUrl);
      return;
    }

    // 同步状态超时：syncing/resyncing 停留过久 → 强制恢复到 live 并重拉
    const syncState = this.obManager.getSyncState();
    if (syncState !== "live" && syncState !== "init") {
      const diag = this.obManager.getDiagnostics();
      if (diag.stateDurationMs > SYNC_TIMEOUT_MS) {
        this.setOrderBookSyncState("live");
        this.fetchSnapshot(true);
        return;
      }
    }

    const diag = this.obManager.getDiagnostics();

    // 全局数据过期
    if (diag.lastDeltaAt > 0) {
      const deltaAge = now - diag.lastDeltaAt;
      if (deltaAge > STALE_DATA_MS) {
        this.ensureSnapshotFetch("global_stale");
        return;
      }
    }

    // 单侧失衡：一侧活跃另一侧过期
    if (diag.lastBidDeltaAt > 0 && diag.lastAskDeltaAt > 0) {
      const bidAge = now - diag.lastBidDeltaAt;
      const askAge = now - diag.lastAskDeltaAt;
      if (
        (bidAge < SIDE_ACTIVE_MS && askAge > SIDE_STALE_MS) ||
        (askAge < SIDE_ACTIVE_MS && bidAge > SIDE_STALE_MS)
      ) {
        this.ensureSnapshotFetch("side_imbalance");
      }
    }
  };

  /** 启动吞吐速率统计（每秒上报一次） */
  private startRateCounter() {
    this.stopRateCounter();
    this.bookCount = 0;
    this.tradeCount = 0;
    this.rateTimer = setInterval(() => {
      useConnectionStore.getState().setRates(this.bookCount, this.tradeCount);
      this.bookCount = 0;
      this.tradeCount = 0;
    }, 1000);
  }

  private stopRateCounter() {
    if (this.rateTimer !== null) { clearInterval(this.rateTimer); this.rateTimer = null; }
  }

  /** 启动成交缓冲区定时刷新 */
  private startTradeFlush() {
    this.stopTradeFlush();
    this.tradeBuf = [];
    this.tradeFlushTimer = setInterval(this.flushTrades, TRADE_AGG_WINDOW_MS);
  }

  private stopTradeFlush() {
    if (this.tradeFlushTimer !== null) { clearInterval(this.tradeFlushTimer); this.tradeFlushTimer = null; }
    this.flushTrades();
  }

  /** 启动定期健康检查 */
  private startHealthCheck() {
    this.stopHealthCheck();
    this.healthTimer = setInterval(this.checkHealth, HEALTH_CHECK_MS);
  }

  private stopHealthCheck() {
    if (this.healthTimer !== null) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  /** 统一设置订单簿同步状态（引擎 + Store 双写） */
  private setOrderBookSyncState(state: OrderBookSyncState, reason?: string) {
    this.obManager.setSyncState(state, reason);
    useConnectionStore.getState().setOrderBookSyncState(state, reason);
  }

  /** 标准化成交记录（确保必填字段完整） */
  private normalizeTrades(trades: Trade[]): Trade[] {
    return trades.map((t) => ({
      tradeId: t.tradeId, ts: t.ts, price: t.price,
      size: t.size, side: t.side, aggCount: t.aggCount ?? 1,
    }));
  }

  /** 清理所有资源：引擎、定时器、WebSocket */
  private cleanup() {
    this.obManager.stop();
    this.obManager.reset();
    this.stopRateCounter();
    this.cancelScheduledFetch();
    this.stopTradeFlush();
    this.stopHealthCheck();
    this.retryAttempt = 0;
    this.lastFetchAt = 0;
    this.lastResyncAt = 0;
    useConnectionStore.getState().setOrderBookSyncState("init");
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
  }
}
