/**
 * BigNumber 工具模块
 *
 * 统一封装 bignumber.js 的配置和常用操作，
 * 避免原生浮点运算导致的精度丢失问题（如 70668.9 vs 70668.90000000001）。
 * 所有涉及价格、数量、金额的计算均应通过此模块进行。
 */

import BigNumber from "bignumber.js";

BigNumber.config({
  DECIMAL_PLACES: 20,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

export { BigNumber };

/** 便捷构造函数 */
export function BN(value: BigNumber.Value): BigNumber {
  return new BigNumber(value);
}

/** 将价格归一化为 Map key 字符串（消除浮点噪声） */
export function priceKey(price: BigNumber.Value): string {
  return new BigNumber(price).toFixed(10);
}

export const ZERO = new BigNumber(0);
export const TWO = new BigNumber(2);
export const HUNDRED = new BigNumber(100);
