 import type {
   EventMsg,
   SessionHandle,
   SessionInfo,
   SessionRecord,
 } from '@liskin/core';

/**
 * Web 侧 KernelClient 接口，与 @liskin/core 的 KernelClient 同形。
 * UI 只依赖此接口，不感知 transport（当前 HTTP/SSE，未来可换 WebSocket）。
 *
 * 见 docs/architecture/web-frontend-design.md §1.2。
 */
export interface KernelClient {
  createSession(opts?: { cwd?: string; system?: string }): Promise<SessionHandle>;
  resumeSession(sessionId: string): Promise<SessionHandle>;
  getRecord(sessionId: string): Promise<SessionRecord>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  submit(op: { sessionId: string; content: string; maxTurns?: number }): AsyncIterable<EventMsg>;
  interrupt(sessionId: string): Promise<void>;
  confirmTool(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
  ): Promise<void>;
}

 export type { EventMsg, SessionHandle, SessionInfo, SessionRecord };
