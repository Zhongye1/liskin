import type { ChatRequest, LLMEvent, LLMPort, LoggerPort } from '@liskin/core';
import { NoopLogger } from '@liskin/core';
import OpenAI from 'openai';

import { isAbortedEvent, normalizeError } from './errors.js';
import { parseOpenAIStream } from './stream.js';
import { toOpenAIMessages, toOpenAITools } from './translate.js';
import type { OpenAIProviderOptions } from './types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * 验证并规范化 base URL。
 *
 * OpenAI SDK 会自动在 baseURL 后拼接 `/chat/completions`，因此：
 * - 如果 baseURL 以 `/responses` 结尾（OpenAI Responses API 格式），需要去掉该后缀
 * - 如果 baseURL 以 `/chat/completions` 结尾，需要去掉该后缀
 * - 如果 baseURL 以 `/v1/` 结尾且包含额外路径，需要警告
 *
 * 返回规范化后的 baseURL。
 */
function normalizeBaseURL(baseURL: string | undefined): string | undefined {
  if (!baseURL) {
    return undefined;
  }

  let normalized = baseURL;

  // 去掉末尾的斜杠
  normalized = normalized.replace(/\/+$/u, '');

  // 检测并移除 /responses 后缀（OpenAI Responses API 格式，不是 Chat Completions）
  if (normalized.endsWith('/responses')) {
    // eslint-disable-next-line no-console -- 配置错误需要明确告知用户
    console.warn(
      `[liskin] warning: baseURL ends with '/responses' (OpenAI Responses API format). ` +
        `The Chat Completions API requires baseURL without this suffix. ` +
        `Automatically stripping '/responses' suffix. ` +
        `If you intended to use the Responses API, this provider does not support it.`,
    );
    normalized = normalized.slice(0, -'/responses'.length);
  }

  // 检测并移除 /chat/completions 后缀
  if (normalized.endsWith('/chat/completions')) {
    // eslint-disable-next-line no-console -- 配置错误需要明确告知用户
    console.warn(
      `[liskin] warning: baseURL ends with '/chat/completions'. ` +
        `The OpenAI SDK automatically appends this path. ` +
        `Automatically stripping the suffix.`,
    );
    normalized = normalized.slice(0, -'/chat/completions'.length);
  }

  // 检测 /v1 后面是否有其他路径片段（可能是错误配置）
  const v1Match = normalized.match(/\/v1\/(?<suffix>.+)$/u);
  const suffix = v1Match?.groups?.suffix;
  if (suffix && !suffix.includes('/')) {
    // 只有一个路径片段在 /v1/ 之后，可能是模型 ID 或其他错误配置
    // eslint-disable-next-line no-console -- 配置错误需要明确告知用户
    console.warn(
      `[liskin] warning: baseURL contains unexpected path after '/v1/': '${suffix}'. ` +
        `Expected format: https://host/v1 or https://host/v1/responses. ` +
        `The SDK will append '/chat/completions' to this URL.`,
    );
  }

  return normalized;
}

export class OpenAIProvider implements LLMPort {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger: LoggerPort;

  constructor(options: OpenAIProviderOptions) {
    const normalizedBaseURL = normalizeBaseURL(options.baseURL);

    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: normalizedBaseURL,
      organization: options.organization,
      timeout: options.timeout,
      // 应修 #7：透传 maxRetries（不写默认值，让 SDK 内部默认 2 兜底）
      maxRetries: options.maxRetries,
    });
    this.model = options.model ?? DEFAULT_MODEL;
    this.logger = options.logger ?? new NoopLogger();
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<LLMEvent, void, void> {
    const startTime = Date.now();
    let firstTokenTime: number | null = null;
    let tokenCount = 0;
    const retries = 0; // OpenAI SDK 内部处理重试，此处暂不追踪

    try {
      if (req.signal?.aborted) {
        return;
      }

      const messages = toOpenAIMessages(req.messages);
      const { tools, nameMap } = toOpenAITools(req.tools);

      // 记录 LLM 请求开始
      this.logger.debug('llm.request', {
        model: this.model,
        message_count: messages.length,
        tool_count: tools?.length ?? 0,
      });

      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools ? { tools } : {}),
        },
        { signal: req.signal },
      );

      // 包装流以追踪 first token latency 和 token count
      const trackedStream = async function* (): AsyncGenerator<LLMEvent, void, void> {
        for await (const ev of parseOpenAIStream(stream, req.signal, nameMap)) {
          if (firstTokenTime === null && (ev.kind === 'token' || ev.kind === 'tool_call')) {
            firstTokenTime = Date.now();
          }
          if (ev.kind === 'token') {
            tokenCount++;
          }
          yield ev;
        }
      };

      let usage: { inputTokens?: number; outputTokens?: number } | undefined = undefined;
      for await (const ev of trackedStream()) {
        if (ev.kind === 'done') {
          ({ usage } = ev);
        }
        yield ev;
      }

      // 记录 LLM 响应完成
      const totalLatencyMs = Date.now() - startTime;
      const firstTokenLatencyMs = firstTokenTime ? firstTokenTime - startTime : undefined;
      const totalTokens = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : tokenCount;

      this.logger.debug('llm.response', {
        token_count: totalTokens,
        first_token_latency_ms: firstTokenLatencyMs,
        total_latency_ms: totalLatencyMs,
        retries,
      });
    } catch (error) {
      // 必修 #3：用户取消静默语义 — 归一化后若 code='aborted'，直接 return，不再 yield error
      const errorEvent = normalizeError(error);
      if (isAbortedEvent(errorEvent)) {
        return;
      }
      // 兼容老逻辑：如果 signal 已被 abort（普通 Error 也可能落到这里），同样静默
      if (req.signal?.aborted) {
        return;
      }

      // 记录错误响应
      const totalLatencyMs = Date.now() - startTime;
      this.logger.error('llm.response', {
        error_message: errorEvent.error.message,
        total_latency_ms: totalLatencyMs,
        retries,
      });

      yield errorEvent;
    }
  }
}
