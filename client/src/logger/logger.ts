import type {
  LogContext,
  LogLevel,
  LogEntry,
  LoggerPort,
  LoggerOptions,
  RingBufferOptions,
  Sink,
} from './types.js';
import { LEVEL_ORDER } from './types.js';

import { RingBuffer } from './ring-buffer.js';
import { ConsoleSink, FileSink, TelemetrySink } from './sinks.js';

// —— StructuredLogger —— //

/**
 * 结构化日志器。
 * 支持 5 个级别，with() 派生子 logger 自动注入上下文。
 */
export class StructuredLogger implements LoggerPort {
  private readonly context: LogContext;
  private readonly level: LogLevel;
  /** @internal — 子 logger 共享父 logger 的 buffer，避免重复 flush */
  protected readonly buffer: RingBuffer;
  private readonly sinks: Sink[];
  private readonly verbose: boolean;
  private readonly fileSink?: FileSink;
  private readonly isChild: boolean;

  private constructor(
    context: LogContext,
    opts: LoggerOptions,
    bufferOrChildOpts?: RingBufferOptions | { buffer: RingBuffer; fileSink?: FileSink },
  ) {
    this.context = context;
    this.level = opts.level;
    this.sinks = opts.sinks;
    this.verbose = opts.verbose ?? false;

    // 判断是创建新 buffer 还是共享已有 buffer
    if (bufferOrChildOpts && 'buffer' in bufferOrChildOpts) {
      // 子 logger：共享已有 buffer
      this.buffer = bufferOrChildOpts.buffer;
      this.fileSink = bufferOrChildOpts.fileSink;
      this.isChild = true;
    } else {
      // root logger：创建新 buffer
      const bufferOpts = (bufferOrChildOpts as RingBufferOptions) ?? {};
      const defaultBufferOpts: Required<RingBufferOptions> = {
        capacity: bufferOpts.capacity ?? 1000,
        flushThreshold: bufferOpts.flushThreshold ?? 50,
        flushIntervalMs: bufferOpts.flushIntervalMs ?? 1000,
      };
      this.buffer = new RingBuffer(this.sinks, defaultBufferOpts, this.verbose);
      this.fileSink = this.sinks.find((s) => s instanceof FileSink) as FileSink | undefined;
      this.isChild = false;
      this.setupShutdownHandlers();
    }
  }

  /** 创建 root logger（公开工厂方法）。 */
  static create(
    context: LogContext,
    opts: LoggerOptions,
    bufferOpts: RingBufferOptions = {},
  ): StructuredLogger {
    return new StructuredLogger(context, opts, bufferOpts);
  }

  private setupShutdownHandlers(): void {
    // 只有 root logger 设置 shutdown 处理，避免重复注册
    if (this.isChild) {
      return;
    }

    const shutdown = async (): Promise<void> => {
      await this.buffer.close();
    };

    process.on('SIGINT', () => {
      void shutdown().finally(() => process.exit(130));
    });

    process.on('beforeExit', () => {
      void shutdown();
    });
  }

  trace(message: string, data?: Record<string, unknown>): void {
    this.log('trace', message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      session_id: this.context.session_id,
      ...(this.context.turn_id ? { turn_id: this.context.turn_id } : {}),
      ...(this.context.tool_call_id ? { tool_call_id: this.context.tool_call_id } : {}),
      ...(data ? { data } : {}),
    };

    this.buffer.write(entry);
  }

  /**
   * 派生子 logger，自动合并上下文。
   * 子 logger 继承父 logger 的 session_id，覆盖 turn_id / tool_call_id。
   */
  with(context: Partial<LogContext>): StructuredLogger {
    const newContext: LogContext = {
      session_id: this.context.session_id,
      ...(this.context.turn_id ? { turn_id: this.context.turn_id } : {}),
      ...(this.context.tool_call_id ? { tool_call_id: this.context.tool_call_id } : {}),
      ...context,
    };

    // 子 logger 共享同一个 buffer 和 sinks，避免重复 flush
    return new StructuredLogger(
      newContext,
      {
        level: this.level,
        verbose: this.verbose,
        sinks: this.sinks,
      },
      { buffer: this.buffer, fileSink: this.fileSink },
    ) as unknown as StructuredLogger;
  }

  /** 强制 flush 所有缓冲。 */
  async flush(): Promise<void> {
    await this.buffer.flush();
  }

  /** 关闭 logger，flush 并清理资源。只有 root logger 会真正关闭 buffer。 */
  async close(): Promise<void> {
    if (!this.isChild) {
      await this.buffer.close();
    }
  }

  /** 获取日志文件路径（如果有 FileSink）。 */
  getLogFilePath(): string | undefined {
    return this.fileSink?.getCurrentFilePath();
  }

  /** 获取日志目录。 */
  getLogDir(): string | undefined {
    return this.fileSink?.getLogDir();
  }

  /** 获取当前日志级别。 */
  getLevel(): LogLevel {
    return this.level;
  }

  /** 获取内部 metrics。 */
  getMetrics(): { dropped: number; flushCount: number; queueLength: number } {
    const m = this.buffer.getMetrics();
    return {
      dropped: m.droppedCount,
      flushCount: m.flushCount,
      queueLength: this.buffer.getQueueLength(),
    };
  }
}

/** 创建默认配置的 logger。 */
export function createLogger(
  sessionId: string,
  opts: { level?: LogLevel; verbose?: boolean; enableTelemetry?: boolean } = {},
): StructuredLogger {
  const level = opts.level ?? 'info';
  const verbose = opts.verbose ?? false;
  const enableTelemetry = opts.enableTelemetry ?? false;

  const sinks: Sink[] = [new ConsoleSink('info'), new FileSink(sessionId)];

  if (enableTelemetry) {
    sinks.push(new TelemetrySink());
  }

  return StructuredLogger.create({ session_id: sessionId }, { level, verbose, sinks });
}
