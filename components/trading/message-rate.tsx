/**
 * 消息速率显示
 * 展示过去 1 秒内收到的 WebSocket 消息总数（book_delta + trade）
 */

"use client";

import { useTranslations } from "next-intl";
import { BN } from "@/lib/bn";
import { useConnectionStore } from "@/stores/connection-store";
import { Activity } from "lucide-react";

export function MessageRate() {
  const t = useTranslations("messageRate");
  const bookRate = useConnectionStore((s) => s.bookRate);
  const tradeRate = useConnectionStore((s) => s.tradeRate);

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Activity className="h-3 w-3" />
      <span className="font-mono tabular-nums">
        {BN(bookRate).plus(tradeRate).toFixed(0)} {t("unit")}
      </span>
    </div>
  );
}
