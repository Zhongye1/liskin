 import type { EventMsg, Msg, ToolCall, ToolResult } from '@liskin/core';

 export interface TextStep {
   kind: 'text';
   id: string;
   parts: string[];
 }
 export interface ToolStep {
   kind: 'tool';
   id: string;
   call: ToolCall;
   status: 'pending' | 'confirm' | 'running' | 'done' | 'error';
   stdout: string[];
   stderr: string[];
   result?: ToolResult;
 }

 /** 时间线上的一个块：assistant 文本 或 工具调用。 */
 export type Step = TextStep | ToolStep;

/** 一轮 = 一次 UserTurn + 它触发的所有事件聚合成 steps。 */
export interface Turn {
  id: string;
  userContent: string;
  steps: Step[];
  status: 'running' | 'done' | 'interrupted' | 'error';
}

let stepSeq = 0;
function newStepId(): string {
  stepSeq += 1;
  return `step-${stepSeq}`;
}

 // 只复用「最后一个 step 是 text」的情况：保证 token/tool 按到达顺序交织，
 // 即 text→tool→text 会开新的 text step，而不是把后续 token 错误追加到 tool 之前的块。
 function lastTextStep(turn: Turn): TextStep | undefined {
   const last = turn.steps.at(-1);
   return last && last.kind === 'text' ? last : undefined;
 }

function findToolStep(turn: Turn, callId: string): Step | undefined {
  return turn.steps.find((s) => s.kind === 'tool' && s.id === callId);
}

/**
 * 把一个 EventMsg 折进 turn（原地修改 + 返回），纯 reducer。
 * token 与 tool_call 按到达顺序交织进 steps，与终端一致。
 *
 * 见 docs/architecture/web-frontend-design.md §2.3。
 */
export function applyEvent(turn: Turn, ev: EventMsg): void {
  switch (ev.type) {
    case 'TurnStart': {
      return;
    }
    case 'Token': {
      let text = lastTextStep(turn);
      if (!text) {
        text = { kind: 'text', id: newStepId(), parts: [] };
        turn.steps.push(text);
      }
      text.parts.push(ev.text);
      return;
    }
    case 'ToolCall': {
      turn.steps.push({
        kind: 'tool',
        id: ev.call.id,
        call: ev.call,
        status: 'pending',
        stdout: [],
        stderr: [],
      });
      return;
    }
    case 'ToolProgress': {
      const step = findToolStep(turn, ev.callId);
      if (step && step.kind === 'tool') {
        if (ev.stream === 'stdout') {step.stdout.push(ev.chunk);}
        else {step.stderr.push(ev.chunk);}
        step.status = 'running';
      }
      return;
    }
    case 'ToolResult': {
      const step = findToolStep(turn, ev.result.toolCallId);
      if (step && step.kind === 'tool') {
        step.result = ev.result;
        step.status = ev.result.ok ? 'done' : 'error';
      }
      return;
    }
    case 'ToolConfirmRequired': {
      const step = findToolStep(turn, ev.call.id);
      if (step && step.kind === 'tool') {step.status = 'confirm';}
      return;
    }
    case 'TurnEnd': {
      if (ev.reason === 'completed') {
        turn.status = 'done';
      } else if (ev.reason === 'interrupted') {
        turn.status = 'interrupted';
      } else if (ev.reason === 'error') {
        turn.status = 'error';
      } else {
        turn.status = 'done';
      }
      return;
    }
    case 'Error': {
      turn.status = 'error';
      return;
    }
    default: {
      // 其余会话生命周期事件不影响 turn
      break;
    }
  }
}

export function newTurn(turnId: string, userContent: string): Turn {
  return { id: turnId, userContent, steps: [], status: 'running' };
}

let turnSeq = 0;

/**
 * 把持久化的 Msg[] 重建为 Turn[]，用于刷新/切会话时回放历史。
 * 重建是 lossy 的：没有 ToolProgress 的 stdout/stderr 与实时状态，
 * tool step 一律标 done（result 来自后续 tool 消息）。
 * system 消息不产生 turn。
 *
 * 见 docs/architecture/web-frontend-design.md §Step 3.3。
 */
export function messagesToTurns(messages: Msg[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  // callId → tool step 引用，用于把后续 tool 消息回填 result
  const toolSteps = new Map<string, ToolStep>();

  const flush = () => {
    if (current) {
      current.status = 'done';
      turns.push(current);
      current = null;
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      // system 消息不产生 turn
    } else if (msg.role === 'user') {
      flush();
      turnSeq += 1;
      current = newTurn(`hist-${turnSeq}`, msg.content);
    } else {
      if (!current) {
        // 没有 user 前导的 assistant/tool：挂到一个空 turn 兜底
        turnSeq += 1;
        current = newTurn(`hist-${turnSeq}`, '');
      }
      if (msg.role === 'assistant') {
        if (msg.content) {
          current.steps.push({ kind: 'text', id: `hist-text-${turnSeq}-${current.steps.length}`, parts: [msg.content] });
        }
        for (const call of msg.toolCalls ?? []) {
          const step: ToolStep = {
            kind: 'tool',
            id: call.id,
            call,
            status: 'done',
            stdout: [],
            stderr: [],
          };
          current.steps.push(step);
          toolSteps.set(call.id, step);
        }
      } else if (msg.role === 'tool') {
        const step = toolSteps.get(msg.toolCallId);
        if (step) {
          step.result = { content: msg.content, ok: true, toolCallId: msg.toolCallId };
        } else {
          // 无对应 tool 调用的 tool 消息：作为一条文本兜底
          current.steps.push({
            kind: 'text',
            id: `hist-tool-${turnSeq}-${current.steps.length}`,
            parts: [msg.content],
          });
        }
      }
    }
  }
  flush();
  return turns;
}
