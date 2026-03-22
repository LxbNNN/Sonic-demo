/**
 * Solana 交易流面板（Bonus 功能）
 *
 * 连接 /ws/stream WebSocket，实时展示 Solana 链上交易：
 * - 交易签名（可点击跳转 Sonic Explorer）
 * - Slot 编号
 * - 手续费（lamports → SOL）
 * - 调用的程序数量
 *
 * 处理 reorg 事件：自动移除回滚 slot 之后的交易
 */

"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSolanaStream, useStreamStore } from "@/hooks/use-solana-stream";
import { formatLamports } from "@/lib/format";
import { ExternalLink, Radio } from "lucide-react";
import React from "react";

const EXPLORER_BASE = "https://explorer.sonic.game/tx/";

const TxRow = React.memo(function TxRow({
  signature,
  slot,
  fee,
  programIds,
}: {
  signature: string;
  slot: number;
  fee: number;
  programIds: string[];
}) {
  const shortSig = `${signature.slice(0, 6)}…${signature.slice(-4)}`;

  return (
    <div className="flex items-center h-[26px] px-3 text-[11px] font-mono gap-3 hover:bg-accent/30 transition-colors">
      <a
        href={`${EXPLORER_BASE}${signature}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:text-primary/80 flex items-center gap-1 shrink-0"
      >
        {shortSig}
        <ExternalLink className="h-2.5 w-2.5" />
      </a>
      <span className="text-muted-foreground tabular-nums">
        {slot.toLocaleString()}
      </span>
      <span className="text-foreground/60 tabular-nums">
        {formatLamports(fee)}
      </span>
      <span className="text-muted-foreground flex-1 text-right tabular-nums">
        {programIds.length}
      </span>
    </div>
  );
});

export function TransactionFeed() {
  const t = useTranslations("txFeed");
  useSolanaStream();

  const transactions = useStreamStore((s) => s.transactions);
  const status = useStreamStore((s) => s.status);
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: transactions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 5,
  });

  return (
    <div className="flex flex-col h-full">
      {/* 头部：标题 + 连接状态 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t("title")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Radio
            className={`h-3 w-3 ${
              status === "connected" ? "text-long" : "text-muted-foreground"
            }`}
          />
          <span className="text-[10px] text-muted-foreground">{status}</span>
        </div>
      </div>

      {/* 列头 */}
      <div className="flex items-center h-5 px-3 text-[10px] text-muted-foreground uppercase tracking-wider gap-3 border-b border-border/50">
        <span className="shrink-0 w-[90px]">{t("signature")}</span>
        <span>{t("slot")}</span>
        <span>{t("fee")}</span>
        <span className="flex-1 text-right">{t("programs")}</span>
      </div>

      {/* 交易列表 */}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto scrollbar-thin"
        style={{ minHeight: 0 }}
      >
        {transactions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            {t("waiting")}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const tx = transactions[vItem.index];
              return (
                <div
                  key={vItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: vItem.size,
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <TxRow
                    signature={tx.signature}
                    slot={tx.slot}
                    fee={tx.fee}
                    programIds={tx.programIds}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
