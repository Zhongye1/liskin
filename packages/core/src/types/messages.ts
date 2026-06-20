import { z } from 'zod';
import { ToolCallSchema } from '@liskin/protocol';

// 从 protocol 重导出 tool 基础类型（兼容旧 import 路径）
export { ToolCallSchema, ToolResultSchema } from '@liskin/protocol';
export type { ToolCall, ToolResult, ToolDefinition } from '@liskin/protocol';

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export const MsgSchema = z.discriminatedUnion('role', [
  z.object({ content: z.string(), role: z.literal('system') }),
  z.object({ content: z.string(), role: z.literal('user') }),
  z.object({
    content: z.string(),
    role: z.literal('assistant'),
    toolCalls: z.array(ToolCallSchema).optional(),
  }),
  z.object({
    content: z.string(),
    role: z.literal('tool'),
    toolCallId: z.string(),
  }),
]);
export type Msg = z.infer<typeof MsgSchema>;
