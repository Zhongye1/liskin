import type { Msg, ToolDefinition } from '@liskin/core';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

// —— 工具名规范化 —— //

/**
 * OpenAI 兼容 API 要求工具名只含 [a-zA-Z0-9_-]。
 * 把非法字符替换为下划线，合并连续下划线，限长 64。
 */
export function sanitizeToolName(name: string): string {
  return name
    .replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    .replaceAll(/_+/g, '_')
    .slice(0, 64);
}

/** sanitized → original 的反向映射表 */
export type ToolNameMap = Map<string, string>;

/**
 * 根据原始名反查，找不到则返回原名。
 * 用于 tool_call 响应从 sanitized 名还原为 ToolRegistry 能识别的原名。
 */
export function resolveOriginalName(sanitized: string, map?: ToolNameMap): string {
  if (!map || map.size === 0) {return sanitized;}
  return map.get(sanitized) ?? sanitized;
}

// —— Msg / Tool 序列化 —— //

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
          // 消息里的 tool_call name 也需要 sanitize：
          // 流解析时 desanitize 回了原名（fs.read），再次发给 API 必须规范化
          name: sanitizeToolName(c.name),
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

export function toOpenAIMessages(messages: Msg[]): ChatCompletionMessageParam[] {
  return messages.map((m) => msgToOpenAI(m));
}

/** toOpenAITools 的返回值：规范化后的 tools 数组 + sanitized→original 映射表。 */
export interface NormalizedTools {
  tools: ChatCompletionTool[] | undefined;
  nameMap: ToolNameMap;
}

/**
 * 把内核的 `ToolDefinition[]` 翻译为 OpenAI 的 `tools` 字段，
 * 同时对 tool name 做规范化（只保留 [a-zA-Z0-9_-]），
 * 并返回 sanitized→original 反向映射供流解析时还原。
 */
export function toOpenAITools(tools?: ToolDefinition[]): NormalizedTools {
  const nameMap: ToolNameMap = new Map();
  if (!tools || tools.length === 0) {
    return { tools: undefined, nameMap };
  }

  const result: ChatCompletionTool[] = [];
  for (const t of tools) {
    const sanitized = sanitizeToolName(t.name);
    if (sanitized !== t.name) {
      nameMap.set(sanitized, t.name);
    }
    result.push({
      type: 'function',
      function: {
        name: sanitized,
        description: t.description,
        parameters: t.parameters,
      },
    });
  }
  return { tools: result, nameMap };
}
