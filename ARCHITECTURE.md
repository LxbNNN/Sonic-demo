# Sonic Perpetual Trading UI — 项目架构文档

## 一、项目概述

基于 Next.js (App Router) + TypeScript + shadcn/ui 构建的实时永续合约交易界面，通过 WebSocket 连接 Sonic Market Feed Service (SMFS) 后端，处理高频订单簿和交易数据更新。

**技术栈：**

| 类别 | 选型 | 说明 |
|------|------|------|
| 框架 | Next.js (App Router) | SSR/SSG 支持，Vercel 原生部署 |
| 语言 | TypeScript (strict) | 全量严格类型 |
| UI 框架 | shadcn/ui + Tailwind CSS | 可定制、高性能组件库 |
| 状态管理 | Zustand | 轻量级、支持细粒度订阅，避免不必要的重渲染 |
| 图表 | Lightweight Charts (TradingView) | 专业级金融图表，性能优异 |
| 虚拟列表 | @tanstack/react-virtual | 高性能虚拟滚动 |
| 测试 | Vitest + React Testing Library | 快速、与 Vite 兼容 |
| CI/CD | GitHub Actions + Vercel | 自动化 lint/build/test + 部署 |

---

## 二、目录结构

```
my-next/
├── .github/
│   └── workflows/
│       └── ci.yml                        # GitHub Actions: lint → build → test
├── public/
│   └── favicon.ico
├── src/
│   ├── app/                              # Next.js App Router
│   │   ├── layout.tsx                    # 根布局 (字体、主题 Provider)
│   │   ├── page.tsx                      # 主交易页面 (组合各组件)
│   │   └── globals.css                   # Tailwind 全局样式 + shadcn/ui 主题变量
│   │
│   ├── components/
│   │   ├── ui/                           # shadcn/ui 基础组件
│   │   │   ├── button.tsx
│   │   │   ├── input.tsx
│   │   │   ├── select.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── card.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── separator.tsx
│   │   │   └── tooltip.tsx
│   │   │
│   │   ├── trading/                      # 交易业务组件
│   │   │   ├── market-selector.tsx       # 市场切换 (BTC-PERP / SOL-PERP)
│   │   │   ├── order-book.tsx            # 订单簿 (虚拟化列表渲染)
│   │   │   ├── order-book-row.tsx        # 订单簿行 (React.memo 优化)
│   │   │   ├── trade-tape.tsx            # 最近成交流 (虚拟化 + 流式更新)
│   │   │   ├── trade-row.tsx             # 成交行 (React.memo 优化)
│   │   │   ├── order-entry.tsx           # 下单面板 (mock POST /orders)
│   │   │   ├── price-chart.tsx           # K线图 (Lightweight Charts)
│   │   │   ├── connection-status.tsx     # 连接状态指示器
│   │   │   ├── message-rate.tsx          # 消息速率显示
│   │   │   └── transaction-feed.tsx      # [Bonus] Solana 交易流
│   │   │
│   │   └── layout/
│   │       └── trading-layout.tsx        # 交易页面网格布局
│   │
│   ├── hooks/                            # 自定义 Hooks
│   │   ├── use-websocket.ts              # WebSocket 连接管理 (重连/心跳)
│   │   ├── use-order-book.ts             # 订单簿数据消费 (从 store 细粒度订阅)
│   │   ├── use-trades.ts                 # 成交数据消费
│   │   ├── use-candles.ts                # K线数据获取
│   │   ├── use-message-rate.ts           # 消息速率统计
│   │   └── use-throttled-updates.ts      # 通用节流更新 Hook
│   │
│   ├── stores/                           # Zustand 状态仓库
│   │   ├── market-store.ts               # 当前市场选择
│   │   ├── order-book-store.ts           # 订单簿状态 (bids/asks 排序树)
│   │   ├── trade-store.ts                # 最近成交列表
│   │   ├── connection-store.ts           # 连接状态 + 消息速率计数
│   │   └── order-store.ts               # 下单表单状态
│   │
│   ├── lib/                              # 核心库 / 工具
│   │   ├── smfs-client.ts                # REST API 客户端 (类型安全)
│   │   ├── websocket-manager.ts          # WebSocket 管理器 (重连 + 指数退避)
│   │   ├── order-book-engine.ts          # 订单簿引擎 (delta 应用 + seq 校验)
│   │   ├── types.ts                      # 全局类型定义 (从 OpenAPI 生成)
│   │   ├── constants.ts                  # 常量 (API URL、WS URL、间隔时间等)
│   │   └── utils.ts                      # 工具函数 (格式化价格/数量等)
│   │
│   └── __tests__/                        # 测试
│       ├── lib/
│       │   ├── order-book-engine.test.ts # 订单簿引擎单元测试
│       │   └── websocket-manager.test.ts # WebSocket 管理器测试
│       └── components/
│           ├── order-book.test.tsx        # 订单簿组件测试
│           └── order-entry.test.tsx       # 下单面板测试
│
├── .env.local                            # 环境变量
├── components.json                       # shadcn/ui 配置
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md                             # 包含架构说明、性能决策、扩展策略等
```

---

## 三、核心架构设计

### 3.1 数据流架构

```
┌─────────────────────────────────────────────────────────┐
│                      SMFS Backend                       │
│  REST: interviews-api.sonic.game                        │
│  WS:   wss://interviews-api.sonic.game/ws/market        │
└──────────┬──────────────────────────────┬───────────────┘
           │ REST (初始化)                │ WebSocket (实时)
           ▼                              ▼
┌──────────────────┐         ┌───────────────────────────┐
│  smfs-client.ts  │         │  websocket-manager.ts     │
│  (API 客户端)     │         │  - 自动重连 (指数退避)      │
│  - /markets      │         │  - ping/pong 心跳          │
│  - /snapshot     │         │  - seq 序列号校验           │
│  - /candles      │         │  - 消息分发                │
│  - /orders       │         └──────────┬────────────────┘
└──────────────────┘                    │
                                        │ 消息分发
                              ┌─────────┴─────────┐
                              ▼                   ▼
                   ┌──────────────────┐ ┌─────────────────┐
                   │ order-book-engine│ │  trade-store     │
                   │ (delta 应用)     │ │  (追加成交)       │
                   └────────┬─────────┘ └────────┬────────┘
                            │                    │
                            ▼                    ▼
                   ┌──────────────────┐ ┌─────────────────┐
                   │ order-book-store │ │  trade-store     │
                   │ (Zustand)        │ │  (Zustand)       │
                   └────────┬─────────┘ └────────┬────────┘
                            │                    │
                   节流批量更新 (requestAnimationFrame)
                            │                    │
                            ▼                    ▼
                   ┌──────────────────┐ ┌─────────────────┐
                   │  OrderBook 组件   │ │  TradeTape 组件  │
                   │  (虚拟化列表)     │ │  (虚拟化列表)     │
                   │  (memo 行渲染)    │ │  (memo 行渲染)    │
                   └──────────────────┘ └─────────────────┘
```

### 3.2 WebSocket 生命周期

```
[初始化] ──→ [连接中] ──→ [已连接] ──→ [接收数据]
                │              │            │
                │              │     检测到 seq gap
                │              │            │
                │              │            ▼
                │              │     [重新获取 snapshot]
                │              │            │
                │              ▼            ▼
                │         [断开连接] ──→ [重连中]
                │              │            │
                │              │     指数退避等待
                │              │     (1s → 2s → 4s → 8s → 16s → 30s max)
                │              │            │
                └──────────────┴────────────┘
```

### 3.3 状态管理策略

使用 **Zustand** 并利用其 selector 机制实现细粒度订阅：

| Store | 职责 | 更新频率 | 优化策略 |
|-------|------|----------|----------|
| `market-store` | 当前选择的市场 | 极低 (用户操作) | 切换时重置其他 store |
| `order-book-store` | bids/asks 价格档位 | 20-50/sec (原始) → 节流至 ~16ms | RAF 批量更新，浅比较 |
| `trade-store` | 最近 N 条成交 | 5-20/sec | 追加队列，固定长度 |
| `connection-store` | 连接状态 + 消息计数 | 状态变化时 | - |
| `order-store` | 下单表单数据 | 用户输入时 | - |

---

## 四、性能优化方案 (满足 ≥3 项技术要求)

### ✅ 1. 虚拟化列表渲染 (Virtualized List)

- 使用 `@tanstack/react-virtual` 对订单簿和成交流实现虚拟滚动
- 订单簿通常有上百个价格档位，只渲染可视区域内的 20-30 行
- 成交列表保留最近 200 条，但只渲染可见部分

### ✅ 2. 批量状态更新 (Batched Updates)

- WebSocket 消息先在引擎层累积，通过 `requestAnimationFrame` 批量写入 store
- 确保渲染频率不超过 60fps (~16ms 间隔)
- 避免每条消息都触发 React 重渲染

### ✅ 3. 细粒度状态订阅 (Granular Subscriptions)

- Zustand selector 确保组件只在自身关心的数据变化时重渲染
- 例：`OrderBook` 只订阅 `bids` 和 `asks`，不关心 `trades`
- 例：`ConnectionStatus` 只订阅 `status` 字段

### ✅ 4. Memoized 行渲染

- `OrderBookRow` 和 `TradeRow` 使用 `React.memo` + 自定义比较函数
- 价格和数量格式化使用 `useMemo` 缓存

### ✅ 5. WebSocket 重连 + 指数退避

- 断线自动重连，退避间隔：1s → 2s → 4s → 8s → 16s → 30s (上限)
- 重连成功后重新获取 snapshot 恢复状态

### ✅ 6. Snapshot 重置 (Seq Gap 检测)

- 每条 `book_delta` 携带 `seq`，维护本地 `lastSeq`
- 检测到跳跃时立即调用 `/markets/:marketId/snapshot` 重建订单簿

### ✅ 7. Ping/Pong 心跳

- 每 20 秒发送 `{ "type": "ping" }`
- 超时未收到 pong 视为连接异常，触发重连

---

## 五、订单簿引擎设计 (`order-book-engine.ts`)

```
初始化:
  1. GET /markets/:marketId/snapshot → 获取完整订单簿
  2. 以 snapshot 的 bids/asks 构建本地排序 Map
  3. 记录 snapshot 的 seq 作为 lastSeq

增量更新 (book_delta):
  1. 校验 delta.seq === lastSeq + 1
     - 若不等 → 触发 snapshot 重置
  2. 遍历 delta.bids:
     - size > 0 → 插入/更新价格档位
     - size === 0 → 删除该价格档位
  3. 遍历 delta.asks: 同上逻辑
  4. lastSeq = delta.seq
  5. 将更新推入批量队列 (等待 RAF flush)

数据结构:
  - bids: Map<price, size> (降序展示)
  - asks: Map<price, size> (升序展示)
  - 展示时取 top N 档位 (如 20 档)
```

---

## 六、组件设计

### 6.1 页面布局 (CSS Grid)

```
┌──────────────────────────────────────────────────────────────┐
│  [Market Selector]  [Connection Status]  [Message Rate]      │
├──────────────┬──────────────────────┬────────────────────────┤
│              │                      │                        │
│  Order Book  │    Price Chart       │    Order Entry         │
│  (Bids/Asks) │    (K线图)           │    (下单面板)           │
│              │                      │                        │
│              │                      ├────────────────────────┤
│              │                      │                        │
│              │                      │    Trade Tape          │
│              │                      │    (最近成交)           │
│              │                      │                        │
├──────────────┴──────────────────────┴────────────────────────┤
│  [Bonus] Solana Transaction Feed                             │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 组件与 shadcn/ui 映射

| 业务组件 | 使用的 shadcn/ui 组件 | 说明 |
|----------|----------------------|------|
| MarketSelector | `Select`, `Badge` | 下拉切换市场，Badge 显示当前价格 |
| OrderBook | `Card`, `Separator` | Card 容器，自定义虚拟列表 |
| TradeTape | `Card`, `Badge` | Badge 标记 buy/sell 方向 |
| OrderEntry | `Card`, `Input`, `Button`, `Tabs`, `Select` | Tabs 切换 Limit/Market，Input 输入价格/数量 |
| ConnectionStatus | `Badge`, `Tooltip` | 红/黄/绿状态点 + Tooltip 详情 |
| MessageRate | `Badge` | 实时显示 msg/sec |
| PriceChart | `Card`, `Tabs` | Tabs 切换时间间隔 (1s/1m/5m/15m) |

---

## 七、API 客户端设计 (`smfs-client.ts`)

```typescript
const BASE_URL = "https://interviews-api.sonic.game";
const WS_URL = "wss://interviews-api.sonic.game/ws/market";

// 类型从 /openapi.json 生成
interface SMFSClient {
  getHealth(): Promise<HealthResponse>;
  getMarkets(): Promise<Market[]>;
  getSnapshot(marketId: string): Promise<OrderBookSnapshot>;
  getCandles(marketId: string, opts?: CandleParams): Promise<Candle[]>;
  submitOrder(order: OrderRequest): Promise<OrderResponse>;
  getStats(): Promise<Stats>;
}
```

---

## 八、关键类型定义 (`types.ts`)

```typescript
type MarketId = "BTC-PERP" | "SOL-PERP";
type Side = "buy" | "sell";
type CandleInterval = "1s" | "1m" | "5m" | "15m";
type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

interface PriceLevel {
  price: number;
  size: number;
}

interface BookDelta {
  type: "book_delta";
  marketId: MarketId;
  seq: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  ts: number;
}

interface Trade {
  type: "trade";
  marketId: MarketId;
  tradeId: string;
  price: number;
  size: number;
  side: Side;
  ts: number;
  seq: number;
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ts: number;
}

interface OrderRequest {
  marketId: MarketId;
  side: Side;
  type: "limit" | "market";
  price?: number;
  size: number;
}
```

---

## 九、CI/CD 流水线

### GitHub Actions (`ci.yml`)

```yaml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm build
      - run: pnpm test
```

### Vercel 部署

- 连接 GitHub 仓库，push 到 main 自动部署
- 环境变量通过 Vercel Dashboard 配置

---

## 十、依赖清单

```json
{
  "dependencies": {
    "next": "latest",
    "react": "^19",
    "react-dom": "^19",
    "zustand": "^5",
    "lightweight-charts": "^4",
    "@tanstack/react-virtual": "^3",
    "class-variance-authority": "^0.7",
    "clsx": "^2",
    "tailwind-merge": "^2",
    "lucide-react": "latest"
  },
  "devDependencies": {
    "typescript": "^5",
    "tailwindcss": "^4",
    "@types/react": "^19",
    "eslint": "^9",
    "vitest": "^3",
    "@testing-library/react": "^16",
    "jsdom": "^26"
  }
}
```

---

## 十一、扩展策略 (10x 负载场景)

| 瓶颈 | 当前策略 | 10x 扩展方案 |
|------|----------|-------------|
| 消息处理频率 | RAF 批量更新 | Web Worker 中处理 delta 运算，主线程仅接收渲染数据 |
| 订单簿渲染 | 虚拟列表 20 档 | 减少可见档位 + 降低更新频率至 30fps |
| 内存占用 | 固定长度队列 | SharedArrayBuffer 减少序列化开销 |
| WebSocket 压力 | 单连接 | 服务端支持 delta 压缩 (如 protobuf) |
| 图表渲染 | Lightweight Charts | Canvas 降采样，仅更新最新 K 线 |

---

## 十二、权衡取舍 (Tradeoffs)

| 决策 | 选择 | 原因 | 代价 |
|------|------|------|------|
| 状态管理 | Zustand vs Redux | Zustand 更轻量、selector 天然细粒度 | 生态不如 Redux 庞大 |
| 图表库 | Lightweight Charts vs Recharts | 金融级性能、Canvas 渲染 | 定制化需要更多工作 |
| 虚拟列表 | @tanstack/react-virtual vs react-window | 更现代的 API、headless 设计 | 需要自行处理样式 |
| 订单簿结构 | Map vs 排序数组 | Map O(1) 查找/更新 | 展示时需排序 (但只取 top N) |
| 节流策略 | RAF vs 固定 interval | RAF 与浏览器渲染周期同步 | 不同刷新率设备表现不同 |
| 框架 | Next.js vs Vite SPA | Vercel 部署零配置、SSR 支持 | 对纯 SPA 场景略重 |
