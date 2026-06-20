import { z } from 'zod';

// —— 会话元信息 —— //

export const SessionInfoSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionHandleSchema = SessionInfoSchema.extend({
  isNew: z.boolean(),
});
export type SessionHandle = z.infer<typeof SessionHandleSchema>;
