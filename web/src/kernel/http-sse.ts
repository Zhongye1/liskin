 import type { EventMsg, SessionHandle, SessionInfo, SessionRecord } from '@liskin/core';

import type { KernelClient } from './client';

const BASE = '/api/v1';

/** 解析一段 SSE 块（以 \n\n 分隔）为 EventMsg，无法解析返回 null。 */
function parseSSEBlock(block: string): EventMsg | null {
  let dataLine: string | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith(':') && line.startsWith('data:')) {
      dataLine = line.slice(5).trim();
    }
  }
  if (!dataLine) {return null;}
  try {
    return JSON.parse(dataLine) as EventMsg;
  } catch {
    return null;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * HTTP/SSE 实现：把 KernelClient 方法映射到 server 的 sessions 端点。
 *
 * submit 是唯一的长连接：POST /v1/sessions/:id/turns 返回 SSE 流，
 * 用 fetch + ReadableStream reader 解析（不用 EventSource，因 POST）。
 * 见 docs/architecture/web-frontend-design.md §1.5。
 */
export class HttpSseKernelClient implements KernelClient {
  async createSession(opts?: { cwd?: string; system?: string }): Promise<SessionHandle> {
    const res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    return jsonOrThrow<SessionHandle>(res);
  }

  async resumeSession(sessionId: string): Promise<SessionHandle> {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`);
    return jsonOrThrow<SessionHandle>(res);
  }

  async getRecord(sessionId: string): Promise<SessionRecord> {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`);
    return jsonOrThrow<SessionRecord>(res);
  }

  async closeSession(sessionId: string): Promise<void> {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`${res.status}: ${res.statusText}`);
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await fetch(`${BASE}/sessions`);
    const body = await jsonOrThrow<{ sessions: SessionInfo[] }>(res);
    return body.sessions;
  }

  async *submit(op: {
    sessionId: string;
    content: string;
    maxTurns?: number;
  }): AsyncIterable<EventMsg> {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(op.sessionId)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        content: op.content,
        ...(op.maxTurns ? { maxTurns: op.maxTurns } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`turn ${res.status}: ${text || res.statusText}`);
    }
    if (!res.body) {
      throw new Error('empty stream body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {break;}
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const ev = parseSSEBlock(block);
          if (ev) {yield ev;}
          sep = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {
        // reader 已关闭，取消失败可忽略
      });
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`interrupt ${res.status}: ${res.statusText}`);
    }
  }

  async confirmTool(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, decision }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`confirm ${res.status}: ${text || res.statusText}`);
    }
  }
}
