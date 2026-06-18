/* eslint-disable no-console -- 本模块就是 console hijacker，必须操作 console */
/* eslint-disable no-empty-function -- hijack 重复调用时返回 no-op restore 是刻意设计 */
import { inspect } from 'node:util';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
}

const MAX_BUFFER = 500;

/**
 * 进程级日志总线：
 *   - 维护一个最多 500 条的 ring buffer（push 时裁剪最早条目）
 *   - 订阅者实时收到新条目
 *   - hijackConsole 把全局 console.log/info/warn/error 转接到 push（同时仍然写到原来的输出流）
 *
 * 注意事项：
 *   - hijackConsole 内部会保留原始 console 引用，push 自己只通过原始引用「不递归」地写出
 *   - apiKey 由调用方在 console 之前掩码，这里不做敏感字段过滤
 */
export class LogBus {
  private buffer: LogEntry[] = [];
  private subscribers = new Set<(entry: LogEntry) => void>();
  private restored = true;

  push(level: LogLevel, ...args: unknown[]): void {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: 120 })))
      .join(' ');
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
    for (const fn of this.subscribers) {
      try {
        fn(entry);
      } catch {
        // 单个订阅者失败不影响其他人
      }
    }
  }

  subscribe(fn: (entry: LogEntry) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getBuffer(): LogEntry[] {
    return [...this.buffer];
  }

  /**
   * 把全局 console.log/info/warn/error 接到本 bus；返回 restore 函数。
   * 重复调用：先 restore 再 hijack，避免叠层。
   */
  hijackConsole(): () => void {
    if (!this.restored) {
      // 已被 hijack；先返回一个 no-op 释放函数，避免恢复错乱
      return () => {};
    }
    this.restored = false;

    const origLog = console.log.bind(console);
    const origInfo = console.info.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]): void => {
      this.push('info', ...args);
      origLog(...args);
    };
    console.info = (...args: unknown[]): void => {
      this.push('info', ...args);
      origInfo(...args);
    };
    console.warn = (...args: unknown[]): void => {
      this.push('warn', ...args);
      origWarn(...args);
    };
    console.error = (...args: unknown[]): void => {
      this.push('error', ...args);
      origError(...args);
    };

    return () => {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
      this.restored = true;
    };
  }
}
