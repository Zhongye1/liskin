import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatRequest,
  type LLMEvent,
  type LLMPort,
  type ProviderConfig,
  type ToolCall,
  type ToolDefinition,
  type ToolPort,
  type ToolResult,
} from '@liskin/core';
import { OpenAIProvider } from '@liskin/llm';

import { createApp, maskKey } from '../src/app.js';
import { SqliteStore } from '../src/store/sqlite-store.js';

class NoopTools implements ToolPort {
  list(): ToolDefinition[] {
    return [];
  }
  async invoke(call: ToolCall): Promise<ToolResult> {
    return { ok: true, content: '', toolCallId: call.id };
  }
}

class StaticLLM implements LLMPort {
  constructor(private readonly events: LLMEvent[]) {}
  chatStream(_req: ChatRequest): AsyncIterable<LLMEvent> {
    const { events } = this;
    return (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })();
  }
}

let dbPath = '';
let store = null as unknown as SqliteStore;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `liskin-providers-${Date.now()}-${Math.random()}.sqlite`);
  store = new SqliteStore(dbPath);
});

afterEach(() => {
  store.close();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
});

const sampleConfig: ProviderConfig = {
  id: 'openai-default',
  name: 'OpenAI Default',
  protocol: 'openai-compatible',
  apiKey: 'sk-abcdefghijklmnopq1234',
  model: 'gpt-4o-mini',
};

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

describe('maskKey', () => {
  it('长度 ≤ 4 全打 *', () => {
    expect(maskKey('a')).toBe('*');
    expect(maskKey('abcd')).toBe('****');
  });
  it('长度 > 4 → 前 3 + *** + 末 4', () => {
    expect(maskKey('sk-abcdefghij1234')).toBe('sk-***1234');
  });
});

describe('providers CRUD + activate', () => {
  it('POST /v1/providers → GET /v1/providers (apiKey masked) → activate → chat 用新 active provider', async () => {
    const app = createApp({ tools: new NoopTools(), store });

    // 1. 创建
    const createRes = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleConfig),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { apiKey: string; isActive: boolean; id: string };
    expect(created.id).toBe('openai-default');
    expect(created.apiKey).toBe('sk-***1234');
    // 第一个创建的应自动 active
    expect(created.isActive).toBe(true);

    // 2. 列表回读，apiKey 已掩码
    const listRes = await app.request('/v1/providers');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { id: string; apiKey: string; isActive: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.apiKey).toBe('sk-***1234');
    expect(list[0]!.apiKey).not.toContain('abcdefghij');
    expect(list[0]!.isActive).toBe(true);

    // 3. 再加一个，并 activate 它
    const second: ProviderConfig = {
      ...sampleConfig,
      id: 'ark-seed',
      name: 'Ark',
      apiKey: 'sk-zzzzzzzzzzzzzzzz9999',
    };
    const createRes2 = await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(second),
    });
    expect(createRes2.status).toBe(201);

    const actRes = await app.request('/v1/providers/ark-seed/activate', { method: 'POST' });
    expect(actRes.status).toBe(200);
    const actBody = (await actRes.json()) as { id: string; isActive: boolean };
    expect(actBody.id).toBe('ark-seed');
    expect(actBody.isActive).toBe(true);

    const active = store.getActiveProvider();
    expect(active?.id).toBe('ark-seed');

    // 4. POST /v1/chat：没有静态 llm，应通过 createProvider 实例化 active provider
    //    用一个非真实 baseURL 让请求失败也无所谓 —— 只验证路由不再返回 503
    //    实际 test 中走 SSE，会 yield error 事件而不是 panic
    const chatRes = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sx', message: 'hi' }),
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get('content-type')).toContain('text/event-stream');
    const text = await readSSE(chatRes);
    // 真实 OpenAI 调用会失败 → 落到 error 事件；起码不是 503
    expect(text).toContain('event: error');
  });

  it('POST /v1/chat — 没有 active provider 时返回 503', async () => {
    const app = createApp({ tools: new NoopTools(), store });
    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's2', message: 'hi' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no active provider/u);
  });

  it('DELETE /v1/providers/:id — 不允许删 active provider，返回 409', async () => {
    const app = createApp({ tools: new NoopTools(), store });

    await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleConfig),
    });

    const delRes = await app.request(`/v1/providers/${sampleConfig.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(409);
    const body = (await delRes.json()) as { error: string };
    expect(body.error).toMatch(/cannot delete active/u);

    // 确认还在
    const listRes = await app.request('/v1/providers');
    const list = (await listRes.json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it('DELETE /v1/providers/:id — 非 active 可以删', async () => {
    const app = createApp({ tools: new NoopTools(), store });

    await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleConfig),
    });
    const second: ProviderConfig = { ...sampleConfig, id: 'p2', name: 'Other' };
    await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(second),
    });

    const delRes = await app.request('/v1/providers/p2', { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const listRes2 = await app.request('/v1/providers');
    const list = (await listRes2.json()) as unknown[];
    expect(list).toHaveLength(1);
  });

  it('PUT /v1/providers/:id — apiKey 空字符串视为保持原值', async () => {
    const app = createApp({ tools: new NoopTools(), store });
    await app.request('/v1/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleConfig),
    });

    const putRes = await app.request(`/v1/providers/${sampleConfig.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', apiKey: '' }),
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { name: string; apiKey: string };
    expect(body.name).toBe('Renamed');
    expect(body.apiKey).toBe('sk-***1234'); // 还是原 key 掩码

    const stored = store.getProvider(sampleConfig.id);
    expect(stored?.apiKey).toBe(sampleConfig.apiKey);
  });
});

describe('env seed 不覆盖语义', () => {
  it('upsertProvider({ onlyIfMissing: true }) — 已存在同 id 时 noop', () => {
    // 用户先创建了一个
    store.upsertProvider({ ...sampleConfig, apiKey: 'sk-user-key', source: 'user' });
    expect(store.getProvider(sampleConfig.id)?.apiKey).toBe('sk-user-key');

    // env seed 试图写入同 id
    store.upsertProvider(
      { ...sampleConfig, apiKey: 'sk-from-env', source: 'env' },
      { onlyIfMissing: true },
    );

    // 用户的 apiKey 必须保留
    const after = store.getProvider(sampleConfig.id);
    expect(after?.apiKey).toBe('sk-user-key');
    expect(after?.source).toBe('user');
  });

  it('upsertProvider({ onlyIfMissing: true }) — 不存在时正常插入', () => {
    store.upsertProvider({ ...sampleConfig, source: 'env' }, { onlyIfMissing: true });
    const row = store.getProvider(sampleConfig.id);
    expect(row).not.toBeNull();
    expect(row?.source).toBe('env');
  });
});

describe('createApp — 静态 llm 兼容', () => {
  it('传了静态 llm 时，chat 走静态 llm，无需 active provider', async () => {
    const app = createApp({
      llm: new StaticLLM([{ kind: 'token', text: 'static' }, { kind: 'done' }]),
      tools: new NoopTools(),
      store,
    });

    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sX', message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const text = await readSSE(res);
    expect(text).toContain('"text":"static"');
    expect(text).toContain('event: done');
  });
});

// 让 OpenAIProvider 在测试 import 中保留（避免某些 lint「unused」误报；同时确保 createProvider 路由存在）
void OpenAIProvider;
