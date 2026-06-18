import { z } from 'zod';

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export const ToolCallSchema = z.object({
  args: z.unknown(), // 工具入参，由 LLM 生成
  id: z.string(),
  name: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  content: z.string(), // 工具结果文本（成功 or 错误）
  ok: z.boolean(),
  toolCallId: z.string(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}
