import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { LogLevel, LogEntry, Sink, FileSinkOptions } from './types.js';
import { LEVEL_ORDER } from './types.js';

// —— Sink 实现 —— //

/**
 * 终端输出 Sink。
 * 仅 info 及以上，格式化为人性化文本，克制不刷屏。
 */
export class ConsoleSink implements Sink {
  private readonly minLevel: LogLevel;

  constructor(minLevel: LogLevel = 'info') {
    this.minLevel = minLevel;
  }

  write(entry: LogEntry): void {
    if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const levelColors: Record<LogLevel, string> = {
      trace: '\u001B[90m', // gray
      debug: '\u001B[36m', // cyan
      info: '\u001B[32m', // green
      warn: '\u001B[33m', // yellow
      error: '\u001B[31m', // red
    };
    const reset = '\u001B[0m';
    const color = levelColors[entry.level];
    const levelUpper = entry.level.toUpperCase().padStart(5);

    let line = `${color}${levelUpper}${reset} ${entry.message}`;
    if (
      entry.data &&
      Object.keys(entry.data).length > 0 &&
      LEVEL_ORDER[entry.level] <= LEVEL_ORDER.debug
    ) {
      // 只在 debug 及以下显示完整 data
      line += ` ${JSON.stringify(entry.data)}`;
    }

    process.stderr.write(`${line}\n`);
  }

  async flush(): Promise<void> {
    // 终端是同步的，无需 flush
  }

  async close(): Promise<void> {
    // 无需关闭
  }
}

/**
 * 本地文件 Sink。
 * debug 及以上，完整 JSON line，带 rotation。
 */
export class FileSink implements Sink {
  private readonly logDir: string;
  private readonly sessionId: string;
  private readonly maxFileSize: number;
  private readonly maxFileAgeDays: number;
  private readonly maxFiles: number;
  private currentFilePath: string;
  private currentFileSize = 0;
  private currentFileCreatedAt: number;

  constructor(sessionId: string, opts: FileSinkOptions = {}) {
    this.sessionId = sessionId;
    this.logDir = opts.logDir ?? getDefaultLogDir();
    this.maxFileSize = opts.maxFileSize ?? 10 * 1024 * 1024; // 10MB
    this.maxFileAgeDays = opts.maxFileAgeDays ?? 7;
    this.maxFiles = opts.maxFiles ?? 5;

    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    this.currentFilePath = this.getLogFilePath(0);
    this.currentFileCreatedAt = Date.now();

    // 如果文件已存在，获取其大小
    if (existsSync(this.currentFilePath)) {
      this.currentFileSize = statSync(this.currentFilePath).size;
    }

    this.cleanupOldFiles();
  }

  private getLogFilePath(index: number): string {
    const suffix = index === 0 ? '' : `.${index}`;
    return join(this.logDir, `chat-${this.sessionId}${suffix}.log`);
  }

  write(entry: LogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const lineSize = Buffer.byteLength(line, 'utf8');

    // 检查是否需要 rotation
    this.checkRotation(lineSize);

    try {
      appendFileSync(this.currentFilePath, line, 'utf8');
      this.currentFileSize += lineSize;
    } catch {
      // 写入失败静默忽略，不影响主流程
    }
  }

  private checkRotation(newLineSize: number): void {
    const now = Date.now();
    const ageMs = now - this.currentFileCreatedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    const needsRotation =
      this.currentFileSize + newLineSize > this.maxFileSize || ageDays > this.maxFileAgeDays;

    if (needsRotation) {
      this.rotate();
    }
  }

  private rotate(): void {
    // 移动现有文件：chat.log → chat.1.log → chat.2.log → ...
    for (let i = this.maxFiles - 1; i >= 0; i--) {
      const src = this.getLogFilePath(i);
      const dst = this.getLogFilePath(i + 1);
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          // 忽略重命名失败
        }
      }
    }

    // 创建新文件（先创建空文件，确保 cleanupOldFiles 能看到它）
    this.currentFilePath = this.getLogFilePath(0);
    this.currentFileSize = 0;
    this.currentFileCreatedAt = Date.now();
    // 创建空文件，确保目录列表包含此文件
    appendFileSync(this.currentFilePath, '', 'utf8');

    this.cleanupOldFiles();
  }

  private cleanupOldFiles(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter((f) => f.startsWith(`chat-${this.sessionId}`) && f.endsWith('.log'))
        .sort((a, b) => getFileIndex(b) - getFileIndex(a));

      // 删除超过 maxFiles 的文件
      while (files.length > this.maxFiles) {
        const oldest = files.shift();
        if (oldest) {
          try {
            unlinkSync(join(this.logDir, oldest));
          } catch {
            // 忽略删除失败
          }
        }
      }

      // 删除超过 maxFileAgeDays 的文件
      const now = Date.now();
      for (const file of files) {
        const filePath = join(this.logDir, file);
        try {
          const stats = statSync(filePath);
          const ageMs = now - stats.mtimeMs;
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          if (ageDays > this.maxFileAgeDays) {
            unlinkSync(filePath);
          }
        } catch {
          // 忽略
        }
      }
    } catch {
      // 清理失败静默忽略
    }
  }

  getCurrentFilePath(): string {
    return this.currentFilePath;
  }

  getLogDir(): string {
    return this.logDir;
  }

  async flush(): Promise<void> {
    // 同步写入，无需 flush
  }

  async close(): Promise<void> {
    // 无需关闭（appendFileSync 每次都打开关闭）
  }
}

/**
 * 服务端上报 Sink（占位实现）。
 * info 及以上，脱敏后，采样（trace/debug 1%，error 100%）。
 * 带本地持久化队列（断网时存盘，联网后补传）。
 */
export class TelemetrySink implements Sink {
  private readonly queueDir: string;
  private readonly sampleRates: Record<LogLevel, number> = {
    trace: 0.01,
    debug: 0.01,
    info: 0.1,
    warn: 1,
    error: 1,
  };

  constructor() {
    this.queueDir = join(getDefaultLogDir(), 'telemetry-queue');
    if (!existsSync(this.queueDir)) {
      mkdirSync(this.queueDir, { recursive: true });
    }
  }

  write(entry: LogEntry): void {
    // 采样
    const sampleRate = this.sampleRates[entry.level];
    if (Math.random() > sampleRate) {
      return;
    }

    // 持久化到本地队列（真实上报需要后端接口）
    const queueFile = join(
      this.queueDir,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    try {
      appendFileSync(queueFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 忽略
    }
  }

  async flush(): Promise<void> {
    // 占位：尝试上报队列中的数据
    // 真实实现需要 HTTP 客户端和后端接口
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

// —— 辅助函数 —— //

/** 从文件名提取 rotation 索引，用于正确排序。chat-session.log → 0, chat-session.1.log → 1, etc. */
function getFileIndex(filename: string): number {
  const match = filename.match(/\.(?<index>\d+)\.log$/u);
  return match?.groups?.index ? Number.parseInt(match.groups.index, 10) : 0;
}

/** 获取默认日志目录：~/.liskin/logs 或 $XDG_STATE_HOME/liskin/logs */
export function getDefaultLogDir(): string {
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState) {
    return resolve(xdgState, 'liskin', 'logs');
  }
  return resolve(homedir(), '.liskin', 'logs');
}
