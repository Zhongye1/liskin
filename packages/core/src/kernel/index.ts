// Kernel ↔ Client 外层协议（见 docs/architecture/kernel-client-protocol.md）

export type {
  Op,
  SessionOp,
  EventMsg,
  SessionInfo,
  SessionHandle,
  Usage,
  NormalizedError,
  TurnEndReason,
} from './types.js';

export type { KernelClient, SubmitOp } from './client-port.js';

export { InProcessKernelClient } from './in-process.js';
export type { InProcessKernelOptions } from './in-process.js';

export { InMemoryStore } from './in-memory-store.js';

export { AsyncQueue, Deferred } from './async-queue.js';
