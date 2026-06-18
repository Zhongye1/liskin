import { describe, expect, it } from 'vitest';
import {
  type AgentEvent,
  type ChatRequest,
  ConfirmRequiredError,
  type LLMEvent,
  type LLMPort,
  type Msg,
  type ToolCall,
  type ToolDefinition,
  type ToolPort,
  type ToolResult,
  runAgent,
} from '../src/index.js';

// —— 工具：把 generator 收集成数组 —— //
async function collect(gen: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
  }
  return out;
}

// —— Mock 实现 —— //

/** 用「轮次」模拟 LLM：每轮调用 chatStream 时拿出下一组事件作为流。 */
class MockLLM implements LLMPort {
  public calls = 0;
  constructor(private readonly turns: LLMEvent[][]) {}

  chatStream(req: ChatRequest): AsyncIterable<LLMEvent> {
    const idx = this.calls++;
    const events = this.turns[idx] ?? [{ kind: 'done' as const }];
    void req; // 不在测试里断言 messages 透传，但保留参数以满足接口
    return (async function* () {
      for (const ev of events) {
        yield ev;
      }
    })();
  }
}

/** 一个支持「每次调用按预设结果返回 / 抛出」的 Mock Tool。 */
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

const initialMessages: Msg[] = [{ content: 'hi', role: 'user' }];

describe('runAgent — M1 状态机主循环', () => {
  it('TC1 纯对话：token × N → done(completed)', async () => {
    const llm = new MockLLM([
      [{ kind: 'token', text: 'Hello' }, { kind: 'token', text: ', world' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async () => ({
      content: '',
      ok: true,
      toolCallId: 'never',
    }));

    const events = await collect(runAgent({ initialMessages, llm, tools }));

    expect(events).toEqual<AgentEvent[]>([
      { kind: 'token', text: 'Hello' },
      { kind: 'token', text: ', world' },
      { kind: 'done', reason: 'completed' },
    ]);
    expect(llm.calls).toBe(1);
    expect(tools.invocations.length).toBe(0);
  });

  it('TC2 单工具调用 → 回灌 → 完成', async () => {
    const call: ToolCall = {
      args: { path: 'a.ts' },
      id: 'c1',
      name: 'fs.read',
    };
    const llm = new MockLLM([
      // 第一轮：先文本，再 tool_call
      [{ kind: 'token', text: 'reading...' }, { call, kind: 'tool_call' }, { kind: 'done' }],
      // 第二轮：纯文本完成
      [{ kind: 'token', text: 'done.' }, { kind: 'done' }],
    ]);
    const tools = new MockTool(async (c) => ({
      content: 'file contents',
      ok: true,
      toolCallId: c.id,
    }));

    const events = await collect(runAgent({ initialMessages, llm, tools }));

    expect(events).toEqual<AgentEvent[]>([
      { kind: 'token', text: 'reading...' },
      { call, kind: 'tool_call' },
      {
        kind: 'tool_result',
        result: { content: 'file contents', ok: true, toolCallId: 'c1' },
      },
      { kind: 'token', text: 'done.' },
      { kind: 'done', reason: 'completed' },
    ]);
    expect(llm.calls).toBe(2);
    expect(tools.invocations.length).toBe(1);
    expect(tools.invocations[0]!.call.id).toBe('c1');
    // 第一次未确认
    expect(tools.invocations[0]!.confirmedCallId).toBeUndefined();
  });

  it('TC3 ConfirmRequired → 暂停 → 二次进入并放行', async () => {
    const call: ToolCall = {
      args: { cmd: 'rm -rf /' },
      id: 'c2',
      name: 'shell.exec',
    };

    // 第一次 run：抛 ConfirmRequiredError
    const llm1 = new MockLLM([[{ call, kind: 'tool_call' }, { kind: 'done' }]]);
    const tools1 = new MockTool(async (c) => {
      throw new ConfirmRequiredError(c);
    });

    const events1 = await collect(runAgent({ initialMessages, llm: llm1, tools: tools1 }));

    expect(events1).toEqual<AgentEvent[]>([
      { call, kind: 'tool_call' },
      { call, kind: 'tool_confirm_required' },
    ]);
    expect(llm1.calls).toBe(1);

    // 第二次 run：携带 confirmedCallIds，工具正常执行 → 后续完成
    const llm2 = new MockLLM([
      // 第一轮：复现 tool_call
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      // 第二轮：纯文本完成
      [{ kind: 'token', text: 'ok done' }, { kind: 'done' }],
    ]);
    const tools2 = new MockTool(async (c, _attempt, confirmedCallId) => {
      // 命中确认 → 不再抛
      if (confirmedCallId === c.id) {
        return { content: 'ok', ok: true, toolCallId: c.id };
      }
      throw new ConfirmRequiredError(c);
    });

    const events2 = await collect(
      runAgent({
        confirmedCallIds: ['c2'],
        initialMessages,
        llm: llm2,
        tools: tools2,
      }),
    );

    expect(events2).toEqual<AgentEvent[]>([
      { call, kind: 'tool_call' },
      {
        kind: 'tool_result',
        result: { content: 'ok', ok: true, toolCallId: 'c2' },
      },
      { kind: 'token', text: 'ok done' },
      { kind: 'done', reason: 'completed' },
    ]);
    expect(tools2.invocations[0]!.confirmedCallId).toBe('c2');
  });

  it('TC4 maxTurns 死循环保护', async () => {
    const call: ToolCall = { args: {}, id: 'loop', name: 'noop' };
    // 每一轮都返回 tool_call，永不收敛
    const llm = new MockLLM([
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      [{ call, kind: 'tool_call' }, { kind: 'done' }],
      [{ call, kind: 'tool_call' }, { kind: 'done' }], // 不应再被调到
    ]);
    const tools = new MockTool(async (c) => ({
      content: 'r',
      ok: true,
      toolCallId: c.id,
    }));

    const events = await collect(runAgent({ initialMessages, llm, maxTurns: 3, tools }));

    const last = events.at(-1);
    expect(last).toEqual({ kind: 'done', reason: 'max_turns' });
    expect(llm.calls).toBe(3);
    expect(tools.invocations.length).toBe(3);
  });

  it('TC5 LLM 错误事件转发', async () => {
    const llm = new MockLLM([
      [
        { kind: 'token', text: 'pre' },
        { error: { code: '429', message: 'rate limited' }, kind: 'error' },
      ],
    ]);
    const tools = new MockTool(async () => ({
      content: '',
      ok: true,
      toolCallId: 'x',
    }));

    const events = await collect(runAgent({ initialMessages, llm, tools }));

    expect(events).toEqual<AgentEvent[]>([
      { kind: 'token', text: 'pre' },
      { error: { code: '429', message: 'rate limited' }, kind: 'error' },
    ]);
    expect(llm.calls).toBe(1);
  });

  it('TC6 AbortSignal 取消', async () => {
    const ac = new AbortController();

    // 自定义 LLM：先 yield 一个 token，然后等到外部 abort 后再 yield 下一个事件
    const llm: LLMPort = {
      chatStream(_req: ChatRequest): AsyncIterable<LLMEvent> {
        return (async function* chatStream() {
          yield { kind: 'token', text: 'a' };
          // 让出事件循环，给外部一次 abort 机会
          await new Promise<void>((resolve) => {
            const tick = () => {
              if (ac.signal.aborted) {
                resolve();
              } else {
                setTimeout(tick, 1);
              }
            };
            tick();
          });
          yield { kind: 'token', text: 'b' };
          yield { kind: 'done' };
        })();
      },
    };
    const tools = new MockTool(async () => ({
      content: '',
      ok: true,
      toolCallId: 'x',
    }));

    const gen = runAgent({
      initialMessages,
      llm,
      signal: ac.signal,
      tools,
    });

    const events: AgentEvent[] = [];
    // 拿到第一个 token，然后 abort
    const first = await gen.next();
    if (!first.done && first.value) {
      events.push(first.value);
    }
    ac.abort();

    for await (const ev of gen) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ kind: 'token', text: 'a' });
    expect(events.at(-1)).toEqual({
      kind: 'done',
      reason: 'cancelled',
    });
  });
});
