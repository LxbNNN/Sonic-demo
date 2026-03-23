/**
 * 成交记录单行组件
 *
 * React.memo 优化：相同 trade 对象不重新渲染。
 * 零动画 / 零过渡：高频场景下只做文字差异更新，不触发任何 Paint 开销。
 */

"use client";

import React from "react";
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
  const isBuy = trade.side === "buy";

  return (
    <div className="flex items-center h-[22px] px-3 text-[11px] font-mono tabular-nums cursor-default">
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
          ×{trade.aggCount}
        </span>
      ) : (
        <span className="w-12 ml-2" />
      )}
    </div>
  );
});
