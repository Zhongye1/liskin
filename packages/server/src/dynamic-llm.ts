import type { ChatRequest, LLMPort, LLMEvent, ProviderConfig } from '@liskin/core';
import { createProvider } from '@liskin/llm';

import type { ProviderRow, SqliteStore } from './store/sqlite-store.js';

/**
 * 动态 LLMPort 代理：每次 chatStream 时按数据库 active provider 解析具体实现。
 *
 * InProcessKernelClient 构造时需要一个固定的 LLMPort，但 server 的 LLM 是动态的
 * （active provider 可经 Web UI 切换）。本代理把「固定接口」与「动态后端」解耦：
 * kernel 持有一个 DynamicLLMPort，背后每次都查当前 active provider。
 */
export class DynamicLLMPort implements LLMPort {
  private readonly store: SqliteStore;
  private readonly fallback?: LLMPort;
  private cache: { id: string; llm: LLMPort } | null = null;

  constructor(store: SqliteStore, fallback?: LLMPort) {
    this.store = store;
    this.fallback = fallback;
  }

  /** 当前 active provider 是否仍存在；不存在则清缓存。 */
  invalidate(): void {
    this.cache = null;
  }

  private resolve(): LLMPort {
    // 静态 fallback 优先（兼容旧测试：传了 llm 就始终用它）
    if (this.fallback) {
      return this.fallback;
    }
    const row = this.store.getActiveProvider();
    if (!row) {
      throw new Error('no active provider configured');
    }
    if (this.cache && this.cache.id === row.id) {
      return this.cache.llm;
    }
    const llm = createProvider(rowToConfig(row));
    this.cache = { id: row.id, llm };
    return llm;
  }

  chatStream(req: ChatRequest): AsyncIterable<LLMEvent> {
    const llm = this.resolve();
    return llm.chatStream(req);
  }
}

function rowToConfig(row: ProviderRow): ProviderConfig {
  const cfg: ProviderConfig = {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    apiKey: row.apiKey,
    model: row.model,
  };
  if (row.baseURL) {
    cfg.baseURL = row.baseURL;
  }
  if (row.organization) {
    cfg.organization = row.organization;
  }
  if (row.timeout !== undefined) {
    cfg.timeout = row.timeout;
  }
  if (row.maxRetries !== undefined) {
    cfg.maxRetries = row.maxRetries;
  }
  return cfg;
}
