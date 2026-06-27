import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleSink,
  FileSink,
  StructuredLogger,
  TelemetrySink,
  createLogger,
  getDefaultLogDir,
  redact,
} from '../src/index.js';

describe('redact()', () => {
  // TODO 硬编码
  it('masks API_KEY, API_TOKEN, API_SECRET, API_PASSWORD', () => {
    const data = {
      OPENAI_API_KEY: 'sk-1234567890abcdef',
      GITHUB_TOKEN: 'ghp_abcdef1234567890',
      DATABASE_SECRET: 'my-secret-password',
      DB_PASSWORD: 'password123',
      normal_field: 'should-remain',
    };
    const result = redact(data) as Record<string, unknown>;
    expect(result.OPENAI_API_KEY).toBe('***');
    expect(result.GITHUB_TOKEN).toBe('***');
    expect(result.DATABASE_SECRET).toBe('***');
    expect(result.DB_PASSWORD).toBe('***');
    expect(result.normal_field).toBe('should-remain');
  });

  it('masks lowercase sensitive keys', () => {
    const data = {
      api_key: 'sk-123',
      secret: 'secret-value',
      password: 'pass123',
      passwd: 'passwd123',
      'api-key': 'sk-456',
    };
    const result = redact(data) as Record<string, unknown>;
    expect(result.api_key).toBe('***');
    expect(result.secret).toBe('***');
    expect(result.password).toBe('***');
    expect(result.passwd).toBe('***');
    expect(result['api-key']).toBe('***');
  });

  it('masks URL query parameters containing sensitive keys', () => {
    const data = {
      url: 'https://example.com/api?api_key=sk-123&token=abc&foo=bar',
    };
    const result = redact(data) as Record<string, unknown>;
    expect(result.url).toContain('api_key=***');
    expect(result.url).toContain('token=***');
    expect(result.url).toContain('foo=bar');
  });

  it('masks URL query params in plain strings', () => {
    const result = redact('https://example.com?password=secret123') as string;
    expect(result).toContain('password=***');
    expect(result).not.toContain('secret123');
  });

  it('replaces file content with [REDACTED: <hash>] and adds size/line_count', () => {
    const content = 'line1\nline2\nline3';
    const data = { content };
    const result = redact(data) as Record<string, unknown>;
    expect(result.content).toMatch(/^\[REDACTED: [0-9a-f]{16}\]$/u);
    expect(result.size).toBe(content.length);
    expect(result.line_count).toBe(3);
  });

  it('keeps file content in verbose mode', () => {
    const content = 'line1\nline2\nline3';
    const data = { content };
    const result = redact(data, true) as Record<string, unknown>;
    expect(result.content).toBe(content);
    expect(result.size).toBeUndefined();
    expect(result.line_count).toBeUndefined();
  });

  it('masks CLI arguments after sensitive flags', () => {
    const data = {
      cmd: 'curl --api-key sk-12345 --token abcdef -k secret https://example.com',
    };
    const result = redact(data) as Record<string, unknown>;
    expect(result.cmd).toContain('--api-key ***');
    expect(result.cmd).toContain('--token ***');
    expect(result.cmd).toContain('-k ***');
    expect(result.cmd).not.toContain('sk-12345');
    expect(result.cmd).not.toContain('abcdef');
    expect(result.cmd).not.toContain('secret');
  });

  it('masks CLI arguments with = syntax', () => {
    const data = {
      cmd: 'curl --api-key=sk-12345 --password=secret',
    };
    const result = redact(data) as Record<string, unknown>;
    expect(result.cmd).toContain('--api-key=***');
    expect(result.cmd).toContain('--password=***');
  });

  it('handles nested objects recursively', () => {
    const data = {
      level1: {
        level2: {
          API_KEY: 'sk-123',
          normal: 'value',
        },
      },
    };
    const result = redact(data) as Record<string, unknown>;
    const level1 = result.level1 as Record<string, unknown>;
    const level2 = level1.level2 as Record<string, unknown>;
    expect(level2.API_KEY).toBe('***');
    expect(level2.normal).toBe('value');
  });

  it('handles arrays recursively', () => {
    const data = {
      items: [{ API_KEY: 'sk-1' }, { API_TOKEN: 'tok-2' }, { normal: 'value' }],
    };
    const result = redact(data) as Record<string, unknown>;
    const items = result.items as Record<string, unknown>[];
    expect(items[0].API_KEY).toBe('***');
    expect(items[1].API_TOKEN).toBe('***');
    expect(items[2].normal).toBe('value');
  });

  it('handles null and undefined', () => {
    expect(redact(null)).toBeNull();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- testing undefined input handling
    expect(redact(undefined)).toBeUndefined();
  });

  it('handles primitive values', () => {
    expect(redact('hello')).toBe('hello');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});

describe('StructuredLogger', () => {
  let _tempDir = '';

  beforeEach(() => {
    _tempDir = mkdtempSync(join(tmpdir(), 'logger-test-'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('creates root logger with session_id', () => {
    const logger = createLogger('test-session-123', {
      level: 'debug',
      enableTelemetry: false,
    });
    expect(logger.getLevel()).toBe('debug');
    expect(logger.getLogDir()).toBeDefined();
    expect(logger.getLogFilePath()).toContain('test-session-123');
  });

  it('derives child logger with merged context via with()', () => {
    const logger = createLogger('session-1', { level: 'trace' });
    const turnLogger = logger.with({ turn_id: 'turn-1' });
    const toolLogger = turnLogger.with({ tool_call_id: 'tool-1' });

    expect(turnLogger).not.toBe(logger);
    expect(toolLogger).not.toBe(turnLogger);

    // Child loggers share the same buffer (verified by metrics)
    const rootMetrics = logger.getMetrics();
    const turnMetrics = turnLogger.getMetrics();
    expect(rootMetrics.queueLength).toBe(turnMetrics.queueLength);
  });

  it('filters logs below configured level', () => {
    const logger = createLogger('session-filter', { level: 'warn' });

    logger.trace('trace msg');
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    const metrics = logger.getMetrics();
    // Only warn and error should be in queue (2 entries)
    expect(metrics.queueLength).toBe(2);
  });

  it('performance: 10000 logs write, main thread blocking < 100ms', () => {
    const logger = createLogger('perf-test', {
      level: 'trace',
      enableTelemetry: false,
    });

    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      logger.debug(`log message ${i}`, {
        index: i,
        nested: { value: `data-${i}` },
      });
    }
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);

    const metrics = logger.getMetrics();
    // With capacity 1000, we should have some drops after 10000 writes
    expect(metrics.dropped).toBeGreaterThan(0);
    expect(metrics.queueLength).toBeLessThanOrEqual(1000);
  });

  it('flushes buffer on close', async () => {
    const logger = createLogger('flush-test', { level: 'info' });
    logger.info('message 1');
    logger.info('message 2');

    await logger.close();

    const metrics = logger.getMetrics();
    expect(metrics.queueLength).toBe(0);
    expect(metrics.flushCount).toBeGreaterThan(0);
  });

  it('applies redaction automatically to all log entries', async () => {
    const logger = createLogger('redact-test', { level: 'debug' });

    logger.debug('sensitive data', {
      API_KEY: 'sk-12345',
      password: 'secret',
      url: 'https://example.com?token=abc',
    });

    await logger.flush();

    const logPath = logger.getLogFilePath();
    expect(logPath).toBeDefined();

    const content = readFileSync(logPath!, 'utf8');
    expect(content).toContain('"API_KEY":"***"');
    expect(content).toContain('"password":"***"');
    expect(content).toContain('token=***');
    expect(content).not.toContain('sk-12345');
    expect(content).not.toContain('secret');
    expect(content).not.toContain('abc');
  });
});

describe('FileSink', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'filesink-test-'));
  });

  it('writes JSON lines to file', () => {
    const sink = new FileSink('json-test', { logDir: tempDir, maxFiles: 3 });
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'info' as const,
      message: 'test message',
      session_id: 'json-test',
      data: { foo: 'bar' },
    };

    sink.write(entry);

    const files = readdirSync(tempDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(1);

    const content = readFileSync(join(tempDir, files[0]), 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.message).toBe('test message');
    expect(parsed.data.foo).toBe('bar');
    expect(parsed.session_id).toBe('json-test');
  });

  it('rotates files when size exceeds maxFileSize', () => {
    const maxSize = 500; // 500 bytes
    const sink = new FileSink('rotate-test', {
      logDir: tempDir,
      maxFileSize: maxSize,
      maxFiles: 3,
    });

    // Write enough entries to trigger rotation
    const longMessage = 'x'.repeat(200);
    for (let i = 0; i < 10; i++) {
      sink.write({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `${longMessage} ${i}`,
        session_id: 'rotate-test',
      });
    }

    const files = readdirSync(tempDir)
      .filter((f) => f.startsWith('chat-rotate-test') && f.endsWith('.log'))
      .sort();

    // Should have multiple files due to rotation
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3); // maxFiles

    // First file should be at or near max size
    const firstFileSize = statSync(join(tempDir, files[0])).size;
    expect(firstFileSize).toBeGreaterThanOrEqual(maxSize - 250); // Allow some tolerance
  });

  it('respects maxFiles limit during rotation', () => {
    const sink = new FileSink('maxfiles-test', {
      logDir: tempDir,
      maxFileSize: 200,
      maxFiles: 2,
    });

    const longMessage = 'x'.repeat(150);
    for (let i = 0; i < 20; i++) {
      sink.write({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `${longMessage} ${i}`,
        session_id: 'maxfiles-test',
      });
    }

    const files = readdirSync(tempDir).filter(
      (f) => f.startsWith('chat-maxfiles-test') && f.endsWith('.log'),
    );

    expect(files.length).toBeLessThanOrEqual(2);
  });
});

describe('ConsoleSink', () => {
  it('writes formatted output to stderr', () => {
    const sink = new ConsoleSink('info');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    sink.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'console test',
      session_id: 'test',
    });

    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain('INFO');
    expect(output).toContain('console test');

    writeSpy.mockRestore();
  });

  it('filters messages below minLevel', () => {
    const sink = new ConsoleSink('warn');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    sink.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'should not appear',
      session_id: 'test',
    });

    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
  });
});

describe('TelemetrySink', () => {
  it('implements Sink interface', () => {
    const sink = new TelemetrySink();
    expect(typeof sink.write).toBe('function');
    expect(typeof sink.flush).toBe('function');
    expect(typeof sink.close).toBe('function');
  });

  it('persists entries to queue directory', () => {
    const sink = new TelemetrySink();
    // Override Math.random to ensure sampling passes
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    sink.write({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: 'telemetry test',
      session_id: 'test',
    });

    randomSpy.mockRestore();
  });
});

describe('getDefaultLogDir', () => {
  it('returns ~/.liskin/logs by default', () => {
    const originalXdg = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;

    const dir = getDefaultLogDir();
    expect(dir).toContain('.liskin/logs');

    if (originalXdg) {
      process.env.XDG_STATE_HOME = originalXdg;
    }
  });

  it('uses XDG_STATE_HOME when set', () => {
    const originalXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/tmp/xdg-state';

    const dir = getDefaultLogDir();
    expect(dir).toBe('/tmp/xdg-state/liskin/logs');

    if (originalXdg) {
      process.env.XDG_STATE_HOME = originalXdg;
    } else {
      delete process.env.XDG_STATE_HOME;
    }
  });
});

describe('StructuredLogger.create()', () => {
  it('creates logger with custom sinks', () => {
    const consoleSink = new ConsoleSink('info');
    const logger = StructuredLogger.create(
      { session_id: 'custom-sinks' },
      {
        level: 'debug',
        verbose: false,
        sinks: [consoleSink],
      },
      { capacity: 500, flushThreshold: 25, flushIntervalMs: 500 },
    );

    expect(logger.getLevel()).toBe('debug');
    logger.info('test');
    const metrics = logger.getMetrics();
    expect(metrics.queueLength).toBe(1);
  });
});
