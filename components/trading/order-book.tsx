/**
 * 订单簿组件（OKX 风格）
 *
 * - 卖盘 / 买盘区域各使用固定像素高度 = depth × ROW_HEIGHT
 * - 卖盘 justify-end，从底部向上填充（最优卖价贴近中间价）
 * - 买盘从顶部向下填充（最优买价贴近中间价）
 * - 累计量用原生加法（20 档精度足够），不引入 BigNumber
 */

"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ORDERBOOK_DEPTH, OB_ROW_HEIGHT } from "@/lib/constants";
import { useOrderBookStore } from "@/stores/order-book-store";
import { useMarketStore } from "@/stores/market-store";
import { OrderBookRow } from "./order-book-row";
import { TickSizeSelector } from "./tick-size-selector";
import { formatPrice, formatSpread } from "@/lib/format";
import { ArrowUp, ArrowDown } from "lucide-react";

export function OrderBook() {
  const t = useTranslations("orderBook");
  const bids = useOrderBookStore((s) => s.bids);
  const asks = useOrderBookStore((s) => s.asks);
  const midPrice = useOrderBookStore((s) => s.midPrice);
  const prevMidPrice = useOrderBookStore((s) => s.prevMidPrice);
  const spreadPercent = useOrderBookStore((s) => s.spreadPercent);
  const marketId = useMarketStore((s) => s.marketId);

  const depth = ORDERBOOK_DEPTH;
  const sectionHeight = depth * OB_ROW_HEIGHT;

  // 卖盘反转：[最高价, ..., 最低价]（最低价在底部，贴近中间价）
  const asksReversed = useMemo(() => [...asks].reverse(), [asks]);

  // 卖盘累计量：从最优卖价（底部）向上累加
  const asksCumTotals = useMemo(() => {
    const arr = new Array<number>(asksReversed.length);
    let sum = 0;
    for (let i = asksReversed.length - 1; i >= 0; i--) {
      sum += asksReversed[i].size;
      arr[i] = sum;
    }
    return arr;
  }, [asksReversed]);

  // 买盘累计量：从最优买价（顶部）向下累加
  const bidsCumTotals = useMemo(() => {
    const arr: number[] = [];
    let sum = 0;
    for (const l of bids) {
      sum += l.size;
      arr.push(sum);
    }
    return arr;
  }, [bids]);

  const maxAskCum = asksCumTotals[0] ?? 0;
  const maxBidCum = bidsCumTotals[bidsCumTotals.length - 1] ?? 0;

  const priceUp = midPrice >= prevMidPrice;
  const baseAsset = marketId === "BTC-PERP" ? "BTC" : "SOL";

  return (
    <div className="flex flex-col">
      {/* 表头 */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("title")}
          </span>
          <TickSizeSelector />
        </div>
        <div className="flex text-[10px] text-muted-foreground uppercase tracking-wider">
          <span className="flex-1">{t("price")} (USDT)</span>
          <span className="w-[72px] text-right">
            {t("size")} ({baseAsset})
          </span>
          <span className="w-[72px] text-right">
            {t("total")} ({baseAsset})
          </span>
        </div>
      </div>

      {/* 卖盘区域：固定高度，justify-end 底部填充 */}
      <div
        className="flex flex-col justify-end overflow-hidden"
        style={{ height: sectionHeight }}
      >
        {asksReversed.slice(0, depth).map((level, i) => (
          <OrderBookRow
            key={level.price}
            level={level}
            side="ask"
            cumTotal={asksCumTotals[i] ?? 0}
            maxCumTotal={maxAskCum}
            marketId={marketId}
          />
        ))}
      </div>

      {/* 中间价条 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-accent/40 border-y border-border shrink-0">
        <div className="flex items-center gap-1">
          {priceUp ? (
            <ArrowUp className="h-3.5 w-3.5 text-long" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 text-short" />
          )}
          <span
            className={`text-sm font-mono font-bold tabular-nums ${
              priceUp ? "text-long" : "text-short"
            }`}
          >
            {midPrice > 0 ? formatPrice(midPrice, marketId) : "—"}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums font-mono">
          {formatSpread(spreadPercent)}
        </span>
      </div>

      {/* 买盘区域：固定高度，顶部填充 */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: sectionHeight }}
      >
        {bids.slice(0, depth).map((level, i) => (
          <OrderBookRow
            key={level.price}
            level={level}
            side="bid"
            cumTotal={bidsCumTotals[i] ?? 0}
            maxCumTotal={maxBidCum}
            marketId={marketId}
          />
        ))}
      </div>
    </div>
  );
}
