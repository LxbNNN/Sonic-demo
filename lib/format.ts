/**
 * 数据格式化工具（BigNumber 版本）
 *
 * 所有数值格式化通过 BigNumber 进行，避免 toFixed() 的浮点陷阱。
 * 例如 (1.005).toFixed(2) 在原生 JS 中返回 "1.00"，BigNumber 返回 "1.01"。
 */

import { BN } from "./bn";
import type { MarketId } from "./types";

/** 根据市场类型格式化价格（BTC 2位 / SOL 4位小数），包含千分位 */
export function formatPrice(price: number, marketId: MarketId): string {
  const dp = marketId === "BTC-PERP" ? 2 : 4;
  return addThousandsSeparator(BN(price).toFixed(dp));
}

/** 格式化挂单/成交数量，保留 4 位小数 */
export function formatSize(size: number): string {
  return BN(size).toFixed(4);
}

/** 毫秒时间戳 → HH:MM:SS 格式 */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 格式化消息速率，保留 1 位小数 */
export function formatRate(rate: number): string {
  return BN(rate).toFixed(1);
}

/** 格式化为 USD 货币 */
export function formatUsd(value: number): string {
  return "$" + addThousandsSeparator(BN(value).toFixed(2));
}

/** lamports → SOL（1 SOL = 10^9 lamports） */
export function formatLamports(lamports: number): string {
  return BN(lamports).div(1e9).toFixed(6) + " SOL";
}

/** 格式化价差百分比 */
export function formatSpread(spreadPercent: number): string {
  return BN(spreadPercent).toFixed(3) + "%";
}

/** 为数字字符串添加千分位分隔符 */
function addThousandsSeparator(numStr: string): string {
  const [intPart, decPart] = numStr.split(".");
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${formatted}.${decPart}` : formatted;
}
