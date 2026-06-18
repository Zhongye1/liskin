import type { LLMEvent } from '@liskin/core';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { parseOpenAIStream } from '../src/openai/stream.js';

import { collect, makeChunk, mockChunks } from './_helpers.js';

describe('parseOpenAIStream', () => {
  it('TC1 — 纯文本流式', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      makeChunk({
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      { kind: 'token', text: 'Hel' },
      { kind: 'token', text: 'lo' },
      { kind: 'done', usage: { inputTokens: 7, outputTokens: 2 } },
    ]);
  });

  it('TC2 — 单个 tool_call 增量拼接', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'fs.read' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"pa' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
      makeChunk({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      {
        kind: 'tool_call',
        call: { id: 'call_1', name: 'fs.read', args: { path: 'a.ts' } },
      },
      { kind: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it('TC3 — 多个并行 tool_call', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_a',
                  type: 'function',
                  function: { name: 'fs.read', arguments: '{"path":"a.ts"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_b',
                  type: 'function',
                  function: { name: 'fs.write', arguments: '{"path":"b.ts"' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { arguments: ',"data":"x"}' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      {
        kind: 'tool_call',
        call: { id: 'call_a', name: 'fs.read', args: { path: 'a.ts' } },
      },
      {
        kind: 'tool_call',
        call: {
          id: 'call_b',
          name: 'fs.write',
          args: { path: 'b.ts', data: 'x' },
        },
      },
      { kind: 'done', usage: undefined },
    ]);
  });

  it('TC4 — token 与 tool_call 混合', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: 'thinking...' },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              content: ' calling tool',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_x',
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      { kind: 'token', text: 'thinking...' },
      { kind: 'token', text: ' calling tool' },
      {
        kind: 'tool_call',
        call: { id: 'call_x', name: 'noop', args: {} },
      },
      { kind: 'done', usage: undefined },
    ]);
  });

  it('TC5 — 非法 JSON 的 arguments：yield error 事件并跳过该 tool_call', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'broken', arguments: '{not json' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    // 应修 #6：不再 fallback {_raw}，改为 yield error 跳过该 pending
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      kind: 'error',
      error: { code: 'invalid_tool_args' },
    });
    if (events[0]?.kind === 'error') {
      expect(events[0].error.message).toContain('broken');
      expect(events[0].error.message).toContain('{not json');
    }
    expect(events[1]).toEqual<LLMEvent>({ kind: 'done', usage: undefined });
  });

  it('TC6 — AbortSignal 中途取消', async () => {
    const ac = new AbortController();
    const stream = (async function* (): AsyncGenerator<ChatCompletionChunk, void, void> {
      yield makeChunk({
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
      });
      ac.abort();
      yield makeChunk({
        choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }],
      });
      yield makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
    })();

    const events: LLMEvent[] = [];
    for await (const ev of parseOpenAIStream(stream, ac.signal)) {
      events.push(ev);
    }
    expect(events).toEqual<LLMEvent[]>([{ kind: 'token', text: 'a' }]);
  });
});
