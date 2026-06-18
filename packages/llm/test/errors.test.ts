import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { describe, expect, it } from 'vitest';

import { isAbortedEvent, normalizeError } from '../src/openai/errors.js';

/**
 * 通过 generate 工厂构造一个真实的 APIError，避免 protected 构造函数限制。
 * 注意：SDK 内部会把 errorBody.error 赋给 err.error（OpenAI 包裹格式），
 *       所以服务端 message 必须以 `{ error: { message } }` 形式传入。
 */
function makeAPIError(status: number, message: string, serverMsg?: string): APIError {
  // 必须传非空 headers，否则 SDK 会返回 APIConnectionError(status=undefined)
  const body = serverMsg ? { error: { message: serverMsg } } : undefined;
  return APIError.generate(status, body, message, {} as never);
}

describe('normalizeError', () => {
  it('TC7a — 401 默认透传：unauthorized: <serverMsg>', () => {
    const ev = normalizeError(makeAPIError(401, 'fallback', 'Invalid API key'));
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.error.code).toBe('401');
      expect(ev.error.message).toBe('unauthorized: Invalid API key');
    }
  });

  it('TC7a-2 — 401 服务端 message 缺失：fallback 到 err.message', () => {
    const ev = normalizeError(makeAPIError(401, 'Invalid Authentication'));
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.error.code).toBe('401');
      // serverMsg 缺失时 fallback 到 err.message（含 status code 提示）
      expect(ev.error.message.startsWith('unauthorized: ')).toBe(true);
      expect(ev.error.message).toContain('Invalid Authentication');
    }
  });

  it('TC7b — 429 默认透传：rate limited: <serverMsg>', () => {
    const ev = normalizeError(makeAPIError(429, 'fallback', 'Too Many Requests'));
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.error.code).toBe('429');
      expect(ev.error.message).toBe('rate limited: Too Many Requests');
    }
  });

  it('TC7c — 普通 Error → message / unknown', () => {
    const ev = normalizeError(new Error('boom'));
    expect(ev).toEqual({
      kind: 'error',
      error: { message: 'boom', code: 'unknown' },
    });
  });

  it('TC7d — APIError 500 透传 message + status code（无前缀）', () => {
    const ev = normalizeError(makeAPIError(500, 'server boom', 'oops'));
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.error.code).toBe('500');
      // 非 401/429：不加前缀，直接是 serverMsg
      expect(ev.error.message).toBe('oops');
    }
  });

  it('TC7e — 非 Error 值 → String(err) / unknown', () => {
    const ev = normalizeError('plain string');
    expect(ev).toEqual({
      kind: 'error',
      error: { message: 'plain string', code: 'unknown' },
    });
  });

  it('TC7f — APIUserAbortError → aborted', () => {
    const ev = normalizeError(new APIUserAbortError({ message: 'aborted by user' }));
    expect(ev).toEqual({
      kind: 'error',
      error: { message: 'request aborted', code: 'aborted' },
    });
    expect(isAbortedEvent(ev)).toBe(true);
  });

  it('TC7g — APIConnectionTimeoutError → timeout', () => {
    const ev = normalizeError(new APIConnectionTimeoutError({ message: 'request timed out' }));
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.error.code).toBe('timeout');
      expect(ev.error.message).toContain('timed out');
    }
  });

  it('TC7h — APIConnectionError → connection', () => {
    const ev = normalizeError(new APIConnectionError({ message: 'connection refused' }));
    expect(ev.kind).toBe('error');
    if (ev.kind === 'error') {
      expect(ev.error.code).toBe('connection');
      expect(ev.error.message).toContain('connection refused');
    }
  });

  it('TC7i — isAbortedEvent 仅对 code=aborted 返回 true', () => {
    const aborted = normalizeError(new APIUserAbortError({ message: 'x' }));
    const other = normalizeError(new Error('x'));
    expect(isAbortedEvent(aborted)).toBe(true);
    if (other.kind === 'error') {
      expect(isAbortedEvent(other)).toBe(false);
    }
  });
});
