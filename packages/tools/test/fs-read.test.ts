import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolCall } from '@liskin/core';

import { ToolRegistry } from '../src/registry.js';

import { makeTempDir, rmDir, writeFile } from './_helpers.js';

describe('builtin/fs.read', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await makeTempDir();
  });

  afterEach(async () => {
    await rmDir(cwd);
  });

  it('读取临时文件全文', async () => {
    await writeFile(path.join(cwd, 'a.txt'), 'line1\nline2\nline3');
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = { id: 'r1', name: 'fs.read', args: { path: 'a.txt' } };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('line1\nline2\nline3');
  });

  it('读取指定行号范围（startLine + limit）', async () => {
    await writeFile(path.join(cwd, 'b.txt'), 'L1\nL2\nL3\nL4\nL5');
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'r2',
      name: 'fs.read',
      args: { path: 'b.txt', startLine: 2, limit: 2 },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('L2\nL3');
  });

  it('路径越界（白名单外）→ ok:false（preflight 阶段拒）', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'r3',
      name: 'fs.read',
      args: { path: '/etc/passwd' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('preflight error');
    expect(result.content).toContain('outside whitelist');
  });

  it('文件不存在 → ok:false', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'r4',
      name: 'fs.read',
      args: { path: 'no-such.txt' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/ENOENT|no such file/iu);
  });
});
