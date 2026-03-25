---
name: add-trading-feature
description: 为 Sonic 交易 UI 添加新功能。使用 Plan 模式规划，Agent 模式执行，覆盖 Worker 数据管道、Zustand Store、React 组件三层改动。当用户要添加新的交易功能、新的面板、新的 WebSocket 数据处理逻辑时使用。
---

# 添加新交易功能

## 执行前检查

先读以下文件，了解现有架构：
- `lib/worker-messages.ts` — 现有 Worker 消息类型
- `stores/` 目录 — 现有 Store 结构
- `components/trading/trading-layout.tsx` — 主布局入口

## 三层改动流程

### 第 1 层：数据层（Worker 管道）

如果新功能需要新数据（新 WebSocket 消息、新计算逻辑）：

1. 在 `lib/worker-messages.ts` 新增消息类型（主 → Worker 的命令、Worker → 主的事件）
2. 在 `lib/market.worker.ts` 添加数据处理逻辑
3. 在 `lib/enums.ts` 新增对应枚举值（如有）
4. **同步更新主线程接收侧** `lib/market-service.ts`

```typescript
// worker-messages.ts 新增示例
export type WorkerToMain =
  | { type: WorkerEvent.BookUpdate; data: PriceLevel[] }
  | { type: WorkerEvent.NewAlertTriggered; price: number; side: 'bid' | 'ask' } // 新增
```

### 第 2 层：状态层（Zustand Store）

如果新功能需要持久化状态：

1. 在 `stores/` 新建 `xxx-store.ts`，遵循现有 Store 结构：

```typescript
// 参考 connection-store.ts 的结构
import { create } from 'zustand'

interface XxxStore {
  // 数据字段
  // actions
  setXxx: (value: Xxx) => void
}

export const useXxxStore = create<XxxStore>((set) => ({
  // 初始值
  setXxx: (value) => set({ xxx: value }),
}))
```

2. 如果是对现有 Store 扩展，在对应文件末尾追加 slice，不要改现有字段

### 第 3 层：UI 层（React 组件）

1. 在 `components/trading/` 新建组件文件，文件名用 kebab-case
2. 组件使用具名导出（`export function XxxPanel`），不用 `default export`
3. 列表渲染超过 20 行时用 `useVirtualizer`
4. 行组件用 `React.memo` 包裹

```typescript
// ✅ 正确的组件结构
'use client'

import { useXxxStore } from '@/stores/xxx-store'

export function XxxPanel() {
  const data = useXxxStore(s => s.data)  // selector 精准订阅
  return <div>...</div>
}
```

5. 在 `trading-layout.tsx` 引入新组件，放入合适的网格区域

## 需要同步维护的文件

| 改了什么 | 必须同步更新 |
|---|---|
| 新增 Worker 消息类型 | `worker-messages.ts` + `market-service.ts` + `market.worker.ts` |
| 新增 Store | `trading-layout.tsx` 里挂载初始化逻辑（如需） |
| 新增 UI 文本 | `messages/en.json` + `messages/zh.json` |
| 新增常量 | `lib/constants.ts` |

## 验收清单

- [ ] Worker 侧和主线程侧消息类型一致
- [ ] 新 Store 使用 selector 订阅
- [ ] 列表组件有虚拟化和 memo
- [ ] 新增的 UI 文本有中英文翻译
- [ ] 运行 `bun run lint` 无报错
