import type { SubmitOp } from './op.js';
import type { EventMsg } from './event-msg.js';
import type { SessionHandle, SessionInfo, SessionRecord } from './session.js';

/**
 * Kernel 对外的服务接口（外层协议边界）。
 *
 * 客户端（CLI / Web / IDE 插件 / exec headless）只依赖此接口，
 * 不感知内核内部实现。
 *
 * 三种实现（同一接口，不同 transport）：
 * - InProcessKernelClient  → CLI、测试（直连 runAgent）
 * - HttpSseKernelClient    → Web（HTTP + SSE）
 * - JsonRpcKernelClient    → 未来 IDE 插件（stdio JSON-RPC）
 */
export interface KernelClient {
  createSession(opts?: {
    cwd?: string;
    providerId?: string;
    system?: string;
  }): Promise<SessionHandle>;
  resumeSession(sessionId: string): Promise<SessionHandle>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  /** 读取会话完整记录（含消息历史），用于恢复/回放。 */
  getRecord(sessionId: string): Promise<SessionRecord>;

  /** 投递 Op 并取回本轮事件流。 */
  submit(op: SubmitOp): AsyncIterable<EventMsg>;

  /** 打断当前回合，不关闭 session。 */
  interrupt(sessionId: string): Promise<void>;

  /** 对 ToolConfirmRequired 回执。 */
  confirmTool(sessionId: string, callId: string, decision: 'approve' | 'deny'): Promise<void>;
}
