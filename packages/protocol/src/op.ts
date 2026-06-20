import { z } from 'zod';

// —— Op：客户端 → 内核 —— //

export const OpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CreateSession'),
    cwd: z.string().optional(),
    providerId: z.string().optional(),
    system: z.string().optional(),
  }),
  z.object({ type: z.literal('ResumeSession'), sessionId: z.string() }),
  z.object({ type: z.literal('CloseSession'), sessionId: z.string() }),
  z.object({ type: z.literal('ListSessions') }),
  z.object({
    type: z.literal('UserTurn'),
    sessionId: z.string(),
    content: z.string(),
    maxTurns: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('Interrupt'), sessionId: z.string() }),
  z.object({
    type: z.literal('ConfirmTool'),
    sessionId: z.string(),
    callId: z.string(),
    decision: z.enum(['approve', 'deny']),
  }),
  z.object({ type: z.literal('Cancel'), sessionId: z.string() }),
]);
export type Op = z.infer<typeof OpSchema>;

/** 带会话上下文的 Op。 */
export type SessionOp = Extract<
  Op,
  | { type: 'ResumeSession' }
  | { type: 'CloseSession' }
  | { type: 'UserTurn' }
  | { type: 'Interrupt' }
  | { type: 'ConfirmTool' }
  | { type: 'Cancel' }
>;

/** submit 接受的 Op 子集。 */
export type SubmitOp = Extract<Op, { type: 'UserTurn' }>;
