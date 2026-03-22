/**
 * 连接状态指示器
 * 通过小圆点颜色 + 文字标签展示 WebSocket 连接状态：
 * 绿色 = 已连接 | 黄色闪烁 = 连接中/重连中 | 红色 = 已断开
 */

"use client";

import { useTranslations } from "next-intl";
import { useConnectionStore } from "@/stores/connection-store";
import type { ConnectionStatus as ConnStatus } from "@/lib/types";

const STATUS_DOT: Record<ConnStatus, string> = {
  connected: "bg-long",
  connecting: "bg-yellow-500 animate-pulse",
  reconnecting: "bg-yellow-500 animate-pulse",
  disconnected: "bg-short",
};

const STATUS_KEY: Record<ConnStatus, string> = {
  connected: "live",
  connecting: "connecting",
  reconnecting: "reconnecting",
  disconnected: "offline",
};

export function ConnectionStatus() {
  const t = useTranslations("connection");
  const status = useConnectionStore((s) => s.status);
  const bookSyncState = useConnectionStore((s) => s.orderBookSyncState);

  const syncLabel =
    bookSyncState === "syncing"
      ? t("bookSyncing")
      : bookSyncState === "resyncing"
        ? t("bookResyncing")
        : null;
  const dotClass = syncLabel ? "bg-yellow-500 animate-pulse" : STATUS_DOT[status];

  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span className="text-xs text-muted-foreground">
        {syncLabel ?? t(STATUS_KEY[status])}
      </span>
    </div>
  );
}
