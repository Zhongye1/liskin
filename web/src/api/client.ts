/**
 * HttpSseKernelClient：实现 KernelClient 接口，组合 http（控制） + stream（流式）。
 *
 * 对上层 UI 暴露统一的 KernelClient 接口，axios 和 fetch 的差异完全封在内部。
 * 见 docs/前后端联调/通信/前端与内核通信.md。
 */
import type {
  EventMsg,
  SessionHandle,
  SessionInfo,
} from '@liskin/core';

import { sessions } from './Http_Req/http';
import { streamRequest } from './Http_Req/stream';
import type {
  CreateSessionBody,
  KernelClient,
  SessionRecord,
  UserTurnBody,
} from './types/types';

export class HttpSseKernelClient implements KernelClient {
  // —— 会话生命周期（控制类，axios）—— //

  async createSession(opts?: CreateSessionBody): Promise<SessionHandle> {
    return sessions.create(opts) as Promise<SessionHandle>;
  }

  async resumeSession(sessionId: string): Promise<SessionHandle> {
    return sessions.get(sessionId) as Promise<SessionHandle>;
  }

  async getRecord(sessionId: string): Promise<SessionRecord> {
    return sessions.get(sessionId) as Promise<SessionRecord>;
  }

  async closeSession(sessionId: string): Promise<void> {
    await sessions.close(sessionId);
  }

  async listSessions(): Promise<SessionInfo[]> {
    const data = await sessions.list();
    return (data as { sessions: SessionInfo[] }).sessions;
  }

  // —— 回合流式（流式类，fetch + ReadableStream）—— //

  async *submit(op: {
    sessionId: string;
    content: string;
    maxTurns?: number;
  }): AsyncIterable<EventMsg> {
    const body: UserTurnBody = { content: op.content };
    if (op.maxTurns) {
      body.maxTurns = op.maxTurns;
    }

    for await (const ev of streamRequest<EventMsg>(
      `/sessions/${encodeURIComponent(op.sessionId)}/turns`,
      body,
    )) {
      yield ev;
    }
  }

  // —— 控制（控制类，axios）—— //

  async interrupt(sessionId: string): Promise<void> {
    await sessions.interrupt(sessionId);
  }

  async confirmTool(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    await sessions.confirm(sessionId, callId, decision);
  }
}
