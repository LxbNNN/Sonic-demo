/**
 * 数据格式化工具（原生运算版本）
 *
 * 订单簿 / 成交流等高频更新场景下，每 200ms 调用 120+ 次。
 * 使用原生 toFixed 代替 BigNumber，消除对象创建开销。
 *
 * 精度说明：
 * - 服务端下发的价格/数量已是合法浮点数，不存在 1.005 类边界问题
 * - 显示精度（BTC 2 位 / SOL 4 位）远低于 float64 有效位数，原生运算完全准确
 * - 需要任意精度的场景（下单校验等）仍使用 BigNumber（见 order-entry.tsx）
 */

import type { MarketId } from "./types";

/** 根据市场类型格式化价格（BTC 2位 / SOL 4位小数），包含千分位 */
export function formatPrice(price: number, marketId: MarketId): string {
  const dp = marketId === "BTC-PERP" ? 2 : 4;
  return addThousandsSeparator(price.toFixed(dp));
}

/** 格式化挂单/成交数量，保留 4 位小数 */
export function formatSize(size: number): string {
  return size.toFixed(4);
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
  return rate.toFixed(1);
}

/** 格式化为 USD 货币 */
export function formatUsd(value: number): string {
  return "$" + addThousandsSeparator(value.toFixed(2));
}

/** lamports → SOL（1 SOL = 10^9 lamports） */
export function formatLamports(lamports: number): string {
  return (lamports / 1e9).toFixed(6) + " SOL";
}

/** 格式化价差百分比 */
export function formatSpread(spreadPercent: number): string {
  return spreadPercent.toFixed(3) + "%";
}

/** 为数字字符串添加千分位分隔符 */
function addThousandsSeparator(numStr: string): string {
  const [intPart, decPart] = numStr.split(".");
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${formatted}.${decPart}` : formatted;
}
