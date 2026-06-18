import {
  ConfirmRequiredError,
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
}

interface ResolvedRegistryOptions {
  cwd: string;
  pathWhitelist: string[];
  confirmPolicy: ConfirmPolicy;
  builtins: ToolImpl[];
  signal?: AbortSignal;
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

    const ctx: ToolExecContext = {
      cwd: this.options.cwd,
      confirmPolicy: this.options.confirmPolicy,
      pathWhitelist: this.options.pathWhitelist,
      signal: this.options.signal,
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
        return {
          toolCallId: call.id,
          ok: false,
          content: `preflight error: ${(error as Error).message}`,
        };
      }
    }

    const callbacks: ToolExecCallbacks = opts?.onProgress ? { onProgress: opts.onProgress } : {};

    try {
      const content = await impl.execute(call.args, ctx, callbacks);
      return { toolCallId: call.id, ok: true, content };
    } catch (error) {
      return { toolCallId: call.id, ok: false, content: (error as Error).message };
    }
  }
}
