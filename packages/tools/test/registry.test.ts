import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmRequiredError, type ToolCall } from '@liskin/core';

import { ToolRegistry } from '../src/registry.js';
import { fsRead } from '../src/builtin/fs-read.js';
import { fsWrite } from '../src/builtin/fs-write.js';

import { makeTempDir, rmDir, writeFile } from './_helpers.js';

describe('ToolRegistry', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await makeTempDir();
  });

  afterEach(async () => {
    await rmDir(cwd);
  });

  it('list() 返回三个 builtin 定义', () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const list = reg.list();
    const names = list.map((t) => t.name).toSorted();
    expect(names).toEqual(['fs.read', 'fs.write', 'shell.exec']);
  });

  it('未知工具名 → ok:false 且 content 含 unknown tool', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = { id: 'c1', name: 'no.such.tool', args: {} };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('unknown tool');
    expect(result.toolCallId).toBe('c1');
  });

  it('普通成功路径：fs.read 读取临时文件', async () => {
    const file = path.join(cwd, 'a.txt');
    await writeFile(file, 'hello world');
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = { id: 'c2', name: 'fs.read', args: { path: 'a.txt' } };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello world');
    expect(result.toolCallId).toBe('c2');
  });

  it('preflight 抛 ConfirmRequiredError 时透传给上层（不 catch 成 ok:false）', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'ask' });
    const call: ToolCall = {
      id: 'c3',
      name: 'fs.write',
      args: { path: 'b.txt', content: 'x' },
    };
    await expect(reg.invoke(call)).rejects.toBeInstanceOf(ConfirmRequiredError);
  });

  it('携带 confirmedCallId === call.id 时跳过确认直接执行', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'ask' });
    const call: ToolCall = {
      id: 'c4',
      name: 'fs.write',
      args: { path: 'b.txt', content: 'hello' },
    };
    const result = await reg.invoke(call, { confirmedCallId: 'c4' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('wrote 5 bytes');
  });

  it('register() 重名抛错', () => {
    const reg = new ToolRegistry({
      cwd,
      confirmPolicy: 'auto',
      builtins: [fsRead],
    });
    expect(() => reg.register(fsRead)).toThrow(/tool name collision/u);
  });

  it('preflight 普通错误（路径越界）以 ok:false 返回，不透传', async () => {
    const reg = new ToolRegistry({ cwd, confirmPolicy: 'auto' });
    const call: ToolCall = {
      id: 'c5',
      name: 'fs.read',
      args: { path: '/etc/passwd' },
    };
    const result = await reg.invoke(call);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('preflight error');
  });

  it('register 自定义 builtins 列表（替换默认）', () => {
    const reg = new ToolRegistry({
      cwd,
      confirmPolicy: 'auto',
      builtins: [fsRead, fsWrite],
    });
    const names = reg.list().map((t) => t.name);
    expect(names).toContain('fs.read');
    expect(names).toContain('fs.write');
    expect(names).not.toContain('shell.exec');
  });
});
