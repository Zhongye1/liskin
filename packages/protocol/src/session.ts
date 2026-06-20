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

/** 持久化的会话记录（含完整消息历史）。Msg 具体类型由 core 定义，此处用 unknown。 */
export const SessionRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(z.unknown()),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
