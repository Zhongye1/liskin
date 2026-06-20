# 协议层 Zod 化 + Wire 编解码

> 状态：已落地  
> 版本：v1 · 2026-06-20  
> 关联：`packages/protocol/src/` · `docs/architecture/kernel-client-protocol.md`

---

```
架构效果

            ┌──────────────────────────┐
            │  @liskin/protocol        │
            │                          │
            │  Schema  (单一事实源)       │
            │  OpSchema / EventMsgSchema│
            │                          │
            │  Wire    (编解码 + 校验)    │
            │  encodeOp / decodeOp      │
            │  encodeEvent / decodeEvent │
            │  toSseFrame              │
            └──────┬──────────┬────────┘
                   │          │
        ┌──────────┴──┐  ┌───┴──────────┐
        │  Server     │  │  Web          │
        │  toSseFrame │  │  decodeEvent  │
        │  (出口校验)   │  │  (入口护栏)    │
        └─────────────┘  └──────────────┘
```

## 一、背景

Liskin 的三端架构（CLI / Web / IDE）通过 `@liskin/protocol` 包共享一份协议类型。上一版本中 `Op`、`EventMsg`、`SessionInfo` 等跨网络类型是手写 TypeScript interface/union，缺少运行时校验。如果 server 发出的 SSE 帧里某个字段类型错误，前端 `JSON.parse` 后直接进 reducer，不会在边界拦截，脏数据直击 UI。

本次改造将全部跨网络类型转为 zod schema 派生（单一事实源），并在 protocol 包内新增 `wire.ts`（编解码 + 校验）——所有进出网络的帧都经过 `parse()`，脏数据在边界即被拒绝。

---

## 二、文件结构

```
packages/protocol/src/
├── tool-types.ts      # ToolCall / ToolResult / ToolDefinition — zod Schema
├── session.ts         # SessionInfo / SessionHandle — zod Schema
├── op.ts              # Op — zod discriminatedUnion
├── event-msg.ts       # EventMsg — zod discriminatedUnion (下行，最关键)
├── kernel-client.ts   # KernelClient — 纯 interface (行为契约，不改)
├── wire.ts            # encodeOp / decodeOp / encodeEvent / decodeEvent / toSseFrame
└── index.ts           # 统一导出 (type + schema + wire 函数)

packages/protocol/test/
└── wire.test.ts       # Op × 9 + EventMsg × 11 + 直接校验 × 4 = 24 往返测试
```

---

## 三、设计原则

### 3.1 单一事实源

所有跨网络类型从 zod schema 派生，手写 interface 全部移除：

```
之前:  export type EventMsg = { type: 'Token'; ... } | { type: 'ToolCall'; ... } | ...
之后:  export const EventMsgSchema = z.discriminatedUnion('type', [...]);
       export type EventMsg = z.infer<typeof EventMsgSchema>;
```

效果：一份 schema，编译期给 TypeScript 做类型检查，运行时给 `wire.ts` 做数据校验。

### 3.2 边界校验

跨网络的每一帧都经过 `wire.ts`：

```
上行 (前端 → 内核):
  JSON string → decodeOp() → OpSchema.parse() → Op
                                                ↑ 坏请求在此拒绝

下行 (内核 → 前端):
  EventMsg → encodeEvent() → EventMsgSchema.parse() → JSON string
             ↑ 出口也校验，防止内部构造出非法事件

SSE 帧:
  EventMsg → toSseFrame(ev, id) → "id: 1\nevent: Token\ndata: {...}\n\n"
```

### 3.3 三端同构

`InProcessKernelClient`、`HttpSseKernelClient`、未来 `JsonRpcKernelClient` 三种实现共用同一套 `decode` 函数。差异只在 transport（函数调用 / HTTP+SSE / stdio），不在协议层。

---

## 四、各类型 Schema

### 4.1 tool-types.ts

```ts
export const ToolCallSchema = z.object({
  args: z.record(z.unknown()).default({}), // 从 z.unknown() 收紧为 record
  id: z.string(),
  name: z.string(),
});

export const ToolResultSchema = z.object({
  content: z.string(),
  ok: z.boolean(),
  toolCallId: z.string(),
});

export const ToolDefinitionSchema = z.object({
  // 新增 schema
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.unknown()),
});
```

**变更点**：`args` 从 `z.unknown()` 改为 `z.record(z.unknown()).default({})`。旧代码构造 `ToolCall` 时如果缺 `args` 字段会运行时炸，现在自动兜底 `{}`。

### 4.2 session.ts

```ts
export const SessionInfoSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
});

export const SessionHandleSchema = SessionInfoSchema.extend({
  isNew: z.boolean(),
});
```

### 4.3 op.ts

```ts
export const OpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CreateSession'), ... }),
  z.object({ type: z.literal('ResumeSession'), ... }),
  z.object({ type: z.literal('CloseSession'), ... }),
  z.object({ type: z.literal('ListSessions') }),
  z.object({ type: z.literal('UserTurn'), ... }),
  z.object({ type: z.literal('Interrupt'), ... }),
  z.object({ type: z.literal('ConfirmTool'), ... }),
  z.object({ type: z.literal('Cancel'), ... }),
]);
```

**为什么用 discriminatedUnion 而非普通 union**：`type` 字段作为判别键，zod 按 `type` 精确分派校验，报错信息精确到哪个变体不匹配，而非笼统的 "union 不匹配"。

### 4.4 event-msg.ts

```ts
export const EventMsgSchema = z.discriminatedUnion('type', [
  // 会话生命周期 (4)
  z.object({ type: z.literal('SessionCreated'), ... }),
  z.object({ type: z.literal('SessionResumed'), ... }),
  z.object({ type: z.literal('SessionClosed'), ... }),
  z.object({ type: z.literal('SessionList'), ... }),
  // 回合包络 (2)
  z.object({ type: z.literal('TurnStart'), ... }),
  z.object({ type: z.literal('TurnEnd'), ... }),
  // 回合内 (5)
  z.object({ type: z.literal('Token'), ... }),
  z.object({ type: z.literal('ToolCall'), ... }),
  z.object({ type: z.literal('ToolProgress'), ... }),
  z.object({ type: z.literal('ToolResult'), ... }),
  z.object({ type: z.literal('ToolConfirmRequired'), ... }),
  // 错误 (1)
  z.object({ type: z.literal('Error'), ... }),
]);
```

共 12 个变体，覆盖全部下行事件。辅助 schema 独立导出：`UsageSchema`、`NormalizedErrorSchema`、`TurnEndReasonSchema`。

---

## 五、wire.ts 编解码

```ts
export const PROTOCOL_VERSION = 1 as const;

// 上行
encodeOp(op: Op): string        // Op → JSON, 出口校验
decodeOp(raw: string): Op       // JSON → Op, 入口校验

// 下行
encodeEvent(ev: EventMsg): string    // EventMsg → JSON, 出口校验
decodeEvent(raw: string): EventMsg   // JSON → EventMsg, 入口校验

// SSE
toSseFrame(ev: EventMsg, id: number): string
// → "id: 1\nevent: Token\ndata: {"type":"Token",...}\n\n"
```

`id` 参数是单调序号，用于 SSE 断线重连的去重/补发（`Last-Event-ID` 头）。

---

## 六、三端使用方式

### Server 端（`kernel-routes.ts`）

```ts
import { toSseFrame } from '@liskin/protocol';

let id = 0;
for await (const ev of kernel.submit({ type: 'UserTurn', ... })) {
  id += 1;
  await s.write(toSseFrame(ev, id));
}
```

### Web 端（`api/stream.ts`）

```ts
import { decodeEvent } from '@liskin/protocol';
// 或直接使用 EventMsgSchema.parse() 做校验
```

### InProcess 端（`InProcessKernelClient`）

```ts
// 即便同进程也校验——测试即契约
EventMsgSchema.parse(ev);
```

---

## 七、往返测试

`packages/protocol/test/wire.test.ts` — 24 个 case：

```
Op 往返 (9)
  CreateSession / ResumeSession / CloseSession / ListSessions
  UserTurn / Interrupt / ConfirmTool / Cancel
  + reject 非法 op

EventMsg 往返 (11)
  Token / ToolCall / ToolProgress / ToolResult / ToolConfirmRequired
  TurnStart / TurnEnd / Error
  SessionCreated / SessionResumed / SessionClosed / SessionList
  + reject 非法 event

Schema 直接校验 (4)
  EventMsgSchema 拒绝畸形 Token
  OpSchema 拒绝缺字段 UserTurn
  ToolCall args 缺省为 {}
```

---

## 八、影响范围

| 层                 | 变更                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `@liskin/protocol` | 4 个类型文件转 zod + 新增 wire.ts + 24 个测试                                                  |
| `@liskin/core`     | 无变更（仍通过 `./types/messages.ts` 兼容 re-export）                                          |
| `@liskin/server`   | `kernel-routes.ts` 用 `toSseFrame()` 替换手写 `formatEventMsg()`；新增 `@liskin/protocol` 依赖 |
| `web/`             | `ToolCall.args` 类型从 `unknown` → `Record<string, unknown>`，现有代码兼容                     |
| `client/`          | 无变更（in-process 直连，Schema 校验尚未接入，待后续 InProcessKernelClient 加入 parse 调用）   |

## 九、待办

- [ ] `InProcessKernelClient.submit()` 内加 `EventMsgSchema.parse(ev)`，让同进程也过校验
- [ ] `web/src/api/stream.ts` 的 `parseSSEBlock` 改用 `decodeEvent`
- [ ] `ToolCall.args` 进一步从 `z.record(z.unknown())` 收窄为 per-tool 的具体 schema
- [ ] CI 加一条 `dependency-cruiser` 规则：`web/client/server` 不互相 import，只从 `@liskin/protocol` import
