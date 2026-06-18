export interface CommandPolicy {
  /** 命中任一模式则拦截 */
  blockedPatterns: RegExp[];
}

export interface CommandCheckResult {
  allowed: boolean;
  reason?: string;
}

export const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+\/(?!\S)/u, // rm -rf /
  /\brm\s+-rf?\s+~/u, // rm -rf ~
  /\b(?:curl|wget)\s+.*\|\s*sh\b/u, // curl ... | sh
  /\b(?:curl|wget)\s+.*\|\s*bash\b/u, // curl ... | bash
  /\b:>\s*\/dev\/sda/u, // 写入磁盘设备
  /\bmkfs\.\w+/u, // 格式化
  /\bdd\s+if=.*of=\/dev\//u, // dd 写设备
  />\s*~\/\.ssh\//u, // 写入 .ssh
  />\s*\.env\b/u, // 写入 .env
];

export function checkCommandAllowed(cmd: string, policy: CommandPolicy): CommandCheckResult {
  for (const pattern of policy.blockedPatterns) {
    if (pattern.test(cmd)) {
      return {
        allowed: false,
        reason: `dangerous command pattern matched: ${pattern.source}`,
      };
    }
  }
  return { allowed: true };
}
