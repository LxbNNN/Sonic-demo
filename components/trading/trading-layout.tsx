/**
 * 交易页面主布局
 *
 * 采用三栏布局：
 * - 左侧：订单簿（买卖盘）
 * - 中间：K线图 + Solana 交易流
 * - 右侧：下单面板 + 最近成交
 *
 * 顶部导航栏包含品牌标识、市场选择器、消息速率、语言切换和连接状态。
 * 在此顶层组件中调用 useMarketFeed() 启动 WebSocket 数据管道。
 */

"use client";

import { useTranslations } from "next-intl";
import { useMarketFeed } from "@/hooks/use-market-feed";
import { MarketSelector } from "./market-selector";
import { ConnectionStatus } from "./connection-status";
import { MessageRate } from "./message-rate";
import { LocaleSwitcher } from "./locale-switcher";
import { OrderBook } from "./order-book";
import { PriceChart } from "./price-chart";
import { OrderEntry } from "./order-entry";
import { TradeTape } from "./trade-tape";
import { TransactionFeed } from "./transaction-feed";

export function TradingLayout() {
  const t = useTranslations("header");
  // 启动市场行情数据管道（WebSocket + 引擎 + Store 刷新）
  useMarketFeed();

  return (
    <div className="flex flex-col h-screen overflow-hidden select-none">
      {/* 顶部导航栏 */}
      <header className="flex items-center justify-between h-12 px-4 border-b border-border bg-panel shrink-0">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-primary flex items-center justify-center">
              <span className="text-[10px] font-black text-primary-foreground leading-none">
                S
              </span>
            </div>
            <span className="text-sm font-semibold tracking-tight">
              {t("brand")}
            </span>
          </div>
          <div className="h-4 w-px bg-border" />
          <MarketSelector />
        </div>
        <div className="flex items-center gap-3">
          <MessageRate />
          <div className="h-4 w-px bg-border" />
          <LocaleSwitcher />
          <div className="h-4 w-px bg-border" />
          <ConnectionStatus />
        </div>
      </header>

      {/* 主体区域：三栏 Flex 布局 */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* 左栏：订单簿（固定 280px 宽，内容超出时滚动） */}
        <div className="w-[280px] shrink-0 border-r border-border overflow-y-auto">
          <OrderBook />
        </div>

        {/* 中栏：K线图（占 3/5）+ Solana 交易流（占 2/5） */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-[3] border-b border-border min-h-0">
            <PriceChart />
          </div>
          <div className="flex-[2] min-h-0">
            <TransactionFeed />
          </div>
        </div>

        {/* 右栏：下单面板 + 最近成交（固定 300px 宽） */}
        <div className="w-[300px] shrink-0 border-l border-border flex flex-col">
          <div className="shrink-0 border-b border-border">
            <OrderEntry />
          </div>
          <div className="flex-1 min-h-0">
            <TradeTape />
          </div>
        </div>
      </div>
    </div>
  );
}
