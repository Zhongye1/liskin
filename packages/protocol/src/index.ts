// —— Tool 基础类型 + Schema —— //
export { ToolCallSchema, ToolResultSchema, ToolDefinitionSchema } from './tool-types.js';
export type { ToolCall, ToolResult, ToolDefinition } from './tool-types.js';

// —— Session —— //
export { SessionInfoSchema, SessionHandleSchema, SessionRecordSchema } from './session.js';
export type { SessionInfo, SessionHandle, SessionRecord } from './session.js';

// —— Op —— //
export { OpSchema } from './op.js';
export type { Op, SessionOp, SubmitOp } from './op.js';

// —— EventMsg —— //
export {
  EventMsgSchema,
  UsageSchema,
  NormalizedErrorSchema,
  TurnEndReasonSchema,
} from './event-msg.js';
export type { EventMsg, Usage, NormalizedError, TurnEndReason } from './event-msg.js';

// —— KernelClient 接口 —— //
export type { KernelClient } from './kernel-client.js';

// —— Wire 编解码 —— //
export {
  encodeOp,
  decodeOp,
  encodeEvent,
  decodeEvent,
  toSseFrame,
  PROTOCOL_VERSION,
} from './wire.js';
