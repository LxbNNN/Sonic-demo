/**
 * WebSocket 连接管理器
 *
 * 核心能力：
 * - 自动重连（指数退避：1s → 2s → 4s → ... → 30s 上限）
 * - Ping/Pong 心跳保活（每 20s 发送 ping，10s 内未收到 pong 则断开重连）
 * - 浏览器 offline/online 事件监听（即时感知网络状态变化）
 * - 连接状态回调通知
 */

import {
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "./constants";
import type { ConnectionStatus } from "./types";

export type WsManagerOptions = {
  /** WebSocket 服务端地址 */
  url: string;
  /** 收到消息时的回调（已解析为 JSON 对象） */
  onMessage: (data: unknown) => void;
  /** 连接状态变化时的回调 */
  onStatusChange: (status: ConnectionStatus) => void;
};

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private onMessage: (data: unknown) => void;
  private onStatusChange: (status: ConnectionStatus) => void;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前重连尝试次数，用于计算指数退避延迟 */
  private reconnectAttempt = 0;
  /** 是否已被手动销毁，防止销毁后继续重连 */
  private disposed = false;
  private status: ConnectionStatus = "disconnected";
  /** 最后一次收到业务消息的时间戳（不含 pong） */
  private lastMessageAt = 0;

  private boundOnOffline: (() => void) | null = null;
  private boundOnOnline: (() => void) | null = null;

  constructor(opts: WsManagerOptions) {
    this.url = opts.url;
    this.onMessage = opts.onMessage;
    this.onStatusChange = opts.onStatusChange;
  }

  /** 发起 WebSocket 连接 */
  connect() {
    if (this.disposed) return;
    this.cleanup();

    this.listenNetworkEvents();
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      this.startPing();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "pong") {
          this.clearPongTimeout();
          return;
        }

        this.lastMessageAt = Date.now();
        this.onMessage(data);
      } catch (e) {
        console.error("[WS] onmessage error:", e);
      }
    };

    ws.onclose = () => {
      this.stopPing();
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    this.ws = ws;
  }

  /** 主动断开连接并释放资源，不再自动重连 */
  disconnect() {
    this.disposed = true;
    this.cleanup();
    this.removeNetworkEvents();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  /** 重新连接（可选传入新 URL，用于切换市场） */
  reconnect(newUrl?: string) {
    if (newUrl) this.url = newUrl;
    this.disposed = false;
    this.reconnectAttempt = 0;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.cleanup();
    this.connect();
  }

  /** 更新连接状态并通知外部 */
  private setStatus(s: ConnectionStatus) {
    if (this.status !== s) {
      this.status = s;
      this.onStatusChange(s);
    }
  }

  /**
   * 监听浏览器 offline/online 事件
   * offline → 立即关闭 WebSocket 并标记断连
   * online  → 立即触发重连
   */
  private listenNetworkEvents() {
    if (typeof window === "undefined") return;
    this.removeNetworkEvents();

    this.boundOnOffline = () => {
      this.stopPing();
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      this.clearReconnectTimer();
      this.setStatus("disconnected");
    };

    this.boundOnOnline = () => {
      if (this.disposed) return;
      this.reconnectAttempt = 0;
      this.setStatus("reconnecting");
      this.connect();
    };

    window.addEventListener("offline", this.boundOnOffline);
    window.addEventListener("online", this.boundOnOnline);
  }

  /** 移除 offline/online 事件监听 */
  private removeNetworkEvents() {
    if (typeof window === "undefined") return;
    if (this.boundOnOffline) {
      window.removeEventListener("offline", this.boundOnOffline);
      this.boundOnOffline = null;
    }
    if (this.boundOnOnline) {
      window.removeEventListener("online", this.boundOnOnline);
      this.boundOnOnline = null;
    }
  }

  /** 启动心跳：定期发送 ping，等待 pong 超时则关闭连接 */
  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
        this.pongTimer = setTimeout(() => {
          this.ws?.close();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  /** 停止心跳 */
  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  /** 清除 pong 超时定时器（收到 pong 时调用） */
  private clearPongTimeout() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** 指数退避重连：delay = min(base * 2^attempt, max) */
  private scheduleReconnect() {
    this.setStatus("reconnecting");
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /** 清除重连定时器 */
  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 获取最后一次业务消息的时间戳 */
  getLastMessageAt(): number {
    return this.lastMessageAt;
  }

  /** 当前连接是否处于 OPEN 状态 */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 清理所有定时器 */
  private cleanup() {
    this.stopPing();
    this.clearReconnectTimer();
  }
}
