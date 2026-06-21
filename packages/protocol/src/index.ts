/**
 * ## 协议边界 — @liskin/protocol
 *
 * 这是前后端共享的类型契约包，**零依赖（仅 zod）**。不依赖 core/llm/tools/server
 * 任何一个内部包，确保协议层可以被任何环境（CLI / Web / IDE 插件）独立引用。
 *
 * ## 定位
 *
 * ```
 *                         ┌──────────────────────┐
 *     CLI / Web / IDE ───→│   KernelClient 接口   │←── 协议边界
 *                         └──────────┬───────────┘
 *                                    │ implements
 *                 ┌──────────────────┼──────────────────┐
 *                 ▼                  ▼                  ▼
 *          InProcessKernelClient  HttpSseKernelClient  JsonRpcKernelClient
 *          (直连 runAgent)       (HTTP + SSE)         (stdio JSON-RPC)
 * ```
 *
 * KernelClient 是内核对外的**唯一服务接口**。客户端不感知内核内部实现，
 * 只依赖这个接口。三种 transport 实现同一份契约，换 transport 不改协议。
 *
 * ## 协议结构
 *
 * ### 上行 — Op（客户端 → 内核）
 *
 * 8 种操作，zod discriminatedUnion：CreateSession / ResumeSession /
 * CloseSession / ListSessions / UserTurn / Interrupt / ConfirmTool / Cancel。
 * SubmitOp = UserTurn 是 submit() 接受的唯一种类。
 *
 * ### 下行 — EventMsg（内核 → 客户端）
 *
 * 12 种事件，zod discriminatedUnion：
 *   SessionCreated / SessionResumed / SessionClosed / SessionList   ← 会话管理
 *   TurnStart / TurnEnd              ← 回合边界
 *   Token / ToolCall / ToolProgress / ToolResult                   ← 流式内容
 *   ToolConfirmRequired              ← 确认暂停
 *   Error                            ← 错误
 *
 * ### KernelClient 接口
 *
 *   - createSession({cwd?, providerId?, system?}) → SessionHandle
 *   - resumeSession(sessionId) → SessionHandle
 *   - closeSession(sessionId) → void
 *   - listSessions() → SessionInfo[]
 *   - getRecord(sessionId) → SessionRecord（含完整 messages）
 *   - submit(SubmitOp) → AsyncIterable<EventMsg>  ← 唯一回合入口
 *   - interrupt(sessionId) → void                  ← Ctrl-C
 *   - confirmTool(sessionId, callId, 'approve'|'deny') → void  ← 确认回执
 *
 * ### Wire 编解码
 *
 *   - encodeOp / decodeOp        — Op ↔ JSON string，出入口双重 zod 校验
 *   - encodeEvent / decodeEvent   — EventMsg ↔ JSON string
 *   - toSseFrame(ev, id)          — EventMsg → SSE text/event-stream 行
 *
 * 跨网络的每一帧都经过 schema 校验，脏数据在协议层拦截，不会侵入内核或 UI。
 *
 * ## 设计原则
 *
 *   1. 协议层不 import 任何内部包 — 任何环境都能独立引用
 *   2. 所有类型走 zod schema 校验 — 非法帧在边界拦截，内核和 UI 只处理合法数据
 *   3. KernelClient 是单一抽象 — 换 transport 不改协议，换协议类型不改内核
 *   4. SubmitOp = UserTurn 是回合唯一入口 — 所有对话都走 submit() 投递
 */

// —— Tool 基础类型 + Schema —— //
export { ToolCallSchema, ToolResultSchema, ToolDefinitionSchema } from './tool-types.js';
export type { ToolCall, ToolResult, ToolDefinition } from './tool-types.js';

// —— Session —— //
export { SessionInfoSchema, SessionHandleSchema, SessionRecordSchema } from './session.js';
export type { SessionInfo, SessionHandle, SessionRecord } from './session.js';

// —— Op —— //
export { OpSchema } from './op.js';
export type { Op, SessionOp, SubmitOp } from './op.js';

// —— EventMsg —— //
export {
  EventMsgSchema,
  UsageSchema,
  NormalizedErrorSchema,
  TurnEndReasonSchema,
} from './event-msg.js';
export type { EventMsg, Usage, NormalizedError, TurnEndReason } from './event-msg.js';

// —— KernelClient 接口 —— //
export type { KernelClient } from './kernel-client.js';

// —— Wire 编解码 —— //
export {
  encodeOp,
  decodeOp,
  encodeEvent,
  decodeEvent,
  toSseFrame,
  PROTOCOL_VERSION,
} from './wire.js';
