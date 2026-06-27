import {
  ConfirmRequiredError,
  type LoggerPort,
  NoopLogger,
  type ToolCall,
  type ToolDefinition,
  type ToolInvokeOptions,
  type ToolPort,
  type ToolResult,
} from '@liskin/core';

import { builtins as defaultBuiltins } from './builtin/index.js';
import type { ConfirmPolicy } from './sandbox/confirm-policy.js';
import type { ToolExecCallbacks, ToolExecContext, ToolImpl } from './types.js';

export type { ToolExecCallbacks, ToolExecContext, ToolImpl } from './types.js';

export interface ToolRegistryOptions {
  cwd: string;
  pathWhitelist?: string[];
  confirmPolicy?: ConfirmPolicy;
  builtins?: ToolImpl[];
  signal?: AbortSignal;
  /** 可选：结构化日志器，用于记录工具调用事件 */
  logger?: LoggerPort;
}

interface ResolvedRegistryOptions {
  cwd: string;
  pathWhitelist: string[];
  confirmPolicy: ConfirmPolicy;
  builtins: ToolImpl[];
  signal?: AbortSignal;
  logger: LoggerPort;
}

export class ToolRegistry implements ToolPort {
  private readonly tools = new Map<string, ToolImpl>();
  private readonly options: ResolvedRegistryOptions;

  constructor(options: ToolRegistryOptions) {
    this.options = {
      cwd: options.cwd,
      pathWhitelist: options.pathWhitelist ?? [options.cwd],
      confirmPolicy: options.confirmPolicy ?? 'ask',
      builtins: options.builtins ?? defaultBuiltins,
      signal: options.signal,
      logger: options.logger ?? new NoopLogger(),
    };
    for (const t of this.options.builtins) {
      this.register(t);
    }
  }

  register(impl: ToolImpl): void {
    if (this.tools.has(impl.definition.name)) {
      throw new Error(`tool name collision: ${impl.definition.name}`);
    }
    this.tools.set(impl.definition.name, impl);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async invoke(call: ToolCall, opts?: ToolInvokeOptions): Promise<ToolResult> {
    const impl = this.tools.get(call.name);
    if (!impl) {
      return { toolCallId: call.id, ok: false, content: `unknown tool: ${call.name}` };
    }

    // 派生带 tool_call_id 的 logger
    const toolLogger = this.options.logger.with({ tool_call_id: call.id });

    // 记录工具调用开始
    const argsSummary = this.summarizeArgs(call.args);
    toolLogger.info('tool.call', { tool_name: call.name, args_summary: argsSummary });

    const ctx: ToolExecContext = {
      cwd: this.options.cwd,
      confirmPolicy: this.options.confirmPolicy,
      pathWhitelist: this.options.pathWhitelist,
      signal: this.options.signal,
      logger: toolLogger,
    };

    const skipConfirm = opts?.confirmedCallId === call.id;

    if (impl.preflight) {
      const preflightCtx: ToolExecContext = skipConfirm ? { ...ctx, confirmPolicy: 'auto' } : ctx;
      try {
        impl.preflight(call, preflightCtx);
      } catch (error) {
        if (error instanceof ConfirmRequiredError) {
          throw error;
        }
        const result = {
          toolCallId: call.id,
          ok: false,
          content: `preflight error: ${(error as Error).message}`,
        };
        toolLogger.info('tool.result', {
          tool_name: call.name,
          ok: false,
          error_message: (error as Error).message,
        });
        return result;
      }
    }

    const callbacks: ToolExecCallbacks = opts?.onProgress ? { onProgress: opts.onProgress } : {};

    const startTime = Date.now();
    try {
      const content = await impl.execute(call.args, ctx, callbacks);
      const durationMs = Date.now() - startTime;
      const result = { toolCallId: call.id, ok: true, content };
      toolLogger.info('tool.result', {
        tool_name: call.name,
        ok: true,
        duration_ms: durationMs,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const result = { toolCallId: call.id, ok: false, content: (error as Error).message };
      toolLogger.info('tool.result', {
        tool_name: call.name,
        ok: false,
        error_message: (error as Error).message,
        duration_ms: durationMs,
      });
      return result;
    }
  }

  /** 生成参数摘要，避免记录敏感数据。 */
  private summarizeArgs(args: unknown): string {
    if (args === null || args === undefined) {
      return '';
    }
    if (typeof args === 'object') {
      const keys = Object.keys(args as Record<string, unknown>);
      if (keys.length <= 3) {
        return keys.join(', ');
      }
      return `${keys.length} fields`;
    }
    return typeof args;
  }
}
