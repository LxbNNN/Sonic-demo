# Sonic Perpetual Trading UI

基于 Next.js 16 (App Router) + TypeScript + shadcn/ui 构建的实时永续合约交易界面，通过 WebSocket 连接 Sonic Market Feed Service (SMFS) 后端，在每秒 20–50 条订单簿更新和 5–20 条成交消息的高频场景下保持 UI 流畅无卡顿。

- **API 文档：** https://interviews-api.sonic.game/docs
- **OpenAPI 规范：** https://interviews-api.sonic.game/openapi.json
- **支持市场：** BTC-PERP / SOL-PERP（双市场实时切换）

---

## Getting Started

```bash
# 安装依赖
bun install

# 启动开发服务器
bun dev
```

访问 [http://localhost:3000](http://localhost:3000) 查看应用。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXT_PUBLIC_API_URL` | `https://interviews-api.sonic.game` | SMFS REST API 地址 |
| `NEXT_PUBLIC_WS_MARKET_URL` | `wss://interviews-api.sonic.game/ws` | 市场行情 WebSocket |
| `NEXT_PUBLIC_WS_STREAM_URL` | `wss://interviews-api.sonic.game/ws/stream` | Solana 交易流 WebSocket |

### 可用命令

| 命令 | 说明 |
|------|------|
| `bun dev` | 启动开发服务器 (Next.js HMR) |
| `bun run build` | 生产构建 |
| `bun start` | 启动生产服务器 |
| `bun run lint` | ESLint 代码检查 |

---

## 架构说明

### 技术栈

| 类别 | 选型 | 版本 | 选择理由 |
|------|------|------|----------|
| 框架 | Next.js (App Router) | 16.2 | Vercel 原生部署零配置，支持 SSR/RSC |
| 语言 | TypeScript (strict) | ^5 | 全量严格类型，消息体联合类型保证类型安全 |
| UI 框架 | shadcn/ui + Tailwind CSS | v4 | 可定制、零运行时开销，暗色主题开箱即用 |
| 状态管理 | Zustand | ^5 | 轻量（<1KB），selector 天然支持细粒度订阅 |
| 图表 | Lightweight Charts | ^5 | TradingView 金融级 Canvas 图表，GPU 加速 |
| 虚拟列表 | @tanstack/react-virtual | ^3 | Headless 虚拟化，灵活控制 DOM 结构 |
| 精度计算 | bignumber.js | ^10 | 消除浮点精度问题（如 70668.9 vs 70668.90000000001） |
| 事件总线 | mitt | ^3 | 极轻量的类型安全事件发射器，用于模块间解耦通信 |
| 国际化 | next-intl | ^4 | 基于 cookie 的语言切换（en / zh），Server Component 兼容 |
| 包管理 | Bun | latest | 安装速度快，CI 构建时间更短 |
| CI/CD | GitHub Actions + Vercel | - | push/PR 自动触发 lint → build 流水线 |

### 数据流架构（Worker 模式）

```
┌──────────────────────────────────────────────────────────────────┐
│                       SMFS Backend                               │
│  REST:   https://interviews-api.sonic.game                       │
│  WS:     wss://interviews-api.sonic.game/ws?marketId=BTC-PERP    │
│  Stream: wss://interviews-api.sonic.game/ws/stream               │
└──────────┬─────────────────────────────────────┬─────────────────┘
           │                                     │
     REST API (初始化)                     WebSocket (实时流)
     smfs-client.ts                      websocket-manager.ts
     • /snapshot                          • 自动重连 (指数退避)
     • /candles                           • ping/pong 心跳 (20s)
     • /orders                            • offline/online 事件监听
           │                                     │
           └───────────────┬─────────────────────┘
                           │
              ┌────────────▼────────────┐
              │   Web Worker 线程        │  ← market.worker.ts
              │   (主线程零计算开销)      │
              │                         │
              │   WebSocketManager      │  WebSocket 连接 & 心跳
              │         │               │
              │    消息分发 (type)       │
              │   ┌──────┼──────┐       │
              │   ▼      ▼      ▼       │
              │  book   trade  reset    │
              │  delta                  │
              │   │      │      │       │
              │   ▼      │      │       │
              │  OrderBookManager       │  参考价分区 + EMA + seq 校验
              │   │      │      │       │
              │   ▼      ▼      ▼       │
              │  flush   成交   快照     │
              │  (rAF    聚合   重拉     │
              │   节流)                  │
              └────────────┬────────────┘
                           │
                    postMessage()
               (预计算的 PriceLevel[])
                           │
              ┌────────────▼────────────┐
              │     主线程               │
              │                         │
              │  MarketService 单例     │  ← 接收 Worker 快照
              │   │                     │     写入 Zustand Store
              │   ▼                     │
              │  Zustand Stores         │  order-book / trade /
              │   │                     │  connection
              │   ▼                     │
              │  React UI 组件          │
              │   OrderBook (DOM 直写)  │
              │   TradeTape (虚拟化)    │
              │   PriceChart (Canvas)   │
              │   OrderEntry            │
              │   ConnectionStatus      │
              │   TransactionFeed       │
              └─────────────────────────┘
```

**降级路径：** 当浏览器不支持 Web Worker 或 Worker 加载失败时，`MarketService` 自动回退到主线程模式（`MainThreadMarketService`），逻辑与 Worker 对称，保证功能完整。

### 目录结构

```
├── .github/workflows/ci.yml         # GitHub Actions: lint → build
├── app/
│   ├── layout.tsx                    # 根布局（Geist 字体、next-intl Provider、暗色主题）
│   ├── page.tsx                      # 入口，渲染 TradingLayout
│   └── globals.css                   # Tailwind 4 + shadcn/ui 主题变量 + 交易语义色
├── components/
│   ├── ui/                           # shadcn/ui 基础组件
│   │   └── button / input / select / badge / card / tabs / separator / tooltip
│   └── trading/                      # 交易业务组件（13 个）
│       ├── trading-layout.tsx        # 三栏主布局 + 顶部导航，挂载 useMarketFeed
│       ├── market-selector.tsx       # 市场切换（悬停下拉 + 实时价格/价差/速率）
│       ├── order-book.tsx            # 订单簿（高性能 DOM 直写 + store 订阅）
│       ├── order-book-row.tsx        # 订单簿行（React.memo + 双层深度条）
│       ├── tick-size-selector.tsx    # 价格聚合粒度选择器（OKX 风格）
│       ├── trade-tape.tsx            # 成交流（虚拟化列表 + raw/readable 切换）
│       ├── trade-row.tsx             # 成交行（React.memo + 闪烁动画）
│       ├── order-entry.tsx           # 下单面板（限价/市价 + BigNumber 精度验证）
│       ├── price-chart.tsx           # K线图（4 个时间间隔 + 实时 tick 更新）
│       ├── connection-status.tsx     # 连接状态（绿/黄/红圆点 + 同步状态文字）
│       ├── message-rate.tsx          # 消息吞吐率（msg/s）
│       ├── locale-switcher.tsx       # 语言切换（en/zh）
│       └── transaction-feed.tsx      # [Bonus] Solana 交易流
├── hooks/
│   ├── use-market-feed.ts            # React ↔ MarketService 桥接（监听 marketId 切换）
│   └── use-solana-stream.ts          # Solana 交易流连接 + 本地 Store
├── stores/
│   ├── market-store.ts               # 当前市场选择（BTC-PERP / SOL-PERP）
│   ├── order-book-store.ts           # 订单簿（bids/asks + 预计算 mid/spread/cum）
│   ├── trade-store.ts                # 最近成交（固定 200 条 + displayMode）
│   └── connection-store.ts           # 连接状态 + 同步状态 + 消息速率
├── lib/
│   ├── market-service.ts             # 数据服务单例（Worker 优先 / 主线程降级双模式）
│   ├── market.worker.ts              # Web Worker：WS + 引擎 + 成交聚合（主线程零开销）
│   ├── order-book-engine.ts          # 订单簿引擎（参考价分区 + EMA + rAF 节流 flush）
│   ├── order-book-side.ts            # 单侧订单簿（Map 存储 + 延迟删除 + tick 聚合）
│   ├── websocket-manager.ts          # WebSocket 管理器（重连 + 心跳 + 网络事件）
│   ├── market-events.ts              # mitt 事件总线（模块间类型安全通信）
│   ├── smfs-client.ts                # REST API 类型安全客户端
│   ├── worker-messages.ts            # Worker ↔ 主线程消息协议定义
│   ├── enums.ts                      # WorkerCmd / WorkerEvent 枚举
│   ├── types.ts                      # 全局类型（REST 响应 + WS 消息联合类型）
│   ├── constants.ts                  # 配置常量（URL、深度、心跳参数等）
│   ├── bn.ts                         # BigNumber 工具（BN/priceKey/常量）
│   ├── format.ts                     # 数据格式化（热路径原生 toFixed + BigNumber 精确输出）
│   └── utils.ts                      # 通用工具（cn = clsx + tailwind-merge）
├── i18n/request.ts                   # next-intl 语言解析（cookie-based）
├── messages/
│   ├── en.json                       # 英文翻译
│   └── zh.json                       # 中文翻译
└── next.config.ts                    # Next.js + next-intl 插件
```

### 状态管理设计

4 个独立的 Zustand Store，各自职责清晰，通过 selector 实现细粒度订阅：

| Store | 数据 | 更新频率 | 订阅者 |
|-------|------|----------|--------|
| `market-store` | 当前 `marketId` | 极低（用户切换时） | 几乎所有组件（切换时重建整个数据管道） |
| `order-book-store` | `bids[]`, `asks[]`, `midPrice`, `spreadPercent`, `tickSize` | ~5fps（引擎 rAF 节流） | OrderBook, MarketSelector, OrderEntry |
| `trade-store` | `trades[]`（最近 200 条）, `displayMode` | 5–20 次/秒 | TradeTape, PriceChart |
| `connection-store` | `status`, `syncState`, `bookRate`, `tradeRate` | 1 次/秒（速率）+ 状态变化时 | ConnectionStatus, MessageRate, MarketSelector |

### Worker 双模式架构

```
MarketService.switchMarket(marketId)
    │
    ├─ Worker 可用？── 是 ──→ startWorker()
    │                           │
    │                    market.worker.ts 线程:
    │                    ├── WebSocketManager (WS 连接)
    │                    ├── OrderBookManager (引擎)
    │                    ├── 成交聚合 (readable/raw)
    │                    ├── 速率统计
    │                    └── postMessage → 主线程 Store
    │
    └─ Worker 不可用？─→ startMainThread()
                           │
                    MainThreadMarketService:
                    ├── WebSocketManager (WS 连接)
                    ├── OrderBookManager (引擎)
                    ├── mitt 事件总线分发
                    ├── 成交批处理 + 聚合
                    └── 直接写入 Zustand Store
```

**通信协议（`worker-messages.ts`）：**

| 方向 | 类型 | 说明 |
|------|------|------|
| 主线程 → Worker | `SwitchMarket` | 携带 marketId、tickSize、depth、flushInterval |
| 主线程 → Worker | `SetTickSize` | 动态修改聚合粒度 |
| 主线程 → Worker | `SetTradeDisplayMode` | 切换 raw/readable |
| 主线程 → Worker | `Stop` | 终止所有任务 |
| Worker → 主线程 | `BookUpdate` | 预计算的 `PriceLevel[]`（bids + asks） |
| Worker → 主线程 | `TradeUpdate` | 聚合后完整成交列表 |
| Worker → 主线程 | `ConnectionStatus` | WS 连接状态 |
| Worker → 主线程 | `SyncState` | 订单簿同步状态 |
| Worker → 主线程 | `Rates` | 每秒消息吞吐统计 |

### 订单簿同步协议

**核心架构：参考价分区（Reference-Price Partitioning）**

与传统的"剪枝式"订单簿不同，本项目采用 **EMA 参考价分区** 解决 bid/ask 交叉问题：

```
传统方案（剪枝式）：
  bid delta 价格 X → 删除 askMap 中 < X 的条目
  问题：部分成交/延迟导致误删 → 列表数量闪烁

本项目方案（参考价分区）：
  1. Map 忠实存储服务端数据，仅 size=0 标记延迟删除
  2. 维护 EMA 参考价 refPrice，实时跟踪市场中枢
  3. 显示时用 refPrice 分区：bid 取 price < refPrice，ask 取 price > refPrice
  4. 结构性保证 bid < refPrice < ask，不可能交叉
```

**flush 显示逻辑：**
1. 用 `refPrice` 过滤 bid → 得到 `bestBid`（真实最优买价）
2. 用 `bestBid` 作为 ask 的边界 → 边界由实际数据决定，不随 EMA 波动
3. 如 bid 不足 depth，用 `bestAsk` 扩展 bid 边界
4. 结构性保证：`bids < bestAsk ≤ asks`

**状态机：** `init → syncing → live → resyncing`

**seq 校验逻辑：**
- `msg.seq <= lastSeq` 且差距小 → 正常去重，丢弃
- `msg.seq <= lastSeq` 且差距大（倒跳） → 服务端 seq 重置，清空锚点 + 快照修正
- `msg.seq > lastSeq` 且 gap 小（≤ 20） → 容忍并应用
- `msg.seq > lastSeq` 且 gap 大（> 20） → 触发快照修正
- `lastSeq = -1`（未锚定） → 直接应用

**快照策略：**
- 快照仅在必要时拉取：初始加载 / WS 重连 / 大 seq 缺口 / 服务端 reset
- 失败后指数退避重试（2s → 4s → 8s → ... → 30s 上限）
- 超时保护（10s 超时 + 15s isFetching 卡死保护）

**`OrderBookSide` 延迟删除机制：**
- `size=0` 不立即从 Map 删除，而是加入 `pendingDeletes` 集合
- 保证边界附近数据稀疏时 `top()` 仍返回足够行数
- 同价位新数据到来时自动取消待删标记
- 待删积累超过 200 条时批量执行物理删除

### 成交流可读模式

- 两种展示模式：
  - `readable`（默认）：`TRADE_AGG_WINDOW_MS`（150ms）短窗内同价同方向聚合
  - `raw`：逐条原始成交展示
- 单次推送条数受 `TRADE_BATCH_MAX_ITEMS`（40 条）限制，降低高频时的视觉抖动
- 新成交高亮动画 700ms，便于肉眼追踪

### WebSocket 生命周期

```
     ┌────────── 用户切换市场 / 组件挂载 ──────────┐
     ▼                                              │
[创建 WebSocketManager] ──→ [connecting]            │
     │                                              │
     ▼  ws.onopen                                   │
[connected] ──→ 拉取 REST snapshot 初始化引擎        │
     │          启动 ping 定时器 (每 20s)             │
     │          启动 rAF flush 循环                   │
     │          启动 1s 速率统计定时器                 │
     │                                              │
     │  ws.onmessage                                │
     ├──→ book_delta: seq 校验 → applyDelta → 更新 EMA refPrice
     ├──→ trade:      缓冲 → 批量聚合 → postMessage   │
     ├──→ reset:      重新拉取 snapshot              │
     ├──→ pong:       清除 pong 超时定时器            │
     │                                              │
     │  seq 跳跃检测                                 │
     ├──→ gap > SEQ_GAP_TOLERANCE → 重新拉取 snapshot│
     │                                              │
     │  心跳超时 / ws.onclose / ws.onerror           │
     ▼                                              │
[reconnecting] ──→ 指数退避等待                      │
     │              1s → 2s → 4s → 8s → 16s → 30s (上限)
     │                                              │
     └──────────── 重连成功回到 [connected] ─────────┘

额外：监听 window offline → 立即断连
      监听 window online  → 立即重连（重置退避计数）
```

---

## 性能决策

### 1. Web Worker 离线计算

默认将 WebSocket 连接、订单簿引擎、成交聚合、速率统计全部运行在 Web Worker 线程：

- 主线程零 delta 运算、零排序开销
- Worker 通过 `postMessage` 传递预计算的 `PriceLevel[]`，主线程直接写入 Store
- Worker 不可用时自动降级到主线程模式，功能完全对称

### 2. rAF 节流刷新

`OrderBookManager` 使用 `requestAnimationFrame` 循环，按 `OB_FLUSH_INTERVAL_MS`（200ms ≈ 5fps）节流：

- 无论 WS 消息频率多高（50+/s），UI 刷新频率始终 ≤ 5fps
- `dirty` 脏位检查避免无变化时的排序开销
- `levelsEqual()` 逐行比较避免无变化时触发 React 更新

### 3. 虚拟化列表渲染

`@tanstack/react-virtual` v3：

- OrderBook 和 TradeTape 均使用 `useVirtualizer`，只渲染可视区域内的行
- 订单簿另有高性能 DOM 直写路径，减少 React reconciliation 开销
- `estimateSize: 22px`，`overscan: 5–10` 预渲染行

### 4. 细粒度状态订阅（Zustand selector）

每个组件只订阅自己需要的字段切片：

- `OrderBook` → `useOrderBookStore(s => s.bids)` + `s.asks`
- `ConnectionStatus` → `useConnectionStore(s => s.status)`
- `MessageRate` → `useConnectionStore(s => s.bookRate)` + `s.tradeRate`

当 `bids` 更新时，`ConnectionStatus` 不会重渲染；当 `status` 变化时，`OrderBook` 不会重渲染。

### 5. 行组件记忆化（React.memo）

`OrderBookRow` 和 `TradeRow` 均使用 `React.memo`，浅比较跳过无变更行。

### 6. WebSocket 断线重连（指数退避）

`WebSocketManager` 实现：

- **退避公式：** `delay = min(1000 * 2^attempt, 30000)`
- **心跳保活：** 每 20s 发送 ping，10s 内未收到 pong 则主动重连
- **网络感知：** 监听 `offline` 立即断连，`online` 立即重连并重置退避

### 7. 参考价分区（零剪枝）

替代传统剪枝方案，避免高频场景下的列表数量闪烁：

- Map 忠实存储服务端数据，不做任何交叉删除
- EMA 参考价跟踪市场中枢（alpha = 0.03）
- 显示时用参考价分区，结构性保证 bid < refPrice < ask

---

## 已识别的性能瓶颈

| # | 瓶颈点 | 根因分析 | 当前缓解措施 | 残余风险 |
|---|--------|----------|-------------|----------|
| 1 | **Worker postMessage 序列化** | 每次 flush 需将 PriceLevel[] 从 Worker 序列化到主线程 | 数组固定 20 档 × 2 侧，数据量极小（< 1KB） | 极端场景下序列化可能引入微延迟 |
| 2 | **订单簿排序** | 每次 flush 需对 Map → 过滤 → sort → tick 聚合 → slice | 在 Worker 线程执行，不阻塞 UI；200ms 节流限制频率 | 档位数暴增时排序开销上升 |
| 3 | **EMA 参考价冷启动** | 首次连接时 refPrice = 0，需等待 delta 到达后才能正确分区 | 冷启动时 `top()` 无 bound 过滤返回全量数据 | 首帧可能短暂显示异常 |
| 4 | **K线 tick 更新** | 每条 trade 触发 PriceChart re-render + `series.update()` | Lightweight Charts 内部 Canvas 局部重绘，增量更新 | 1s 间隔下成交密集时更新频率高 |
| 5 | **单市场连接** | 切换市场时销毁 Worker、重建新连接，存在短暂数据断流 | Worker 终止 → 新 Worker 启动 → 快照填充，过渡快速 | 切换瞬间 UI 可能闪烁 |
| 6 | **延迟删除积累** | `size=0` 条目暂不物理删除，可能在 Map 中积累 | `pendingDeletes > 200` 时批量清除；`trimToMax` 裁剪容量 | 长时间运行后 Map 可能膨胀 |

---

## 扩容策略（10 倍负载场景）

假设消息频率从当前峰值 50 条/秒提升至 500 条/秒：

### 计算层

| 问题 | 当前方案 | 10x 方案 |
|------|----------|----------|
| Worker 单线程瓶颈 | 单 Worker 处理全部计算 | **多 Worker 并行**：拆分订单簿引擎与成交聚合到独立 Worker |
| 排序 O(N log N) | 全量 Map → sort → slice | 维护**排序跳表**（Skip List）或**堆结构**，取 top-K 为 O(K) |
| postMessage 开销 | 结构化克隆 PriceLevel[] | **SharedArrayBuffer + Atomics** 共享内存，主线程直接读取 |

### 渲染层

| 问题 | 当前方案 | 10x 方案 |
|------|----------|----------|
| flush 频率 | 200ms / 5fps | 降至 **2fps** 或按需刷新，肉眼无感知 |
| DOM 直写 | 订单簿高性能直写 | 进一步压缩 DOM 操作，或迁移至 **Canvas 渲染** |
| K线逐 tick 更新 | 每笔 trade → `series.update()` | 累积 100ms 内的 trades，**批量更新** OHLC |

### 网络层

| 问题 | 当前方案 | 10x 方案 |
|------|----------|----------|
| JSON 解析开销 | Worker 内 `JSON.parse()` | 协商服务端启用 **Protocol Buffers / MessagePack**，解析提升 5–10x |
| 单连接单市场 | 切换时销毁/重建 Worker | **多 Worker 并发**，每个市场独立管道；或单连接 + 服务端多路复用 |

### 监控与降级

- Worker 内添加**帧率监控**，自动降低 flush 频率
- 消息队列深度超过阈值时**丢弃中间帧**，只保留最新状态
- 添加 **Performance Observer** 监测 Long Task，上报至 APM 系统

---

## 技术权衡

| 决策 | 选择 A (采纳) | 选择 B (放弃) | 采纳理由 | 代价 |
|------|--------------|--------------|----------|------|
| 计算架构 | **Web Worker 优先** | 纯主线程 | 主线程零 delta 运算，UI 永不卡顿；降级模式保底 | Worker 通信有序列化开销，调试略复杂 |
| 订单簿交叉处理 | **参考价分区 + 零剪枝** | 客户端剪枝 | 不修改 Map 数据 → 数据完整；EMA 分区 → 显示稳定，不闪烁 | 需维护 refPrice 状态；冷启动前首帧可能异常 |
| 状态管理 | **Zustand** | Redux Toolkit | 包体 <1KB，selector 即订阅粒度，API 极简 | 生态不如 Redux |
| 图表库 | **Lightweight Charts v5** | ECharts | 金融专用 Canvas 渲染，增量 `update()` API | 定制化需手动实现 |
| 虚拟列表 | **@tanstack/react-virtual** | react-window | Headless 设计，不侵入 DOM 结构 | 需自行处理容器样式 |
| 事件通信 | **mitt 事件总线** | 直接回调 / RxJS | 极轻量（<200B），类型安全，模块解耦 | 无背压/缓冲机制 |
| 精度计算 | **bignumber.js** | 原生 Number | 消除浮点噪声（价格 key 归一化、中间价计算） | 包体 +8KB；热路径改用原生 toFixed 降低 GC |
| 节流策略 | **requestAnimationFrame** | setInterval | 与浏览器渲染管线同步，Worker 内也可使用 rAF | Worker 中 rAF 行为可能因浏览器而异 |
| 框架 | **Next.js 16 (App Router)** | Vite SPA | Vercel 零配置部署，内建优化，RSC 减少客户端 JS | 对纯 SPA 场景概念偏重 |
| 国际化 | **next-intl (cookie-based)** | URL-based i18n | 无需路由重写，切换仅设置 cookie | 不利于 SEO（交易 UI 影响可忽略） |
| 包管理 | **Bun** | pnpm / npm | 安装快，CI 时间短 | 少数 npm 兼容性问题 |

---

## 功能清单

### 核心功能

- [x] **市场选择器** — 悬停下拉切换 BTC-PERP / SOL-PERP，实时显示中间价、价差、成交速率
- [x] **订单簿** — 参考价分区的买卖盘（高性能 DOM 直写 + 双层深度条），tick 聚合粒度可调
- [x] **成交流** — 虚拟化列表，raw / readable 双模式，新成交闪烁动画
- [x] **下单面板** — 限价 / 市价切换，买入（做多）/ 卖出（做空），BigNumber 精度验证
- [x] **K 线图** — Lightweight Charts，4 个时间间隔（1s / 1m / 5m / 15m），实时 tick 更新
- [x] **连接状态** — 绿色（已连接）/ 黄色（同步中 / 重连中）/ 红色（已断开）
- [x] **消息速率** — 实时显示每秒 WebSocket 消息数（book + trade）
- [x] **国际化** — 英文 / 中文切换（cookie-based）

### 加分项

- [x] **Web Worker 离线计算** — WS + 引擎 + 聚合在 Worker 线程，主线程零计算
- [x] **Solana 交易流面板** — 连接 `/ws/stream`，展示实时链上交易
  - 交易签名（点击跳转 Sonic Explorer）
  - Slot 编号、手续费（lamports → SOL）、程序数量
  - 处理 `reorg` 事件（移除回滚 slot 之后的交易）
  - 虚拟化列表 + React.memo 行优化

### CI/CD

GitHub Actions 流水线（`.github/workflows/ci.yml`）：

```
push / PR to main → checkout → setup bun → install → lint → build
```

Vercel 自动部署：连接 GitHub 仓库，push 到 main 自动触发生产部署。
