import { describe, expect, it } from 'vitest';
import type { EventMsg, ToolCall, ToolResult } from '@liskin/core';

 import { applyEvent, messagesToTurns, newTurn } from '../src/kernel/events';

const SESSION = 'sess-1';
const TURN = 'turn-1';

function mkTurn() {
  return newTurn(TURN, '读 README 并总结');
}

const TOOL_CALL: ToolCall = { id: 'call-1', name: 'fs.read', args: { path: 'README.md' } };

const okResult: ToolResult = { content: '# hello', ok: true, toolCallId: 'call-1' };
const errResult: ToolResult = { content: 'boom', ok: false, toolCallId: 'call-1' };

function ev(e: EventMsg): EventMsg {
  return e;
}

describe('applyEvent / reducer', () => {
  it('Token 累积成单个 text step', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'TurnStart', turnId: TURN, sessionId: SESSION }));
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: 'Hello' }));
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: ' world' }));
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]?.kind).toBe('text');
    if (turn.steps[0]?.kind === 'text') {
      expect(turn.steps[0].parts).toEqual(['Hello', ' world']);
      expect(turn.steps[0].parts.join('')).toBe('Hello world');
    }
  });

  it('ToolCall 后再收到 Token 会开新 text step（交织）', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: 'before' }));
    applyEvent(turn, ev({ type: 'ToolCall', turnId: TURN, call: TOOL_CALL }));
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: 'after' }));
    expect(turn.steps.map((s) => s.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('ToolProgress 写入对应流并置 running', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'ToolCall', turnId: TURN, call: TOOL_CALL }));
    applyEvent(turn, ev({ type: 'ToolProgress', turnId: TURN, callId: 'call-1', stream: 'stdout', chunk: 'line1\n' }));
    applyEvent(turn, ev({ type: 'ToolProgress', turnId: TURN, callId: 'call-1', stream: 'stderr', chunk: 'warn\n' }));
    const [step] = turn.steps;
    expect(step?.kind).toBe('tool');
    if (step?.kind === 'tool') {
      expect(step.status).toBe('running');
      expect(step.stdout).toEqual(['line1\n']);
      expect(step.stderr).toEqual(['warn\n']);
    }
  });

  it('ToolResult ok → done；fail → error', () => {
    const a = mkTurn();
    applyEvent(a, ev({ type: 'ToolCall', turnId: TURN, call: TOOL_CALL }));
    applyEvent(a, ev({ type: 'ToolResult', turnId: TURN, result: okResult }));
    expect(a.steps[0]?.kind === 'tool' && a.steps[0].status).toBe('done');

    const b = mkTurn();
    applyEvent(b, ev({ type: 'ToolCall', turnId: TURN, call: TOOL_CALL }));
    applyEvent(b, ev({ type: 'ToolResult', turnId: TURN, result: errResult }));
    expect(b.steps[0]?.kind === 'tool' && b.steps[0].status).toBe('error');
  });

  it('ToolConfirmRequired 把工具 step 置 confirm', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'ToolCall', turnId: TURN, call: TOOL_CALL }));
    applyEvent(turn, ev({ type: 'ToolConfirmRequired', turnId: TURN, call: TOOL_CALL }));
    expect(turn.steps[0]?.kind === 'tool' && turn.steps[0].status).toBe('confirm');
  });

  it('未对应任何 tool step 的 ToolProgress/Result 安全忽略', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'ToolProgress', turnId: TURN, callId: 'ghost', stream: 'stdout', chunk: 'x' }));
    applyEvent(turn, ev({ type: 'ToolResult', turnId: TURN, result: okResult }));
    expect(turn.steps).toHaveLength(0);
  });

  it('TurnEnd completed/interrupted/error 各自映射 turn.status', () => {
    const a = mkTurn();
    applyEvent(a, ev({ type: 'TurnEnd', turnId: TURN, sessionId: SESSION, reason: 'completed' }));
    expect(a.status).toBe('done');

    const b = mkTurn();
    applyEvent(b, ev({ type: 'TurnEnd', turnId: TURN, sessionId: SESSION, reason: 'interrupted' }));
    expect(b.status).toBe('interrupted');

    const c = mkTurn();
    applyEvent(c, ev({ type: 'TurnEnd', turnId: TURN, sessionId: SESSION, reason: 'error' }));
    expect(c.status).toBe('error');

    // 未知 reason 兜底为 done
    const d = mkTurn();
    applyEvent(d, ev({ type: 'TurnEnd', turnId: TURN, sessionId: SESSION, reason: 'max_turns' }));
    expect(d.status).toBe('done');
  });

  it('Error 事件把 turn.status 置 error', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'Error', turnId: TURN, sessionId: SESSION, error: { message: 'fail', code: 'E1' } }));
    expect(turn.status).toBe('error');
  });

  it('会话生命周期事件不影响 turn', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: 'hi' }));
    applyEvent(turn, ev({ type: 'SessionCreated', sessionId: SESSION, createdAt: 't', isNew: true }));
    applyEvent(turn, ev({ type: 'SessionList', sessions: [] }));
    expect(turn.steps).toHaveLength(1);
    expect(turn.status).toBe('running');
  });

  it('完整一轮：文本+工具+确认+结果+结束', () => {
    const turn = mkTurn();
    applyEvent(turn, ev({ type: 'TurnStart', turnId: TURN, sessionId: SESSION }));
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: '我来读文件' }));
    applyEvent(turn, ev({ type: 'ToolCall', turnId: TURN, call: TOOL_CALL }));
    applyEvent(turn, ev({ type: 'ToolConfirmRequired', turnId: TURN, call: TOOL_CALL }));
    applyEvent(turn, ev({ type: 'ToolProgress', turnId: TURN, callId: 'call-1', stream: 'stdout', chunk: 'reading' }));
    applyEvent(turn, ev({ type: 'ToolResult', turnId: TURN, result: okResult }));
    applyEvent(turn, ev({ type: 'Token', turnId: TURN, text: '文件内容是 hello' }));
    applyEvent(turn, ev({ type: 'TurnEnd', turnId: TURN, sessionId: SESSION, reason: 'completed' }));

    expect(turn.steps.map((s) => s.kind)).toEqual(['text', 'tool', 'text']);
    expect(turn.steps[1]?.kind === 'tool' && turn.steps[1].status).toBe('done');
    expect(turn.status).toBe('done');
  });
});

describe('messagesToTurns / 历史重建', () => {
  it('system 消息不产生 turn', () => {
    const turns = messagesToTurns([
      { role: 'system', content: 'you are helpful' },
    ]);
    expect(turns).toHaveLength(0);
  });

  it('user→assistant text 重建为单 turn 单 text step', () => {
    const turns = messagesToTurns([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userContent).toBe('你好');
    expect(turns[0]?.status).toBe('done');
    expect(turns[0]?.steps.map((s) => s.kind)).toEqual(['text']);
    if (turns[0]?.steps[0]?.kind === 'text') {
      expect(turns[0].steps[0].parts).toEqual(['你好，有什么可以帮你？']);
    }
  });

  it('assistant 的 toolCalls 重建为 tool step，后续 tool 消息回填 result', () => {
    const turns = messagesToTurns([
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '我来读', toolCalls: [TOOL_CALL] },
      { role: 'tool', toolCallId: 'call-1', content: '# hello' },
      { role: 'assistant', content: '文件内容是 hello' },
    ]);
    expect(turns).toHaveLength(1);
    const steps = turns[0]?.steps ?? [];
    expect(steps.map((s) => s.kind)).toEqual(['text', 'tool', 'text']);
    const [, tool] = steps;
    expect(tool?.kind).toBe('tool');
    if (tool?.kind === 'tool') {
      expect(tool.status).toBe('done');
      expect(tool.result?.content).toBe('# hello');
      expect(tool.result?.ok).toBe(true);
    }
  });

  it('多个 user 消息切成多个 turn', () => {
    const turns = messagesToTurns([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.userContent).toBe('q1');
    expect(turns[1]?.userContent).toBe('q2');
  });

  it('无前导 user 的 assistant 挂到空 userContent 的兜底 turn', () => {
    const turns = messagesToTurns([
      { role: 'assistant', content: 'orphan' },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userContent).toBe('');
    expect(turns[0]?.steps[0]?.kind).toBe('text');
  });

  it('无对应 tool 调用的 tool 消息作为文本兜底', () => {
    const turns = messagesToTurns([
      { role: 'user', content: 'hi' },
      { role: 'tool', toolCallId: 'ghost', content: 'dangling' },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.steps.map((s) => s.kind)).toEqual(['text']);
  });

  it('空数组返回空', () => {
    expect(messagesToTurns([])).toEqual([]);
  });
});
