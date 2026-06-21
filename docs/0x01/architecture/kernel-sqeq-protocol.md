# Kernel SQ/EQ Protocol Design — Liskin Coding Agent

> 路径：`docs/architecture/kernel-sqeq-protocol.md`
> 状态：Draft（设计前置；面向 Phase 2/3 落地）
> 版本：v0.1
> 关联文档：
>
> - `docs/architecture/coding-agent-design.md`（路线图与整体架构）
> - `docs/architecture/kernel-protocol.md`（包内 Provider/Tool 协议）

---

## 0. 文档定位

### 0.1 目的

本文档钉死 **Kernel ↔ Client** 这一条协议边界 —— 内核（Kernel）作为「服务」对所有客户端（CLI / TUI / Web / IDE 插件 / exec headless）暴露的统一接口契约。

核心论点（用户表述，直接保留）：

> **Codex 最关键的一个决定是 —— 内核和 UI 之间不是函数调用，而是一对消息队列。**
> Submission Queue (SQ) 提交操作 → Event Queue (EQ) 吐回事件流。

围绕这条主线，本文要回答四个问题：

1. **为什么是异步队列而非同步调用？** → 一次性解决「流式 + 可中断 + 多端订阅」三个看起来独立但本质同源的需求。
2. **协议类型为什么独立成包？** → TS 全栈共享同一份类型，省掉跨语言 schema 代码生成那一步。
3. **headless 与交互式为什么同根？** → exec / CI 不是另一条管线，是「不渲染 UI 的事件消费者」。
4. **事件粒度为什么要细？** → `ExecCommandBegin/End` / `PatchApplied` / `TokensUsed` 各自独立事件，埋点 / 调试 / 审计 / 计费都不必二次解析 text 流。

### 0.2 读者

- **Kernel 实现者**：理解 SQ/EQ 调度循环、session 生命周期、错误归一化对外的呈现方式
- **客户端实现者**（CLI / TUI / Web / IDE 插件 / exec headless）：拿到一份与传输无关的协议契约，只关心「我提交什么 Op、订阅什么 EventMsg」
- **Transport 适配器作者**（in-process / stdio JSON-RPC / HTTP+SSE）：对照 `KernelTransport` 接口实现新管道

### 0.3 与三份文档的分工

| 文档                                  | 关注边界                             | 接口形态                                              | 范围                                     | 读者                                 |
| ------------------------------------- | ------------------------------------ | ----------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| `coding-agent-design.md`              | 整体架构与路线图                     | —                                                     | 全局                                     | 所有人                               |
| `kernel-protocol.md`                  | 内核 ↔ 模型适配器；内核 ↔ 工具来源 | `LLMProvider.stream(req)` / `Tool.execute(input,ctx)` | 包内（packages/llm、packages/tools）     | Provider / Tool 实现者               |
| **`kernel-sqeq-protocol.md`**（本文） | **内核 ↔ UI / 客户端**              | **`submit(op)` + `subscribe(events)`**                | **跨进程**（HTTP/SSE / JSON-RPC / 内存） | 客户端实现者（CLI/TUI/Web/IDE/exec） |

三条边界各管一头，互不干扰：

- `kernel-protocol.md` 描述的是 Kernel **向内**的两条边界（怎么调模型、怎么调工具）
- 本文描述 Kernel **向外**的一条边界（怎么被客户端调）
- `coding-agent-design.md` 是上层视角，引用前两份的结论但不重写

### 0.4 与 `kernel-protocol.md` 的关系

`kernel-protocol.md` 是**内层**协议，本文是**外层**协议：

- Kernel 的 SQ/EQ 实现内部仍然消费 `LLMProvider` / `Tool` / `ToolRegistry`
- 内层 `StreamEvent` 是 Provider 吐给 Loop 的低阶事件
- 外层 `EventMsg` 是 Kernel 吐给 Client 的高阶事件 —— **聚合 + 翻译 + 标注 turnId**

具体翻译规则见 §6.2。

### 0.5 版本与状态

- v0.1（当前）：Draft，设计前置，**Phase 2/3 落地**
- 当前 M2 现状：`runAgent` 已是 async generator（事实上是 EQ 的雏形）；对外仍是 `POST /v1/chat`（request/response 形态）
- 用户已敲定：Phase 0/1 不升级，先把 Tool / Sandbox / Server 跑通；本文是 Phase 2 拉起 Kernel 时的契约依据

### 0.6 参考实现

- **OpenAI Codex（codex-rs）**：`Submission` / `Op` / `EventMsg` 模型；`codex-protocol` crate 独立成包；`InProcessAppServerClient` 让 exec / TUI / VSCode 共用一套协议
- **Anthropic claude-code**：基于 IPC 的 daemon 风格、客户端订阅事件流、确认环节走回执消息
- **Language Server Protocol**：JSON-RPC 双向消息、Notification + Request/Response 的二分

---

## 1. 设计哲学：「内核是服务，不是函数」

### 1.1 一句话总纲

> **客户端不调用内核的函数，客户端往内核投递 Op、订阅内核吐回的 EventMsg。**

这是 SQ/EQ 范式的全部精神。

### 1.2 反例对比

#### 反例 A：同步 await 模型（自然但是错的）

```ts
// ❌ 看起来很自然，但每个特性都得旁路加补丁
const turn = await kernel.runTurn(message); // 流式怎么办？
turn.onDelta(...); // 加 callback
controller.abort(); // 加 AbortController 旁路
turn.onToolConfirm(...); // 加另一个 callback
// 多个 UI 同时订阅 → 改不动了
```

问题：

- 流式是 callback 补丁
- 打断走 AbortController 这条与主接口完全不同的旁路
- 工具确认是另一个 callback，命名完全不一致
- 多端订阅根本无解

#### 反例 B：SQ/EQ 模型（看起来啰嗦但是对的）

```ts
// ✅ 一切都是消息：流式、打断、确认、订阅 —— 一根管子
kernel.submit({ type: 'UserTurn', sessionId, message });
for await (const ev of kernel.subscribe()) {
  if (ev.type === 'AgentMessageDelta') ui.append(ev.text);
  if (ev.type === 'ToolConfirmRequired') {
    const ok = await ui.askConfirm(ev);
    kernel.submit({ type: 'ConfirmTool', sessionId, callId: ev.callId, approved: ok });
  }
}
// 打断与提交走同一根管子
kernel.submit({ type: 'Interrupt', sessionId });
// 多端订阅天然成立 —— 多次调 subscribe() 即可
```

### 1.3 为什么这是「最关键的一个决定」

把这一个决定做对，三件事顺手解决：

1. **流式是底色，不是特性** —— EQ 本来就是流，`AgentMessageDelta` 跟 `ExecCommandBegin` 平级
2. **打断是一等公民** —— `Op::Interrupt` 与 `Op::UserTurn` 共用同一根 SQ 管道
3. **多端订阅天然成立** —— EQ 是广播队列，TUI / Web / 日志 sink 同时连，没有主从

把它做错（用同步 await），三件事都得反复打补丁，越打越乱。Codex 的实践已经证明这条路走得通。

### 1.4 三个不变量

整套协议必须保证以下三条恒成立：

1. **客户端不知道内核在哪个进程**
   - 同进程嵌入 / 本地 daemon / 远端服务，对客户端代码而言没有差别
   - 唯一变化点是 `KernelTransport` 适配器，业务层零感知
2. **内核不知道客户端是谁**
   - CLI / TUI / Web / IDE 插件 / exec headless / 监控 sink，对内核而言全是「一个 EQ 订阅者」
   - 内核不为任何一种客户端「特别处理」事件
3. **打断 / 流式 / 多端订阅是默认形态，不是补丁**
   - 协议层面就保证，不需要客户端组合 AbortController / EventEmitter / pub-sub 等几样东西凑出来

任何 PR 引入了违反这三条的代码（例如「内核针对 Web UI 多吐一种事件」「CLI 走的不是 SQ 而是直接调 Loop」），都应当在 review 阶段拒绝。

---

## 2. SQ/EQ 协议核心

### 2.1 两个原语

协议的全部表面积只有两类消息和两个动词：

| 方向            | 类型       | 动词                                   | 形态         |
| --------------- | ---------- | -------------------------------------- | ------------ |
| Client → Kernel | `Op`       | `submit(op): Promise<void>`            | 单条命令推入 |
| Kernel → Client | `EventMsg` | `subscribe(): AsyncIterable<EventMsg>` | 事件流订阅   |

`Op` 是 **discriminated union**（`type` 字段判别），`EventMsg` 同理。所有变种字段封闭，不允许 `Op` 携带「自定义键值对」逃出协议表面。

### 2.2 Op 完整集合

```ts
// packages/core/src/protocol/v2/sqeq.ts
import type { Message } from './messages';
import type { ProviderConfig } from './registry';

export type Op =
  // —— 回合控制 ——
  | { type: 'UserTurn'; sessionId: string; message: Message }
  | { type: 'Interrupt'; sessionId: string }
  | { type: 'ConfirmTool'; sessionId: string; callId: string; approved: boolean }
  // —— 会话管理 ——
  | { type: 'CreateSession'; cwd: string; provider: ProviderConfig }
  | { type: 'ResumeSession'; sessionId: string }
  | { type: 'CloseSession'; sessionId: string }
  | { type: 'Cancel'; sessionId: string }
  // —— 内核控制 ——
  | { type: 'Shutdown' };
```

变种解释：

- `CreateSession` / `ResumeSession` / `CloseSession`：会话生命周期（隐含状态：cwd / 选用的 provider / 历史消息）
- `UserTurn`：在某 session 上开启一轮新对话
- `Interrupt`：打断**当前正在运行的回合**，不关闭 session（用户最常用）
- `ConfirmTool`：对 `ToolConfirmRequired` 的回执
- `Cancel`：终止整个 session（比 Interrupt 更重）
- `Shutdown`：通知内核优雅停机

### 2.3 EventMsg 完整集合

```ts
import type { NormalizedError } from './errors';

export type TurnEndReason = 'completed' | 'interrupted' | 'error' | 'length' | 'content_filter';

export type EventMsg =
  // —— 会话生命周期 ——
  | { type: 'SessionCreated'; sessionId: string }
  | { type: 'SessionClosed'; sessionId: string; reason: 'user' | 'timeout' | 'error' }
  // —— 回合生命周期 ——
  | { type: 'TurnStarted'; sessionId: string; turnId: string }
  | { type: 'TurnFinished'; sessionId: string; turnId: string; reason: TurnEndReason }
  // —— 流式输出 ——
  | { type: 'AgentMessageDelta'; turnId: string; text: string }
  | { type: 'ThinkingDelta'; turnId: string; text: string }
  // —— 工具执行 ——
  | { type: 'ToolCallProposed'; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'ToolConfirmRequired'; turnId: string; callId: string; reason: string }
  | { type: 'ExecCommandBegin'; turnId: string; callId: string; cmd: string }
  | { type: 'ExecCommandEnd'; turnId: string; callId: string; exitCode: number; durationMs: number }
  | { type: 'PatchApplied'; turnId: string; path: string; bytesAdded: number; bytesRemoved: number }
  | { type: 'ToolCallFinished'; turnId: string; callId: string; ok: boolean }
  // —— 可观测性 ——
  | {
      type: 'TokensUsed';
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    }
  | { type: 'TurnError'; turnId: string; error: NormalizedError }
  // —— 控制 ——
  | { type: 'Interrupted'; turnId: string }
  | { type: 'KernelError'; error: NormalizedError };
```

#### 路由不变量

- 每个 EventMsg 必须带 `sessionId` **或** `turnId`（其中 `turnId` 隐含归属一个唯一 session）
- 多 session 并行时，客户端按 id 把事件分流到对应 UI
- 内核不允许吐**无路由信息**的事件（`KernelError` 是例外，本身就是「与 session 无关的内核级故障」）

#### 与内层 `StreamEvent` 的对照

| 内层（`kernel-protocol.md`） | 外层（本文）           | 说明                             |
| ---------------------------- | ---------------------- | -------------------------------- |
| `text_delta`                 | `AgentMessageDelta`    | 直接转发，加 `turnId`            |
| `thinking_delta`             | `ThinkingDelta`        | 直接转发                         |
| `tool_use_start/delta/stop`  | `ToolCallProposed`     | **聚合**：三段累积成一个完整事件 |
| `message_stop`               | `TurnFinished` 的输入  | `stopReason` → `TurnEndReason`   |
| `error`                      | `TurnError`            | 包装为 `TurnError`（带 turnId）  |
| —                            | `ExecCommandBegin/End` | 由 Tool 执行层注入               |
| —                            | `PatchApplied`         | 由 fs.write / patch 工具注入     |
| —                            | `TokensUsed`           | `Usage` 字段独立成事件           |

外层事件**比内层粗、比内层富**（带语义、带可观测性元数据）。

### 2.4 时序图

#### 2.4.1 一条完整 turn 的事件流

```
Client                                 Kernel
   │                                      │
   │ submit(Op::UserTurn{session, msg})   │
   │─────────────────────────────────────▶│
   │                                      │
   │            TurnStarted{sid, tid}     │
   │◀─────────────────────────────────────│
   │            AgentMessageDelta...      │
   │◀─────────────────────────────────────│
   │            AgentMessageDelta...      │
   │◀─────────────────────────────────────│
   │            ToolCallProposed{call=42} │
   │◀─────────────────────────────────────│
   │            ExecCommandBegin{42, cmd} │
   │◀─────────────────────────────────────│
   │            ExecCommandEnd{42, exit=0}│
   │◀─────────────────────────────────────│
   │            ToolCallFinished{42, ok}  │
   │◀─────────────────────────────────────│
   │            AgentMessageDelta...      │
   │◀─────────────────────────────────────│
   │            TokensUsed{...}           │
   │◀─────────────────────────────────────│
   │            TurnFinished{reason=done} │
   │◀─────────────────────────────────────│
```

#### 2.4.2 打断场景

```
Client                                 Kernel
   │ submit(UserTurn)                     │
   │─────────────────────────────────────▶│
   │ ◀── TurnStarted, AgentMessageDelta ──│
   │                                      │
   │ submit(Op::Interrupt{sid})           │
   │─────────────────────────────────────▶│
   │            Interrupted{tid}          │
   │◀─────────────────────────────────────│
   │            TurnFinished{reason=interrupted}
   │◀─────────────────────────────────────│
```

注意：`Interrupted` 与 `TurnFinished{interrupted}` 都吐 —— 前者是「打断信号已被内核接收并执行」，后者是「回合按打断收尾」。客户端可以选择只看后者。

#### 2.4.3 工具确认场景

```
Client                                 Kernel
   │ submit(UserTurn)                     │
   │─────────────────────────────────────▶│
   │ ◀── ToolCallProposed{call=7, ...} ───│
   │ ◀── ToolConfirmRequired{call=7, ...}─│   （此时 turn 暂停在工具调用前）
   │                                      │
   │ submit(ConfirmTool{call=7, ok=true}) │
   │─────────────────────────────────────▶│
   │ ◀── ExecCommandBegin{7, ...}  ───────│   （内核继续执行）
   │ ◀── ExecCommandEnd{7, ...}    ───────│
   │ ◀── ToolCallFinished{7, ok}   ───────│
   │ ◀── TurnFinished{completed}   ───────│
```

`ToolConfirmRequired` 是阻塞型事件 —— 内核会等到 `ConfirmTool` 回执（或会话超时）才继续，不依赖客户端的 RPC 模型。

---

## 3. 六大设计优势

逐项展开 SQ/EQ 范式相比同步 await 在六个维度的实质收益。

### 3.1 打断是一等公民

同步 await 模型里，打断只能是「主接口外的一根旁路线」（AbortController / Cancellation Token）。这意味着：

- 主接口签名长得像没有打断功能
- 文档不写、新接入者忘记接 abort、异步调用栈深处漏接 signal
- 测试也得写两套：正常路径一套、abort 路径一套

SQ/EQ 模型里：

```ts
kernel.submit({ type: 'UserTurn', sessionId, message });
// ... 用户按 ESC ...
kernel.submit({ type: 'Interrupt', sessionId });
```

打断 = 提交另一个 Op，**与提交回合走同一根 SQ 管道**。Kernel 在回合处理循环里同时消费 SQ，自然能在两个 token 之间收到 `Interrupt` 并触发 `session.abort()`。

收益：

- 协议表面积没膨胀（只是多了一个 Op variant）
- 不需要旁路传 AbortController
- 跨进程天然可达 —— 旁路 AbortController 跨进程根本传不过去，必须翻译成消息；SQ 模型直接就是消息

### 3.2 流式输出 = 默认形态

SQ/EQ 不需要专门设计「流式 API」—— EQ 本来就是事件流。

在同步 await 模型里，「返回 string」和「流式吐 token」是两套 API：

```ts
// ❌ 两份接口
kernel.runTurn(msg).then((text) => ...);
kernel.streamTurn(msg, { onDelta: ... });
```

SQ/EQ 模型只有一种：

```ts
kernel.submit({ type: 'UserTurn', ... });
for await (const ev of kernel.subscribe()) {
  if (ev.type === 'AgentMessageDelta') accumulate(ev.text);
  if (ev.type === 'TurnFinished') break;
}
```

`AgentMessageDelta` 与 `ExecCommandBegin` 在协议层平级 —— **流式不是特殊场景，是底色**。

### 3.3 UI 与内核彻底解耦（多端订阅）

EQ 是多订阅源（broker 模式），同一份事件流可以被多个客户端同时消费：

```
                ┌──── TUI（同步渲染）
Kernel EQ ──────┼──── Web UI（远端 SSE）
                ├──── 日志 sink（写文件）
                └──── 监控 sink（埋点上报）
```

每个客户端只是事件消费者，对内核而言没有区别。结果：

- 调试时多挂一个日志 sink 即可，不需改内核代码
- Web 与 TUI 共享同一个 daemon —— 同一会话两端同时观察，状态一致
- 监控 / 录屏 / 审计都是「再多挂一个订阅者」

同步 await 模型实现这件事需要内核内部维护 EventEmitter + 显式发布逻辑，多塞一份维护成本。SQ/EQ 模型免费送。

### 3.4 headless 与交互式同根

`exec` / CI / 一次性脚本不应该是「另一条管线」。它们是「**不渲染 UI 的事件消费者**」。

```ts
// CLI 交互模式
for await (const ev of kernel.subscribe()) {
  tui.render(ev);
}

// exec headless 模式 —— 同一份订阅，仅替换消费者
for await (const ev of kernel.subscribe()) {
  if (ev.type === 'TurnFinished') {
    process.stdout.write(collectFinalText());
    process.exit(ev.reason === 'completed' ? 0 : 1);
  }
}
```

Codex 把 exec 改成走 `InProcessAppServerClient`，本质就是这件事：让 headless 与 TUI 共享同一份 Kernel 实例与 SQ/EQ 协议，而不是为 exec 写一条独立的同步 chat 管线。

收益：

- 内核演进时 exec 自动跟上，不会「TUI 有新事件，CI 看不到」
- 测试基础设施统一 —— 录制 EQ 事件流可以同时 replay 到 TUI 和 exec
- 一份协议、两个客户端，避免代码二份

### 3.5 事件粒度 = 可观测性

把事件拆细到 `ExecCommandBegin/End` / `PatchApplied` / `TokensUsed` 各自独立，而不是只吐一个聚合 text，是一个**为可观测性买单**的决定。

| 事件                   | 直接收益                                      |
| ---------------------- | --------------------------------------------- |
| `TokensUsed`           | 直接进计费表 / 配额检查；不必从 text 推算     |
| `ExecCommandBegin/End` | 单独打日志、做命令审计；不必正则解析 stdout   |
| `PatchApplied`         | 单独存档、做变更追踪；不必 diff 整个工作区    |
| `ToolCallFinished`     | 单独埋点工具成功率；不必扫 text 找「✓/✗」     |
| `ThinkingDelta`        | 单独折叠/隐藏 reasoning UI；不必标签解析 text |

反例：如果只吐 `text_delta`，事后做以上五件事都得二次解析 —— 不仅低效，还容易和 LLM 输出风格耦合（LLM 改一下「Running command:」前缀，你的 grep 就坏了）。

**协议层面的细粒度，是把「未来要做的所有埋点 / 调试 / 审计」预付掉。**

### 3.6 进程边界天然适配

SQ/EQ 是消息模型，消息天然可序列化。三层部署形态共用同一份协议：

| 部署形态   | 传输               | 序列化 | 客户端举例                 |
| ---------- | ------------------ | ------ | -------------------------- |
| 同进程     | 内存 AsyncQueue    | 无     | 嵌入式 TUI、单测 Mock      |
| 跨进程同机 | stdio JSON-RPC 2.0 | JSON   | VSCode 插件 ↔ 本地 daemon |
| 跨机器     | HTTP POST + SSE    | JSON   | Web UI ↔ Cloud daemon     |

协议形态没变，**只是序列化层加了一道**。同步 await 模型则需要为跨进程版本重新设计接口（callback 没法跨进程，要换成 long polling / pub-sub）—— SQ/EQ 一个模型走到底。

---

## 4. 三层传输实现

抽象出统一的 `KernelTransport` 接口，三种部署形态各实现一套适配器。

### 4.1 transport 适配器接口

```ts
// packages/core/src/protocol/v2/transport.ts
export interface EventFilter {
  sessionId?: string;
  turnId?: string;
  types?: ReadonlyArray<EventMsg['type']>;
  /** SSE 重连时由客户端传入；从该 id 之后续订（不含） */
  lastEventId?: string;
}

export interface KernelTransport {
  submit(op: Op): Promise<void>;
  subscribe(filter?: EventFilter): AsyncIterable<EventMsg>;
}
```

`subscribe` 返回 `AsyncIterable` 是设计的核心 —— 三种 transport 的实现差异被压缩到「如何把消息塞进这个 AsyncIterable」内部。

### 4.2 同进程（in-process）

适用：MVP 阶段、TUI 嵌入式、单元测试。

```ts
class InProcessTransport implements KernelTransport {
  constructor(private kernel: Kernel) {}
  async submit(op: Op) {
    this.kernel.submit(op);
  }
  subscribe(filter?: EventFilter) {
    return this.kernel.subscribe(filter);
  }
}
```

实现细节：SQ 是内存 `AsyncQueue<Op>`，EQ 是 `EventBroker<EventMsg>`（参考 §5）。无序列化开销、无连接断开。

### 4.3 跨进程同机器（local IPC，JSON-RPC over stdio）

适用：VSCode / JetBrains 插件连本地 kernel daemon；CLI 子进程托管模式。

帧格式：JSON-RPC 2.0 over stdio，按 `Content-Length: N\r\n\r\n<json>`（参考 LSP）。

```jsonc
// Client → Kernel：提交 Op（Notification，无返回）
{ "jsonrpc": "2.0", "method": "submit",
  "params": { "type": "UserTurn", "sessionId": "s1", "message": { ... } } }

// Kernel → Client：派发 EventMsg（Notification，无返回）
{ "jsonrpc": "2.0", "method": "event",
  "params": { "type": "AgentMessageDelta", "turnId": "t42", "text": "Hello" } }

// Client → Kernel：订阅（Request，有返回）
{ "jsonrpc": "2.0", "id": 1, "method": "subscribe",
  "params": { "filter": { "sessionId": "s1" } } }
{ "jsonrpc": "2.0", "id": 1, "result": { "subscriptionId": "sub-3" } }
```

注意：

- 单连接多路复用 SQ 与 EQ —— 同一根 stdio 管道，区分靠 `method`
- 多客户端场景由 daemon 进程持有所有 stdio 子连接

### 4.4 跨机器（remote，HTTP + SSE）

适用：Web UI 连后端 / 多人共享 daemon。

```
POST /v1/op
  Body: Op JSON
  Resp: 204 No Content（成功） / 4xx 5xx + NormalizedError JSON

GET  /v1/events?sessionId=s1&types=AgentMessageDelta,TurnFinished
  Header: Last-Event-ID: <id>     （重连时携带）
  Resp:   text/event-stream
          每条 EventMsg 一帧：
              id: <monotonic>
              event: <EventMsg.type>
              data: <JSON of EventMsg>
```

约定：

- `id` 单调递增；客户端断连后重连用 `Last-Event-ID` 续订
- `event` 字段可选，方便 SSE 事件分发；`data` 是权威 JSON
- POST 与 GET 不绑定，**SQ 与 EQ 是两条 HTTP 连接** —— 这是 SSE 的原生形态

### 4.5 一致性保证

对客户端而言，三种 transport **等价**：

- 都是 `submit(op)` + `subscribe(filter)`
- 都遵守同一份 `Op` / `EventMsg` schema
- 都能续订（in-process 没断点；JSON-RPC 由进程重启实现；HTTP/SSE 用 Last-Event-ID）

业务代码切换部署形态时只换 transport 实例，零业务改动。

---

## 5. Kernel 实现骨架

### 5.1 整体结构

```ts
// packages/core/src/kernel/index.ts
import type { LLMProvider } from '../protocol/v2/provider';
import type { ToolRegistry } from '../protocol/v2/tool';

interface Session {
  id: string;
  cwd: string;
  provider: LLMProvider;
  tools: ToolRegistry;
  history: Message[];
  abortController: AbortController | null;
  pendingConfirms: Map<string, (ok: boolean) => void>;
  abort(): void;
  resolveConfirm(callId: string, ok: boolean): void;
}

export class Kernel {
  private sessions = new Map<string, Session>();
  private sq: AsyncQueue<Op>;
  private eq: EventBroker<EventMsg>;

  constructor(private deps: { providerRegistry: ProviderRegistry; toolRegistry: ToolRegistry }) {
    this.sq = new AsyncQueue();
    this.eq = new EventBroker();
    this.run();
  }

  async submit(op: Op): Promise<void> {
    this.sq.push(op);
  }

  subscribe(filter?: EventFilter): AsyncIterable<EventMsg> {
    return this.eq.stream(filter);
  }

  private async run(): Promise<void> {
    while (true) {
      const op = await this.sq.pop();
      try {
        await this.dispatch(op);
      } catch (e) {
        this.eq.emit({ type: 'KernelError', error: normalizeError(e) });
      }
    }
  }

  private async dispatch(op: Op): Promise<void> {
    switch (op.type) {
      case 'CreateSession':
        return this.handleCreateSession(op);
      case 'CloseSession':
        return this.handleCloseSession(op);
      case 'UserTurn':
        return this.handleUserTurn(op); // 异步分派，不阻塞 SQ
      case 'Interrupt':
        this.sessions.get(op.sessionId)?.abort();
        return;
      case 'ConfirmTool':
        this.sessions.get(op.sessionId)?.resolveConfirm(op.callId, op.approved);
        return;
      case 'Cancel':
        return this.handleCancel(op);
      case 'Shutdown':
        return this.handleShutdown();
      // ...
    }
  }
}
```

### 5.2 一次 turn 的内部翻译

```ts
private handleUserTurn(op: Extract<Op, { type: 'UserTurn' }>): void {
  const session = this.sessions.get(op.sessionId);
  if (!session) {
    this.eq.emit({ type: 'KernelError',
      error: { code: 'unknown', message: `unknown session: ${op.sessionId}`, retriable: false } });
    return;
  }
  const turnId = uuid();
  session.abortController = new AbortController();
  session.history.push(op.message);

  // fire-and-forget，不阻塞 SQ 主循环
  void (async () => {
    this.eq.emit({ type: 'TurnStarted', sessionId: op.sessionId, turnId });
    try {
      for await (const ev of runAgent({                       // §kernel-protocol.md §7
        provider: session.provider,
        tools: session.tools,
        messages: session.history,
        signal: session.abortController!.signal,
        toolCtx: this.buildToolCtx(session, turnId),
      })) {
        const out = translateAgentEvent(ev, op.sessionId, turnId);
        if (out) this.eq.emit(out);
      }
      this.eq.emit({ type: 'TurnFinished', sessionId: op.sessionId, turnId, reason: 'completed' });
    } catch (e) {
      const err = normalizeError(e);
      if (err.code === 'aborted') {
        this.eq.emit({ type: 'Interrupted', turnId });
        this.eq.emit({ type: 'TurnFinished', sessionId: op.sessionId, turnId, reason: 'interrupted' });
      } else {
        this.eq.emit({ type: 'TurnError', turnId, error: err });
        this.eq.emit({ type: 'TurnFinished', sessionId: op.sessionId, turnId, reason: 'error' });
      }
    } finally {
      session.abortController = null;
    }
  })();
}
```

要点：

- SQ 主循环**不阻塞**等 turn 结束 —— 否则 `Interrupt` / `ConfirmTool` 会被排在 `UserTurn` 之后，永远来不及打断
- 把 turn 当成「派生协程」，主循环只负责派发 + 信号回写
- `translateAgentEvent` 是把 `kernel-protocol.md` 的内层 `StreamEvent` + Tool 执行事件翻译成外层 `EventMsg` 的纯函数

### 5.3 工具执行注入事件

工具执行层在 §kernel-protocol.md `Tool.execute` 之上挂一层包装，注入 `ExecCommandBegin/End` / `PatchApplied`：

```ts
private buildToolCtx(session: Session, turnId: string): ToolContext {
  return {
    cwd: session.cwd,
    signal: session.abortController!.signal,
    confirm: async ({ name, input }) => this.askConfirm(session, turnId, name, input),
    env: { __emit: (ev: EventMsg) => this.eq.emit(ev), turnId },
  };
}
```

约定（不在类型上强制，靠 ToolSource 实现自律）：

- `local__shell.exec` 在 spawn 前 emit `ExecCommandBegin`，进程退出时 emit `ExecCommandEnd`
- `local__fs.write` / `local__patch.apply` 在写盘成功后 emit `PatchApplied`
- 其他 Tool 只 emit `ToolCallFinished`（由 Loop 统一发，工具不必关心）

---

## 6. 与 `kernel-protocol.md` 的对接

### 6.1 内核三大边界完整对比表

> ⭐ **本文最关键的一张表 —— 钉死「Kernel 有且只有三条协议边界」。**

| 边界                  | 文档                    | 接口                                             | 范围                       | 形态                         |
| --------------------- | ----------------------- | ------------------------------------------------ | -------------------------- | ---------------------------- |
| 内核 ↔ 模型适配器    | `kernel-protocol.md` §3 | `LLMProvider.stream(req)`                        | 包内 `packages/llm`        | `AsyncIterable<StreamEvent>` |
| 内核 ↔ 工具来源      | `kernel-protocol.md` §4 | `Tool.execute(input, ctx)` / `ToolSource.list()` | 包内 `packages/tools`      | `Promise<ContentBlock[]>`    |
| **内核 ↔ 客户端 UI** | **本文**                | **`submit(op)` + `subscribe(events)`**           | **跨进程**（多 transport） | **SQ/EQ 双队列**             |

性质上的差异：

- 前两条是**包内**接口（同一进程的依赖注入边界），用 TS interface 表达即可
- 第三条是**跨进程**接口，必须可序列化、必须有重连语义、必须支持多订阅 —— 因此选 SQ/EQ 范式

三条边界各管一头：

- Loop 不感知 Provider 是哪家、不感知 Tool 是本地 / MCP / Skill
- Provider 不感知工具如何被执行
- Kernel 不感知客户端是 CLI / Web / IDE

### 6.2 数据流端到端（一图打通三层）

```
[Client UI: TUI / Web / IDE / exec]
   │
   │ submit(Op::UserTurn{ sessionId, message })       ──────────────  外层边界（本文）
   ▼
[Kernel SQ] ──worker──▶ [runAgent generator]
                         │
                         ├─ provider.stream(req) ────  内层边界 1（kernel-protocol.md §3）
                         │   ◀── StreamEvent: text_delta / tool_use_* / message_stop / error
                         │
                         ├─ tool.execute(input, ctx)──  内层边界 2（kernel-protocol.md §4）
                         │   ◀── ContentBlock[]（含工具执行期间注入的事件）
                         │
                         ▼ AgentEvent（内部）
                    [translateAgentEvent]
                         │ 1:1 / 1:N / 聚合
                         ▼ EventMsg
                    [Kernel EQ broker]
                         │
                         ▼ AsyncIterable<EventMsg>     ──────────────  外层边界（本文）
[Client UI subscribers: 多端可同时订阅]
```

#### 翻译规则（举例）

| 内部事件                                | 外部 EventMsg                                    |
| --------------------------------------- | ------------------------------------------------ |
| `StreamEvent.text_delta`                | `AgentMessageDelta`（直接转发，注入 turnId）     |
| `StreamEvent.thinking_delta`            | `ThinkingDelta`                                  |
| `StreamEvent.tool_use_start/delta/stop` | `ToolCallProposed`（**聚合**完整 input 后才发）  |
| Loop 决策走入工具执行环节               | `ToolConfirmRequired`（如需确认）                |
| `local__shell.exec` 执行前/后           | `ExecCommandBegin` / `ExecCommandEnd`            |
| `local__fs.write` 写盘后                | `PatchApplied`                                   |
| Tool.execute 完成                       | `ToolCallFinished`                               |
| `StreamEvent.message_stop.usage`        | `TokensUsed`                                     |
| `StreamEvent.message_stop.stopReason`   | `TurnFinished.reason`（end_turn → completed 等） |
| `StreamEvent.error`                     | `TurnError`                                      |
| 用户 abort                              | `Interrupted` + `TurnFinished{interrupted}`      |

### 6.3 现状与升级路径

| 阶段        | 状态                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| **M2 现状** | `runAgent` 已是 async generator（事实上是 EQ 雏形）；对外 `POST /v1/chat` 返回 SSE，request/response 形态         |
| **Phase 1** | **不动外层协议**。先把 Tool / Sandbox / Server 跑通；内层完成 `ContentBlock + LLMProviderV2 + StreamEvent` 升级   |
| **Phase 2** | 引入 `Kernel + SQ/EQ`。HTTP 层重构为 `POST /v1/op` + `GET /v1/events`；保留旧 `/v1/chat` 一个 minor 标 deprecated |
| **Phase 3** | 加 stdio JSON-RPC transport（IDE 插件接入触发）；exec 切换到 `InProcessTransport`，与 TUI 同根                    |

兼容策略：

- **旧 `/v1/chat`**：内部实现转发为 `submit(Op::CreateSession)` + `submit(Op::UserTurn)` + 订阅 EQ 后投影回 OpenAI-style chunked response，对老客户端零感知
- **协议类型独立成 `@liskin/core/protocol`** —— 跟 `kernel-protocol.md` 的 v2 类型同一目录、同一发布单元，TS 全栈共享，**省掉 Codex 那种 ts-rs 代码生成步骤**

---

## 7. 关键决策与不做的事

### 7.1 关键决策

| 决策                                                                   | 理由                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 协议类型独立成 `@liskin/core/protocol`                                 | TS 全栈无需代码生成；客户端与内核共享真相源；类型变更通过包版本统一发布        |
| `sessionId` + `turnId` 双层标识                                        | 一个 session 多个 turn；多客户端订阅时按 id 分流；Interrupt/Cancel 作用域明确  |
| EventMsg 拆细到 `ExecCommandBegin/End` / `PatchApplied` / `TokensUsed` | 计费 / 审计 / 调试 / UI 折叠都不必二次解析 text 流；为可观测性预付             |
| Kernel 单进程持有所有 sessions，SQ 是单一全局队列                      | 避免分布式状态机；FIFO 简单可推理；多 session 并行靠「派生协程」而非「分队列」 |
| transport 是适配器：in-process / stdio JSON-RPC / HTTP+SSE             | 业务零感知部署形态；同一份协议覆盖嵌入式 / 桌面插件 / 云端                     |
| `Op::Interrupt` 与 `Op::UserTurn` 共用 SQ                              | 打断成为协议一等公民；旁路 AbortController 跨不了进程，消息能跨                |
| `ToolConfirmRequired` 走 EQ + `ConfirmTool` 走 SQ                      | 确认本质是「双向消息一来一回」；不引入额外 RPC channel；天然支持跨进程         |
| headless 与交互式同根                                                  | exec 是 EQ 的另一类消费者，不是另一条管线；测试录制可在两种模式间共用          |

### 7.2 不做的事

- ❌ **不做 gRPC**：JSON-RPC + JSON 已足够；gRPC 引入 protobuf 编译 / 双语言绑定的复杂度，对纯 TS 全栈是负价值
- ❌ **不做 WebSocket 双工**：HTTP/SSE 单向流 + POST 提交已能完整表达 SQ/EQ；WS 多了连接生命周期管理与代理穿透问题
- ❌ **不做 Redis Pub/Sub 当 EQ**：单 Kernel 进程足够；Phase 3 真出现多机部署再议（届时 Redis 也只是 transport 实现细节）
- ❌ **不在 SQ 里做优先级队列**：FIFO 足够；`Interrupt` 之所以「插队生效」靠的是 SQ 主循环本身轻量、turn 处理是派生协程
- ❌ **不引入 Actor 模型**（Erlang 风格 send/receive）：TS 生态不亲和；异步迭代器 + AsyncQueue 已能表达
- ❌ **不做协议自动 schema 生成**（ts-rs / OpenAPI 反向生成）：TS 全栈共用同一份 `.ts` 文件就是真相源
- ❌ **不在协议里塞「自定义键值对」逃生口**：所有扩展走新增 Op / EventMsg variant，封闭 union 是健康的

---

## 8. MCP 双重身份（呼应 Codex 设计）

Codex 设计中的一个重要侧面：MCP 既是 client 也是 server。本文 SQ/EQ 协议天然支持这一双重身份。

### 8.1 作为 client：连外部 MCP server

由 `kernel-protocol.md` §4 的 `McpToolSource` 涵盖。模型把 MCP server 暴露的工具当成普通 `Tool` 调用，外层 `EventMsg` 与本地工具完全一致（`ToolCallProposed` / `ToolCallFinished`）。本文不重复。

### 8.2 作为 server：把自己暴露成 MCP

Kernel 可以把 SQ/EQ 包装成一个 MCP server endpoint：

- 上层编排器（可能是另一个 liskin Kernel、可能是 Claude Desktop、可能是某个工作流引擎）把当前 Kernel 当成一个「Tool」调用
- 调用形态：编排器 `MCP call → kernel.submit(Op::UserTurn)` → 等 EQ 上的 `TurnFinished` → 把累积的 assistant 输出作为工具结果回传

这是 SQ/EQ 范式带来的「**协议是嵌套对称的**」性质：

```
[上层编排 Kernel]
   │
   ├─ ToolSource: McpToolSource
   │     └─ MCP call ─→ [下层 liskin Kernel SQ/EQ]
   │                          │
   │                          ├─ ToolSource: LocalToolSource
   │                          └─ ToolSource: McpToolSource → [更下层 ...]
```

这呼应 `coding-agent-design.md` §13「工作流编排」的协议落点 —— 编排不是新协议，是 SQ/EQ + MCP 的递归组合。

---

## 9. 错误与降级

### 9.1 错误事件分类

| 事件            | 含义                                    | 客户端处理建议                                     |
| --------------- | --------------------------------------- | -------------------------------------------------- |
| `TurnError`     | 单次 turn 失败（带 NormalizedError）    | 展示错误；按 `retriable` 决定是否提示用户重试      |
| `KernelError`   | 内核级故障（OOM / 配置错误 / 致命异常） | 提示用户重启 daemon；上报监控                      |
| `SessionClosed` | session 被关或超时                      | 清理本地 session 状态；下一次自动 `CreateSession`  |
| `Interrupted`   | 打断信号已被内核执行                    | 通常不显式 UI；等 `TurnFinished{interrupted}` 收尾 |

`NormalizedError` 直接复用 `kernel-protocol.md` §5 的定义 —— Kernel 不再对 ErrorCode 做翻译，原样透传。

### 9.2 transport 失败

| Transport      | 断连场景                | 恢复策略                                                                   |
| -------------- | ----------------------- | -------------------------------------------------------------------------- |
| in-process     | 不会断                  | 进程级故障由外层 supervisor（如 OS launcher）处理                          |
| stdio JSON-RPC | 子进程崩溃 / 父进程退出 | 客户端重启子进程；session 状态丢失 —— 由客户端持久化或重新 `CreateSession` |
| HTTP / SSE     | 网络抖动 / 超时         | 客户端用 `Last-Event-ID` 重连，从断点续订；POST 端有幂等性 / 客户端去重    |

#### Last-Event-ID 续订的边界

- Kernel 内 EQ broker 维持一个**有限的环形缓冲**（默认 1k 条 / 5 分钟，可配）
- 客户端断开超出窗口后重连：内核回 410 Gone，客户端必须 `ResumeSession` 重新走流程
- 这是 Web SSE 的成熟模式，无须自创

### 9.3 SQ / EQ 背压

| 场景            | 策略                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **SQ 满**       | reject 新 Op，`submit()` 抛 `kernel_busy`（NormalizedError，retriable=true）；客户端退避后重试                            |
| **EQ 慢消费者** | 客户端订阅有 buffer 上限；超限**丢弃低优事件**（`ThinkingDelta` / `AgentMessageDelta` 中段可丢）                          |
| **关键事件**    | turn 边界事件（`TurnStarted` / `TurnFinished` / `TurnError` / `Interrupted` / `ToolConfirmRequired`）**必送达**，不可丢弃 |

实现层面，`EventBroker` 给每条事件打优先级标志，broker 根据订阅方 buffer 水位决定是否对低优事件做采样丢弃。

---

## 10. 完整 TS 类型定义（附录）

> 目标路径：`packages/core/src/protocol/v2/sqeq.ts`
> 与 `kernel-protocol.md` §11 共同发布在 `@liskin/core/protocol`，TS 全栈共享。

```ts
// =====================================================================
// packages/core/src/protocol/v2/sqeq.ts
// =====================================================================
import type { Message } from './messages';
import type { NormalizedError } from './errors';
import type { ProviderConfig } from './registry';

// ---------- Op：客户端 → 内核 ----------

export type Op =
  // 回合控制
  | { type: 'UserTurn'; sessionId: string; message: Message }
  | { type: 'Interrupt'; sessionId: string }
  | { type: 'ConfirmTool'; sessionId: string; callId: string; approved: boolean }
  // 会话管理
  | { type: 'CreateSession'; cwd: string; provider: ProviderConfig }
  | { type: 'ResumeSession'; sessionId: string }
  | { type: 'CloseSession'; sessionId: string }
  | { type: 'Cancel'; sessionId: string }
  // 内核控制
  | { type: 'Shutdown' };

// ---------- EventMsg：内核 → 客户端 ----------

export type TurnEndReason = 'completed' | 'interrupted' | 'error' | 'length' | 'content_filter';

export type EventMsg =
  // 会话生命周期
  | { type: 'SessionCreated'; sessionId: string }
  | { type: 'SessionClosed'; sessionId: string; reason: 'user' | 'timeout' | 'error' }
  // 回合生命周期
  | { type: 'TurnStarted'; sessionId: string; turnId: string }
  | { type: 'TurnFinished'; sessionId: string; turnId: string; reason: TurnEndReason }
  // 流式输出
  | { type: 'AgentMessageDelta'; turnId: string; text: string }
  | { type: 'ThinkingDelta'; turnId: string; text: string }
  // 工具执行
  | { type: 'ToolCallProposed'; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'ToolConfirmRequired'; turnId: string; callId: string; reason: string }
  | { type: 'ExecCommandBegin'; turnId: string; callId: string; cmd: string }
  | { type: 'ExecCommandEnd'; turnId: string; callId: string; exitCode: number; durationMs: number }
  | { type: 'PatchApplied'; turnId: string; path: string; bytesAdded: number; bytesRemoved: number }
  | { type: 'ToolCallFinished'; turnId: string; callId: string; ok: boolean }
  // 可观测性
  | {
      type: 'TokensUsed';
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    }
  | { type: 'TurnError'; turnId: string; error: NormalizedError }
  // 控制
  | { type: 'Interrupted'; turnId: string }
  | { type: 'KernelError'; error: NormalizedError };

// ---------- Transport ----------

export interface EventFilter {
  sessionId?: string;
  turnId?: string;
  types?: ReadonlyArray<EventMsg['type']>;
  /** SSE 重连续订点（不含此 id） */
  lastEventId?: string;
}

export interface KernelTransport {
  submit(op: Op): Promise<void>;
  subscribe(filter?: EventFilter): AsyncIterable<EventMsg>;
}

// ---------- Kernel 对外契约（in-process 实现可直接复用） ----------

export interface Kernel extends KernelTransport {
  /** 与 KernelTransport 一致；显式声明便于其他 transport 包装 */
}
```

---

**END of `kernel-sqeq-protocol.md`**
