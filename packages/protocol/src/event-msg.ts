import { z } from 'zod';

import { SessionInfoSchema } from './session.js';
import { ToolCallSchema, ToolResultSchema } from './tool-types.js';

// —— 辅助 —— //

export const UsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const NormalizedErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});
export type NormalizedError = z.infer<typeof NormalizedErrorSchema>;

export const TurnEndReasonSchema = z.enum([
  'completed',
  'interrupted',
  'max_turns',
  'error',
  'cancelled',
]);
export type TurnEndReason = z.infer<typeof TurnEndReasonSchema>;

// —— EventMsg：内核 → 客户端 —— //

export const EventMsgSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SessionCreated'),
    sessionId: z.string(),
    createdAt: z.string(),
    isNew: z.boolean(),
  }),
  z.object({
    type: z.literal('SessionResumed'),
    sessionId: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal('SessionClosed'),
    sessionId: z.string(),
    reason: z.enum(['user', 'error']),
  }),
  z.object({
    type: z.literal('SessionList'),
    sessions: z.array(SessionInfoSchema),
  }),
  z.object({
    type: z.literal('TurnStart'),
    turnId: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('TurnEnd'),
    turnId: z.string(),
    sessionId: z.string(),
    reason: TurnEndReasonSchema,
    usage: UsageSchema.optional(),
  }),
  z.object({
    type: z.literal('Token'),
    turnId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('ToolCall'),
    turnId: z.string(),
    call: ToolCallSchema,
  }),
  z.object({
    type: z.literal('ToolProgress'),
    turnId: z.string(),
    callId: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal('ToolResult'),
    turnId: z.string(),
    result: ToolResultSchema,
  }),
  z.object({
    type: z.literal('ToolConfirmRequired'),
    turnId: z.string(),
    call: ToolCallSchema,
  }),
  z.object({
    type: z.literal('Error'),
    turnId: z.string().optional(),
    sessionId: z.string().optional(),
    error: NormalizedErrorSchema,
  }),
]);
export type EventMsg = z.infer<typeof EventMsgSchema>;
