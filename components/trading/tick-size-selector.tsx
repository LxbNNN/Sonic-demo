/**
 * 价格聚合粒度选择器（OKX 风格）
 *
 * 点击按钮展开下拉面板，选中后同时更新 store（UI）和 engine（数据）。
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useOrderBookStore } from "@/stores/order-book-store";
import { useMarketStore } from "@/stores/market-store";
import { MarketService } from "@/lib/market-service";
import { TICK_SIZES } from "@/lib/constants";

export function TickSizeSelector() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tickSize = useOrderBookStore((s) => s.tickSize);
  const marketId = useMarketStore((s) => s.marketId);

  const options = TICK_SIZES[marketId] ?? [0.1];

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const handleSelect = (tick: number) => {
    MarketService.getInstance().setTickSize(tick);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground rounded border border-border hover:border-foreground/30 transition-colors"
      >
        {tickSize}
        <ChevronDown className="h-2.5 w-2.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[56px]">
          {options.map((tick) => (
            <button
              key={tick}
              onClick={() => handleSelect(tick)}
              className={`block w-full text-right px-3 py-1 text-[11px] font-mono transition-colors ${
                tick === tickSize
                  ? "text-primary bg-accent"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              }`}
            >
              {tick}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
