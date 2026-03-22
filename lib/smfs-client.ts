/**
 * SMFS REST API 客户端
 * 封装所有与 Sonic Market Feed Service 的 HTTP 通信
 */

import { API_BASE_URL } from "./constants";
import type {
  CandleInterval,
  CandlesResponse,
  HealthResponse,
  MarketsResponse,
  OrderBookSnapshot,
  OrderRequest,
  OrderResponse,
  StatsResponse,
} from "./types";

/** 通用 JSON 请求封装，自动处理错误 */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `HTTP ${res.status}`
    );
  }
  return res.json() as Promise<T>;
}

export const smfsClient = {
  /** 健康检查 — 返回服务状态、可用市场、WS 地址 */
  getHealth() {
    return fetchJson<HealthResponse>("/health");
  },

  /** 获取所有可用市场列表 */
  getMarkets() {
    return fetchJson<MarketsResponse>("/markets");
  },

  /** 获取指定市场的订单簿完整快照 + 最近成交 */
  getSnapshot(marketId: string, signal?: AbortSignal) {
    return fetchJson<OrderBookSnapshot>(`/markets/${marketId}/snapshot`, {
      signal,
    });
  },

  /**
   * 获取K线数据
   * API 返回 { candles: [...] }，此方法直接返回 Candle 数组
   */
  async getCandles(
    marketId: string,
    interval: CandleInterval = "1m",
    limit = 3600
  ) {
    const params = new URLSearchParams({
      interval,
      limit: String(limit),
    });
    const res = await fetchJson<CandlesResponse>(
      `/markets/${marketId}/candles?${params.toString()}`
    );
    return res.candles;
  },

  /** 提交模拟订单（订单被确认但不会实际撮合） */
  submitOrder(order: OrderRequest) {
    return fetchJson<OrderResponse>("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(order),
    });
  },

  /** 获取各市场的实时吞吐统计 */
  getStats() {
    return fetchJson<StatsResponse>("/stats");
  },
};
