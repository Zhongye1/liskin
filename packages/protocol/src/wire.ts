/**
 * 编解码 + SSE 帧格式。
 *
 * 三端（CLI / Web / IDE）共用同一套 encode/decode，把 transport 差异挡在外面。
 * 跨网络的每一帧都经过 schema 校验——脏数据在此拦截，不会侵入内核或 UI。
 */
import { EventMsgSchema, type EventMsg } from './event-msg.js';
import { OpSchema, type Op } from './op.js';

export const PROTOCOL_VERSION = 1 as const;

// —— 上行：Op —— //

/** 编码 Op 为 JSON 字符串。出口也校验，防止内部构造出非法 Op。 */
export function encodeOp(op: Op): string {
  return JSON.stringify(OpSchema.parse(op));
}

/** 解码 JSON 字符串为 Op。内核入口护栏——非法请求在此拒绝。 */
export function decodeOp(raw: string): Op {
  return OpSchema.parse(JSON.parse(raw));
}

// —— 下行：EventMsg —— //

/** 编码 EventMsg 为 JSON 字符串。 */
export function encodeEvent(ev: EventMsg): string {
  return JSON.stringify(EventMsgSchema.parse(ev));
}

/** 解码 JSON 字符串为 EventMsg。客户端入口护栏——脏数据在此拦截。 */
export function decodeEvent(raw: string): EventMsg {
  return EventMsgSchema.parse(JSON.parse(raw));
}

// —— SSE 帧 —— //

/**
 * 把 EventMsg 序列化为 SSE text/event-stream 行。
 * @param ev 事件
 * @param id  单调序号，用于断线重连去重/补发
 */
export function toSseFrame(ev: EventMsg, id: number): string {
  return `id: ${id}\nevent: ${ev.type}\ndata: ${encodeEvent(ev)}\n\n`;
}
