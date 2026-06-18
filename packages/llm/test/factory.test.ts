import type { ProviderConfig } from '@liskin/core';
import { describe, expect, it } from 'vitest';

import { createProvider } from '../src/factory.js';
import { OpenAIProvider } from '../src/openai/provider.js';

describe('createProvider — protocol routing', () => {
  it('TC-Factory-1 — protocol="openai-compatible" → 返回 OpenAIProvider 实例', () => {
    const config: ProviderConfig = {
      id: 'p1',
      name: 'Default',
      protocol: 'openai-compatible',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    };
    const llm = createProvider(config);
    expect(llm).toBeInstanceOf(OpenAIProvider);
  });

  it('TC-Factory-2 — 完整字段透传给 OpenAI 客户端（baseURL/timeout/maxRetries）', () => {
    const config: ProviderConfig = {
      id: 'p2',
      name: 'Ark',
      protocol: 'openai-compatible',
      apiKey: 'sk-ark',
      model: 'doubao',
      baseURL: 'https://ark.example.com/v1',
      timeout: 12_000,
      maxRetries: 5,
      organization: 'org-x',
    };
    const llm = createProvider(config) as OpenAIProvider;
    const { client } = llm as unknown as {
      client: { baseURL: string; timeout: number; maxRetries: number; organization: string };
    };
    expect(client.baseURL).toBe('https://ark.example.com/v1');
    expect(client.timeout).toBe(12_000);
    expect(client.maxRetries).toBe(5);
    expect(client.organization).toBe('org-x');
  });
});
