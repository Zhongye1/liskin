import { z } from 'zod';

// —— Tool 相关类型（协议基础，无依赖）—— //

export const ToolCallSchema = z.object({
  args: z.unknown(),
  id: z.string(),
  name: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  content: z.string(),
  ok: z.boolean(),
  toolCallId: z.string(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
