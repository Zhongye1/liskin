# Kernel ↔ Client 协议与解耦设计

> 路径：`docs/architecture/kernel-client-protocol.md`
> 状态：Draft（面向 Phase 1/2 落地，与现状对齐）
> 版本：v0.1 · 2026-06-18
> 关联文档：
>
> - `docs/architecture/coding-agent-design.md`（路线图与整体架构）
> - `docs/architecture/kernel-protocol.md`（内核向内：Provider/Tool 协议）
> - `docs/architecture/kernel-sqeq-protocol.md`（内核向外：SQ/EQ 理想形态，本文是其落地版）

---

## 0. 文档定位

### 0.1 这份文档回答什么

1. **当前到哪了**：内核已实现什么、协议缺什么、CLI/Web 为什么必须重写。
2. **MVP 怎么分**：先 CLI 还是先 Web，为什么，顺序依据。
3. **内核怎么设计才能不感知调用平台**：三条不变量 + 依赖反转。
4. **内核 ↔ CLI/Web 怎么解耦**：一份协议、多种 transport、客户端零业务状态。

### 0.2 与现有三份文档的分工

| 文档                      | 关注                            | 状态          | 本文关系                              |
| ------------------------- | ------------------------------- | ------------- | ------------------------------------- |
| `coding-agent-design.md`  | 路线图、包边界、状态机骨架      | 可开工        | 引用其路线图，不重写                  |
| `kernel-protocol.md`      | 内核↔Provider、内核↔Tool 契约 | v0.1          | 本文是其外层协议的落地                |
| `kernel-sqeq-protocol.md` | 内核↔Client 的理想 SQ/EQ 形态  | Draft，未落地 | 本文是「现状 → 理想」的过渡           |
| **本文**                  | 现状盘点 + 落地顺序 + 解耦机制  | Draft         | 把前两者连起来，给 MVP 一条可执行路径 |

### 0.3 一句话总纲

> **协议是第一个要交付的 MVP 产物，CLI 是它的验收用例，Web 是它的第二个消费者。**
> 内核是服务不是函数；客户端不调用内核函数，投递 Op、订阅 EventMsg。

---

## 1. 现状盘点

### 1.1 内核（`packages/core`）已实现什么

| 模块     | 文件                | 状态        | 说明                                                                                                                                                                      |
| -------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 消息模型 | `types/messages.ts` | ✅ 可用     | `Msg` = system/user/assistant/tool；assistant 带 `toolCalls`；tool 带 `toolCallId`。**注意：当前 `content` 仍是纯 string，非 ContentBlock 数组**（v2 协议已设计但未落地） |
| 事件模型 | `types/events.ts`   | ✅ 粒度正确 | `AgentEvent` 7 个 variant：`token`/`tool_call`/`tool_progress`/`tool_result`/`tool_confirm_required`/`done`/`error`。粒度细，无需二次解析                                 |
| 主循环   | `agent/loop.ts`     | ✅ 可用     | `runAgent(): AsyncGenerator<AgentEvent>`。逐事件 yield，含取消检查、maxTurns、ConfirmRequired 暂停、tool_progress 流式透传                                                |
| 状态机   | `agent/state.ts`    | ⚠️ 仅类型   | `AgentState` 6 态定义了，但 runAgent 用局部变量推进，状态未对外暴露（无 `AgentStatus` 订阅）                                                                              |
| 端口     | `ports/*`           | ✅ 接口齐   | `LLMPort.chatStream`、`ToolPort.invoke(list)`、`StorePort(load/saveSession)`。依赖反转到位                                                                                |
| Harness  | `harness/*`         | ⚠️ noop     | `HarnessPort` 接口齐，`NoopHarness` 占位                                                                                                                                  |
| 预算     | `context/budget.ts` | ⚠️ 占位     | `applyBudget` 原样返回，tokenizer 未接                                                                                                                                    |

**结论：内核向内（Provider/Tool）的边界已经立住，主循环可跑。** 问题全部在「内核向外（Client）」这条边界——它目前**不存在**。

### 1.2 内核 ↔ Client 边界：目前不存在

当前没有任何 `Op` / `EventMsg` / `KernelClient` 抽象。客户端直连 `runAgent` 的方式有两种，都不对：

**CLI（`client/src/cli.ts`）**：只有 `agent serve`，起一个 HTTP daemon。**没有交互式消费器**——`agent chat` / `agent exec` 不存在。CLI 把自己降级成了「Web 的 daemon host」，而不是内核的第一个消费者。

**Web（`web/`）**：直连 `POST /v1/chat`（request/response），把 `runAgent` 的 generator 当成「一次请求一个流」。于是产生了大量 hack：

| 需求     | 理想形态（Op）    | 当前 hack                                           | 后果                               |
| -------- | ----------------- | --------------------------------------------------- | ---------------------------------- |
| 中断     | `Interrupt` Op    | `abortRef.abort()` 砍 HTTP 连接                     | 正在跑的 shell 被腰斩，非优雅取消  |
| 确认     | `ConfirmTool` Op  | 发 `<continue:${id}>` 假 user 消息                  | 假消息污染 `session.messages` 落库 |
| 会话真相 | kernel/Store 持有 | web 用 localStorage 存 sessionId，messages 刷新归空 | 无历史恢复、无多会话               |
| 多端订阅 | EQ 多订阅者       | 单次 SSE 连接，断开即丢                             | 无法 IDE+Web 同时看一个 session    |

**根因：协议缺位。** `kernel-sqeq-protocol.md` 设计了 SQ/EQ，但仍是 Draft、未落地。在不稳协议上做 Web = 跑跑步机，这是 web 必须重写的根本原因。

### 1.3 类型 drift

`web/src/services/agentClient.ts` 手抄了一份 `AgentEvent`，与 `packages/core/src/types/events.ts` 已经不一致：

- core 的 `done` 在 `AgentEvent` 里无 `usage`（`LLMEvent` 才有），web 抄的版本混淆了
- web 的 `tool_result` 自定义了 `ok` 字段位置
- `reason` 枚举两边对不齐

类型不共享 → 改一处漏一处 → 协议永远稳不了。

---

## 2. 分层与依赖方向

### 2.1 五层映射（沿用 `coding-agent-design.md`）

```
依赖方向（单向，越往下越稳定；内核不知道外面是谁在用它）
─────────────────────────────────────────────────────────
  L4 接入层     client/ (CLI)  ·  web/  ·  (未来 IDE 插件)
                     ↓ 只依赖 KernelClient 接口 + 协议类型
  传输适配      packages/server (daemon: HTTP/SSE)        ← Web 必经
                     ↓
  ┄┄┄┄┄┄ 协议边界（Op / EventMsg / KernelClient）┄┄┄┄┄┄
                     ↑
  L3 模型适配   packages/llm   (LLMProvider → LLMPort)
                     ↑（被 core 引用）
  L2 工具/执行  packages/tools (ToolRegistry → ToolPort)
                     ↑（被 core 引用）
  L1 内核       packages/core  (runAgent + ports + state)
                     ↑ 不依赖任何外层
```

### 2.2 架构红线（依赖方向必须单向收敛）

| 层                  | 不能依赖                    | 不能感知                         |
| ------------------- | --------------------------- | -------------------------------- |
| `core` (L1)         | tools/llm/server/client/web | 用哪家模型、是 CLI 还是 Web 调它 |
| `tools` (L2)        | llm/server/client/web       | 结果渲染到终端还是网页           |
| `llm` (L3)          | core/tools/server/client    | 谁在用它                         |
| `server` (L4)       | client/web                  | 具体 UI 形态                     |
| `client`/`web` (L4) | core 内部实现               | 只依赖 `KernelClient` + 协议类型 |

**关键：`core` 对外只暴露 `KernelClient` 接口 + `Op`/`EventMsg` 类型，不暴露 `runAgent` 给跨层调用方。** `runAgent` 是 `KernelClient` 的 in-process 实现的内部细节。

---

## 3. 内核设计：如何不感知调用平台

### 3.1 三条不变量（内核纯洁性的判据）

任何 PR 引入违反以下任一条的代码，review 阶段拒绝：

1. **Loop 不知道用哪家模型**
   - `loop.ts` 里不存在 `if (provider === 'openai')`、不 `import` 任何 provider SDK
2. **Loop 不知道工具来自哪里**
   - 不存在 `if (tool.source === 'mcp')`、不存在 `if (call instanceof SkillTool)`
3. **内核不知道调用方是 CLI / Web / IDE / exec**
   - 不 `import` 自 `client/`/`web/`/`server/`；不读 `process.stdout`；不假设 `confirm` 由人回答（exec 消费者可能自动 deny）

第 3 条是本文新增、当前文档未显式写明的红线，但它是「不感知平台」的核心。

### 3.2 依赖反转：内核定义 Port，外层实现

内核通过三个 Port 接口与外界交互，**接口定义在 core，实现在外层**：

```ts
// packages/core/src/ports/llm-port.ts   ← 内核定义，packages/llm 实现
interface LLMPort {
  chatStream(req: ChatRequest): AsyncIterable<LLMEvent>;
}

// packages/core/src/ports/tool-port.ts  ← 内核定义，packages/tools 实现
interface ToolPort {
  list(): ToolDefinition[];
  invoke(call, opts?): Promise<ToolResult>;
}

// packages/core/src/ports/store-port.ts ← 内核定义，packages/server 实现(SqliteStore)
interface StorePort {
  loadSession(id): Promise<SessionRecord | null>;
  saveSession(r): Promise<void>;
}
```

内核不知道 OpenAI、不知道 shell.exec、不知道 SQLite。这三条是**向内**的边界（见 `kernel-protocol.md`）。

### 3.3 向外边界：KernelClient（本文新增）

内核对外暴露的不是 `runAgent`，而是一个**服务接口** `KernelClient`。无论 in-process 还是跨进程，客户端看到的都是它：

```ts
// packages/core/src/kernel/client-port.ts  ← 内核定义接口
interface KernelClient {
  // 会话生命周期
  createSession(opts?: { cwd?: string; providerId?: string }): Promise<SessionHandle>;
  resumeSession(id: string): Promise<SessionHandle>;
  closeSession(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;

  // 投递 Op，返回本轮事件流（EQ 的拉模型等价物）
  submit(op: Op): AsyncIterable<EventMsg>;

  // 控制流（非轮询：直接作用于 session）
  interrupt(sessionId: string): Promise<void>;
}
```

**为什么 `submit` 返回 `AsyncIterable` 而非「投递后另开订阅」？**

- MVP 用拉模型：一次 `submit(UserTurn)` 对应一个 `AsyncIterable<EventMsg>`，消费完即止。语义清晰、实现简单，足以覆盖 CLI/Web。
- 真 SQ/EQ（多订阅、长连、`GET /events` 独立流）是 Phase 2+ 的事，届时 `KernelClient` 增补 `subscribe(sessionId): AsyncIterable<EventMsg>`，`submit` 退化为只投递不返回。**接口形状向后兼容**，这是刻意留的演进缝。

### 3.4 实现三态（同一接口，不同 transport）

| 实现                    | 位置                                               | 适用             | 是否跨进程           |
| ----------------------- | -------------------------------------------------- | ---------------- | -------------------- |
| `InProcessKernelClient` | `packages/core/src/kernel/in-process.ts`           | CLI MVP、测试    | 否（直连 runAgent）  |
| `HttpSseKernelClient`   | `packages/server` 暴露 + 客户端侧在 `web`/`client` | Web、远程 CLI    | 是（HTTP+SSE）       |
| `JsonRpcKernelClient`   | 未来 IDE 插件                                      | VSCode/JetBrains | 是（stdio JSON-RPC） |

`InProcessKernelClient` 是 MVP 的核心交付物：它持有 `LLMPort`/`ToolPort`/`StorePort`，内部调 `runAgent`，把 `AgentEvent` 包装成带 `turnId` 的 `EventMsg`。**CLI 直接用它，不碰端口、不碰 daemon。**

### 3.5 内核不感知平台的代码判据

- `packages/core` 的 `package.json` dependencies 里**不得出现** `hono`/`express`/`commander`/`react`/`openai`/`@modelcontextprotocol`
- `loop.ts` 不得 `console.log`/`process.stdout.write`（调试日志走注入的 logger port，MVP 可 noop）
- `ConfirmRequiredError` 抛出后，内核**只 yield `tool_confirm_required` 事件并暂停**，不阻塞等待 stdin、不开 HTTP 长连——由客户端决定怎么回填 `ConfirmTool` Op

---

## 4. 协议：Op 与 EventMsg

### 4.1 设计原则

- **可序列化**：所有 Op/EventMsg 是 plain JSON，跨进程无损失。
- **turnId 聚合**：内核给每个 `UserTurn` 分配 `turnId`，该 turn 产生的所有事件都带 `turnId`。客户端据此把流式事件聚合成「一轮」。
- **内层事件不外泄**：`LLMEvent`（provider-specific）绝不直接给客户端；内核翻译成 `EventMsg`。
- **Op 是意图，EventMsg 是事实**：客户端投递 Op 表达「我想做X」，内核回 EventMsg 报告「发生了Y」。

### 4.2 Op（客户端 → 内核）

```ts
export type Op =
  // —— 会话生命周期 ——
  | { type: 'CreateSession'; cwd?: string; providerId?: string }
  | { type: 'ResumeSession'; sessionId: string }
  | { type: 'CloseSession'; sessionId: string }
  // —— 回合 ——
  | { type: 'UserTurn'; sessionId: string; content: string; attachments?: ContentBlock[] }
  | { type: 'Interrupt'; sessionId: string } // 打断当前回合，不关 session
  | { type: 'ConfirmTool'; sessionId: string; callId: string; decision: 'approve' | 'deny' }
  | { type: 'Cancel'; sessionId: string }; // 终止整个 session（比 Interrupt 重）
```

**与现有 loop 的衔接**：

- `UserTurn` → 内核 load session、追加 user msg、调 `runAgent`、流式 yield 事件
- `Interrupt` → 触发该 session 的 `AbortController.abort()`；loop 已有 `cancelled` 处理（loop.ts:49），优雅在 turn 边界停止
- `ConfirmTool(approve)` → 带该 `callId` 进 `confirmedCallIds`，重新 `runAgent` 续跑暂停的 turn（**不追加 user 消息**，消除现有 `<continue:id>` hack）
- `ConfirmTool(deny)` → 内核把 deny 结果回灌为 tool_result(ok=false)，turn 继续

### 4.3 EventMsg（内核 → 客户端）

`EventMsg = AgentEvent` 的超集，补 `turnId` 和 session 生命周期事件：

```ts
export type EventMsg =
  // —— 会话生命周期 ——
  | { type: 'SessionCreated'; sessionId: string; createdAt: string }
  | { type: 'SessionClosed'; sessionId: string; reason: 'user' | 'error' | 'timeout' }
  // —— 回合事件（全部带 turnId）——
  | { type: 'TurnStart'; turnId: string; sessionId: string }
  | { type: 'Token'; turnId: string; text: string }
  | { type: 'ToolCall'; turnId: string; call: ToolCall }
  | {
      type: 'ToolProgress';
      turnId: string;
      callId: string;
      stream: 'stdout' | 'stderr';
      chunk: string;
    }
  | { type: 'ToolResult'; turnId: string; result: ToolResult }
  | { type: 'ToolConfirmRequired'; turnId: string; call: ToolCall }
  | {
      type: 'TurnEnd';
      turnId: string;
      reason: 'completed' | 'interrupted' | 'max_turns' | 'error';
      usage?: Usage;
    }
  | { type: 'Error'; turnId?: string; error: NormalizedError };
```

**与现有 `AgentEvent` 的映射**（在 `InProcessKernelClient` 内做）：

| `AgentEvent`                          | `EventMsg`            | 备注                  |
| ------------------------------------- | --------------------- | --------------------- |
| `token`                               | `Token`               | 加 turnId             |
| `tool_call`                           | `ToolCall`            | 加 turnId             |
| `tool_progress`                       | `ToolProgress`        | 加 turnId             |
| `tool_result`                         | `ToolResult`          | 加 turnId             |
| `tool_confirm_required`               | `ToolConfirmRequired` | 加 turnId             |
| `done(completed/max_turns/cancelled)` | `TurnEnd`             | cancelled→interrupted |
| `error`                               | `Error`               | 加 turnId             |

### 4.4 类型归属：先在 core，后拆 protocol 包

MVP：`Op`/`EventMsg`/`KernelClient` 定义在 `packages/core/src/kernel/`，从 `@liskin/core` 导出。CLI/Web/Server 都 import 同一份，**消除 drift**。

Phase 2：拆 `@liskin/protocol` 独立包（对应 Codex 的 `codex-protocol` crate），让 server/client/web 不必依赖整个 core。拆分是纯重构，不改类型。

---

## 5. 解耦机制：一份协议，多种 transport

### 5.1 客户端只依赖接口，不依赖实现

```ts
// client/src 或 web/src 里
import type { KernelClient, Op, EventMsg } from '@liskin/core';

async function run(client: KernelClient) {
  const session = await client.createSession({ cwd: process.cwd() });
  for await (const ev of client.submit({
    type: 'UserTurn',
    sessionId: session.id,
    content: '修 bug',
  })) {
    render(ev); // CLI: 渲染成终端文本；Web: 渲染成时间线
  }
}
```

`run()` 对 transport 零感知。换 transport = 换 `client` 实例。

### 5.2 三种 transport 的装配

**CLI MVP（in-process，无 daemon）**：

```ts
// client/src/cli.ts → agent chat
const client = new InProcessKernelClient({ llm, tools, store });
// 直接在当前进程跑，无端口、无 SSE、无序列化损耗
```

**Web（必须跨进程）**：

```ts
// web/src/kernel/http-sse.ts
const client = new HttpSseKernelClient({ baseUrl: '/api' });
// 走 server daemon；submit(UserTurn) → POST /v1/sessions/:id/turns (SSE)
```

**远程 CLI / IDE 插件（未来）**：

```ts
const client = new JsonRpcKernelClient({ transport: stdio });
```

### 5.3 Server 的职责边界（仅 Web 必经）

`packages/server` 是 **transport 适配器**，不是业务层。它只做三件事：

1. 把 HTTP 请求翻译成 `Op`，交给一个内部的 `InProcessKernelClient`
2. 把 `EventMsg` 序列化成 SSE
3. 持有 `SqliteStore`（实现 `StorePort`）做持久化

**server 不得包含任何 agent 逻辑**——没有 if 分支、没有状态机、没有工具确认策略。所有逻辑在 core。server 换成 JSON-RPC gateway 时，Op/EventMsg 一字不改。

> 现有 `packages/server/src/app.ts` 的 `POST /v1/chat` 把 session 装载、消息追加、落库、SSE 包装全做在路由里——这是「server 当业务层」的反例，重写时应把这部分下沉到 `InProcessKernelClient.submit()`，路由只剩 transport 翻译。

### 5.4 客户端零业务状态原则

- **会话真相在 kernel/Store**，客户端只持渲染态（哪些 turn、哪些 step、滚动位置）。
- 刷新 = 重新 `resumeSession` + 重放历史 `EventMsg`（内核需支持事件回放，见 §7）。
- 客户端**不**自行 append user message 到本地数组再和 server 对账——当前 web 这么做导致状态双轨。

### 5.5 解耦校验矩阵

| 变更                         | core 改  | server 改    | client 改      | web 改          |
| ---------------------------- | -------- | ------------ | -------------- | --------------- |
| 加一个 LLM provider          | llm 包   | ✗            | ✗              | ✗               |
| 加一个工具                   | tools 包 | ✗            | ✗              | ✗(渲染映射可选) |
| 加一个 Op（如 `AttachFile`） | core     | server(翻译) | client(发送)   | web(发送)       |
| 换 HTTP→WebSocket            | ✗        | server       | client(换实现) | web(换实现)     |
| 改终端渲染样式               | ✗        | ✗            | client         | ✗               |
| 改 web 渲染样式              | ✗        | ✗            | ✗              | web             |

「换 transport 只动 server + client 侧 client 实现，core 不动」是解耦成立的硬指标。

---

## 6. MVP 顺序：先 CLI，后 Web

### 6.1 结论

**先 CLI（in-process），后 Web（daemon）。** 与 `coding-agent-design.md` §7.2「Web 优先」表面相反，但前提不同：§7.2 假设协议已稳定，现实是协议未落地。在未稳协议上做 Web = 已重写一次。

### 6.2 CLI 先的三个硬理由

1. **CLI 能 in-process，Web 不能。** CLI 把 kernel 拿在进程里走 `InProcessKernelClient`，不碰端口/CORS/序列化/daemon 生命周期。Web 天然跨进程，必须先有 daemon + SSE。MVP 铁律是减层不是加层——CLI 严格少一层。
2. **CLI 是协议完整性的强制校验器。** 终端里每个事件都得能渲染成文本；一旦往协议塞「只有 Web 能表达的 affordance」，CLI 立刻暴露。Web 能用 UI 把协议窟窿藏起来（modal 假装确认协议是好的），掩盖问题。
3. **最难交互在终端最显形。** 工具确认、中断、流式中途打断——终端里最难做，逼你把 Op 模型设计对。终端做对了，Web 只是换渲染器。Codex / Claude Code / Aider 全 CLI-first 非偶然。

### 6.3 落地三步（每步可独立验证、可停）

**Step 1 — 钉协议（core）**

- 在 `packages/core/src/kernel/` 落 `Op`/`EventMsg`/`KernelClient` 类型 + `InProcessKernelClient` 实现
- `InProcessKernelClient.submit(UserTurn)` 内部调 `runAgent`，包装 `AgentEvent → EventMsg`（加 turnId）
- `interrupt`/`confirmTool` 走 `AbortController` + `confirmedCallIds`，**消除假消息 hack**
- 此步不动 CLI/Web UI，但协议立住

**Step 2 — CLI 交互消费器（client）**

- 给 `client/src/cli.ts` 加 `agent chat`（REPL）+ `agent exec`（headless 一次性）
- 用 `InProcessKernelClient`，渲染 `EventMsg` 流：token 流式打印、tool_call/progress/result 按时间线、confirm 内联问询、interrupt 走 Ctrl-C
- `agent serve` 保留但 MVP 不依赖
- **此步证明协议可用**：如果 `agent exec` 在 CI 里能跑通「读→改→跑」且 confirm 策略可配，协议就立住了

**Step 3 — daemon + Web**

- server 升级：`POST /v1/chat` → `POST /v1/sessions/:id/turns`（SSE）+ `POST /v1/sessions/:id/interrupt` + `POST /v1/sessions/:id/confirm`；路由只做 transport 翻译，逻辑下沉 `InProcessKernelClient`
- web 重写：`HttpSseKernelClient` + 时间线渲染（见下文「Web 渲染重写」）
- **此步是第二个消费者**：同一协议，换 transport，换渲染器

### 6.4 为什么 Step 1/2 能停住也安全

即使永远不做 Web，Step 1+2 交付的是一个**可用的本地 CLI coding agent**——这本身是产品的第一个真实形态。Web 是增量，不是前置依赖。这符合 `coding-agent-design.md` §2.2「价值锚点早：用户第一天就能用客户端单端跑通」。

---

## 7. Web 渲染重写（Step 3 细节，承接前轮诊断）

### 7.1 前提

服务端管线已齐：`packages/server/src/app.ts` 对每个 `AgentEvent` 都 `formatSSE` 透传（含 `tool_progress` 的 stdout/stderr chunk）。**终端要的能力，后端已具备，问题 100% 在前端渲染割裂。**

### 7.2 当前 web 的渲染问题

- assistant 文本流（顶部蓝框）和工具调用（底部侧栏 `toolLog`）分属两个区域，中间隔着消息列表——终端里是一条交织时间线，web 劈成两半
- `tool_progress` 累积成静态 `<pre>`，无终端式实时滚动
- 工具确认是全屏 modal，盖住时间线
- 流式文本纯 `<span>` 累加，无 markdown/代码高亮
- tool args 永远 `JSON.stringify`，无语义

### 7.3 重写方案：统一时间线

**数据模型：Turn → Steps**（reducer 在 `web/src/kernel/events.ts`，纯函数可单测）

```ts
type Step =
  | { kind: 'text'; id: string; parts: string[] }
  | {
      kind: 'tool';
      id: string;
      call: ToolCall;
      status: 'pending' | 'confirm' | 'running' | 'done' | 'error';
      stdout: string[];
      stderr: string[];
      result?: ToolResult;
    };

type Turn = { id: string; userContent: string; steps: Step[]; status: TurnStatus };
```

事件归一化：`Token`→追加最后一个 text step；`ToolCall`→push tool step；`ToolProgress`→追加对应 tool 的 stdout/stderr；`ToolResult`→写 result 改 status；`ToolConfirmRequired`→tool status=confirm + turn 进 awaiting_confirm。

**组件**：

```
<Timeline>                 // 虚拟化滚动
  <TurnItem>
    <UserMessage />
    <StepList>             // token 和 tool_call 天然交织
      <TextStep />         // react-markdown + shiki,流式增量
      <ToolStep>
        <ToolHeader />     // 图标+工具名+状态徽标(spinner/✓/✗/🔒)
        <ToolArgs />       // 语义化:shell 显示命令,fs 显示路径
        <TerminalOutput /> // 实时 stdout/stderr,终端样式,自动吸底
        <ToolResult />     // patch 类走 diff 视图
      </ToolStep>
      <ConfirmStep />      // 内联审批,非 modal
```

**实时流式策略**：chunk 级 `push` 不重建数组；`requestAnimationFrame` 批量 flush 合并渲染保 60fps；`@tanstack/react-virtual` 虚拟化；stdout/stderr 同区按到达顺序混排（stderr 红字），像真终端。

**类型对齐**：web 并入 pnpm workspace，`import type { EventMsg, ToolCall } from '@liskin/core'`，删 `agentClient.ts` 手抄类型，堵 drift。

---

## 8. 与现有代码的衔接清单

| 现有                                         | 处置                | 说明                                             |
| -------------------------------------------- | ------------------- | ------------------------------------------------ |
| `packages/core/src/agent/loop.ts`            | **保留**            | `runAgent` 是 `InProcessKernelClient` 的内部实现 |
| `packages/core/src/types/events.ts`          | **保留 AgentEvent** | 作为内层事件；外层用新 `EventMsg`                |
| `packages/core/src/agent/state.ts`           | **激活**            | `AgentState` 对外暴露，供客户端同步阶段          |
| `packages/core/src/ports/*`                  | **保留**            | 依赖反转已到位                                   |
| `packages/server/src/app.ts` `POST /v1/chat` | **Step 3 重构**     | 逻辑下沉 `InProcessKernelClient`，路由只翻译     |
| `client/src/cli.ts` `agent serve`            | **保留**            | Step 3 Web 需要                                  |
| `client/src/cli.ts` `agent chat/exec`        | **Step 2 新增**     | in-process 消费器                                |
| `web/src/hooks/useLLMChat.ts`                | **Step 3 删除**     | 散装 state → timeline store                      |
| `web/src/services/agentClient.ts` 手抄类型   | **Step 3 删除**     | 从 core import                                   |
| `web/src/pages/Chat.tsx` 三块割裂            | **Step 3 重写**     | 统一时间线                                       |
| `web/src/store/useChatStore.ts` 死代码       | **Step 3 删除**     | —                                                |

---

## 9. 未决事项

1. **事件回放**：`resumeSession` 后如何把历史 turn 的 EventMsg 重放给新订阅者？MVP 可只回放最终 `Msg[]`（文本+toolCalls+toolResult），不回放中间 token/progress——够用。真回放需 Store 记录事件流，Phase 2+。
2. **多订阅**：MVP `submit` 拉模型单订阅。IDE+Web 同时看一个 session 需 EQ 多订阅，Phase 2。
3. **ContentBlock v2**：当前 `Msg.content` 是 string，`kernel-protocol.md` 设计了 ContentBlock union（text/tool_use/thinking/image）但未落地。MVP 暂用 string，图片/富内容留 Phase 2。
4. **`@liskin/protocol` 拆包时机**：core 不再想被 web 间接拉入 server 实现时拆。MVP 不拆。

---

## 10. 一句话收尾

> 内核通过 Port 反转依赖（向内）、通过 KernelClient 接口隔离调用方（向外）。
> 协议（Op/EventMsg）是唯一跨层契约，定义在 core、共享给所有消费者。
> CLI 用 in-process 实现验证协议，Web 用 HTTP/SSE 实现复用协议——内核永远不知道是谁在调它。
