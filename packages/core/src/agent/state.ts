import type { ToolCall } from '../types/messages.js';

/**
 * Agent 状态机内部状态。
 * 注意：M1 的 runAgent 主循环是 async generator，状态以局部变量推进；
 * 这里的类型主要用于上层（server）描述/同步当前 Agent 处于哪个阶段。
 */
export type AgentState =
  | { status: 'idle' }
  | { status: 'streaming' }
  | { status: 'awaiting_tool'; pendingCalls: ToolCall[] }
  | { status: 'awaiting_user'; confirmCall: ToolCall }
  | { status: 'done'; reason: 'completed' | 'max_turns' | 'cancelled' }
  | { status: 'error'; error: { message: string; code?: string } };
