import { twMerge } from 'tailwind-merge';

type ClassValue = string | false | null | undefined;

/**
 * 轻量 className 合并：过滤 falsy + twMerge 去重冲突。
 * 不依赖 clsx（Step 3.3 清理冗余依赖）。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(inputs.filter((v): v is string => typeof v === 'string'));
}
