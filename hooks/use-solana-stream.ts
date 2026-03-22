/**
 * Solana 交易流 Hook（Bonus 功能）
 *
 * 连接 /ws/stream WebSocket，接收实时 Solana 交易：
 * - transaction 消息 → 追加到交易列表
 * - reorg 消息 → 移除回滚 slot 之后的交易
 *
 * 同时导出 useStreamStore 供 TransactionFeed 组件订阅
 */

"use client";

import { useEffect, useRef, useCallback } from "react";
import { create } from "zustand";
import { WS_STREAM_URL, MAX_TRANSACTIONS } from "@/lib/constants";
import { WebSocketManager } from "@/lib/websocket-manager";
import type {
  StreamMessage,
  StreamTransactionMessage,
  ConnectionStatus,
} from "@/lib/types";

/** 精简后的 Solana 交易数据（只保留 UI 展示所需字段） */
export interface SolTx {
  /** 交易签名 */
  signature: string;
  /** 确认 slot */
  slot: number;
  /** 区块时间 */
  blockTime: number | null;
  /** 手续费（lamports） */
  fee: number;
  /** 调用的程序 ID 列表 */
  programIds: string[];
  /** 交易错误（null 表示成功） */
  err: object | null;
  /** 序列号 */
  seq: number;
}

interface StreamStoreState {
  /** 交易列表（最新在前） */
  transactions: SolTx[];
  /** 流连接状态 */
  status: ConnectionStatus;
  /** 追加一条交易 */
  addTx: (tx: SolTx) => void;
  /** 移除指定 slot 之后的所有交易（处理链重组） */
  removeAfterSlot: (slot: number) => void;
  setStatus: (s: ConnectionStatus) => void;
  clear: () => void;
}

export const useStreamStore = create<StreamStoreState>((set) => ({
  transactions: [],
  status: "disconnected",
  addTx: (tx) =>
    set((s) => ({
      transactions: [tx, ...s.transactions].slice(0, MAX_TRANSACTIONS),
    })),
  removeAfterSlot: (slot) =>
    set((s) => ({
      transactions: s.transactions.filter((t) => t.slot <= slot),
    })),
  setStatus: (status) => set({ status }),
  clear: () => set({ transactions: [] }),
}));

/** 建立 Solana 交易流 WebSocket 连接 */
export function useSolanaStream() {
  const addTx = useStreamStore((s) => s.addTx);
  const removeAfterSlot = useStreamStore((s) => s.removeAfterSlot);
  const setStatus = useStreamStore((s) => s.setStatus);
  const wsRef = useRef<WebSocketManager | null>(null);

  /** 消息分发处理 */
  const handleMessage = useCallback(
    (raw: unknown) => {
      const msg = raw as StreamMessage;
      switch (msg.type) {
        case "transaction": {
          const t = msg as StreamTransactionMessage;
          addTx({
            signature: t.signature,
            slot: t.slot,
            blockTime: t.blockTime,
            fee: t.fee,
            programIds: t.programIds,
            err: t.err,
            seq: t.seq,
          });
          break;
        }
        case "reorg": {
          // 链重组：丢弃 rollbackSlot 之后的交易
          removeAfterSlot(msg.rollbackSlot);
          break;
        }
        default:
          break;
      }
    },
    [addTx, removeAfterSlot]
  );

  const handleStatus = useCallback(
    (s: ConnectionStatus) => setStatus(s),
    [setStatus]
  );

  useEffect(() => {
    const ws = new WebSocketManager({
      url: WS_STREAM_URL,
      onMessage: handleMessage,
      onStatusChange: handleStatus,
    });
    wsRef.current = ws;
    ws.connect();

    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, [handleMessage, handleStatus]);
}
