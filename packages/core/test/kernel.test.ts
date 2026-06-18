/* eslint-disable max-lines -- 9 个协议测试用例内聚于单文件 */
import { describe, expect, it } from 'vitest';
import {
  type ChatRequest,
  ConfirmRequiredError,
  type EventMsg,
  type LLMEvent,
  type LLMPort,
  InMemoryStore,
  InProcessKernelClient,
  type ToolCall,
  type ToolDefinition,
  type ToolPort,
  type ToolResult,
} from '../src/index.js';

// —— 工具 —— //

function collect(gen: AsyncIterable<EventMsg>): Promise<EventMsg[]> {
  const out: EventMsg[] = [];
  return (async () => {
    for await (const ev of gen) {
      out.push(ev);
    }
    return out;
  })();
}

class MockLLM implements LLMPort {
  public calls = 0;
  constructor(private readonly turns: LLMEvent[][]) {}

  chatStream(req: ChatRequest): AsyncIterable<LLMEvent> {
    void req;
    const idx = this.calls++;
    const events = this.turns[idx] ?? [{ kind: 'done' as const }];
    return (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })();
  }
}

class MockTool implements ToolPort {
  public invocations: { call: ToolCall; confirmedCallId?: string }[] = [];

  constructor(
    private readonly behavior: (
      call: ToolCall,
      attempt: number,
      confirmedCallId?: string,
    ) => Promise<ToolResult> | ToolResult,
    private readonly defs: ToolDefinition[] = [],
  ) {}

  list(): ToolDefinition[] {
    return this.defs;
  }

  async invoke(call: ToolCall, opts?: { confirmedCallId?: string }): Promise<ToolResult> {
    const attempt = this.invocations.length;
    this.invocations.push({ call, confirmedCallId: opts?.confirmedCallId });
    return await this.behavior(call, attempt, opts?.confirmedCallId);
  }
}

function eventsOf(arr: EventMsg[]): string[] {
  return arr.map((e) => e.type);
}

// —— 测试 —— //

describe('InProcessKernelClient — Step 1 协议落地', () => {
  it('TC1 会话生命周期：create / resume / list / close', async () => {
    const llm = new MockLLM([[{ kind: 'done' }]]);
    const tools = new MockTool(async () => ({ content: '', ok: true, toolCallId: 'x' }));
    const store = new InMemoryStore();
    const kernel = new InProcessKernelClient({ llm, tools, store });

    const created = await kernel.createSession({ system: 'you are helpful' });
    expect(created.isNew).toBe(true);
    expect(created.messageCount).toBe(1); // system

    const list1 = await kernel.listSessions();
    expect(list1).toHaveLength(1);
    expect(list1[0]!.id).toBe(created.id);

    const resumed = await kernel.resumeSession(created.id);
    expect(resumed.isNew).toBe(false);
    expect(resumed.id).toBe(created.id);

    await kernel.closeSession(created.id);
    const list2 = await kernel.listSessions();
    expect(list2).toHaveLength(0);
  });

  it('TC2 纯对话：TurnStart → Token×N → TurnEnd(completed)', async () => {
    const llm = new MockLLM([
      [{ kind: 'token', text: 'Hello' }, { kind: 'token', text: ', world' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async () => ({ content: '', ok: true, toolCallId: 'x' }));
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const session = await kernel.createSession();
    const evs = await collect(
      kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'hi' }),
    );

    expect(eventsOf(evs)).toEqual(['TurnStart', 'Token', 'Token', 'TurnEnd']);
    const turnEnd = evs.at(-1)!;
    expect(turnEnd.type).toBe('TurnEnd');
    expect(turnEnd).toMatchObject({ reason: 'completed' });
    // turnId 贯穿
    const { turnId } = evs.find((e) => e.type === 'TurnStart') as { turnId: string };
    expect(evs.filter((e) => 'turnId' in e && e.turnId === turnId).length).toBe(Number(evs.length));
  });

  it('TC3 工具调用：ToolCall → ToolResult → 续跑文本 → completed', async () => {
    const call: ToolCall = { args: { path: 'a.ts' }, id: 'c1', name: 'fs.read' };
    const llm = new MockLLM([
      [{ kind: 'token', text: 'reading...' }, { call, kind: 'tool_call' }, { kind: 'done' }],
      [{ kind: 'token', text: 'done.' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async (c) => ({ content: 'file', ok: true, toolCallId: c.id }));
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const session = await kernel.createSession();
    const evs = await collect(
      kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'read a.ts' }),
    );

    expect(eventsOf(evs)).toEqual([
      'TurnStart',
      'Token',
      'ToolCall',
      'ToolResult',
      'Token',
      'TurnEnd',
    ]);
    expect(tools.invocations).toHaveLength(1);
  });

  it('TC4 工具确认 approve：暂停 → confirmTool(approve) → 续跑完成', async () => {
    const call: ToolCall = { args: { cmd: 'ls' }, id: 'c2', name: 'shell.exec' };
    const llm = new MockLLM([
      // 第一轮：tool_call，工具抛 ConfirmRequired
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      // 第二轮（approve 后续跑）：工具放行，LLM 文本完成
      [{ kind: 'token', text: 'ran it' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async (c, _a, confirmedCallId) => {
      if (confirmedCallId === c.id) {
        return { content: 'ok', ok: true, toolCallId: c.id };
      }
      throw new ConfirmRequiredError(c);
    });
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const session = await kernel.createSession();
    const consuming = collect(
      kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'run ls' }),
    );

    // approve：需在事件流被消费的同时触发；用微任务交错
    void (async () => {
      // 等到 confirm 事件出现
      await new Promise((r) => {
        void setTimeout(r, 5);
      });
      await kernel.confirmTool(session.id, 'c2', 'approve');
    })();

    const evs = await consuming;

    expect(eventsOf(evs)).toEqual([
      'TurnStart',
      'ToolCall',
      'ToolConfirmRequired',
      'ToolResult',
      'Token',
      'TurnEnd',
    ]);
    expect(evs.at(-1)).toMatchObject({ reason: 'completed' });
    // 工具被调两次：第一次抛 confirm，第二次带 confirmedCallId 放行
    expect(tools.invocations).toHaveLength(2);
    expect(tools.invocations[1]!.confirmedCallId).toBe('c2');
  });

  it('TC5 工具确认 deny：回灌失败结果 → 续跑 → completed', async () => {
    const call: ToolCall = { args: { cmd: 'rm' }, id: 'c3', name: 'shell.exec' };
    const llm = new MockLLM([
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      [{ kind: 'token', text: 'ok, skipped' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async (c, _a, confirmedCallId) => {
      if (confirmedCallId === c.id) {
        return { content: 'ok', ok: true, toolCallId: c.id };
      }
      throw new ConfirmRequiredError(c);
    });
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const session = await kernel.createSession();
    const consuming = collect(
      kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'rm something' }),
    );

    void (async () => {
      await new Promise((r) => {
        void setTimeout(r, 5);
      });
      await kernel.confirmTool(session.id, 'c3', 'deny');
    })();

    const evs = await consuming;

    expect(eventsOf(evs)).toEqual([
      'TurnStart',
      'ToolCall',
      'ToolConfirmRequired',
      'ToolResult',
      'Token',
      'TurnEnd',
    ]);
    expect(evs.at(-1)).toMatchObject({ reason: 'completed' });
    // deny 的 tool_result
    const result = evs.find((e) => e.type === 'ToolResult') as {
      result: ToolResult;
    };
    expect(result.result.ok).toBe(false);
  });

  it('TC6 中断：interrupt → TurnEnd(interrupted)', async () => {
    // MockLLM 持续 yield token，依赖 runAgent 在事件间检查 signal 中断
    const llm: LLMPort = {
      chatStream(req: ChatRequest): AsyncIterable<LLMEvent> {
        return (async function* () {
          for (let i = 0; i < 1000; i++) {
            // 每次 yield 前检查 signal，配合 loop 的取消检查
            if (req.signal?.aborted) {
              return;
            }
            yield { kind: 'token', text: 'x' };
            await new Promise((r) => {
              void setTimeout(r, 0);
            });
          }
          yield { kind: 'done' };
        })();
      },
    };
    const tools = new MockTool(async () => ({ content: '', ok: true, toolCallId: 'x' }));
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const session = await kernel.createSession();
    const consuming = collect(
      kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'long' }),
    );

    // 让它产出一些 token
    await new Promise((r) => {
      void setTimeout(r, 5);
    });
    await kernel.interrupt(session.id);
    const evs = await consuming;

    const tokens = evs.filter((e) => e.type === 'Token').length;
    expect(tokens).toBeGreaterThan(0);
    expect(evs.at(-1)?.type).toBe('TurnEnd');
    expect(evs.at(-1)).toMatchObject({ reason: 'interrupted' });
  });

  it('TC7 会话持久化：UserTurn 后 messages 落库，resume 可读', async () => {
    const llm = new MockLLM([[{ kind: 'token', text: 'hi back' }, { kind: 'done' }]]);
    const tools = new MockTool(async () => ({ content: '', ok: true, toolCallId: 'x' }));
    const store = new InMemoryStore();
    const kernel = new InProcessKernelClient({ llm, tools, store });

    const session = await kernel.createSession();
    await collect(kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'hello' }));

    // persist 在 finally 里异步落库，等待微任务
    await new Promise((r) => {
      void setTimeout(r, 5);
    });
    const record = await store.loadSession(session.id);
    expect(record).not.toBeNull();
    const roles = record!.messages.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('TC8 session 不存在：submit 返回 Error 事件', async () => {
    const llm = new MockLLM([[{ kind: 'done' }]]);
    const tools = new MockTool(async () => ({ content: '', ok: true, toolCallId: 'x' }));
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const evs = await collect(
      kernel.submit({ type: 'UserTurn', sessionId: 'nope', content: 'hi' }),
    );
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe('Error');
  });

  it('TC9 maxTurns：达到上限 → TurnEnd(max_turns)', async () => {
    const call: ToolCall = { args: {}, id: 'loop', name: 'noop' };
    const llm = new MockLLM([
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async (c) => ({ content: 'r', ok: true, toolCallId: c.id }));
    const kernel = new InProcessKernelClient({ llm, tools, store: new InMemoryStore() });

    const session = await kernel.createSession();
    const evs = await collect(
      kernel.submit({ type: 'UserTurn', sessionId: session.id, content: 'loop', maxTurns: 2 }),
    );
    expect(evs.at(-1)).toMatchObject({ reason: 'max_turns' });
    expect(llm.calls).toBe(2);
  });
});
