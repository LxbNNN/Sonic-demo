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
| 国际化 | next-intl | ^4 | 基于 cookie 的语言切换（en / zh），Server Component 兼容 |
| 包管理 | Bun | latest | 安装速度快，CI 构建时间更短 |
| CI/CD | GitHub Actions + Vercel | - | push/PR 自动触发 lint → build 流水线 |

### 数据流架构

```
┌─────────────────────────────────────────────────────────────┐
│                    SMFS Backend                              │
│  REST:  https://interviews-api.sonic.game                    │
│  WS:    wss://interviews-api.sonic.game/ws?marketId=BTC-PERP │
│  Stream: wss://interviews-api.sonic.game/ws/stream           │
└─────────┬──────────────────────────────────┬─────────────────┘
          │                                  │
    REST API (初始化)                   WebSocket (实时流)
    smfs-client.ts                    websocket-manager.ts
    • /snapshot                        • 自动重连 (指数退避)
    • /candles                         • ping/pong 心跳 (20s)
    • /orders                          • offline/online 事件监听
          │                                  │
          │                           消息分发 (handleMessage)
          │                    ┌──────────────┼──────────────┐
          │                    ▼              ▼              ▼
          │             book_delta         trade          reset
          │                    │              │              │
          │          order-book-engine   trade-store    重新拉取
          │          • seq 校验           (Zustand)      snapshot
          │          • BigNumber delta     最近200条
          │          • Map<priceKey,BN>    追加队列
          │                    │              │
          │          order-book-store         │
          │          (Zustand)               │
          │                    │              │
          │            ┌───────┴──────────────┘
          │            │
          │    requestAnimationFrame 循环
          │    每帧检查 dirtyRef → 排序 top-20 → 批量写入 store
          │            │
          ▼            ▼
    ┌─────────────────────────────────┐
    │         React UI 组件            │
    │  OrderBook (虚拟化 + memo 行)    │
    │  TradeTape (虚拟化 + memo 行)    │
    │  PriceChart (Lightweight Charts) │
    │  OrderEntry (BigNumber 验证)     │
    │  ConnectionStatus / MessageRate  │
    │  TransactionFeed (Bonus)         │
    └─────────────────────────────────┘
```

### 目录结构

```
├── .github/workflows/ci.yml       # GitHub Actions: lint → build
├── app/
│   ├── layout.tsx                  # 根布局（Geist 字体、next-intl Provider、暗色主题）
│   ├── page.tsx                    # 入口，渲染 TradingLayout
│   └── globals.css                 # Tailwind + shadcn/ui 主题变量
├── components/
│   ├── ui/                         # shadcn/ui 基础组件（8 个）
│   │   └── button / input / select / badge / card / tabs / separator / tooltip
│   └── trading/                    # 交易业务组件（12 个）
│       ├── trading-layout.tsx      # 三栏主布局 + 顶部导航
│       ├── market-selector.tsx     # 市场切换（悬停下拉 + 实时价格/价差/速率）
│       ├── order-book.tsx          # 订单簿（双向虚拟化列表 + BigNumber 累计量）
│       ├── order-book-row.tsx      # 订单簿行（React.memo + 双层深度条）
│       ├── trade-tape.tsx          # 成交流（虚拟化列表）
│       ├── trade-row.tsx           # 成交行（React.memo + 闪烁动画）
│       ├── order-entry.tsx         # 下单面板（限价/市价 + BigNumber 精度验证）
│       ├── price-chart.tsx         # K线图（4 个时间间隔 + 实时 tick 更新）
│       ├── connection-status.tsx   # 连接状态（绿/黄/红圆点 + 文字）
│       ├── message-rate.tsx        # 消息吞吐率（msg/s）
│       ├── locale-switcher.tsx     # 语言切换（en/zh）
│       └── transaction-feed.tsx    # [Bonus] Solana 交易流
├── hooks/
│   ├── use-market-feed.ts          # 数据引擎枢纽（WS + 引擎 + RAF + 速率统计）
│   └── use-solana-stream.ts        # Solana 交易流连接 + StreamStore
├── stores/
│   ├── market-store.ts             # 当前市场选择（BTC-PERP / SOL-PERP）
│   ├── order-book-store.ts         # 订单簿（bids/asks + BigNumber 中间价/价差）
│   ├── trade-store.ts              # 最近成交（固定 200 条）
│   └── connection-store.ts         # 连接状态 + 消息速率
├── lib/
│   ├── websocket-manager.ts        # WebSocket 管理器（重连 + 心跳 + 网络事件）
│   ├── order-book-engine.ts        # 订单簿引擎（BigNumber delta 应用 + seq 校验）
│   ├── smfs-client.ts              # REST API 类型安全客户端
│   ├── types.ts                    # 全局类型（REST 响应 + WS 消息联合类型）
│   ├── constants.ts                # 配置常量（URL、深度、心跳参数等）
│   ├── bn.ts                       # BigNumber 工具（BN/priceKey/常量）
│   ├── format.ts                   # 数据格式化（BigNumber 精确 toFixed）
│   └── utils.ts                    # 通用工具
├── i18n/request.ts                 # next-intl 语言解析（cookie-based）
├── messages/
│   ├── en.json                     # 英文翻译
│   └── zh.json                     # 中文翻译
└── next.config.ts                  # Next.js + next-intl 插件
```

### 状态管理设计

4 个独立的 Zustand Store，各自职责清晰，通过 selector 实现细粒度订阅：

| Store | 数据 | 更新频率 | 订阅者 |
|-------|------|----------|--------|
| `market-store` | 当前 `marketId` | 极低（用户切换时） | 几乎所有组件（切换时重建整个数据管道） |
| `order-book-store` | `bids[]`, `asks[]`, `midPrice`, `spreadPercent` | ~60fps（RAF 批量写入） | OrderBook, MarketSelector, OrderEntry |
| `trade-store` | `trades[]`（最近 200 条） | 5–20 次/秒 | TradeTape, PriceChart |
| `connection-store` | `status`, `bookRate`, `tradeRate` | 1 次/秒（速率）+ 状态变化时 | ConnectionStatus, MessageRate, MarketSelector |

### WebSocket 生命周期

```
     ┌────────── 用户切换市场 / 组件挂载 ──────────┐
     ▼                                              │
[创建 WebSocketManager] ──→ [connecting]            │
     │                                              │
     ▼  ws.onopen                                   │
[connected] ──→ 拉取 REST snapshot 初始化引擎        │
     │          启动 ping 定时器 (每 20s)             │
     │          启动 RAF 刷新循环                     │
     │          启动 1s 速率统计定时器                 │
     │                                              │
     │  ws.onmessage                                │
     ├──→ book_delta: seq 校验 → applyDelta → dirtyRef = true
     ├──→ trade:      追加到 tradeStore              │
     ├──→ reset:      重新拉取 snapshot              │
     ├──→ pong:       清除 pong 超时定时器            │
     │                                              │
     │  seq 跳跃检测                                 │
     ├──→ applyDelta 返回 false → 重新拉取 snapshot  │
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

### 订单簿同步协议（交易所风格）

- 状态机：`init -> syncing -> live -> resyncing`
- 连接成功后先进入 `syncing`，缓存 `book_delta` 到有界队列（`DELTA_BUFFER_MAX`）
- 快照到达后使用 **replace** 重建订单簿（不再 merge 旧档位）
- 回放快照窗口内缓存增量并恢复到 `live`
- `live` 阶段严格校验 seq 连续性：非 `lastSeq + 1` 立即进入 `resyncing`
- 引擎 watchdog 检测全局静默/单侧失衡时触发重同步请求

### 成交流可读模式

- 新增两种展示模式：
  - `readable`（默认）：`TRADE_AGG_WINDOW_MS` 短窗内同价同方向聚合
  - `raw`：逐条原始成交展示
- 单次推送条数受 `TRADE_BATCH_MAX_ITEMS` 限制，降低高频时的视觉抖动
- 新成交高亮动画统一为 700ms，便于肉眼追踪

---

## 性能决策

本项目实现了全部 7 项技术要求中的优化方案：

### 1. 虚拟化列表渲染

**库：** `@tanstack/react-virtual` v3

OrderBook 和 TradeTape 均使用 `useVirtualizer`，只渲染可视区域内的行。订单簿买卖盘各 20 档，成交列表最多 200 条，但实际 DOM 中只存在约 20–30 个行节点。

- `estimateSize: 22px`（订单簿）/ `22px`（成交流）/ `26px`（Solana 交易流）
- `overscan: 5–10` 预渲染行，保证快速滚动时不出现空白

### 2. 批量状态更新（requestAnimationFrame）

`useMarketFeed` Hook 中实现的核心调度机制：

- 每条 WebSocket 消息到达时，仅在内存中的 `OrderBookState`（引擎层）执行 delta 运算，标记 `dirtyRef = true`
- 一个持续运行的 RAF 循环每帧检查 `dirtyRef`，有变更时才排序 top-20 档位并一次性写入 Zustand store
- 效果：无论 WS 消息频率多高（50+/s），React 渲染频率始终 ≤ 60fps

### 3. 细粒度状态订阅（Zustand selector）

每个组件只订阅自己需要的字段切片：

- `OrderBook` → `useOrderBookStore(s => s.bids)` + `useOrderBookStore(s => s.asks)`
- `ConnectionStatus` → `useConnectionStore(s => s.status)`（不关心 `bookRate/tradeRate`）
- `MessageRate` → `useConnectionStore(s => s.bookRate)` + `s.tradeRate`（不关心 `status`）
- `MarketSelector` → 从三个不同 store 各取一个字段

当 `bids` 更新时，`ConnectionStatus` 不会重渲染；当 `status` 变化时，`OrderBook` 不会重渲染。

### 4. 行组件记忆化（React.memo）

`OrderBookRow` 和 `TradeRow` 均使用 `React.memo` 包裹：

- OrderBookRow 接收 `level`（price/size）、`cumTotal`、`maxCumTotal` 等基本类型属性，React 默认浅比较即可跳过无变更的行
- TradeRow 以 `trade` 对象引用为判据，已存在的成交记录引用不变则不重渲染
- 双层深度条的宽度百分比使用 BigNumber 精确计算（`BN(cumTotal).div(maxCumTotal).times(100)`）

### 5. WebSocket 断线重连（指数退避）

`WebSocketManager` 类实现：

- **退避公式：** `delay = min(1000 * 2^attempt, 30000)`，即 1s → 2s → 4s → 8s → 16s → 30s（上限）
- **心跳保活：** 每 20 秒发送 `{ "type": "ping" }`，10 秒内未收到 pong 则主动关闭连接触发重连
- **网络感知：** 监听 `window.offline` 立即断连，`window.online` 立即重连并重置退避计数器
- **状态通知：** 通过 `onStatusChange` 回调实时更新 UI 状态（connecting → connected → reconnecting → disconnected）

### 6. Seq 序列号校验 + Snapshot 重置

`order-book-engine.ts` 中的 `applyDelta()` 函数：

- 校验 `delta.seq === lastSeq + 1`，不等则返回 `false`
- 调用方检测到 `false` 后立即调用 `GET /markets/:marketId/snapshot` 重建完整订单簿
- 服务端发送 `reset` 消息时也触发 snapshot 重拉
- 使用 `fetchingSnapshotRef` 防止并发重复拉取

### 7. Ping/Pong 心跳保活

- Ping 间隔：`PING_INTERVAL_MS = 20_000`（20 秒）
- Pong 超时：`PONG_TIMEOUT_MS = 10_000`（10 秒）
- 超时处理：直接 `ws.close()`，触发 `onclose` → `scheduleReconnect()`

### 额外：BigNumber 精度保障

所有涉及价格/数量/金额的计算均通过 `bignumber.js` 进行：

- 订单簿引擎 Map 的 key 使用 `priceKey(price)` 归一化（`new BigNumber(price).toFixed(10)`），消除浮点噪声导致的 key 不匹配
- 中间价 `(bestBid + bestAsk) / 2` 和价差百分比使用 BigNumber 精确运算
- `formatPrice()` / `formatSize()` 通过 `BN(value).toFixed(dp)` 输出，避免原生 `toFixed()` 的四舍五入错误

---

## 已识别的性能瓶颈

| # | 瓶颈点 | 根因分析 | 当前缓解措施 | 残余风险 |
|---|--------|----------|-------------|----------|
| 1 | **主线程 delta 运算** | 高频 `book_delta`（最高 50/s）的 BigNumber Map 更新 + 排序在主线程执行 | RAF 批量合并，实际排序频率 ≤ 60fps；排序仅取 top-20 档 | 极端场景下 BigNumber 运算可能导致帧丢失 |
| 2 | **订单簿排序** | 每帧需对 Map → Array → sort → slice 取 top-N，复杂度 O(N log N) | 限制展示深度 `ORDERBOOK_DEPTH = 20`，实际 Map 通常数百个 key | 档位数暴增时排序开销上升 |
| 3 | **BigNumber 实例化** | 每次 delta 为每个价格档创建 BigNumber 实例，GC 压力 | 对象池化暂未实现，依赖 V8 短生命周期对象优化 | 可能在低端设备上引起 GC 抖动 |
| 4 | **K线 tick 更新** | 每条 trade 触发 `PriceChart` 组件 re-render + `series.update()` | Lightweight Charts 内部 Canvas 局部重绘，增量更新 | 1s 间隔下成交密集时更新频率高 |
| 5 | **单市场连接** | 切换市场时销毁旧连接、重建新连接，存在短暂数据断流 | 切换后立即拉取 snapshot 填充，WS 重连后 delta 流接续 | 切换瞬间 UI 可能闪烁 |
| 6 | **Trade Store 追加** | 每条 trade 消息触发 Zustand set，创建新数组 `[trade, ...old].slice(0, 200)` | 固定长度限制内存增长；TradeTape 通过虚拟化限制渲染量 | 高频追加产生短暂数组拷贝开销 |

---

## 扩容策略（10 倍负载场景）

假设消息频率从当前峰值 50 条/秒提升至 500 条/秒：

### 计算层

| 问题 | 当前方案 | 10x 方案 |
|------|----------|----------|
| delta 运算阻塞主线程 | RAF 批量更新（~16ms/帧） | 迁移至 **Web Worker**：Worker 内维护 OrderBookState，完成 delta 应用 + 排序后，通过 `postMessage` 传递最终 `PriceLevel[]` 给主线程，主线程零运算直接写入 store |
| BigNumber GC 压力 | 每次 delta 创建新实例 | 在 Worker 内使用 **TypedArray**（Float64Array）作为订单簿存储，固定大小无 GC；或使用 **SharedArrayBuffer** + Atomics 让主线程直接读取 Worker 计算结果，消除序列化开销 |
| 排序 O(N log N) | 全量 Map → sort → slice | 维护**排序跳表**（Skip List）或**堆结构**，插入/删除 O(log N)，取 top-K 为 O(K)，避免全量排序 |

### 渲染层

| 问题 | 当前方案 | 10x 方案 |
|------|----------|----------|
| 订单簿 60fps 刷新 | RAF 每帧刷新 | 降至 **30fps**（每 2 帧刷新一次），肉眼无感知差异但运算量减半 |
| 虚拟列表 20 档 | 固定 20 行 | 根据负载动态调整档位数（如 10 档），减少 diff 成本 |
| K线逐 tick 更新 | 每笔 trade → `series.update()` | 累积 100ms 内的 trades，**批量更新**最新 K 线柱的 OHLC，降低 Canvas 重绘频率 |

### 网络层

| 问题 | 当前方案 | 10x 方案 |
|------|----------|----------|
| JSON 解析开销 | `JSON.parse()` 每条消息 | 协商服务端启用 **Protocol Buffers / MessagePack** 二进制编码，解析速度提升 5–10x，带宽减少 50%+ |
| 单连接单市场 | 切换时销毁/重建 | 支持 **多 Worker 并发连接**，每个市场独立的 delta 管道，主线程做最终聚合；也可使用单连接 + 服务端多路复用 |

### 监控与降级

- 在 `useMarketFeed` 中添加**帧率监控**（检测连续 N 帧超过 16ms），自动降级渲染频率
- 消息队列深度超过阈值时**丢弃中间帧**，只保留最新状态
- 添加 **Performance Observer** 监测 Long Task，上报至 APM 系统

---

## 技术权衡

| 决策 | 选择 A (采纳) | 选择 B (放弃) | 采纳理由 | 代价 |
|------|--------------|--------------|----------|------|
| 状态管理 | **Zustand** | Redux Toolkit | 包体 <1KB，selector 即订阅粒度，无需 `createSelector` / `reselect`；API 极简（`create` 一个函数即完成） | 生态不如 Redux（DevTools 功能较少，中间件选择少） |
| 图表库 | **Lightweight Charts v5** | Recharts / ECharts | 专为金融时序设计，Canvas 渲染 GPU 加速，内建十字线/时间轴/价格轴；增量 `update()` API 无需全量 `setData` | 定制化需要手动实现（如自定义 tooltip），社区体量小于 ECharts |
| 虚拟列表 | **@tanstack/react-virtual** | react-window | Headless 设计，不侵入 DOM 结构，可自由组合 absolute 定位 + transform；支持动态行高 | 需自行处理容器样式和滚动条，上手成本略高于 react-window 的 FixedSizeList |
| 订单簿引擎 | **Map\<priceKey, BigNumber\>** | 排序数组 | O(1) 查找/更新，delta 应用极快；`priceKey()` 归一化消除浮点噪声 | 展示时需 O(N log N) 排序（但 N 有限，top-20 slice 后开销可控） |
| 精度计算 | **bignumber.js** | 原生 Number | 彻底消除浮点问题（如中间价计算、深度条百分比、价格 Map key 碰撞） | 每次运算创建 BigNumber 实例，存在 GC 开销；包体 +8KB gzip |
| 节流策略 | **requestAnimationFrame** | `setInterval(16)` | 与浏览器渲染管线完全同步，不会在非渲染帧浪费计算 | 120Hz 显示器上渲染频率翻倍（可通过帧计数器限制） |
| 应用框架 | **Next.js 16 (App Router)** | Vite SPA | Vercel 部署零配置，内建字体优化/图片优化，RSC 减少客户端 JS；i18n 集成借助 `next-intl` 实现 server-side 语言解析 | 对纯 SPA 场景引入 Server Component 概念略显偏重；构建比 Vite 稍慢 |
| 国际化 | **next-intl (cookie-based)** | URL-based i18n | 无需路由重写，切换语言仅设置 cookie 即可；避免 `/en/` `/zh/` 路径前缀 | 不利于 SEO 多语言索引（但交易 UI 为纯 SPA，影响可忽略） |
| 包管理 | **Bun** | pnpm / npm | 安装速度显著更快，CI 时间缩短；`bun.lock` 体积更小 | 部分 npm 生态兼容性待完善，少数场景需 fallback 到 Node.js |

---

## 功能清单

### 核心功能

- [x] **市场选择器** — 悬停下拉切换 BTC-PERP / SOL-PERP，实时显示中间价、价差、成交速率
- [x] **订单簿** — 买卖盘双向虚拟化列表，双层深度条（单档 + 累计量），BigNumber 精确计算
- [x] **成交流** — 虚拟化列表展示最近 200 条成交，新成交闪烁动画，绿涨红跌
- [x] **下单面板** — 限价 / 市价切换，买入（做多）/ 卖出（做空），BigNumber 精度验证，POST /orders 模拟提交
- [x] **K 线图** — Lightweight Charts 渲染，4 个时间间隔（1s / 1m / 5m / 15m），实时 tick 更新最新 K 线
- [x] **连接状态** — 绿色（已连接）/ 黄色闪烁（连接中/重连中）/ 红色（已断开）
- [x] **消息速率** — 实时显示每秒 WebSocket 消息总数（book + trade）
- [x] **国际化** — 支持英文 / 中文切换

### 加分项

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
