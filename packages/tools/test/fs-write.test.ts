import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmRequiredError, type ToolCall } from '@liskin/core';

import { ToolRegistry } from '../src/registry.js';

import { makeTempDir, rmDir } from './_helpers.js';

describe('builtin/fs.write', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await makeTempDir();
  });

  afterEach(async () => {
    await rmDir(cwd);
  });

  it('写入临时文件（policy=auto）成功', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'w1',
      name: 'fs.write',
      args: { path: 'out.txt', content: 'hello' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(cwd, 'out.txt'), 'utf8');
    expect(written).toBe('hello');
  });

  it('写入触发确认（policy=ask）→ 抛 ConfirmRequiredError', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'ask' });
    const call: ToolCall = {
      id: 'w2',
      name: 'fs.write',
      args: { path: 'out.txt', content: 'hello' },
    };
    await expect(reg.invoke(call)).rejects.toBeInstanceOf(ConfirmRequiredError);
    // 文件不应被写入
    await expect(fs.readFile(path.join(cwd, 'out.txt'), 'utf8')).rejects.toThrow();
  });

  it('路径越界 → ok:false', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'w3',
      name: 'fs.write',
      args: { path: '/etc/foo.txt', content: 'x' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('outside whitelist');
  });

  it('confirmedCallId 命中 → 跳过确认直接写入', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'ask' });
    const call: ToolCall = {
      id: 'w4',
      name: 'fs.write',
      args: { path: 'sub/dir/out.txt', content: 'world!' },
    };
    const result = await reg.invoke(call, { confirmedCallId: 'w4' });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(cwd, 'sub/dir/out.txt'), 'utf8');
    expect(written).toBe('world!');
  });
});
