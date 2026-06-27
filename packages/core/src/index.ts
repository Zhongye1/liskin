// L1 Agent Core: state machine + harness + context management
// MUST NOT depend on @liskin/llm, @liskin/tools, @liskin/server, @liskin/client

export const __VERSION__ = '0.0.0';

// —— 类型 —— //
export type { Role, ToolCall, ToolResult, Msg, ToolDefinition } from './types/messages.js';
export { RoleSchema, ToolCallSchema, ToolResultSchema, MsgSchema } from './types/messages.js';

export type { LLMEvent, AgentEvent, AgentStatus } from './types/events.js';

// —— Ports —— //
export type {
  LLMPort,
  ChatRequest,
  ToolPort,
  ToolInvokeOptions,
  StorePort,
  SessionRecord,
  SessionSummary,
  LoggerPort,
  LogLevel,
  LogContext,
  LogEntry,
} from './ports/index.js';
export { ConfirmRequiredError, NoopLogger } from './ports/index.js';

// —— Harness —— //
export type { HarnessPort } from './harness/index.js';
export { NoopHarness } from './harness/index.js';

// —— Agent —— //
export type { AgentState, RunAgentOptions } from './agent/index.js';
export { runAgent } from './agent/index.js';

// —— Context —— //
export { applyBudget } from './context/budget.js';

// —— Provider config —— //
export type { ProviderProtocol, ProviderConfig } from './types/provider.js';
export { ProviderProtocolSchema, ProviderConfigSchema } from './types/provider.js';

// —— Kernel ↔ Client（外层协议）—— //
export type {
  Op,
  SessionOp,
  EventMsg,
  SessionInfo,
  SessionHandle,
  Usage,
  NormalizedError,
  TurnEndReason,
  KernelClient,
  SubmitOp,
} from './kernel/index.js';
export { InProcessKernelClient, InMemoryStore, AsyncQueue, Deferred } from './kernel/index.js';
export type { InProcessKernelOptions } from './kernel/index.js';
