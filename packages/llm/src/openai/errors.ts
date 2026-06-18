import type { LLMEvent } from '@liskin/core';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

type ErrorEvent = Extract<LLMEvent, { kind: 'error' }>;

/**
 * 把任意错误归一化为 LLMEvent.error。
 *
 * code 字段值与 docs/architecture/kernel-protocol.md §5 ErrorCode 枚举对齐：
 *   'aborted' / 'timeout' / 'connection' / '<HTTP status>' / 'unknown'
 *
 * 优先级（自上而下匹配）：
 *  1. APIUserAbortError              → { code: 'aborted',    message: 'request aborted' }
 *  2. APIConnectionTimeoutError      → { code: 'timeout',    message: err.message }
 *  3. APIConnectionError             → { code: 'connection', message: err.message }
 *  4. APIError                       → 用 err.error.message 透传服务端文案，
 *                                      401 → 'unauthorized: <msg>'
 *                                      429 → 'rate limited: <msg>'
 *                                      其他 → <msg>
 *                                      code = String(err.status ?? 'unknown')
 *  5. 普通 Error                     → { code: 'unknown', message: err.message }
 *  6. 非 Error                        → { code: 'unknown', message: String(err) }
 */
export function normalizeError(error: unknown): ErrorEvent {
  // 1. 用户主动取消
  if (error instanceof APIUserAbortError) {
    return {
      kind: 'error',
      error: { message: 'request aborted', code: 'aborted' },
    };
  }

  // 2. 网络层超时（必须先于通用 ConnectionError 判断）
  if (error instanceof APIConnectionTimeoutError) {
    return {
      kind: 'error',
      error: { message: error.message, code: 'timeout' },
    };
  }

  // 3. 网络层连接错误
  if (error instanceof APIConnectionError) {
    return {
      kind: 'error',
      error: { message: error.message, code: 'connection' },
    };
  }

  // 4. HTTP API 错误：透传服务端真信息
  if (error instanceof APIError) {
    const serverMsg = (error.error as { message?: string } | undefined)?.message;
    const baseMsg = serverMsg ?? error.message;
    const code = String(error.status ?? 'unknown');

    let message = baseMsg;
    if (error.status === 401) {
      message = `unauthorized: ${baseMsg}`;
    } else if (error.status === 429) {
      message = `rate limited: ${baseMsg}`;
    }

    return {
      kind: 'error',
      error: { message, code },
    };
  }

  // 5. 普通 Error
  if (error instanceof Error) {
    return {
      kind: 'error',
      error: { message: error.message, code: 'unknown' },
    };
  }

  // 6. 非 Error
  return {
    kind: 'error',
    error: { message: String(error), code: 'unknown' },
  };
}

/**
 * 判断归一化后的事件是否表示「用户主动取消」。
 * provider 层用：取消时静默返回（不 yield error 事件）。
 */
export function isAbortedEvent(event: ErrorEvent): boolean {
  return event.error.code === 'aborted';
}
