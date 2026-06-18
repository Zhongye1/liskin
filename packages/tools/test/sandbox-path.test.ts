import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkPathAllowed } from '../src/sandbox/path-policy.js';

describe('sandbox/path-policy', () => {
  const cwd = '/tmp/some/project';

  it('白名单内（绝对路径相同）→ allowed', () => {
    const result = checkPathAllowed(cwd, cwd, { whitelist: [cwd] });
    expect(result.allowed).toBe(true);
  });

  it('白名单子目录 → allowed', () => {
    const target = path.join(cwd, 'src/foo.ts');
    const result = checkPathAllowed(target, cwd, { whitelist: [cwd] });
    expect(result.allowed).toBe(true);
  });

  it('白名单父目录 → 拒绝', () => {
    const result = checkPathAllowed('/tmp/some', cwd, { whitelist: [cwd] });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('outside whitelist');
  });

  it('路径穿越 ../../etc/passwd → 拒绝', () => {
    const result = checkPathAllowed('../../etc/passwd', cwd, { whitelist: [cwd] });
    expect(result.allowed).toBe(false);
  });

  it('相对路径相对 cwd 解析', () => {
    const result = checkPathAllowed('./src/a.ts', cwd, { whitelist: [cwd] });
    expect(result.allowed).toBe(true);
  });

  it('相似前缀（非 sep 边界）不会被误判', () => {
    // /tmp/some/project-evil 不应被白名单 /tmp/some/project 接纳
    const result = checkPathAllowed('/tmp/some/project-evil/x', cwd, {
      whitelist: [cwd],
    });
    expect(result.allowed).toBe(false);
  });
});
