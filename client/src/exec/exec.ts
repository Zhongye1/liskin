/**
 * agent exec: headless 一次性消费器。
 *
 * 用 InProcessKernelClient 直连 kernel（in-process，无 daemon），
 * 把 EventMsg 流渲染成终端文本，auto 批准工具调用。
 *
 * 设计依据：docs/architecture/kernel-client-protocol.md §6.3 Step 2。
 * headless 是「不渲染 UI 的事件消费者」，与 agent chat 同根协议。
 */
import type { EventMsg } from '@liskin/protocol';
import { InMemoryStore, InProcessKernelClient } from '@liskin/core';
import { createProvider } from '@liskin/llm';
import { ToolRegistry } from '@liskin/tools';

import type { ExecOptions, ExecResult } from './types.js';

import {
  writeToken,
  writeToolCall,
  writeToolProgress,
  writeToolResult,
  writeError,
} from '../render/index.js';

/**
 * 运行一次任务，把事件流打印到 stdout/stderr。
 * 返回最终 TurnEnd 的 reason。
 */
export async function runExec(prompt: string, opts: ExecOptions): Promise<ExecResult> {
  // 装配三个 Port 实现
  const llm = createProvider({
    id: 'exec',
    name: 'exec',
    protocol: 'openai-compatible',
    apiKey: opts.apiKey,
    model: opts.model,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  const tools = new ToolRegistry({
    cwd: opts.cwd,
    pathWhitelist: [opts.cwd],
    confirmPolicy: 'auto',
  });

  const kernel = new InProcessKernelClient({
    llm,
    tools,
    store: new InMemoryStore(),
    maxTurns: opts.maxTurns ?? 24,
  });

  const session = await kernel.createSession({
    cwd: opts.cwd,
    system: opts.system,
  });

  let lastReason = 'unknown';
  const stream = kernel.submit({
    type: 'UserTurn',
    sessionId: session.id,
    content: prompt,
    maxTurns: opts.maxTurns,
  });

  for await (const ev of stream) {
    lastReason = render(ev, lastReason);
  }

  const ok = lastReason === 'completed';
  return { ok, turnEndReason: lastReason };
}

/** 把单个 EventMsg 渲染成终端输出，返回当前 turn 结束原因。 */
function render(ev: EventMsg, prevReason: string): string {
  switch (ev.type) {
    case 'TurnStart': {
      return prevReason;
    }
    case 'Token': {
      writeToken(ev.text);
      return prevReason;
    }
    case 'ToolCall': {
      writeToolCall(ev.call);
      return prevReason;
    }
    case 'ToolProgress': {
      writeToolProgress(ev.chunk);
      return prevReason;
    }
    case 'ToolResult': {
      writeToolResult(ev.result);
      return prevReason;
    }
    case 'ToolConfirmRequired': {
      process.stderr.write(`\n[confirm required] ${ev.call.name} (auto-approved)\n`);
      return prevReason;
    }
    case 'TurnEnd': {
      return ev.reason;
    }
    case 'Error': {
      writeError(ev.error.message);
      return 'error';
    }
    default: {
      return prevReason;
    }
  }
}
