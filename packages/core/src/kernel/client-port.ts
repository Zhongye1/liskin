import type { Op, EventMsg, SessionHandle, SessionInfo } from './types.js';

/**
 * Kernel 对外的服务接口（外层协议边界）。
 *
 * 客户端（CLI / Web / IDE 插件 / exec headless）只依赖此接口，
 * 不感知内核内部实现（runAgent / ports / store）。
 *
 * 三种实现（同一接口，不同 transport）：
 * - InProcessKernelClient  → CLI MVP、测试（直连 runAgent，无序列化）
 * - HttpSseKernelClient    → Web（HTTP + SSE，跨进程）
 * - JsonRpcKernelClient    → 未来 IDE 插件（stdio JSON-RPC）
 *
 * 设计要点（见 docs/architecture/kernel-client-protocol.md §3.3）：
 * - submit 返回 AsyncIterable<EventMsg>（拉模型），消费完即止；
 *   Phase 2 真 SQ/EQ 增补 subscribe(sessionId) 长订阅，接口向后兼容。
 * - interrupt/confirmTool 直接作用于 session，非轮询。
 */
export interface KernelClient {
  // —— 会话生命周期 —— //
  createSession(opts?: {
    cwd?: string;
    providerId?: string;
    system?: string;
  }): Promise<SessionHandle>;
  resumeSession(sessionId: string): Promise<SessionHandle>;
  closeSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  // —— 回合 —— //
  /**
   * 投递 Op 并取回本轮事件流。
   * 仅 UserTurn 会产生 Turn* 事件；Interrupt/ConfirmTool/Cancel 立即 resolve
   * （其效果通过后续 submit 的事件或 turn 状态体现）。
   *
   * 取消：消费方中途 break / 丢弃迭代器不会中断内核；用 interrupt()。
   */
  submit(op: SubmitOp): AsyncIterable<EventMsg>;

  /** 打断当前正在运行的回合，不关闭 session。 */
  interrupt(sessionId: string): Promise<void>;

  /** 对 ToolConfirmRequired 回执。 */
  confirmTool(sessionId: string, callId: string, decision: 'approve' | 'deny'): Promise<void>;
}

/** submit 接受的 Op 子集（会话级 Op 走专门方法）。 */
export type SubmitOp = Extract<Op, { type: 'UserTurn' }>;
