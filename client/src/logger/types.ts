import type { LogLevel, LogEntry } from '@liskin/core';

// Re-export types for consumers
export type { LogLevel, LogContext, LogEntry, LoggerPort } from '@liskin/core';

// —— 类型 —— //

export const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface Sink {
  write(entry: LogEntry): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface LoggerOptions {
  level: LogLevel;
  verbose?: boolean;
  sinks: Sink[];
}

export interface RingBufferOptions {
  capacity?: number;
  flushThreshold?: number;
  flushIntervalMs?: number;
}

export interface FileSinkOptions {
  logDir?: string;
  maxFileSize?: number;
  maxFileAgeDays?: number;
  maxFiles?: number;
}
