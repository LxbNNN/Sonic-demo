/**
 * 订单簿单行组件（OKX 风格）
 *
 * 双层深度条（从右向左）：
 * - 浅色层：cumTotal / maxCumTotal
 * - 深色层：size / maxCumTotal
 *
 * 自定义 memo 比较器：仅当实际值变化时重渲染，
 * 避免父组件每次 flush 都触发全部 40 行重渲染。
 *
 * CSS transition: 300ms，配合 200ms flush 间隔形成平滑重叠过渡。
 */

"use client";

import React from "react";
import type { MarketId, PriceLevel } from "@/lib/types";
import { formatPrice, formatSize } from "@/lib/format";

interface OrderBookRowProps {
  level: PriceLevel;
  side: "bid" | "ask";
  cumTotal: number;
  maxCumTotal: number;
  marketId: MarketId;
}

export const OrderBookRow = React.memo(
  function OrderBookRow({
    level,
    side,
    cumTotal,
    maxCumTotal,
    marketId,
  }: OrderBookRowProps) {
    const cumPct = maxCumTotal > 0 ? (cumTotal / maxCumTotal) * 100 : 0;
    const sizePct = maxCumTotal > 0 ? (level.size / maxCumTotal) * 100 : 0;
    const isBid = side === "bid";

    const lightColor = isBid
      ? "rgba(0,181,120,0.10)"
      : "rgba(246,70,93,0.10)";
    const darkColor = isBid
      ? "rgba(0,181,120,0.25)"
      : "rgba(246,70,93,0.25)";

    return (
      <div className="relative flex items-center h-[22px] px-3 text-[11px] font-mono tabular-nums hover:bg-accent/30 transition-colors cursor-default shrink-0">
        {/* 浅色层：累计量深度条 */}
        <div
          className="absolute top-0 bottom-0 right-0"
          style={{
            width: `${cumPct}%`,
            transition: "width 300ms ease-out",
            backgroundColor: lightColor,
          }}
        />
        {/* 深色层：单档挂单量深度条 */}
        <div
          className="absolute top-0 bottom-0 right-0"
          style={{
            width: `${sizePct}%`,
            transition: "width 300ms ease-out",
            backgroundColor: darkColor,
          }}
        />
        {/* 价格 */}
        <span
          className={`relative z-10 flex-1 ${
            isBid ? "text-long" : "text-short"
          }`}
        >
          {formatPrice(level.price, marketId)}
        </span>
        {/* 数量 */}
        <span className="relative z-10 w-[72px] text-right text-foreground/80">
          {formatSize(level.size)}
        </span>
        {/* 合计 */}
        <span className="relative z-10 w-[72px] text-right text-foreground/50">
          {formatSize(cumTotal)}
        </span>
      </div>
    );
  },
  (prev, next) =>
    prev.level.price === next.level.price &&
    prev.level.size === next.level.size &&
    prev.cumTotal === next.cumTotal &&
    prev.maxCumTotal === next.maxCumTotal &&
    prev.side === next.side &&
    prev.marketId === next.marketId,
);
