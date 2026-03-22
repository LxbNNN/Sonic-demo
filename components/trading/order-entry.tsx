/**
 * 下单面板（BigNumber 版本）
 *
 * 价格和数量的解析/验证全部使用 BigNumber，
 * 避免 parseFloat 导致的精度丢失。
 */

"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { BN, ZERO } from "@/lib/bn";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useMarketStore } from "@/stores/market-store";
import { useOrderBookStore } from "@/stores/order-book-store";
import { smfsClient } from "@/lib/smfs-client";
import type { OrderType, Side } from "@/lib/types";

export function OrderEntry() {
  const t = useTranslations("orderEntry");
  const marketId = useMarketStore((s) => s.marketId);
  const midPrice = useOrderBookStore((s) => s.midPrice);

  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [side, setSide] = useState<Side>("buy");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);

  const handleSubmit = useCallback(async () => {
    const sizeBN = BN(size);
    if (sizeBN.isNaN() || sizeBN.lte(ZERO)) return;

    let priceNum: number | undefined;
    if (orderType === "limit") {
      const priceBN = BN(price);
      if (priceBN.isNaN() || priceBN.lte(ZERO)) return;
      priceNum = priceBN.toNumber();
    }

    setSubmitting(true);
    setResult(null);

    try {
      const res = await smfsClient.submitOrder({
        marketId,
        side,
        type: orderType,
        price: priceNum,
        size: sizeBN.toNumber(),
      });
      setResult({ ok: true, msg: t("accepted", { orderId: res.orderId }) });
      setSize("");
      if (orderType === "limit") setPrice("");
    } catch (err) {
      setResult({
        ok: false,
        msg: err instanceof Error ? err.message : t("failed"),
      });
    } finally {
      setSubmitting(false);
    }
  }, [marketId, side, orderType, price, size, t]);

  const baseAsset = marketId === "BTC-PERP" ? "BTC" : "SOL";
  const isBuy = side === "buy";
  const midPriceDisplay = BN(midPrice).gt(0) ? BN(midPrice).toFixed(2) : "0.00";

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* 订单类型切换 */}
      <div className="flex rounded-md bg-accent/60 p-0.5">
        {(["limit", "market"] as const).map((tp) => (
          <button
            key={tp}
            onClick={() => setOrderType(tp)}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              orderType === tp
                ? "bg-panel text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(tp)}
          </button>
        ))}
      </div>

      {/* 买入 / 卖出切换 */}
      <div className="flex gap-1.5">
        <button
          onClick={() => setSide("buy")}
          className={`flex-1 py-2.5 text-xs font-semibold rounded-md transition-all ${
            isBuy
              ? "bg-long text-white shadow-[0_0_16px_rgba(0,181,120,0.25)]"
              : "bg-accent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("buyLong")}
        </button>
        <button
          onClick={() => setSide("sell")}
          className={`flex-1 py-2.5 text-xs font-semibold rounded-md transition-all ${
            !isBuy
              ? "bg-short text-white shadow-[0_0_16px_rgba(246,70,93,0.25)]"
              : "bg-accent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("sellShort")}
        </button>
      </div>

      {/* 限价价格输入 */}
      {orderType === "limit" && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] text-muted-foreground">
              {t("price")}
            </label>
            <span className="text-[10px] text-muted-foreground">USDT</span>
          </div>
          <Input
            type="number"
            step="any"
            placeholder={midPriceDisplay}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="h-9 font-mono tabular-nums text-sm bg-accent/60 border-border"
          />
        </div>
      )}

      {/* 数量输入 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] text-muted-foreground">
            {t("amount")}
          </label>
          <span className="text-[10px] text-muted-foreground">{baseAsset}</span>
        </div>
        <Input
          type="number"
          step="any"
          placeholder="0.00"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className="h-9 font-mono tabular-nums text-sm bg-accent/60 border-border"
        />
      </div>

      {/* 快捷百分比按钮 */}
      <div className="grid grid-cols-4 gap-1">
        {["25%", "50%", "75%", "100%"].map((pct) => (
          <button
            key={pct}
            className="py-1 text-[10px] text-muted-foreground rounded bg-accent/60 hover:bg-accent hover:text-foreground transition-colors"
          >
            {pct}
          </button>
        ))}
      </div>

      {/* 提交按钮 */}
      <Button
        onClick={handleSubmit}
        disabled={submitting}
        className={`w-full h-10 font-semibold text-white rounded-md ${
          isBuy
            ? "bg-long hover:bg-long/90 shadow-[0_0_20px_rgba(0,181,120,0.2)]"
            : "bg-short hover:bg-short/90 shadow-[0_0_20px_rgba(246,70,93,0.2)]"
        }`}
      >
        {submitting
          ? t("submitting")
          : `${isBuy ? t("buy") : t("sell")} ${baseAsset}`}
      </Button>

      {/* 提交结果 */}
      {result && (
        <div
          className={`text-[11px] text-center py-1.5 rounded ${
            result.ok
              ? "text-long bg-long-muted"
              : "text-short bg-short-muted"
          }`}
        >
          {result.msg}
        </div>
      )}
    </div>
  );
}
