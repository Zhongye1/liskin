import type { ToolCall, ToolResult } from './messages.js';

// LLM 层往 core 抛的事件（LLMPort 输出）
export type LLMEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'tool_progress'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { kind: 'error'; error: { message: string; code?: string; stack?: string } };

// Agent 层对外抛的事件（runAgent 输出）— 包含 LLM 转发 + 工具结果 + 状态变化
export type AgentEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'tool_progress'; callId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'tool_result'; result: ToolResult }
  | { kind: 'tool_confirm_required'; call: ToolCall } // Sandbox 拦截，等用户确认
  | { kind: 'done'; reason: 'completed' | 'max_turns' | 'cancelled' }
  | { kind: 'error'; error: { message: string; code?: string; stack?: string } };

export type AgentStatus =
  | 'idle'
  | 'streaming'
  | 'awaiting_tool'
  | 'awaiting_user'
  | 'done'
  | 'error';
