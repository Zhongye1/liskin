import type { ChatRequest, LLMEvent, LLMPort } from '@liskin/core';
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { OpenAIProvider } from '../src/openai/provider.js';

import { collect, makeChunk, mockChunks } from './_helpers.js';

interface FakeCreateBody {
  model: string;
  messages: unknown;
  tools?: unknown;
}

interface FakeOpenAIClient {
  chat: {
    completions: {
      create: (
        body: FakeCreateBody,
        opts?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

/**
 * 通过子类替换底层 client.chat.completions.create，避免真实 HTTP 调用。
 * 以「LLMPort」类型来保证 OpenAIProvider 仍满足端口约束。
 */
class FakeProvider extends OpenAIProvider {
  public lastSignal: AbortSignal | undefined;
  public lastBody: FakeCreateBody | undefined;

  constructor(chunks: ChatCompletionChunk[] | (() => Promise<AsyncIterable<ChatCompletionChunk>>)) {
    super({ apiKey: 'test-key' });
    const fakeCreate = (
      body: FakeCreateBody,
      opts?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<ChatCompletionChunk>> => {
      this.lastBody = body;
      this.lastSignal = opts?.signal;
      if (typeof chunks === 'function') {
        return chunks();
      }
      return Promise.resolve(mockChunks(chunks));
    };
    (this as unknown as { client: FakeOpenAIClient }).client = {
      chat: { completions: { create: fakeCreate } },
    };
  }
}

describe('OpenAIProvider — chatStream 集成', () => {
  it('TC9 — Provider 端到端：纯文本 → token + done', async () => {
    const provider: LLMPort = new FakeProvider([
      makeChunk({
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      makeChunk({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ]);

    const req: ChatRequest = {
      messages: [{ role: 'user', content: 'hi' }],
    };
    const events = await collect(provider.chatStream(req));
    expect(events).toEqual<LLMEvent[]>([
      { kind: 'token', text: 'hi' },
      { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it('TC9b — Provider 在 APIUserAbortError 时静默返回，不 yield error', async () => {
    const provider: LLMPort = new FakeProvider(() =>
      Promise.reject(new APIUserAbortError({ message: 'aborted by user' })),
    );

    const events = await collect(
      provider.chatStream({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    // 必修 #3：取消静默语义 — 不应有任何 error 事件
    expect(events.length).toBe(0);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('TC9c — Provider 在 APIConnectionTimeoutError 时 yield error{code:timeout}', async () => {
    const provider: LLMPort = new FakeProvider(() =>
      Promise.reject(new APIConnectionTimeoutError({ message: 'request timed out' })),
    );

    const events = await collect(
      provider.chatStream({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      kind: 'error',
      error: { code: 'timeout' },
    });
  });

  it('TC9d — Provider 在 APIError 401 时透传 unauthorized: <serverMsg>', async () => {
    const apiErr = APIError.generate(
      401,
      { error: { message: 'Invalid API key' } },
      'fallback',
      {} as never,
    );
    const provider: LLMPort = new FakeProvider(() => Promise.reject(apiErr));

    const events = await collect(
      provider.chatStream({ messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events.length).toBe(1);
    expect(events[0]).toEqual<LLMEvent>({
      kind: 'error',
      error: { message: 'unauthorized: Invalid API key', code: '401' },
    });
  });

  it('TC9e — maxRetries 透传给底层 OpenAI 客户端', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', maxRetries: 7 });
    // OpenAI 类（继承 APIClient）将 maxRetries 暴露在实例属性上
    const { client } = provider as unknown as { client: { maxRetries: number } };
    expect(client.maxRetries).toBe(7);
  });

  it('TC9f — 不传 maxRetries 时使用 SDK 默认值（=2）', () => {
    const provider = new OpenAIProvider({ apiKey: 'test' });
    const { client } = provider as unknown as { client: { maxRetries: number } };
    expect(client.maxRetries).toBe(2);
  });
});
