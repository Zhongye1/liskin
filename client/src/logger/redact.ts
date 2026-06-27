import { createHash } from 'node:crypto';

// —— 脱敏中间层 —— //

const SENSITIVE_KEY_PATTERNS = [
  /_KEY$/iu,
  /_TOKEN$/iu,
  /_SECRET$/iu,
  /_PASSWORD$/iu,
  /^api[-_]?key$/iu,
  /^secret$/iu,
  /^password$/iu,
  /^passwd$/iu,
];

const SENSITIVE_QUERY_PARAMS = ['key', 'token', 'secret', 'password', 'api_key', 'api-key'];

const SENSITIVE_CLI_FLAGS = ['--api-key', '--token', '--secret', '--password', '-k'];

const REDACTED = '***';

/**
 * 递归扫描并掩码敏感数据。
 * 所有 sink 写入前必须经过此函数，无法绕过。
 */
export function redact(data: unknown, verbose = false): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return redactString(data);
  }

  if (Array.isArray(data)) {
    return data.map((item) => redact(item, verbose));
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      // 检查 key 是否匹配敏感模式
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
      } else if (key === 'content' && typeof value === 'string' && !verbose) {
        // 文件内容特殊处理：默认只保留摘要
        const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
        result[key] = `[REDACTED: ${hash}]`;
        result.size = value.length;
        result.line_count = value.split('\n').length;
      } else if (key === 'cmd' && typeof value === 'string') {
        // 命令行参数特殊处理
        result[key] = redactCommandLine(value);
      } else {
        result[key] = redact(value, verbose);
      }
    }
    return result;
  }

  return data;
}

function redactString(value: string): string {
  // 检查 URL query 参数
  if (value.includes('?')) {
    try {
      const url = new URL(value);
      for (const param of SENSITIVE_QUERY_PARAMS) {
        if (url.searchParams.has(param)) {
          url.searchParams.set(param, REDACTED);
        }
      }
      return url.toString();
    } catch {
      // 不是有效 URL，继续检查其他模式
    }
  }

  // 检查是否是命令行
  if (value.includes('--') || value.includes('-')) {
    return redactCommandLine(value);
  }

  return value;
}

function redactCommandLine(cmd: string): string {
  let result = cmd;
  for (const flag of SENSITIVE_CLI_FLAGS) {
    // 匹配 --flag value 或 --flag=value
    const regex = new RegExp(`(${escapeRegex(flag)}(?:\\s+|=))[^\\s]+`, 'giu');
    result = result.replace(regex, `$1${REDACTED}`);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function escapeRegex(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
