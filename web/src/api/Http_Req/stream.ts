/**
 * 流式类请求封装：fetch + ReadableStream 消费 SSE。
 *
 * 浏览器端不能用 axios 做流式——XMLHttpRequest 不支持 ReadableStream。
 * 这里用原生 fetch，逐 chunk 解析 SSE 块（\n\n 分隔）。
 */
import type { UserTurnBody } from '../types/types';

const BASE = '/api/v1';

/** 解析一段 SSE 块（以 \n\n 分隔）为 JSON 对象，无法解析返回 null。 */
export function parseSSEBlock(block: string): unknown | null {
  let dataLine: string | null = null;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line && !line.startsWith(':') && line.startsWith('data:')) {
      dataLine = line.slice(5).trim();
    }
  }
  if (!dataLine) {
    return null;
  }
  try {
    return JSON.parse(dataLine);
  } catch {
    return null;
  }
}

/**
 * 发起 SSE POST 请求，返回一个 AsyncGenerator。
 * 调用方用 for-await 逐条消费解析后的 JSON 对象。
 *
 * @param path  端点路径，如 `/sessions/:id/turns`
 * @param body  请求体
 */
export async function* streamRequest<T = unknown>(
  path: string,
  body: UserTurnBody,
): AsyncGenerator<T, void, void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`stream ${res.status}: ${text || res.statusText}`);
  }
  if (!res.body) {
    throw new Error('empty stream body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseSSEBlock(block);
        if (ev) {
          yield ev as T;
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      // reader 已关闭，取消失败可忽略
    });
  }
}
