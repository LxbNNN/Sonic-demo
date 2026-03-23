/**
 * 订单簿组件（OKX 风格）
 *
 * 性能架构：全链路绕过 React
 * - 40 行 DOM 一次性创建（StaticRows），后续更新通过 subscribe + 直写 DOM
 * - React 不参与行数据的任何 re-render（零 VDOM diff / 零 memo / 零 hook）
 * - 中间价条同样 useRef 直写
 * - 组件仅在 syncState / marketId 变化时 React re-render（切换市场/连接状态）
 * - contain: layout style paint 隔离各行渲染边界
 */

"use client";

import { useLayoutEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { ORDERBOOK_DEPTH, OB_ROW_HEIGHT } from "@/lib/constants";
import { useOrderBookStore } from "@/stores/order-book-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useMarketStore } from "@/stores/market-store";
import { TickSizeSelector } from "./tick-size-selector";
import { formatPrice, formatSize, formatSpread } from "@/lib/format";
import { ArrowUp, ArrowDown } from "lucide-react";
import type { MarketId, PriceLevel } from "@/lib/types";

// ---- 深度条颜色 ----

const LIGHT_BID = "rgba(0,181,120,0.10)";
const LIGHT_ASK = "rgba(246,70,93,0.10)";
const DARK_BID = "rgba(0,181,120,0.25)";
const DARK_ASK = "rgba(246,70,93,0.25)";

// ---- 骨架屏 ----

function SkeletonRow({ side, widthPct }: { side: "bid" | "ask"; widthPct: number }) {
  const bg = side === "bid" ? "rgba(0,181,120,0.08)" : "rgba(246,70,93,0.08)";
  return (
    <div className="relative flex items-center h-[22px] px-3 shrink-0">
      <div
        className="absolute top-0 bottom-0 right-0 animate-pulse"
        style={{ width: `${widthPct}%`, backgroundColor: bg }}
      />
      <div className="relative z-10 flex-1">
        <div className="h-2.5 w-16 bg-muted-foreground/10 rounded animate-pulse" />
      </div>
      <div className="relative z-10 w-[72px] flex justify-end">
        <div className="h-2.5 w-12 bg-muted-foreground/10 rounded animate-pulse" />
      </div>
      <div className="relative z-10 w-[72px] flex justify-end">
        <div className="h-2.5 w-14 bg-muted-foreground/10 rounded animate-pulse" />
      </div>
    </div>
  );
}

function SkeletonSection({ side, depth }: { side: "bid" | "ask"; depth: number }) {
  const rows = Array.from({ length: depth }, (_, i) => {
    const pct = 15 + ((depth - i) / depth) * 50;
    return <SkeletonRow key={i} side={side} widthPct={pct} />;
  });
  return <>{rows}</>;
}

// ---- 静态行 DOM（一次创建，永不 re-render，由 subscribe 命令式更新） ----

function StaticRows({
  side,
  depth,
  rowRefs,
}: {
  side: "bid" | "ask";
  depth: number;
  rowRefs: React.MutableRefObject<(HTMLDivElement | null)[]>;
}) {
  const isBid = side === "bid";
  const lightColor = isBid ? LIGHT_BID : LIGHT_ASK;
  const darkColor = isBid ? DARK_BID : DARK_ASK;
  const priceClass = `relative z-10 flex-1 ${isBid ? "text-long" : "text-short"}`;

  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <div
          key={i}
          ref={(el) => { rowRefs.current[i] = el; }}
          className="relative flex items-center h-[22px] px-3 text-[11px] font-mono tabular-nums hover:bg-accent/30 transition-colors cursor-default shrink-0"
          style={{ contain: "layout style paint", visibility: "hidden" }}
        >
          {/* children[0]: 浅色累计量条 */}
          <div
            className="absolute top-0 bottom-0 right-0 w-full"
            style={{
              transform: "scaleX(0)",
              transformOrigin: "right",
              transition: "transform 150ms ease-out",
              backgroundColor: lightColor,
            }}
          />
          {/* children[1]: 深色当档量条 */}
          <div
            className="absolute top-0 bottom-0 right-0 w-full"
            style={{
              transform: "scaleX(0)",
              transformOrigin: "right",
              transition: "transform 150ms ease-out",
              backgroundColor: darkColor,
            }}
          />
          {/* children[2]: 价格 */}
          <span className={priceClass} />
          {/* children[3]: 数量 */}
          <span className="relative z-10 w-[72px] text-right text-foreground/80" />
          {/* children[4]: 累计量 */}
          <span className="relative z-10 w-[72px] text-right text-foreground/50" />
        </div>
      ))}
    </>
  );
}

// ---- 命令式批量更新一侧所有行（零 React 开销） ----

function updateSection(
  rowEls: (HTMLDivElement | null)[],
  levels: PriceLevel[],
  cumTotals: number[],
  maxCum: number,
  marketId: MarketId,
  depth: number,
) {
  for (let i = 0; i < depth; i++) {
    const el = rowEls[i];
    if (!el) continue;

    if (i >= levels.length) {
      el.style.visibility = "hidden";
      continue;
    }

    el.style.visibility = "";
    const level = levels[i];
    const cumTotal = cumTotals[i] ?? 0;

    const ch = el.children;
    (ch[0] as HTMLDivElement).style.transform =
      `scaleX(${maxCum > 0 ? cumTotal / maxCum : 0})`;
    (ch[1] as HTMLDivElement).style.transform =
      `scaleX(${maxCum > 0 ? level.size / maxCum : 0})`;
    (ch[2] as HTMLElement).textContent = formatPrice(level.price, marketId);
    (ch[3] as HTMLElement).textContent = formatSize(level.size);
    (ch[4] as HTMLElement).textContent = formatSize(cumTotal);
  }
}

// ---- 主组件 ----

export function OrderBook() {
  const t = useTranslations("orderBook");
  const syncState = useConnectionStore((s) => s.orderBookSyncState);
  const marketId = useMarketStore((s) => s.marketId);

  const isLoading = syncState === "init" || syncState === "syncing";
  const isResyncing = syncState === "resyncing";

  const depth = ORDERBOOK_DEPTH;
  const sectionHeight = depth * OB_ROW_HEIGHT;
  const baseAsset = marketId === "BTC-PERP" ? "BTC" : "SOL";

  const askRowsRef = useRef<(HTMLDivElement | null)[]>([]);
  const bidRowsRef = useRef<(HTMLDivElement | null)[]>([]);

  const priceRef = useRef<HTMLSpanElement>(null);
  const spreadRef = useRef<HTMLSpanElement>(null);
  const arrowUpWrapRef = useRef<HTMLSpanElement>(null);
  const arrowDownWrapRef = useRef<HTMLSpanElement>(null);

  // 订阅 Store → 命令式更新所有行 + 中间价条（useLayoutEffect 确保首帧即填充，无空白闪烁）
  useLayoutEffect(() => {
    if (isLoading) return;

    const flush = () => {
      const s = useOrderBookStore.getState();

      updateSection(askRowsRef.current, s.asksReversed, s.asksCumTotals, s.maxAskCum, marketId, depth);
      updateSection(bidRowsRef.current, s.bids, s.bidsCumTotals, s.maxBidCum, marketId, depth);

      const up = s.midPrice >= s.prevMidPrice;
      if (priceRef.current) {
        priceRef.current.textContent = s.midPrice > 0 ? formatPrice(s.midPrice, marketId) : "\u2014";
        priceRef.current.className = `text-sm font-mono font-bold tabular-nums ${up ? "text-long" : "text-short"}`;
      }
      if (spreadRef.current) {
        spreadRef.current.textContent = formatSpread(s.spreadPercent);
      }
      if (arrowUpWrapRef.current) {
        arrowUpWrapRef.current.style.display = up ? "" : "none";
      }
      if (arrowDownWrapRef.current) {
        arrowDownWrapRef.current.style.display = up ? "none" : "";
      }
    };

    flush();
    return useOrderBookStore.subscribe(flush);
  }, [marketId, isLoading, depth]);

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

      {/* 卖盘区域 */}
      <div
        className="relative flex flex-col justify-end overflow-hidden"
        style={{ height: sectionHeight }}
      >
        {isLoading ? (
          <SkeletonSection side="ask" depth={depth} />
        ) : (
          <StaticRows side="ask" depth={depth} rowRefs={askRowsRef} />
        )}
        {isResyncing && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-20">
            <span className="text-xs text-muted-foreground animate-pulse">
              Resyncing...
            </span>
          </div>
        )}
      </div>

      {/* 中间价条 — 由 subscribe 直写 DOM */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-accent/40 border-y border-border shrink-0">
        <div className="flex items-center gap-1">
          <span ref={arrowUpWrapRef}>
            <ArrowUp className="h-3.5 w-3.5 text-long" />
          </span>
          <span ref={arrowDownWrapRef} style={{ display: "none" }}>
            <ArrowDown className="h-3.5 w-3.5 text-short" />
          </span>
          <span
            ref={priceRef}
            className="text-sm font-mono font-bold tabular-nums text-long"
          >
            —
          </span>
        </div>
        <span
          ref={spreadRef}
          className="text-[10px] text-muted-foreground tabular-nums font-mono"
        >
          0.000%
        </span>
      </div>

      {/* 买盘区域 */}
      <div
        className="relative flex flex-col overflow-hidden"
        style={{ height: sectionHeight }}
      >
        {isLoading ? (
          <SkeletonSection side="bid" depth={depth} />
        ) : (
          <StaticRows side="bid" depth={depth} rowRefs={bidRowsRef} />
        )}
        {isResyncing && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-20">
            <span className="text-xs text-muted-foreground animate-pulse">
              Resyncing...
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
