import type { ChatRequest, LLMEvent, LLMPort } from '@liskin/core';
import OpenAI from 'openai';

import { isAbortedEvent, normalizeError } from './errors.js';
import { parseOpenAIStream } from './stream.js';
import { toOpenAIMessages, toOpenAITools } from './translate.js';
import type { OpenAIProviderOptions } from './types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

export class OpenAIProvider implements LLMPort {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      organization: options.organization,
      timeout: options.timeout,
      // 应修 #7：透传 maxRetries（不写默认值，让 SDK 内部默认 2 兜底）
      maxRetries: options.maxRetries,
    });
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<LLMEvent, void, void> {
    try {
      if (req.signal?.aborted) {
        return;
      }

      const messages = toOpenAIMessages(req.messages);
      const { tools, nameMap } = toOpenAITools(req.tools);

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

      yield* parseOpenAIStream(stream, req.signal, nameMap);
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
      yield errorEvent;
    }
  }
}
