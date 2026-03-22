/**
 * 市场选择器
 * 展示当前市场 + 悬停下拉切换 + 实时中间价 / 价差 / 成交速率
 * 弹出层使用状态控制 + 延迟关闭，避免鼠标移出时立即消失
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useMarketStore } from "@/stores/market-store";
import { useOrderBookStore } from "@/stores/order-book-store";
import { useConnectionStore } from "@/stores/connection-store";
import { formatPrice, formatSpread, formatRate } from "@/lib/format";
import type { MarketId } from "@/lib/types";
import { ChevronDown } from "lucide-react";

const MARKETS: { id: MarketId; icon: string }[] = [
  { id: "BTC-PERP", icon: "₿" },
  { id: "SOL-PERP", icon: "◎" },
];

const CLOSE_DELAY_MS = 200;

export function MarketSelector() {
  const t = useTranslations("market");
  const marketId = useMarketStore((s) => s.marketId);
  const setMarketId = useMarketStore((s) => s.setMarketId);
  const midPrice = useOrderBookStore((s) => s.midPrice);
  const spreadPercent = useOrderBookStore((s) => s.spreadPercent);
  const tradeRate = useConnectionStore((s) => s.tradeRate);

  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = MARKETS.find((m) => m.id === marketId)!;

  const handleEnter = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  }, []);

  const handleLeave = useCallback(() => {
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);

  const handleSelect = useCallback(
    (id: MarketId) => {
      setMarketId(id);
      setOpen(false);
    },
    [setMarketId]
  );

  return (
    <div className="flex items-center gap-4">
      {/* 市场切换按钮 + 下拉列表 */}
      <div
        className="relative"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <button className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-accent transition-colors">
          <span className="text-lg leading-none">{current.icon}</span>
          <span className="text-sm font-semibold">{marketId}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>

        {/* 下拉列表 — 使用 pt-1 衔接间距，避免鼠标穿越空隙 */}
        {open && (
          <div className="absolute top-full left-0 pt-1 z-50">
            <div className="bg-popover border border-border rounded-md shadow-xl min-w-[160px] py-1 overflow-hidden">
              {MARKETS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleSelect(m.id)}
                  className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm hover:bg-accent transition-colors ${
                    m.id === marketId
                      ? "text-primary bg-accent/50"
                      : "text-foreground"
                  }`}
                >
                  <span className="text-base">{m.icon}</span>
                  <span className="font-medium">{m.id}</span>
                  {m.id === marketId && (
                    <span className="ml-auto text-xs text-primary">●</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 实时价格信息 */}
      {midPrice > 0 && (
        <div className="flex items-center gap-4">
          <span className="text-lg font-mono font-semibold tabular-nums text-foreground">
            {formatPrice(midPrice, marketId)}
          </span>
          <div className="flex flex-col text-[11px] leading-tight">
            <span className="text-muted-foreground">
              {t("spread")}{" "}
              <span className="text-foreground tabular-nums font-mono">
                {formatSpread(spreadPercent)}
              </span>
            </span>
            <span className="text-muted-foreground">
              {t("trades")}{" "}
              <span className="text-foreground tabular-nums font-mono">
                {formatRate(tradeRate)}/s
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
