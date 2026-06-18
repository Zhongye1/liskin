import type { Msg, ToolDefinition } from '@liskin/core';
import { describe, expect, it } from 'vitest';

import { toOpenAIMessages, toOpenAITools } from '../src/openai/translate.js';

describe('translate', () => {
  it('TC8a — toOpenAIMessages 处理 system/user/tool/assistant(含 toolCalls)', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'reading file',
        toolCalls: [{ id: 'c1', name: 'fs.read', args: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'file contents' },
    ];
    const out = toOpenAIMessages(msgs);

    expect(out[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out[2]).toMatchObject({
      role: 'assistant',
      content: 'reading file',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'fs.read', arguments: '{"path":"a.ts"}' },
        },
      ],
    });
    expect(out[3]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'file contents',
    });
  });

  it('TC8b — assistant 无 content（仅 tool_calls）→ content: null', () => {
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'noop', args: {} }],
      },
    ];
    const out = toOpenAIMessages(msgs);
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: null,
    });
  });

  it('TC8c — toOpenAITools 转换 + 空数组 / 缺省都返回 undefined', () => {
    expect(toOpenAITools()).toBeUndefined();
    expect(toOpenAITools([])).toBeUndefined();

    const tools: ToolDefinition[] = [
      {
        name: 'fs.read',
        description: 'read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ];
    const out = toOpenAITools(tools);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'fs.read',
          description: 'read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      },
    ]);
  });
});
