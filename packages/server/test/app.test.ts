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
import { SqliteStore } from '../src/store/sqlite-store.js';

class ScriptedLLM implements LLMPort {
  private idx = 0;
  constructor(private readonly turns: LLMEvent[][]) {}
  chatStream(_req: ChatRequest): AsyncIterable<LLMEvent> {
    const events = this.turns[this.idx++] ?? [{ kind: 'done' as const }];
    return (async function* () {
      for (const ev of events) {
        yield ev;
      }
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
  dbPath = path.join(os.tmpdir(), `liskin-server-${Date.now()}-${Math.random()}.sqlite`);
  store = new SqliteStore(dbPath);
});

afterEach(() => {
  store.close();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
});

async function readSSE(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe('server app', () => {
  it('GET /healthz returns ok', async () => {
    const app = createApp({ llm: new ScriptedLLM([]), tools: new NoopTools(), store });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /v1/tools returns the tool list', async () => {
    const app = createApp({ llm: new ScriptedLLM([]), tools: new NoopTools(), store });
    const res = await app.request('/v1/tools');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tools: [] });
  });

  it('POST /v1/chat streams tokens then done; persists session', async () => {
    const app = createApp({
      llm: new ScriptedLLM([
        [{ kind: 'token', text: 'hello' }, { kind: 'token', text: ' world' }, { kind: 'done' }],
      ]),
      tools: new NoopTools(),
      store,
    });

    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', message: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await readSSE(res);
    expect(body).toContain('event: token');
    expect(body).toContain('"text":"hello"');
    expect(body).toContain('event: done');

    const session = await store.loadSession('s1');
    expect(session).not.toBeNull();
    expect(session!.messages.at(-2)).toEqual({ role: 'user', content: 'hi' });
    expect(session!.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'hello world',
    });
  });

  it('POST /v1/chat rejects invalid body with 400', async () => {
    const app = createApp({ llm: new ScriptedLLM([]), tools: new NoopTools(), store });
    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /v1/sessions/:id reads back persisted history', async () => {
    const app = createApp({
      llm: new ScriptedLLM([[{ kind: 'token', text: 'ok' }, { kind: 'done' }]]),
      tools: new NoopTools(),
      store,
    });
    await readSSE(
      await app.request('/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc', message: 'first', system: 'be brief' }),
      }),
    );

    const res = await app.request('/v1/sessions/abc');
    expect(res.status).toBe(200);
    const session = (await res.json()) as { messages: { role: string; content: string }[] };
    expect(session.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(session.messages[1]).toEqual({ role: 'user', content: 'first' });
    expect(session.messages[2]).toMatchObject({ role: 'assistant', content: 'ok' });
  });

  it('GET /v1/sessions/:id returns 404 for unknown id', async () => {
    const app = createApp({ llm: new ScriptedLLM([]), tools: new NoopTools(), store });
    const res = await app.request('/v1/sessions/not-here');
    expect(res.status).toBe(404);
  });
});
