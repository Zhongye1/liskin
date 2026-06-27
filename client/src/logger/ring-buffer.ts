import type { LogEntry, Sink, RingBufferOptions } from './types.js';

import { redact } from './redact.js';

// —— Ring Buffer —— //

interface RingBufferMetrics {
  droppedCount: number;
  flushCount: number;
  flushLatencyMs: number[];
}

/**
 * 无锁环形缓冲区（Node.js 单线程事件循环保证线程安全）。
 * 满时丢弃最旧条目，保证主流程永不阻塞。
 */
export class RingBuffer {
  private readonly buffer: LogEntry[];
  private readonly capacity: number;
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private writeIndex = 0;
  private readIndex = 0;
  private count = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly sinks: Sink[];
  private readonly verbose: boolean;
  private metrics: RingBufferMetrics = {
    droppedCount: 0,
    flushCount: 0,
    flushLatencyMs: [],
  };

  constructor(sinks: Sink[], opts: Required<RingBufferOptions>, verbose: boolean) {
    this.sinks = sinks;
    this.capacity = opts.capacity;
    this.flushThreshold = opts.flushThreshold;
    this.flushIntervalMs = opts.flushIntervalMs;
    this.verbose = verbose;
    this.buffer = Array.from({ length: this.capacity });
    this.startFlushTimer();
  }

  /** 写入一条日志，O(1)，永不阻塞。 */
  write(entry: LogEntry): void {
    // 脱敏 — 所有写入必须经过
    if (entry.data) {
      entry.data = redact(entry.data, this.verbose) as Record<string, unknown>;
    }

    if (this.count >= this.capacity) {
      // 缓冲区满，丢弃最旧条目
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.count--;
      this.metrics.droppedCount++;
    }

    this.buffer[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.count++;

    // 达到阈值触发 flush
    if (this.count >= this.flushThreshold) {
      void this.flush();
    }
  }

  /** 批量 flush 到所有 sink。 */
  async flush(): Promise<void> {
    if (this.flushing || this.count === 0) {
      return;
    }

    this.flushing = true;
    const startTime = Date.now();

    try {
      const batch: LogEntry[] = [];
      while (this.count > 0) {
        batch.push(this.buffer[this.readIndex]);
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.count--;
      }

      // 写入所有 sink
      for (const entry of batch) {
        for (const sink of this.sinks) {
          try {
            sink.write(entry);
          } catch {
            // 单个 sink 失败不影响其他
          }
        }
      }

      // 等待所有 sink flush
      await Promise.all(this.sinks.map((s) => s.flush().catch(() => null)));

      this.metrics.flushCount++;
      this.metrics.flushLatencyMs.push(Date.now() - startTime);
      // 只保留最近 100 个延迟样本
      if (this.metrics.flushLatencyMs.length > 100) {
        this.metrics.flushLatencyMs.shift();
      }
    } finally {
      this.flushing = false;
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref(); // 不阻塞进程退出
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await Promise.all(this.sinks.map((s) => s.close().catch(() => null)));
  }

  getMetrics(): RingBufferMetrics {
    return { ...this.metrics };
  }

  getQueueLength(): number {
    return this.count;
  }
}
