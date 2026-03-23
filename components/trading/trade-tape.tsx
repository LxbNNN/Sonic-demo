/**
 * 最近成交流（Trade Tape）
 *
 * 使用 @tanstack/react-virtual 虚拟列表展示最近 200 条成交记录。
 * followTop 模式下新成交自动置顶；用户下滚查看历史时暂停自动跟随。
 */

"use client";

import { useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTradeStore } from "@/stores/trade-store";
import { useMarketStore } from "@/stores/market-store";
import { TradeRow } from "./trade-row";
import { MarketService } from "@/lib/market-service";

export function TradeTape() {
  const t = useTranslations("tradeTape");
  const trades = useTradeStore((s) => s.trades);
  const displayMode = useTradeStore((s) => s.displayMode);
  const marketId = useMarketStore((s) => s.marketId);
  const parentRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: trades.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 10,
  });

  // 检测用户是否在手动滚动（scrollTop > 4 视为已离开顶部）
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    isUserScrollingRef.current = el.scrollTop > 4;
  }, []);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  // 自动跟随：用户未手动滚动时，新成交自动置顶
  useEffect(() => {
    if (!isUserScrollingRef.current && trades.length > 0) {
      virtualizer.scrollToIndex(0, { align: "start" });
    }
  }, [trades, virtualizer]);

  return (
    <div className="flex flex-col h-full">
      {/* 表头 */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-xs font-medium text-muted-foreground">
            {t("title")}
          </div>
          <div className="flex items-center border border-border rounded overflow-hidden">
            <button
              className={`px-2 py-0.5 text-[10px] font-mono ${
                displayMode === "readable"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => MarketService.getInstance().setTradeDisplayMode("readable")}
            >
              R
            </button>
            <button
              className={`px-2 py-0.5 text-[10px] font-mono border-l border-border ${
                displayMode === "raw"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => MarketService.getInstance().setTradeDisplayMode("raw")}
            >
              RAW
            </button>
          </div>
        </div>
        <div className="flex text-[10px] text-muted-foreground uppercase tracking-wider">
          <span className="flex-1">{t("price")}</span>
          <span className="w-20 text-right">{t("size")}</span>
          <span className="w-16 text-right">{t("time")}</span>
          <span className="w-12 text-right">{t("aggregated")}</span>
        </div>
      </div>

      {/* 虚拟列表 */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto scrollbar-thin"
        style={{ minHeight: 0 }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const trade = trades[vItem.index];
            return (
              <div
                key={trade.stableKey ?? trade.tradeId}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: vItem.size,
                  transform: `translateY(${vItem.start}px)`,
                }}
              >
                <TradeRow trade={trade} marketId={marketId} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
