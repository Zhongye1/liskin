import Database from 'better-sqlite3';
import type { Msg, ProviderConfig, SessionRecord, SessionSummary, StorePort } from '@liskin/core';

export type ProviderSource = 'env' | 'user';

export interface ProviderRow extends ProviderConfig {
  isActive: boolean;
  source: ProviderSource;
  createdAt: string;
  updatedAt: string;
}

interface RawProviderRow {
  id: string;
  name: string;
  protocol: string;
  base_url: string | null;
  api_key: string;
  model: string;
  organization: string | null;
  timeout_ms: number | null;
  max_retries: number | null;
  is_active: number;
  source: string;
  created_at: string;
  updated_at: string;
}

function rowToProvider(row: RawProviderRow): ProviderRow {
  const out: ProviderRow = {
    id: row.id,
    name: row.name,
    protocol: row.protocol as ProviderConfig['protocol'],
    apiKey: row.api_key,
    model: row.model,
    isActive: row.is_active === 1,
    source: row.source === 'env' ? 'env' : 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.base_url) {
    out.baseURL = row.base_url;
  }
  if (row.organization) {
    out.organization = row.organization;
  }
  if (row.timeout_ms !== null) {
    out.timeout = row.timeout_ms;
  }
  if (row.max_retries !== null) {
    out.maxRetries = row.max_retries;
  }
  return out;
}

/**
 * 极简 SQLite StorePort：会话表 + provider_configs 表。
 * provider_configs 维护多个 LLM 配置；is_active 表示当前活跃配置。
 */
export class SqliteStore implements StorePort {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        messages TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT NOT NULL,
        model TEXT NOT NULL,
        organization TEXT,
        timeout_ms INTEGER,
        max_retries INTEGER,
        is_active INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_providers_active ON provider_configs(is_active);
    `);
  }

  async loadSession(id: string): Promise<SessionRecord | null> {
    const row = this.db
      .prepare<
        [string],
        { id: string; created_at: string; updated_at: string; messages: string }
      >('SELECT id, created_at, updated_at, messages FROM sessions WHERE id = ?')
      .get(id);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: JSON.parse(row.messages) as Msg[],
    };
  }

  async saveSession(record: SessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at, messages)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           messages = excluded.messages`,
      )
      .run(record.id, record.createdAt, record.updatedAt, JSON.stringify(record.messages));
  }

  // ——— provider_configs ——— //

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare<[], RawProviderRow>(
        `SELECT id, name, protocol, base_url, api_key, model, organization,
                timeout_ms, max_retries, is_active, source, created_at, updated_at
         FROM provider_configs
         ORDER BY created_at ASC`,
      )
      .all();
    return rows.map((row) => rowToProvider(row));
  }

  getProvider(id: string): ProviderRow | null {
    const row = this.db
      .prepare<[string], RawProviderRow>(
        `SELECT id, name, protocol, base_url, api_key, model, organization,
                timeout_ms, max_retries, is_active, source, created_at, updated_at
         FROM provider_configs WHERE id = ?`,
      )
      .get(id);
    if (!row) {
      return null;
    }
    return rowToProvider(row);
  }

  getActiveProvider(): ProviderRow | null {
    const row = this.db
      .prepare<[], RawProviderRow>(
        `SELECT id, name, protocol, base_url, api_key, model, organization,
                timeout_ms, max_retries, is_active, source, created_at, updated_at
         FROM provider_configs WHERE is_active = 1 LIMIT 1`,
      )
      .get();
    if (!row) {
      return null;
    }
    return rowToProvider(row);
  }

  /**
   * upsert 一个 provider 配置。
   * - onlyIfMissing=true：当同 id 已存在时直接 noop（用于 env seed，保留用户改动）
   * - 默认（onlyIfMissing=false）：插入或全量更新
   */
  upsertProvider(
    config: ProviderConfig & { source?: ProviderSource },
    options: { onlyIfMissing?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    const exists = this.getProvider(config.id);
    if (exists && options.onlyIfMissing) {
      return;
    }
    const source: ProviderSource = config.source ?? 'user';
    if (exists) {
      this.db
        .prepare(
          `UPDATE provider_configs
           SET name = ?, protocol = ?, base_url = ?, api_key = ?, model = ?,
               organization = ?, timeout_ms = ?, max_retries = ?,
               source = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          config.name,
          config.protocol,
          config.baseURL ?? null,
          config.apiKey,
          config.model,
          config.organization ?? null,
          config.timeout ?? null,
          config.maxRetries ?? null,
          source,
          now,
          config.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO provider_configs
            (id, name, protocol, base_url, api_key, model, organization,
             timeout_ms, max_retries, is_active, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          config.id,
          config.name,
          config.protocol,
          config.baseURL ?? null,
          config.apiKey,
          config.model,
          config.organization ?? null,
          config.timeout ?? null,
          config.maxRetries ?? null,
          source,
          now,
          now,
        );
    }
  }

  /**
   * 切换 active provider（事务一次性把所有行的 is_active 重写）。
   */
  setActiveProvider(id: string): void {
    const txn = this.db.transaction((targetId: string) => {
      this.db
        .prepare('UPDATE provider_configs SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END')
        .run(targetId);
    });
    txn(id);
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const rows = this.db
      .prepare<
        [],
        { id: string; created_at: string; updated_at: string; messages: string }
      >('SELECT id, created_at, updated_at, messages FROM sessions ORDER BY updated_at DESC')
      .all();
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: (JSON.parse(r.messages) as unknown[]).length,
    }));
  }

  async deleteSession(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
