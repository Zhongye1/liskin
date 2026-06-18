import type { Msg, ToolDefinition } from '@liskin/core';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

function msgToOpenAI(m: Msg): ChatCompletionMessageParam {
  switch (m.role) {
    case 'system': {
      return { role: 'system', content: m.content };
    }
    case 'user': {
      return { role: 'user', content: m.content };
    }
    case 'assistant': {
      const toolCalls = m.toolCalls?.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.name,
          arguments: JSON.stringify(c.args ?? {}),
        },
      }));
      return {
        role: 'assistant',
        content: m.content === '' ? null : m.content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case 'tool': {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
  }
}

/**
 * 把内核的 `Msg[]` 翻译为 OpenAI 的 `ChatCompletionMessageParam[]`。
 *
 * - assistant 消息没有 content 时（仅 tool_calls）使用 `null`，符合 OpenAI 协议
 * - tool_calls 的 args 必须序列化为字符串
 */
export function toOpenAIMessages(messages: Msg[]): ChatCompletionMessageParam[] {
  return messages.map((m) => msgToOpenAI(m));
}

/**
 * 把内核的 `ToolDefinition[]` 翻译为 OpenAI 的 `tools` 字段。
 * 空数组或 undefined 都返回 undefined（让 OpenAI 不带 tools 字段）。
 */
export function toOpenAITools(tools?: ToolDefinition[]): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
