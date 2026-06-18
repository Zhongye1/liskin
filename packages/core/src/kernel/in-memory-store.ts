import type { SessionRecord, SessionSummary, StorePort } from '../ports/store-port.js';

/**
 * 进程内内存 StorePort：测试与 CLI MVP（不持久化场景）使用。
 *
 * 真正的持久化由 packages/server 的 SqliteStore 实现；
 * 本实现满足 StorePort 全部契约（含可选 listSessions/deleteSession）。
 */
export class InMemoryStore implements StorePort {
  private readonly sessions = new Map<string, SessionRecord>();

  async loadSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async saveSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, { ...record, messages: [...record.messages] });
  }

  async listSessions(): Promise<SessionSummary[]> {
    const summaries = [...this.sessions.values()].map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r.messages.length,
    }));
    return [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}
