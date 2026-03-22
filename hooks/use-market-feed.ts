/**
 * 市场行情 Hook — 极薄的 React 生命周期桥接层
 *
 * 仅负责：
 * 1. 监听 marketId 变化，通知 MarketService 切换市场
 * 2. 组件卸载时停止 MarketService
 *
 * 所有消息路由、快照拉取、速率统计均由 MarketService 单例处理，
 * 不存在闭包过时问题。
 */

"use client";

import { useEffect } from "react";
import { useMarketStore } from "@/stores/market-store";
import { MarketService } from "@/lib/market-service";

export function useMarketFeed() {
  const marketId = useMarketStore((s) => s.marketId);

  useEffect(() => {
    MarketService.getInstance().switchMarket(marketId);
    return () => {
      MarketService.getInstance().stop();
    };
  }, [marketId]);
}
