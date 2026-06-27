import type { LoggerPort } from '@liskin/core';

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  organization?: string;
  timeout?: number;
  /**
   * 透传给 OpenAI SDK 的 maxRetries（应修 #7）。不写默认值，由 SDK 的默认值（当前为 2）兜底。
   */
  maxRetries?: number;
  /** 可选：结构化日志器，用于记录 LLM 请求/响应事件 */
  logger?: LoggerPort;
}
