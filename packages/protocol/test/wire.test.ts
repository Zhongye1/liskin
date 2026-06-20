import { describe, expect, it } from 'vitest';

import { decodeEvent, encodeEvent } from '../src/wire.js';
import { EventMsgSchema } from '../src/event-msg.js';
import { OpSchema } from '../src/op.js';
import { decodeOp, encodeOp } from '../src/wire.js';

// —— Op 往返 —— //

describe('Op roundtrip', () => {
  const ops = [
    { type: 'CreateSession', cwd: '/tmp', system: 'be helpful' },
    { type: 'CreateSession' },
    { type: 'ResumeSession', sessionId: 's-abc' },
    { type: 'CloseSession', sessionId: 's-abc' },
    { type: 'ListSessions' },
    {
      type: 'UserTurn',
      sessionId: 's-abc',
      content: 'fix the bug',
      maxTurns: 10,
    },
    { type: 'Interrupt', sessionId: 's-abc' },
    {
      type: 'ConfirmTool',
      sessionId: 's-abc',
      callId: 'c-1',
      decision: 'approve',
    },
    { type: 'Cancel', sessionId: 's-abc' },
  ] as const;

  for (const op of ops) {
    it(`${op.type} encode → decode roundtrip`, () => {
      const encoded = encodeOp(op);
      const decoded = decodeOp(encoded);
      expect(decoded).toEqual(op);
    });
  }

  it('rejects invalid op at decode', () => {
    expect(() => decodeOp('{"type":"Bogus"}')).toThrow();
  });

  it('rejects invalid op at encode', () => {
    expect(() => encodeOp({ type: 'Bogus' } as never)).toThrow();
  });
});

// —— EventMsg 往返 —— //

describe('EventMsg roundtrip', () => {
  it('Token', () => {
    const ev = { type: 'Token', turnId: 't1', text: 'hello' } as const;
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('ToolCall', () => {
    const ev = {
      type: 'ToolCall',
      turnId: 't1',
      call: { id: 'c1', name: 'fs.read', args: { path: 'a.ts' } },
    } as const;
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('ToolProgress', () => {
    const ev = {
      type: 'ToolProgress',
      turnId: 't1',
      callId: 'c1',
      stream: 'stdout',
      chunk: 'ok\n',
    } as const;
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('ToolResult', () => {
    const ev = {
      type: 'ToolResult',
      turnId: 't1',
      result: { ok: true, content: 'done', toolCallId: 'c1' },
    } as const;
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('ToolConfirmRequired', () => {
    const ev = {
      type: 'ToolConfirmRequired',
      turnId: 't1',
      call: { id: 'c2', name: 'shell.exec', args: { cmd: 'rm -rf /' } },
    } as const;
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('TurnStart / TurnEnd', () => {
    const start = { type: 'TurnStart', turnId: 't1', sessionId: 's1' } as const;
    expect(decodeEvent(encodeEvent(start))).toEqual(start);

    const end = {
      type: 'TurnEnd',
      turnId: 't1',
      sessionId: 's1',
      reason: 'completed',
      usage: { inputTokens: 100, outputTokens: 50 },
    } as const;
    expect(decodeEvent(encodeEvent(end))).toEqual(end);
  });

  it('Error', () => {
    const ev = {
      type: 'Error',
      turnId: 't1',
      error: { message: 'boom', code: 'TIMEOUT' },
    } as const;
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });

  it('SessionCreated / SessionResumed / SessionClosed / SessionList', () => {
    const created = {
      type: 'SessionCreated',
      sessionId: 's1',
      createdAt: '2025-01-01',
      isNew: true,
    } as const;
    expect(decodeEvent(encodeEvent(created))).toEqual(created);

    const resumed = {
      type: 'SessionResumed',
      sessionId: 's1',
      updatedAt: '2025-01-01',
    } as const;
    expect(decodeEvent(encodeEvent(resumed))).toEqual(resumed);

    const closed = {
      type: 'SessionClosed',
      sessionId: 's1',
      reason: 'user',
    } as const;
    expect(decodeEvent(encodeEvent(closed))).toEqual(closed);

    const list = {
      type: 'SessionList',
      sessions: [{ id: 's1', createdAt: 'x', updatedAt: 'y', messageCount: 3 }],
    } as const;
    expect(decodeEvent(encodeEvent(list))).toEqual(list);
  });

  it('rejects invalid event at decode', () => {
    expect(() => decodeEvent('{"type":"Bogus"}')).toThrow();
  });

  it('rejects invalid event at encode', () => {
    expect(() => encodeEvent({ type: 'Bogus' } as never)).toThrow();
  });
});

// —— Schema 直接校验 —— //

describe('direct schema validation', () => {
  it('EventMsgSchema rejects malformed Token', () => {
    expect(() => EventMsgSchema.parse({ type: 'Token', turnId: 123 })).toThrow();
  });

  it('OpSchema rejects malformed UserTurn', () => {
    expect(() => OpSchema.parse({ type: 'UserTurn', sessionId: 's1' })).toThrow(); // missing content
  });

  it('ToolCall args default to {} when absent', () => {
    const parsed = EventMsgSchema.parse({
      type: 'ToolCall',
      turnId: 't1',
      call: { id: 'c1', name: 'test' },
    });
    expect(parsed).toMatchObject({
      type: 'ToolCall',
      call: { args: {} },
    });
  });
});
