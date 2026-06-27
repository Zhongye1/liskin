import type { LLMPort, LoggerPort, ProviderConfig } from '@liskin/core';

import { OpenAIProvider } from './openai/provider.js';

export interface CreateProviderOptions {
  /** 可选：结构化日志器，用于记录 LLM 请求/响应事件 */
  logger?: LoggerPort;
}

/**
 * 轻量工厂：按 protocol 路由到具体的 LLM Provider 实现。
 * 没有引入 IoC 容器，调用方自行决定何时实例化。
 */
export function createProvider(config: ProviderConfig, opts: CreateProviderOptions = {}): LLMPort {
  switch (config.protocol) {
    case 'openai-compatible': {
      return new OpenAIProvider({
        apiKey: config.apiKey,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        model: config.model,
        ...(config.organization ? { organization: config.organization } : {}),
        ...(config.timeout ? { timeout: config.timeout } : {}),
        ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
        ...(opts.logger ? { logger: opts.logger } : {}),
      });
    }
    default: {
      throw new Error(`unsupported provider protocol: ${String(config.protocol)}`);
    }
  }
}
