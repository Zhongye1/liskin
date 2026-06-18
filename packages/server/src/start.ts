import { serve } from '@hono/node-server';
import type { LLMPort, ProviderConfig, ToolPort } from '@liskin/core';

import { createApp } from './app.js';
import { LogBus } from './logger.js';
import { SqliteStore } from './store/sqlite-store.js';

export interface StartServerOptions {
  port: number;
  host?: string;
  dbPath: string;
  /**
   * 静态 LLM。可选：传了之后 chat 始终走它（兼容旧用法）。
   * 缺省时 chat 走数据库 active provider。
   */
  llm?: LLMPort;
  tools: ToolPort;
  corsOrigin?: string | string[];
  /**
   * 启动 seed：仅当数据库中尚无同 id 的 provider 时写入。
   * 已存在则保留用户配置不覆盖。
   * 如果当前没有 active provider，则把 seed 设为 active。
   */
  envSeed?: ProviderConfig;
}

export interface RunningServer {
  port: number;
  host: string;
  url: string;
  logBus: LogBus;
  close: () => Promise<void>;
}

/**
 * 拉起 HTTP 服务，组合 SQLite store + 给定的 LLM/Tools。
 * 不在内部决定 OpenAI 还是 Mock —— 由调用方（client/CLI）注入。
 */
export function startServer(opts: StartServerOptions): RunningServer {
  const store = new SqliteStore(opts.dbPath);
  const logBus = new LogBus();
  const restoreConsole = logBus.hijackConsole();

  // env seed：保留用户配置；只在 DB 没有同 id 时插入；若没有 active 则把 seed 设为 active
  if (opts.envSeed) {
    const beforeActive = store.getActiveProvider();
    store.upsertProvider({ ...opts.envSeed, source: 'env' }, { onlyIfMissing: true });
    if (!beforeActive) {
      const seedRow = store.getProvider(opts.envSeed.id);
      if (seedRow) {
        store.setActiveProvider(opts.envSeed.id);
      }
    }
  }

  const app = createApp({
    ...(opts.llm ? { llm: opts.llm } : {}),
    tools: opts.tools,
    store,
    logBus,
    ...(opts.corsOrigin ? { corsOrigin: opts.corsOrigin } : {}),
  });

  const host = opts.host ?? '127.0.0.1';
  const handle = serve({ fetch: app.fetch, hostname: host, port: opts.port });

  return {
    port: opts.port,
    host,
    url: `http://${host}:${opts.port}`,
    logBus,
    close: () =>
      new Promise<void>((resolve) => {
        handle.close(() => {
          restoreConsole();
          store.close();
          resolve();
        });
      }),
  };
}
