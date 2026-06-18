import { ConfirmRequiredError, type ToolCall } from '@liskin/core';

export type ConfirmPolicy = 'auto' | 'ask' | 'deny';

/**
 * 根据策略决定行为：
 * - auto → void（直接通过）
 * - ask  → 抛 ConfirmRequiredError（需要用户确认）
 * - deny → 抛普通 Error（拒绝）
 */
export function applyConfirmPolicy(call: ToolCall, policy: ConfirmPolicy): void {
  if (policy === 'auto') {
    return;
  }
  if (policy === 'deny') {
    throw new Error(`tool ${call.name} denied by policy`);
  }
  // 'ask'
  throw new ConfirmRequiredError(call);
}
