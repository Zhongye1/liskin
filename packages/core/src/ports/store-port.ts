import type { Msg } from '../types/messages.js';

export interface SessionRecord {
  id: string;
  createdAt: string; // ISO
  updatedAt: string;
  messages: Msg[];
}

/** 列表视图（不含 messages 全文，避免 N 行消息序列化）。 */
export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StorePort {
  loadSession(id: string): Promise<SessionRecord | null>;
  saveSession(record: SessionRecord): Promise<void>;

  /**
   * 列出所有会话摘要（按 updatedAt 倒序）。
   * 可选：旧实现（如 SqliteStore）未实现时，KernelClient 用内存索引兜底。
   */
  listSessions?(): Promise<SessionSummary[]>;

  /** 删除会话。可选：不实现时 KernelClient 抛 NotImplemented。 */
  deleteSession?(id: string): Promise<void>;
}
