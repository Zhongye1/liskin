import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmRequiredError, type ToolCall } from '@liskin/core';

import { ToolRegistry } from '../src/registry.js';

import { makeTempDir, rmDir } from './_helpers.js';

describe('builtin/shell.exec', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await makeTempDir();
  });

  afterEach(async () => {
    await rmDir(cwd);
  });

  it('echo hello（policy=auto）→ stdout 含 hello', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 's1',
      name: 'shell.exec',
      args: { cmd: 'echo hello' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello');
  });

  it('危险命令 rm -rf /（policy=auto）→ ok:false（command-policy 拦截）', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 's2',
      name: 'shell.exec',
      args: { cmd: 'rm -rf /' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('preflight error');
    expect(result.content).toContain('dangerous');
  });

  it('普通命令在 policy=ask 下 → 抛 ConfirmRequiredError', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'ask' });
    const call: ToolCall = {
      id: 's3',
      name: 'shell.exec',
      args: { cmd: 'echo ok' },
    };
    await expect(reg.invoke(call)).rejects.toBeInstanceOf(ConfirmRequiredError);
  });

  it('命令非零退出 → ok:true（exit code 信息进 content）', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 's4',
      name: 'shell.exec',
      args: { cmd: 'sh -c "exit 7"' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('exit code 7');
  });

  it('confirmedCallId 命中 → policy=ask 下也跳过确认', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'ask' });
    const call: ToolCall = {
      id: 's5',
      name: 'shell.exec',
      args: { cmd: 'echo confirmed' },
    };
    const result = await reg.invoke(call, { confirmedCallId: 's5' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('confirmed');
  });

  it('循环打印（带 sleep）→ onProgress 收到多个 chunk（流式）', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 's6',
      name: 'shell.exec',
      args: {
        cmd: 'for i in 1 2 3; do echo "tick $i"; sleep 0.05; done',
        timeoutMs: 5000,
      },
    };
    const chunks: { stream: 'stdout' | 'stderr'; chunk: string }[] = [];
    const result = await reg.invoke(call, {
      onProgress: (stream, chunk) => {
        chunks.push({ stream, chunk });
      },
    });
    expect(result.ok).toBe(true);
    // 至少要拿到 2 个独立 chunk（流式）
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const merged = chunks.map((c) => c.chunk).join('');
    expect(merged).toContain('tick 1');
    expect(merged).toContain('tick 3');
  });

  it('保留最终聚合 ToolResult（向后兼容）', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 's7',
      name: 'shell.exec',
      args: {
        cmd: 'for i in 1 2; do echo "line $i"; sleep 0.02; done',
        timeoutMs: 5000,
      },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('line 1');
    expect(result.content).toContain('line 2');
  });
});
