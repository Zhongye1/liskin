import { describe, expect, it } from 'vitest';

import { ConfirmRequiredError, type ToolCall } from '@liskin/core';

import { applyConfirmPolicy } from '../src/sandbox/confirm-policy.js';

const call: ToolCall = { id: 'x1', name: 'demo.tool', args: { foo: 1 } };

describe('sandbox/confirm-policy', () => {
  it('auto → 直接通过（不抛）', () => {
    expect(() => applyConfirmPolicy(call, 'auto')).not.toThrow();
  });

  it('ask → 抛 ConfirmRequiredError，error.call 包含原 call', () => {
    try {
      applyConfirmPolicy(call, 'ask');
      throw new Error('should not reach here');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfirmRequiredError);
      expect((error as ConfirmRequiredError).call).toEqual(call);
      expect((error as ConfirmRequiredError).name).toBe('ConfirmRequiredError');
    }
  });

  it('deny → 抛普通 Error 且不是 ConfirmRequiredError', () => {
    let caught: unknown = null;
    try {
      applyConfirmPolicy(call, 'deny');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ConfirmRequiredError);
    expect((caught as Error).message).toContain('denied by policy');
  });
});
