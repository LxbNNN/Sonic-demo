/**
 * K线图组件（BigNumber 版本）
 *
 * 使用 Lightweight Charts (TradingView) 渲染蜡烛图。
 * 实时成交更新最后一根K线时，high/low 比较使用 BigNumber 避免精度丢失。
 */

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { BN } from "@/lib/bn";
import { useMarketStore } from "@/stores/market-store";
import { useTradeStore } from "@/stores/trade-store";
import { smfsClient } from "@/lib/smfs-client";
import { CANDLE_INTERVALS } from "@/lib/constants";
import type { CandleInterval } from "@/lib/types";
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  Time,
  CandlestickSeriesOptions,
  DeepPartial,
} from "lightweight-charts";

export function PriceChart() {
  const t = useTranslations("chart");
  const marketId = useMarketStore((s) => s.marketId);
  // 仅订阅最新一条成交（而非整个 trades 数组），减少不必要的 re-render
  const latestTrade = useTradeStore((s) => s.trades[0] ?? null);
  const [interval, setInterval_] = useState<CandleInterval>("1m");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastCandleRef = useRef<CandlestickData<Time> | null>(null);

  const initChart = useCallback(async () => {
    if (!containerRef.current) return;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }

    const { createChart, CandlestickSeries } = await import(
      "lightweight-charts"
    );

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "#0d1117" },
        textColor: "#7d8590",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(48,54,61,0.4)" },
        horzLines: { color: "rgba(48,54,61,0.4)" },
      },
      crosshair: {
        vertLine: {
          color: "rgba(240,185,11,0.3)",
          labelBackgroundColor: "#21262d",
        },
        horzLine: {
          color: "rgba(240,185,11,0.3)",
          labelBackgroundColor: "#21262d",
        },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: interval === "1s",
        borderColor: "#30363d",
      },
      rightPriceScale: {
        borderColor: "#30363d",
      },
    });

    const seriesOpts: DeepPartial<CandlestickSeriesOptions> = {
      upColor: "#00b578",
      downColor: "#f6465d",
      borderUpColor: "#00b578",
      borderDownColor: "#f6465d",
      wickUpColor: "#00b578",
      wickDownColor: "#f6465d",
    };

    const series = chart.addSeries(CandlestickSeries, seriesOpts);
    chartRef.current = chart;
    seriesRef.current = series;

    try {
      const candles = await smfsClient.getCandles(marketId, interval, 500);
      const data: CandlestickData<Time>[] = candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      if (data.length > 0) {
        series.setData(data);
        lastCandleRef.current = data[data.length - 1];
        chart.timeScale().fitContent();
      }
    } catch {
      // K线拉取失败可静默忽略
    }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [marketId, interval]);

  useEffect(() => {
    const cleanup = initChart();
    return () => {
      cleanup?.then?.((fn) => fn?.());
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
        seriesRef.current = null;
      }
    };
  }, [initChart]);

  // 实时成交 → 更新最后一根K线（同一时间槽内更新 OHLC，跨槽则新建K线）
  useEffect(() => {
    if (!seriesRef.current || !latestTrade) return;

    const candleTime = getCandleTime(latestTrade.ts, interval);
    const last = lastCandleRef.current;

    if (last && (last.time as number) === candleTime) {
      const tradePriceBN = BN(latestTrade.price);
      const updated: CandlestickData<Time> = {
        time: candleTime as Time,
        open: last.open,
        high: tradePriceBN.gt(BN(last.high))
          ? tradePriceBN.toNumber()
          : last.high,
        low: tradePriceBN.lt(BN(last.low))
          ? tradePriceBN.toNumber()
          : last.low,
        close: latestTrade.price,
      };
      seriesRef.current.update(updated);
      lastCandleRef.current = updated;
    } else if (!last || candleTime > (last.time as number)) {
      const newCandle: CandlestickData<Time> = {
        time: candleTime as Time,
        open: latestTrade.price,
        high: latestTrade.price,
        low: latestTrade.price,
        close: latestTrade.price,
      };
      seriesRef.current.update(newCandle);
      lastCandleRef.current = newCandle;
    }
  }, [latestTrade, interval]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">
          {t("title")}
        </span>
        <div className="flex rounded-md bg-accent/60 p-0.5">
          {CANDLE_INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => setInterval_(i)}
              className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${
                interval === i
                  ? "bg-panel text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {i}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}

/** 将毫秒时间戳对齐到K线间隔的起始时间（秒级） */
function getCandleTime(ts: number, interval: CandleInterval): number {
  const sec = Math.floor(ts / 1000);
  switch (interval) {
    case "1s":
      return sec;
    case "1m":
      return sec - (sec % 60);
    case "5m":
      return sec - (sec % 300);
    case "15m":
      return sec - (sec % 900);
  }
}
