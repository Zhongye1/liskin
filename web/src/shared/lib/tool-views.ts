import type { ToolCall } from '@liskin/core';

/** 工具参数语义化展示：shell 显示命令，fs 显示路径，其余 JSON。 */
export function formatToolArgs(call: ToolCall): string {
  const {args} = call;
  if (typeof args !== 'object' || args === null) {return '';}
  const obj = args as Record<string, unknown>;
  if (typeof obj.cmd === 'string') {return `$ ${obj.cmd}`;}
  if (typeof obj.path === 'string') {return obj.path;}
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}
