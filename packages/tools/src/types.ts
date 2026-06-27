import type { LoggerPort, ToolCall, ToolDefinition } from '@liskin/core';

import type { ConfirmPolicy } from './sandbox/confirm-policy.js';

export interface ToolExecContext {
  cwd: string;
  signal?: AbortSignal;
  confirmPolicy: ConfirmPolicy;
  pathWhitelist: string[];
  /** 可选：结构化日志器，用于记录工具执行事件 */
  logger?: LoggerPort;
}

export interface ToolExecCallbacks {
  /** 流式工具用，把 stdout/stderr chunk 推回给 caller。 */
  onProgress?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface ToolImpl {
  definition: ToolDefinition;
  /**
   * 入参由实现内部用 zod 校验。失败抛 Error 或返回 ok:false。
   * callbacks 可选；普通工具忽略即可。
   */
  execute(args: unknown, ctx: ToolExecContext, callbacks?: ToolExecCallbacks): Promise<string>;
  /**
   * 在执行前做沙箱判断：
   *   - 校验入参
   *   - 检查路径/命令白名单
   *   - 触发 ConfirmRequiredError（敏感工具）
   * 抛出 ConfirmRequiredError 时由 registry 透传。
   */
  preflight?(call: ToolCall, ctx: ToolExecContext): void;
}
