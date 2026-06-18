import type { LLMEvent } from '@liskin/core';
import { describe, expect, it } from 'vitest';

import { parseOpenAIStream } from '../src/openai/stream.js';

import { collect, makeChunk, mockChunks } from './_helpers.js';

/**
 * stream 解析的边界场景：
 *  - finish_reason=length / content_filter（必修 #1）
 *  - 流自然结束 + 残留 pending（必修 #2 incomplete_stream）
 *  - drainPending 跳过缺 id/name 的 pending（必修 #2）
 *  - 多 tool_call 中部分 JSON.parse 失败（应修 #6）
 *
 * 拆分自 openai.test.ts 仅为满足单文件 max-lines 约束。
 */
describe('parseOpenAIStream — 边界场景', () => {
  it('TC5b — 多 tool_call 中只有一个 JSON 失败：失败的跳过 + error 事件，其他正常', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ok',
                  type: 'function',
                  function: { name: 'ok', arguments: '{"a":1}' },
                },
                {
                  index: 1,
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'bad', arguments: '{not json' },
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
      {
        kind: 'tool_call',
        call: { id: 'call_ok', name: 'ok', args: { a: 1 } },
      },
      {
        kind: 'error',
        error: {
          code: 'invalid_tool_args',
          message: 'invalid tool args JSON for tool bad: {not json',
        },
      },
      { kind: 'done', usage: undefined },
    ]);
  });

  it('TC10 — finish_reason=length 抬升为 error，不 yield done，不 drain pending', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      }),
      // 残缺 tool_call：仅有 args 片段，没有 id/name —— 这种 pending 不能被输出
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"x":' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      }),
      // 这一帧虽然带 usage，但因为 length 已经触发 return，永远不会被读取
      makeChunk({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      { kind: 'token', text: 'partial' },
      { kind: 'error', error: { message: 'output length', code: 'length' } },
    ]);
    expect(events.some((e) => e.kind === 'done')).toBe(false);
  });

  it('TC11 — finish_reason=content_filter 抬升为 error', async () => {
    const stream = mockChunks([
      makeChunk({
        choices: [{ index: 0, delta: { content: 'unsafe' }, finish_reason: null }],
      }),
      makeChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      { kind: 'token', text: 'unsafe' },
      {
        kind: 'error',
        error: { message: 'output content_filter', code: 'content_filter' },
      },
    ]);
    expect(events.some((e) => e.kind === 'done')).toBe(false);
  });

  it('TC12 — 流自然结束 + 残留 pending → incomplete_stream，不 yield done', async () => {
    // 不下发 finish_reason，直接断流，但 pending 已经存在
    const stream = mockChunks([
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_z',
                  type: 'function',
                  function: { name: 'half', arguments: '{"k":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ]);

    const events = await collect(parseOpenAIStream(stream));
    expect(events).toEqual<LLMEvent[]>([
      {
        kind: 'error',
        error: {
          code: 'incomplete_stream',
          message: 'stream ended before tool_call completion',
        },
      },
    ]);
    expect(events.some((e) => e.kind === 'done')).toBe(false);
  });

  it('TC13 — drainPending 跳过缺 id/name 的 pending（其他正常输出）', async () => {
    const stream = mockChunks([
      // index=0 完整：有 id/name/args
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ok',
                  type: 'function',
                  function: { name: 'ok', arguments: '{"a":1}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      // index=1 残缺：只有 arguments，没有 id 与 name
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { arguments: '{"y":2}' } }],
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
        call: { id: 'call_ok', name: 'ok', args: { a: 1 } },
      },
      { kind: 'done', usage: undefined },
    ]);
  });
});
