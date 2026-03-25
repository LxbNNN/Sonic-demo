---
name: sonic-code-review
description: 对 Sonic 交易 UI 的代码变更进行 Review，重点检查 Worker 通信协议、性能约束、Zustand 订阅粒度、React 渲染优化。当用户提交 PR、要求 review 代码改动、或要求检查性能问题时使用。
---

# Sonic 项目代码 Review

## Review 优先级

### 🔴 P0 — 必须修复（阻塞合并）

**Worker 通信协议破坏**
- `worker-messages.ts` 改了字段名但主线程接收侧没同步
- Worker 发送了主线程不认识的消息类型（静默失败，难以排查）

**主线程阻塞**
- 在 React 组件或主线程代码里做了排序、大数组过滤等密集计算
- `useEffect` 里有无限循环风险（依赖数组缺失）

**Zustand 全量订阅**
```typescript
// 🔴 必须修复：任何 store 字段变化都会触发此组件重渲染
const { bids, asks, midPrice } = useOrderBookStore()
```

**金融精度问题**
- 直接用 `+` / `-` 操作价格数字（浮点精度丢失）
- 没有用 `bignumber.js` 或 `priceKey()` 做价格 key 归一化

---

### 🟡 P1 — 建议修复（本次或下次）

**React 渲染优化缺失**
- 列表行组件缺少 `React.memo`
- 超过 20 行的列表没有 `useVirtualizer`
- `useCallback` / `useMemo` 的依赖数组不准确

**Zustand selector 可以更细粒度**
```typescript
// 🟡 可优化：同时订阅两个字段，任一变化都触发
const bids = useOrderBookStore(s => s.bids)
const asks = useOrderBookStore(s => s.asks)

// ✅ 如果只需要长度，更细
const bidCount = useOrderBookStore(s => s.bids.length)
```

**错误处理**
- Worker 内的 WebSocket 错误没有上报到 `connection-store`
- fetch 失败没有指数退避重试

**类型安全**
- 用了 `as any` 或 `@ts-ignore` 跳过类型检查

---

### 🟢 P2 — 可选优化（不阻塞）

- 注释过于冗余（解释"是什么"而非"为什么"）
- 变量命名不够语义化
- 可以用 `cn()` 合并的 className 字符串拼接
- `useTranslations` 里有硬编码文本

---

## 检查清单（针对高频变更区域）

### 改动了 Worker 相关代码
- [ ] `worker-messages.ts` 和 `market-service.ts` 的消息类型一致
- [ ] Worker 内新增计算逻辑，没有意外引用主线程全局变量（`window` / `document`）
- [ ] `postMessage` 频率不高于 rAF 节流频率（否则多余传输）

### 改动了订单簿逻辑
- [ ] `refPrice` 分区逻辑没有被破坏（bid < refPrice < ask 保证）
- [ ] `pendingDeletes` 延迟删除机制未被改为立即删除
- [ ] seq 校验逻辑的四个分支都有覆盖

### 改动了 React 组件
- [ ] 新组件用具名导出
- [ ] 高频更新的数据（订单簿、成交）通过 selector 订阅
- [ ] 动画 / 过渡效果用 CSS，不用 JS 定时器

### 改动了 REST/WebSocket 接口调用
- [ ] 与 `https://interviews-api.sonic.game/openapi.json` 接口文档一致
- [ ] 失败时有错误处理和用户提示

## 输出格式

Review 结论按以下格式输出：

```
## Code Review 结论

**总体评价**：[一句话总结]

### 🔴 必须修复
- [文件:行号] 问题描述 → 修改建议

### 🟡 建议优化
- [文件:行号] 问题描述 → 修改建议

### 🟢 可选
- [文件:行号] 问题描述 → 修改建议

### ✅ 做得好的地方
- [具体说明]
```
