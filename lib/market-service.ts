/**
 * MarketService — 市场数据服务单例
 *
 * 设计原则（对齐 Binance/OKX 最佳实践）：
 * 1. 增量始终应用——不因同步状态阻塞 delta，避免任何冻结场景
 * 2. 快照为修正手段——成功时全量替换，失败时持续重试不影响增量流
 * 3. 容忍小 seq gap——仅大缺口触发快照修正，小缺口直接容忍
 * 4. 零死角兜底——健康检测覆盖 WS 静默死亡 + 同步超时卡死
 */

import { WebSocketManager } from "./websocket-manager";
import { OrderBookManager } from "./order-book-engine";
import { smfsClient } from "./smfs-client";
import { marketBus } from "./market-events";
import {
  DEFAULT_TRADE_DISPLAY_MODE,
  WS_MARKET_URL,
  ORDERBOOK_DEPTH,
  OB_FLUSH_INTERVAL_MS,
  DEFAULT_TICK_SIZE,
  MAX_TRADES,
  RESYNC_COOLDOWN_MS,
  TRADE_AGG_WINDOW_MS,
  TRADE_BATCH_MAX_ITEMS,
} from "./constants";
import { useOrderBookStore } from "@/stores/order-book-store";
import { useTradeStore } from "@/stores/trade-store";
import { useConnectionStore } from "@/stores/connection-store";
import type {
  MarketId,
  ConnectionStatus,
  OrderBookSyncState,
  Trade,
  TradeDisplayMode,
  WsMessage,
  WsBookDeltaMessage,
  WsTradeMessage,
} from "./types";

/** 快照 HTTP 请求超时（ms） */
const SNAPSHOT_TIMEOUT_MS = 10_000;

/** 快照重试退避上限（ms） */
const SNAPSHOT_RETRY_MAX_MS = 30_000;

/** isFetching 最大保持时间（ms），超时强制重置 */
const FETCH_GUARD_MS = 15_000;

/** 连接健康检测间隔（ms） */
const HEALTH_CHECK_MS = 5_000;

/** 连接被判定为静默死亡的无消息阈值（ms） */
const SILENT_DEATH_MS = 30_000;

/** 非 live 状态持续超过此时间，强制进入 live（降级模式） */
const SYNC_TIMEOUT_MS = 15_000;

/** seq gap 小于此阈值时直接容忍（不触发快照修正） */
const SEQ_GAP_TOLERANCE = 20;

/** 快照请求最小间隔（防抖，ms） */
const SNAPSHOT_DEBOUNCE_MS = 3_000;

export class MarketService {
  private static instance: MarketService | null = null;

  static getInstance(): MarketService {
    if (!MarketService.instance) {
      MarketService.instance = new MarketService();
    }
    return MarketService.instance;
  }

  private ws: WebSocketManager | null = null;
  private currentMarketId: MarketId | null = null;
  private obManager = OrderBookManager.getInstance();

  // ---- 快照拉取 ----
  private isFetching = false;
  private fetchStartedAt = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private lastFetchAt = 0;
  private lastResyncAt = 0;

  // ---- 速率统计 ----
  private rateTimer: ReturnType<typeof setInterval> | null = null;
  private bookCount = 0;
  private tradeCount = 0;

  // ---- trade 批处理 ----
  private tradeBuf: Trade[] = [];
  private tradeFlushTimer: ReturnType<typeof setInterval> | null = null;
  private tradeDisplayMode: TradeDisplayMode = DEFAULT_TRADE_DISPLAY_MODE;

  // ---- 连接健康监控 ----
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    marketBus.on("book_delta", this.handleBookDelta);
    marketBus.on("trade", this.handleTrade);
    marketBus.on("reset", this.handleReset);
    marketBus.on("status_change", this.handleStatusChange);
    marketBus.on("request_snapshot", this.handleRequestSnapshot);
  }

  /** 切换市场（幂等：相同 marketId 且 WS 已连接则跳过） */
  switchMarket(marketId: MarketId) {
    if (this.currentMarketId === marketId && this.ws) return;

    this.cleanup();
    this.currentMarketId = marketId;

    const defaultTick = DEFAULT_TICK_SIZE[marketId] ?? 0.1;
    useOrderBookStore.getState().setTickSize(defaultTick);
    useTradeStore.getState().setDisplayMode(this.tradeDisplayMode);

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

  /** 停止所有活动（组件卸载时调用） */
  stop() {
    this.cleanup();
  }

  /** 设置价格聚合粒度（UI 调用） */
  setTickSize(tick: number) {
    this.obManager.setTickSize(tick);
    useOrderBookStore.getState().setTickSize(tick);
  }

  /** 设置成交流展示模式（raw/readable） */
  setTradeDisplayMode(mode: TradeDisplayMode) {
    this.tradeDisplayMode = mode;
    useTradeStore.getState().setDisplayMode(mode);
  }

  // ---- WS 消息分发 ----

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
      default:
        break;
    }
  };

  // ---- 事件处理器 ----

  /**
   * 核心设计：增量始终应用，不因同步状态阻塞。
   *
   * seq 判定逻辑：
   * - msg.seq <= lastSeq 且差距小 → 正常去重，丢弃
   * - msg.seq <= lastSeq 且差距大（倒跳） → 服务端 seq 重置，清空锚点 + 快照修正 + 应用
   * - msg.seq > lastSeq 且 gap 小 → 容忍并应用
   * - msg.seq > lastSeq 且 gap 大 → 快照修正 + 应用
   * - lastSeq = -1（未锚定） → 直接应用，首条 delta 锚定
   */
  private handleBookDelta = (msg: WsBookDeltaMessage) => {
    if (msg.marketId !== this.currentMarketId) return;
    this.bookCount++;

    const lastSeq = this.obManager.getLastSeq();
    if (lastSeq >= 0) {
      if (msg.seq <= lastSeq) {
        if (lastSeq - msg.seq > SEQ_GAP_TOLERANCE) {
          console.warn(
            `[MarketService] seq backward jump: ${lastSeq} → ${msg.seq}, re-anchoring`,
          );
          this.obManager.clearLastSeq();
          this.ensureSnapshotFetch(`seq_backward_${lastSeq}_to_${msg.seq}`);
        } else {
          return;
        }
      } else {
        const gap = msg.seq - lastSeq - 1;
        if (gap > SEQ_GAP_TOLERANCE) {
          this.ensureSnapshotFetch(
            `seq_gap_expected_${lastSeq + 1}_got_${msg.seq}`,
          );
        }
      }
    }
    this.obManager.applyDelta(msg);
  };

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

  private handleReset = () => {
    this.ensureSnapshotFetch("server_reset");
  };

  private handleStatusChange = (status: ConnectionStatus) => {
    useConnectionStore.getState().setStatus(status);
    if (status === "connected") {
      // 新 WS 连接可能使用不同的 seq 编号空间（常见于每连接递增的服务端）
      // 必须在 fetchSnapshot 之前重置，否则异步等待期间 delta 全部被去重丢弃
      this.obManager.clearLastSeq();
      this.setOrderBookSyncState("syncing", "ws_connected");
      this.fetchSnapshot(true);
    }
  };

  private handleRequestSnapshot = () => {
    this.ensureSnapshotFetch("watchdog_request");
  };

  // ---- 快照拉取 ----

  /**
   * 节流的快照请求入口——合并高频请求，防止风暴。
   * 无论成功失败都保证有后续重试路径（见 scheduleSnapshotRetry）。
   */
  private ensureSnapshotFetch(reason: string) {
    const now = Date.now();
    if (now - this.lastResyncAt < RESYNC_COOLDOWN_MS) return;
    this.lastResyncAt = now;
    console.debug(`[MarketService] snapshot requested: ${reason}`);
    marketBus.emit("orderbook_resync_reason", { reason, at: now });
    this.fetchSnapshot(true);
  }

  private async fetchSnapshot(force = false) {
    const now = Date.now();
    if (!force && now - this.lastFetchAt < SNAPSHOT_DEBOUNCE_MS) return;

    if (this.isFetching) {
      if (now - this.fetchStartedAt > FETCH_GUARD_MS) {
        console.warn("[MarketService] isFetching stuck, force reset");
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
      const snap = await smfsClient.getSnapshot(
        this.currentMarketId,
        abortCtrl.signal,
      );

      if (snap.marketId !== this.currentMarketId) return;
      this.obManager.replaceSnapshot(
        snap.bids as unknown[],
        snap.asks as unknown[],
        snap.snapshotSeq,
      );
      useTradeStore
        .getState()
        .setTrades(this.normalizeTrades(snap.recentTrades));

      this.setOrderBookSyncState("live");
      this.retryAttempt = 0;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("[MarketService] snapshot fetch failed:", e);
      } else {
        console.warn("[MarketService] snapshot fetch timed out");
      }
      this.retryAttempt++;
      this.scheduleSnapshotRetry();
    } finally {
      clearTimeout(timeout);
      this.isFetching = false;
    }
  }

  /**
   * 快照失败后的退避重试——始终调度，确保永不死锁。
   * 这是修复旧版 scheduleNextSnapshot 死锁的关键：
   * 旧版在 snapshotLoaded=true 时直接 return，导致 resync 失败后无人重试。
   */
  private scheduleSnapshotRetry() {
    this.cancelSnapshotRetry();
    const delay = Math.min(
      2_000 * Math.pow(2, this.retryAttempt),
      SNAPSHOT_RETRY_MAX_MS,
    );
    console.debug(
      `[MarketService] scheduling snapshot retry in ${delay}ms (attempt ${this.retryAttempt})`,
    );
    this.snapshotTimer = setTimeout(() => {
      this.fetchSnapshot(true);
    }, delay);
  }

  private cancelSnapshotRetry() {
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  // ---- trade 批处理 ----

  private flushTrades = () => {
    if (this.tradeBuf.length === 0) return;
    const buf = this.tradeBuf;
    this.tradeBuf = [];

    const latest =
      this.tradeDisplayMode === "raw"
        ? this.toRawTrades(buf)
        : this.toReadableTrades(buf);

    const store = useTradeStore.getState();
    const merged = [...latest, ...store.trades].slice(0, MAX_TRADES);
    store.setTrades(merged);
  };

  // ---- 连接健康监控 ----

  private checkHealth = () => {
    if (!this.ws || !this.currentMarketId) return;

    // 1. WebSocket 静默死亡检测
    const lastMsg = this.ws.getLastMessageAt();
    if (
      lastMsg > 0 &&
      Date.now() - lastMsg > SILENT_DEATH_MS &&
      this.ws.isOpen()
    ) {
      console.warn("[MarketService] silent connection detected, reconnecting");
      const wsUrl = `${WS_MARKET_URL}?marketId=${this.currentMarketId}`;
      this.ws.reconnect(wsUrl);
      return;
    }

    // 2. 同步超时检测——防止非 live 状态永久卡死
    const syncState = this.obManager.getSyncState();
    if (syncState !== "live" && syncState !== "init") {
      const diag = this.obManager.getDiagnostics();
      if (diag.stateDurationMs > SYNC_TIMEOUT_MS) {
        console.warn(
          `[MarketService] sync stuck in "${syncState}" for ${diag.stateDurationMs}ms, forcing live + refetch`,
        );
        this.setOrderBookSyncState("live");
        this.fetchSnapshot(true);
      }
    }
  };

  // ---- 定时器管理 ----

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
    if (this.rateTimer !== null) {
      clearInterval(this.rateTimer);
      this.rateTimer = null;
    }
  }

  private startTradeFlush() {
    this.stopTradeFlush();
    this.tradeBuf = [];
    this.tradeFlushTimer = setInterval(this.flushTrades, TRADE_AGG_WINDOW_MS);
  }

  private stopTradeFlush() {
    if (this.tradeFlushTimer !== null) {
      clearInterval(this.tradeFlushTimer);
      this.tradeFlushTimer = null;
    }
    this.flushTrades();
  }

  private startHealthCheck() {
    this.stopHealthCheck();
    this.healthTimer = setInterval(this.checkHealth, HEALTH_CHECK_MS);
  }

  private stopHealthCheck() {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private cleanup() {
    this.obManager.stop();
    this.obManager.reset();
    this.stopRateCounter();
    this.cancelSnapshotRetry();
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

  private setOrderBookSyncState(state: OrderBookSyncState, reason?: string) {
    this.obManager.setSyncState(state, reason);
    useConnectionStore.getState().setOrderBookSyncState(state, reason);
  }

  private normalizeTrades(trades: Trade[]): Trade[] {
    return trades.map((t) => ({
      tradeId: t.tradeId,
      ts: t.ts,
      price: t.price,
      size: t.size,
      side: t.side,
      aggCount: t.aggCount ?? 1,
    }));
  }

  private toRawTrades(buf: Trade[]): Trade[] {
    return [...buf].reverse().slice(0, TRADE_BATCH_MAX_ITEMS);
  }

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

      const next: Trade = {
        tradeId: t.tradeId,
        ts: t.ts,
        price: t.price,
        size: t.size,
        side: t.side,
        aggCount: t.aggCount ?? 1,
      };
      agg.set(key, next);
      out.push(next);
      if (out.length >= TRADE_BATCH_MAX_ITEMS) break;
    }

    return out;
  }
}
