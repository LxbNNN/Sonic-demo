/**
 * 成交记录单行组件
 *
 * React.memo 优化：相同 trade 对象不重新渲染。
 * 新行挂载时触发闪烁动画（买入绿色 / 卖出红色）。
 * 使用 tradeId 作为 key 确保新成交获得新 DOM 元素触发动画。
 */

"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { MarketId, Trade } from "@/lib/types";
import { formatPrice, formatSize, formatTime } from "@/lib/format";

interface TradeRowProps {
  trade: Trade;
  marketId: MarketId;
}

export const TradeRow = React.memo(function TradeRow({
  trade,
  marketId,
}: TradeRowProps) {
  const t = useTranslations("tradeTape");
  const isBuy = trade.side === "buy";

  return (
    <div
      className={`flex items-center h-[22px] px-3 text-[11px] font-mono tabular-nums hover:bg-accent/30 transition-colors cursor-default ${
        isBuy ? "flash-buy" : "flash-sell"
      }`}
    >
      <span className={`flex-1 ${isBuy ? "text-long" : "text-short"}`}>
        {formatPrice(trade.price, marketId)}
      </span>
      <span className="text-foreground/70 w-20 text-right">
        {formatSize(trade.size)}
      </span>
      <span className="text-muted-foreground w-16 text-right">
        {formatTime(trade.ts)}
      </span>
      {trade.aggCount && trade.aggCount > 1 ? (
        <span className="text-[10px] text-muted-foreground ml-2 w-12 text-right">
          {t("aggregated")}x{trade.aggCount}
        </span>
      ) : (
        <span className="w-12 ml-2" />
      )}
    </div>
  );
});
