import path from 'node:path';

export interface PathPolicy {
  whitelist: string[]; // 绝对路径数组（或可解析为绝对路径）
}

export interface PathCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 检查 target 是否在白名单中。target 可以是相对路径（相对 cwd）或绝对路径。
 * 防止 path traversal：先 resolve 再判断前缀。
 */
export function checkPathAllowed(target: string, cwd: string, policy: PathPolicy): PathCheckResult {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  for (const allowed of policy.whitelist) {
    const allowedAbs = path.resolve(allowed);
    if (abs === allowedAbs || abs.startsWith(allowedAbs + path.sep)) {
      return { allowed: true };
    }
  }
  return { allowed: false, reason: `path outside whitelist: ${abs}` };
}
