/**
 * 全局枚举定义
 *
 * Worker 消息通道的指令与事件类型，统一管理避免魔法字符串。
 * 主线程与 Worker 之间的所有通信都通过这两组枚举标识。
 */

/** 主线程 → Worker 指令类型 */
export enum WorkerCmd {
  /** 切换交易市场（携带 marketId、tickSize 等初始化参数） */
  SwitchMarket = "switch_market",
  /** 停止所有任务并清理资源 */
  Stop = "stop",
  /** 动态修改价格聚合粒度 */
  SetTickSize = "set_tick_size",
  /** 切换成交流展示模式（raw / readable） */
  SetTradeDisplayMode = "set_trade_display_mode",
}

/** Worker → 主线程推送事件类型 */
export enum WorkerEvent {
  /** 订单簿快照更新（bids + asks 预计算数组） */
  BookUpdate = "book_update",
  /** 成交列表更新（聚合后的完整列表） */
  TradeUpdate = "trade_update",
  /** WebSocket 连接状态变化（connecting / connected / disconnected / reconnecting） */
  ConnectionStatus = "connection_status",
  /** 订单簿同步状态变化（init / syncing / live / resyncing） */
  SyncState = "sync_state",
  /** 每秒消息吞吐速率统计（book msg/s, trade msg/s） */
  Rates = "rates",
}
