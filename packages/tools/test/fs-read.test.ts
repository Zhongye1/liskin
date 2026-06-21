import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolCall } from '@liskin/core';

import { ToolRegistry } from '../src/registry.js';

import { makeTempDir, rmDir, writeFile } from './_helpers.js';

describe('builtin/fs_read', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await makeTempDir();
  });

  afterEach(async () => {
    await rmDir(cwd);
  });

  it('读取文件全文（带行号）', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'line1\nline2\nline3');
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = { id: 'r1', name: 'fs_read', args: { path: 'a.txt' } };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('1: line1\n2: line2\n3: line3');
  });

  it('读取指定行号范围（offset + limit）', async () => {
    await writeFile(path.join(cwd, 'b.txt'), 'L1\nL2\nL3\nL4\nL5');
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'r2',
      name: 'fs_read',
      args: { path: 'b.txt', offset: 2, limit: 2 },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('2: L2');
    expect(result.content).toContain('3: L3');
    expect(result.content).toContain('[文件共 5 行, 已显示 2-3');
  });

  it('路径越界 → ok:false', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = { id: 'r3', name: 'fs_read', args: { path: '/etc/passwd' } };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('preflight error');
  });

  it('文件不存在 → ok:false', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = { id: 'r4', name: 'fs_read', args: { path: 'no-such.txt' } };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/ENOENT|no such file/iu);
  });
});
