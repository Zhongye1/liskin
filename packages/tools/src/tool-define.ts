/**
 * Tool 抽象层 — Tool.define()。
 *
 * 在现有 ToolImpl（define/execute/preflight）之上增加：
 *   - ToolExecResult：结构化返回（output + metadata + attachments）
 *   - InvalidArgumentsError：参数校验失败的标准化错误（给 LLM 的 "rewrite" 提示）
 *   - defineTool()：工厂函数，自动推断入参类型
 *
 * 向后兼容：ToolImpl 的 execute 返回 string 仍可正常工作，ToolRegistry 自动包装。
 */
import type { ToolCall, ToolDefinition } from '@liskin/core';

import type { ToolExecCallbacks, ToolExecContext, ToolImpl } from './types.js';

// —— 结构化返回 —— //

export interface ToolExecResult {
  /** 模型可见的输出文本（必填） */
  output: string;
  /**
   * 结构化元数据（可选）。
   * 用于 UI 渲染提示：truncated / totalLines / display 等。
   * 不直接发给模型——模型只看 output。
   */
  metadata?: Record<string, unknown>;
  /**
   * 附件（可选）。图片、PDF 等 base64 data URL。
   */
  attachments?: {
    type: 'file';
    mime: string;
    url: string;
  }[];
}

// —— 参数校验错误 —— //

/**
 * 参数校验失败的标准化错误。
 * message 格式设计为对 LLM 友好，提示它 "rewrite the input"。
 */
export class InvalidArgumentsError extends Error {
  public readonly detail: string;

  constructor(toolName: string, detail: string) {
    super(
      `The ${toolName} tool was called with invalid arguments: ${detail}.\nPlease rewrite the input so it satisfies the expected schema.`,
    );
    this.name = 'InvalidArgumentsError';
    this.detail = detail;
  }
}

// —— 优化后的工具执行上下文 —— //

export interface ToolContext extends ToolExecContext {
  /** 本次工具调用的唯一 ID（由 LLM 生成） */
  callId?: string;
  /**
   * 写入结构化元数据（供 UI 渲染）。
   * 与 execute 返回的 output 互补——output 给模型看，metadata 给 UI 看。
   */
  setMetadata?(meta: Record<string, unknown>): void;
}

// —— 定义工厂 —— //

/**
 * 定义一个工具。
 *
 * 返回值满足 ToolImpl 接口，可直接注册到 ToolRegistry。
 * P 是入参的 zod schema 类型，工厂自动提供 execute 的 args 类型推断。
 *
 * @example
 * const fsRead = defineTool({
 *   name: 'fs_read',
 *   description: 'Read a file',
 *   parameters: { type: 'object', properties: { path: { type: 'string' } } },
 *   argsSchema: FsReadArgs,  // zod schema，自动推断 P
 *   preflight(call, ctx) { ... },
 *   async execute(args, ctx) {
 *     // args 自动类型推断为 z.infer<typeof FsReadArgs>
 *     return { output: 'content', metadata: { truncated: false } };
 *   },
 * });
 */
export interface ToolDef<P = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** zod schema，用于 execute 的类型推断 + 参数校验 */
  argsSchema?: {
    parse: (v: unknown) => P;
    safeParse?(
      v: unknown,
    ): { success: true; data: P } | { success: false; error: { issues?: { message: string }[] } };
  };
  preflight?(call: ToolCall, ctx: ToolExecContext): void;
  execute(
    args: P,
    ctx: ToolContext,
    callbacks?: ToolExecCallbacks,
  ): Promise<string | ToolExecResult>;
}

export function defineTool<P>(def: ToolDef<P>): ToolImpl {
  return {
    definition: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    } satisfies ToolDefinition,

    preflight: def.preflight,

    async execute(
      rawArgs: unknown,
      rawCtx: ToolExecContext,
      callbacks?: ToolExecCallbacks,
    ): Promise<string> {
      // 1. 参数校验（如果有 schema）
      let args = rawArgs as P;
      if (def.argsSchema) {
        if (def.argsSchema.safeParse) {
          const parsed = def.argsSchema.safeParse(rawArgs);
          if (!parsed.success) {
            const detail = parsed.error?.issues?.map((i) => i.message).join('; ') ?? 'unknown';
            throw new InvalidArgumentsError(def.name, detail);
          }
          args = parsed.data;
        } else {
          try {
            args = def.argsSchema.parse(rawArgs);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new InvalidArgumentsError(def.name, detail);
          }
        }
      }

      // 2. 构建增强上下文
      const meta: Record<string, unknown> = {};
      const ctx: ToolContext = {
        ...rawCtx,
        setMetadata(m: Record<string, unknown>) {
          Object.assign(meta, m);
        },
      };

      // 3. 执行
      const result = await def.execute(args, ctx, callbacks);

      // 4. 标准化返回
      if (typeof result === 'string') {
        return result;
      }
      // ToolExecResult → 把 metadata 编码进 output（LLM 不可见），
      // 或者通过 setMetadata 回调传递给调用方。
      // 当前 ToolRegistry 只消费 string，metadata 通过 ctx.setMetadata 附着。
      return result.output;
    },
  };
}
