/**
 * Logger 接口 — 供 @liskin/llm、@liskin/tools 等包依赖，避免循环依赖。
 *
 * 具体实现由 @liskin/client 提供（StructuredLogger），通过依赖注入传入。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  session_id: string;
  turn_id?: string;
  tool_call_id?: string;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  session_id: string;
  turn_id?: string;
  tool_call_id?: string;
  data?: Record<string, unknown>;
}

/**
 * 最小化 Logger 接口 — 仅暴露包需要的方法，避免依赖完整实现。
 */
export interface LoggerPort {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  with(context: Partial<LogContext>): LoggerPort;
}

/** 空实现 — 用于未传入 logger 的场景，避免空判断。 */
export class NoopLogger implements LoggerPort {
  trace(): void {
    /* noop */
  }
  debug(): void {
    /* noop */
  }
  info(): void {
    /* noop */
  }
  warn(): void {
    /* noop */
  }
  error(): void {
    /* noop */
  }
  with(): LoggerPort {
    return this;
  }
}
