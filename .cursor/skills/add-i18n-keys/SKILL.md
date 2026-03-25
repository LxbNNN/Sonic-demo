---
name: add-i18n-keys
description: 为 Sonic 交易 UI 添加中英文国际化翻译 key。当用户需要新增 UI 文本、补全缺失翻译、或批量同步 en/zh 两份翻译文件时使用。
---

# 添加 i18n 翻译 Key

## 文件位置

```
messages/
├── en.json   ← 英文（基准文件，以此为准）
└── zh.json   ← 中文（与 en.json 结构必须完全一致）
```

## 使用方式（组件内）

```typescript
import { useTranslations } from 'next-intl'

export function MyComponent() {
  const t = useTranslations('ComponentNamespace')
  return <span>{t('keyName')}</span>
}
```

## 添加新 Key 的步骤

1. **确定命名空间**：查看 `en.json` 现有的顶层 key，新功能优先复用已有命名空间；确实是全新功能才新建命名空间

2. **同时更新两个文件**，结构保持完全一致：

```json
// en.json
{
  "OrderBook": {
    "title": "Order Book",
    "newKey": "New English Text"   // 新增
  }
}

// zh.json
{
  "OrderBook": {
    "title": "订单簿",
    "newKey": "新中文文本"          // 同步新增
  }
}
```

3. **Key 命名规范**：
   - 用 camelCase（`bidPrice`，不是 `bid_price` 或 `BidPrice`）
   - 语义化，不用 `text1` / `label2`
   - 按钮文本加前缀 `btn`（如 `btnCancel`）
   - 状态文本加前缀 `status`（如 `statusConnecting`）

## 批量补全缺失翻译

如果 `zh.json` 缺少某些 `en.json` 中有的 key，执行步骤：

1. 读取 `en.json` 全部内容
2. 读取 `zh.json` 全部内容
3. 找出 `en.json` 中有但 `zh.json` 中没有的 key
4. 为每个缺失 key 补充中文翻译，插入到 `zh.json` 对应位置

## 翻译质量要求

| 场景 | 要求 |
|---|---|
| 金融术语 | 使用行业标准译法（如 "Bid/Ask" → "买价/卖价"，"Spread" → "价差"） |
| 状态文本 | 简洁，与英文字符数接近（移动端布局不撑破） |
| 按钮文本 | 动词开头（"取消"、"确认"、"提交"） |
| 数字/单位 | 保留英文（如 "msg/s"、"SOL" 不翻译） |

## 验收

- [ ] `en.json` 和 `zh.json` 的 JSON 结构完全一致（相同的嵌套层级和 key 名）
- [ ] 所有新 key 在组件里通过 `useTranslations` 调用，无硬编码中文/英文字符串
- [ ] `bun run lint` 无报错
