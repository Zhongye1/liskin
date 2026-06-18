/**
 * 把一个事件对象序列化成 SSE 文本（一条 event = 一行 data:）。
 * event 名用 ev.type（EventMsg）或 ev.kind（AgentEvent），兼容两套协议。
 */
export function formatSSE(ev: Record<string, unknown>): string {
  const name = (ev.type ?? ev.kind ?? 'message') as string;
  return `event: ${name}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export function formatSSEComment(text: string): string {
  return `: ${text}\n\n`;
}
