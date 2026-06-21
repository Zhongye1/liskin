import { z } from 'zod';

// —— Tool 基础类型 —— //

//   ToolDefinition { name, description, parameters }
//   ToolCall       { id, name, args }
//   ToolResult     { toolCallId, ok, content }

export const ToolCallSchema = z.object({
  args: z.record(z.unknown()).default({}),
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

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
