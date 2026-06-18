import type { ToolCall, ToolDefinition, ToolResult } from '../types/messages.js';

/**
 * Sandbox 决定先抛出 ConfirmRequiredError，把决定权交回上层（server）。
 * 上层根据用户回复，再次调用 invoke 时通过 confirmedCallId 跳过确认。
 */
export class ConfirmRequiredError extends Error {
  public readonly call: ToolCall;
  constructor(call: ToolCall) {
    super(`Confirmation required for tool: ${call.name}`);
    this.name = 'ConfirmRequiredError';
    this.call = call;
  }
}

export interface ToolInvokeOptions {
  /** 已被用户确认的 call id；命中则不再触发 ConfirmRequiredError */
  confirmedCallId?: string;
  /** 流式工具进度回调（如 shell.exec 实时 stdout/stderr）；可选 */
  onProgress?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface ToolPort {
  list(): ToolDefinition[];
  /**
   * 执行工具。可能抛出 ConfirmRequiredError；其他错误以 result.ok=false 形式返回。
   */
  invoke(call: ToolCall, opts?: ToolInvokeOptions): Promise<ToolResult>;
}
