/* eslint-disable no-console -- 测试 console hijack 功能，必须调用 console */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatRequest,
  type LLMEvent,
  type LLMPort,
  type ToolCall,
  type ToolDefinition,
  type ToolPort,
  type ToolResult,
} from '@liskin/core';

import { createApp } from '../src/app.js';
import { LogBus } from '../src/logger.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

class ScriptedLLM implements LLMPort {
  chatStream(_req: ChatRequest): AsyncIterable<LLMEvent> {
    return (async function* () {
      yield { kind: 'done' as const };
    })();
  }
}

class NoopTools implements ToolPort {
  list(): ToolDefinition[] {
    return [];
  }
  async invoke(call: ToolCall): Promise<ToolResult> {
    return { ok: true, content: '', toolCallId: call.id };
  }
}

let dbPath = '';
let store = null as unknown as SqliteStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `liskin-logs-${Date.now()}-${Math.random()}.sqlite`);
  store = new SqliteStore(dbPath);
});

afterEach(() => {
  store.close();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
});

async function readSomeSSE(res: Response, untilContains: string, timeoutMs = 1500): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) => {
        void setTimeout(() => resolve({ value: undefined, done: true }), 200);
      }),
    ]);
    if (r.value) {
      out += dec.decode(r.value, { stream: true });
    }
    if (out.includes(untilContains)) {
      break;
    }
    if (r.done) {
      break;
    }
  }
  await reader.cancel().catch(() => {
    // reader 已关闭，取消失败可忽略
  });
  return out;
}

describe('server /v1/logs/stream', () => {
  it('回放 ring buffer：订阅时返回已经存在的 entry', async () => {
    const logBus = new LogBus();
    // push(level, msg) 是单条语义：每条日志独立 push，level/msg 一一对应。
    logBus.push('info', 'first hello', 'warn', 'second warn');
    const app = createApp({
      llm: new ScriptedLLM(),
      tools: new NoopTools(),
      store,
      logBus,
    });

    const res = await app.request('/v1/logs/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await readSomeSSE(res, 'second warn');
    expect(body).toContain('event: log');
    expect(body).toContain('first hello');
    expect(body).toContain('second warn');
    expect(body).toContain('"level":"info"');
    expect(body).toContain('"level":"warn"');
  });

  it('订阅后能收到新推入的 entry', async () => {
    const logBus = new LogBus();
    const app = createApp({
      llm: new ScriptedLLM(),
      tools: new NoopTools(),
      store,
      logBus,
    });

    const res = await app.request('/v1/logs/stream');
    expect(res.status).toBe(200);

    // 等响应头落定后再 push
    setTimeout(() => {
      logBus.push('info', 'late breaking news', 'error', 'boom');
    }, 30);

    const body = await readSomeSSE(res, 'boom');
    expect(body).toContain('late breaking news');
    expect(body).toContain('boom');
    expect(body).toContain('"level":"error"');
  });

  it('LogBus 自身：ring buffer 截断到 500，hijackConsole 不递归', () => {
    const bus = new LogBus();
    for (let i = 0; i < 600; i++) {
      bus.push('info', `entry ${i}`);
    }
    const buf = bus.getBuffer();
    expect(buf.length).toBe(500);
    expect(buf[0]!.msg).toBe('entry 100');
    expect(buf.at(-1)!.msg).toBe('entry 599');

    const restore = bus.hijackConsole();
    try {
      console.log('hijacked log line');
      console.warn('hijacked warn');
      const buf2 = bus.getBuffer();
      const last2 = buf2.slice(-2);
      expect(last2[0]!.msg).toBe('hijacked log line');
      expect(last2[0]!.level).toBe('info');
      expect(last2[1]!.level).toBe('warn');
    } finally {
      restore();
    }
  });

  it('logBus 未提供时 → /v1/logs/stream 返回 404', async () => {
    const app = createApp({
      llm: new ScriptedLLM(),
      tools: new NoopTools(),
      store,
    });
    const res = await app.request('/v1/logs/stream');
    expect(res.status).toBe(404);
  });
});
