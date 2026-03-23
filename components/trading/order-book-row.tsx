/**
 * 订单簿单行组件（OKX 风格）
 *
 * 双层深度条（从右向左）：
 * - 浅色层：cumTotal / maxCumTotal
 * - 深色层：size / maxCumTotal
 *
 * 性能优化：
 * - maxCumTotal 不参与 memo 比较，通过 useRef 命令式更新深度条
 * - 仅当行自身数据（price/size/cumTotal）变化时才触发 React re-render
 * - 深度条使用 transform: scaleX()（compositor-only），150ms 过渡平滑视觉
 * - useLayoutEffect 在 paint 前同步写入，单帧完成
 * - contain: layout style paint 开启 CSS 渲染隔离
 */

"use client";

import React, { useRef, useLayoutEffect } from "react";
import type { MarketId, PriceLevel } from "@/lib/types";
import { formatPrice, formatSize } from "@/lib/format";

interface OrderBookRowProps {
  level: PriceLevel;
  side: "bid" | "ask";
  cumTotal: number;
  maxCumTotal: number;
  marketId: MarketId;
}

const LIGHT_BID = "rgba(0,181,120,0.10)";
const LIGHT_ASK = "rgba(246,70,93,0.10)";
const DARK_BID = "rgba(0,181,120,0.25)";
const DARK_ASK = "rgba(246,70,93,0.25)";

export const OrderBookRow = React.memo(
  function OrderBookRow({
    level,
    side,
    cumTotal,
    maxCumTotal,
    marketId,
  }: OrderBookRowProps) {
    const cumBarRef = useRef<HTMLDivElement>(null);
    const sizeBarRef = useRef<HTMLDivElement>(null);
    const isBid = side === "bid";

    useLayoutEffect(() => {
      const cumRatio = maxCumTotal > 0 ? cumTotal / maxCumTotal : 0;
      const sizeRatio = maxCumTotal > 0 ? level.size / maxCumTotal : 0;
      if (cumBarRef.current) cumBarRef.current.style.transform = `scaleX(${cumRatio})`;
      if (sizeBarRef.current) sizeBarRef.current.style.transform = `scaleX(${sizeRatio})`;
    });

    return (
      <div
        className="relative flex items-center h-[22px] px-3 text-[11px] font-mono tabular-nums hover:bg-accent/30 transition-colors cursor-default shrink-0"
        style={{ contain: "layout style paint" }}
      >
        <div
          ref={cumBarRef}
          className="absolute top-0 bottom-0 right-0 w-full"
          style={{
            transform: "scaleX(0)",
            transformOrigin: "right",
            // transition: "transform 150ms ease-out",
            backgroundColor: isBid ? LIGHT_BID : LIGHT_ASK,
          }}
        />
        <div
          ref={sizeBarRef}
          className="absolute top-0 bottom-0 right-0 w-full"
          style={{
            transform: "scaleX(0)",
            transformOrigin: "right",
            // transition: "transform 150ms ease-out",
            backgroundColor: isBid ? DARK_BID : DARK_ASK,
          }}
        />
        <span
          className={`relative z-10 flex-1 ${isBid ? "text-long" : "text-short"}`}
        >
          {formatPrice(level.price, marketId)}
        </span>
        <span className="relative z-10 w-[72px] text-right text-foreground/80">
          {formatSize(level.size)}
        </span>
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
    prev.side === next.side &&
    prev.marketId === next.marketId,
);
