# Web 前端设计与内核通信

> 路径：`docs/architecture/web-frontend-design.md`
> 状态：Draft（面向 Step 3 落地）
> 版本：v0.1 · 2026-06-18
> 关联文档：
>
> - `kernel-client-protocol.md`（内核↔Client 协议与解耦，本文是其 Web 落地）
> - `kernel-sqeq-protocol.md`（SQ/EQ 理想形态）
> - `coding-agent-design.md`（整体架构与路线图）

---

## 0. 文档定位

本文回答两个问题：

1. **前端怎么和 agent 内核通信？** —— 传输方式、消息形态、中断/确认/流式如何穿过进程边界。
2. **前端应该怎么完全重构？** —— 渲染模型、状态层、目录结构、落地顺序。

与现有文档分工：`kernel-client-protocol.md` 钉死内核↔Client 的协议契约（`Op`/`EventMsg`/`KernelClient`），本文是它在 Web 端的具体落地——选哪种 transport、怎么把 `EventMsg` 渲染成终端式时间线、前端如何零业务状态。

---

## 1. 通信方式：前端 ↔ agent 内核

### 1.1 物理拓扑

```
浏览器 (web/, React)                本地机器
┌──────────────────┐    HTTP+SSE    ┌─────────────────────────────┐
│  React UI        │ ─────────────▶ │ packages/server (Hono daemon)│
│  - 渲染 EventMsg │ ◀───────────── │  - transport 翻译            │
│  - 投递 Op       │   EventMsg 流   │  - 持有 InProcessKernelClient │
└──────────────────┘                │  - SQLite (StorePort)        │
                                    │  - runAgent 主循环            │
                                    └─────────────────────────────┘
```

**Web 天然跨进程**：浏览器里的 React 无法直接持有内核对象，必须经 daemon。这与 CLI 不同——CLI 用 `InProcessKernelClient` 直连 `runAgent`（同进程、零序列化），Web 必须经 HTTP/SSE。

> 这也是 `kernel-client-protocol.md` §6「MVP 先 CLI 后 Web」的根因：CLI 能 in-process，Web 不能；Web 必须先有 daemon + SSE，多一层。

### 1.2 逻辑边界：KernelClient 接口

前端只依赖一个接口 `KernelClient`（定义在 `@liskin/core`，与 transport 无关）：

```ts
interface KernelClient {
  createSession(opts?): Promise<SessionHandle>;
  resumeSession(id): Promise<SessionHandle>;
  closeSession(id): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  submit(op: SubmitOp): AsyncIterable<EventMsg>; // 投递 UserTurn，拿回事件流
  interrupt(sessionId): Promise<void>; // 打断当前回合
  confirmTool(sessionId, callId, decision): Promise<void>;
}
```

Web 侧实现 `HttpSseKernelClient`，把每个方法翻译成 HTTP 调用；CLI 侧实现 `InProcessKernelClient`，直连 `runAgent`。**两者同接口，UI 代码零改动换 transport。**

### 1.3 消息形态：Op 与 EventMsg

通信是**双向异步**：前端投递 `Op`（意图），内核回 `EventMsg`（事实）。全部 plain JSON，可序列化无损失。

**Op（前端 → 内核）**

```ts
type Op =
  | { type: 'CreateSession'; cwd?: string; system?: string }
  | { type: 'ResumeSession'; sessionId: string }
  | { type: 'CloseSession'; sessionId: string }
  | { type: 'UserTurn'; sessionId: string; content: string; maxTurns?: number }
  | { type: 'Interrupt'; sessionId: string }
  | { type: 'ConfirmTool'; sessionId: string; callId: string; decision: 'approve' | 'deny' }
  | { type: 'Cancel'; sessionId: string };
```

**EventMsg（内核 → 前端）** = `AgentEvent` 加 `turnId` 聚合 + 会话生命周期包络：

```ts
type EventMsg =
  | { type: 'SessionCreated'; sessionId: string; createdAt: string; isNew: boolean }
  | { type: 'SessionClosed'; sessionId: string; reason: 'user' | 'error' }
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
      sessionId: string;
      reason: 'completed' | 'interrupted' | 'max_turns' | 'error';
    }
  | { type: 'Error'; turnId?: string; sessionId?: string; error: NormalizedError };
```

`turnId` 是关键：内核给每个 `UserTurn` 分配一个，该 turn 产生的所有事件都带它。前端据此把流式事件聚合成「一轮」。

### 1.4 传输映射：HTTP 端点

`HttpSseKernelClient` 把接口方法映射到 daemon 的 REST 端点：

| KernelClient 方法  | HTTP                              | 说明                                                                                              |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `createSession`    | `POST /v1/sessions`               | body `{cwd?, system?}` → `SessionHandle`                                                          |
| `resumeSession`    | `GET /v1/sessions/:id`            | → `SessionHandle`（含历史 messages）                                                              |
| `closeSession`     | `DELETE /v1/sessions/:id`         |                                                                                                   |
| `listSessions`     | `GET /v1/sessions`                | → `SessionInfo[]`（列表，不含全文）                                                               |
| `submit(UserTurn)` | `POST /v1/sessions/:id/turns`     | **SSE 流**：body `{content, maxTurns?}`，响应 `text/event-stream`，每条 `data:` 是一个 `EventMsg` |
| `interrupt`        | `POST /v1/sessions/:id/interrupt` | 触发内核 `AbortController.abort()`，回合在 turn 边界优雅停                                        |
| `confirmTool`      | `POST /v1/sessions/:id/confirm`   | body `{callId, decision}`，内核带 `confirmedCallIds` 续跑暂停的 turn                              |

> 当前 server 还是旧 `POST /v1/chat`（request/response），Step 3 升级为上述端点。路由**只做 transport 翻译**，逻辑下沉 `InProcessKernelClient.submit()`——这是 `kernel-client-protocol.md` §5.3 的硬约束。

### 1.5 SSE 流式细节

`submit` 是唯一的长连接：`POST /v1/sessions/:id/turns` 返回 `text/event-stream`，daemon 对每个 `EventMsg` 写一行 `data: <json>\n\n`。前端用 `fetch` + `ReadableStream` reader 解析（不用 `EventSource`，因为 `EventSource` 只支持 GET）：

```ts
const res = await fetch(`/v1/sessions/${id}/turns`, { method: 'POST', body: ... });
const reader = res.body.getReader();
// 按 \n\n 分块，解析 data: 行 → JSON.parse → EventMsg
```

SSE 心跳：daemon 每 15s 写一行 `: ping` 注释，防反代切流。

### 1.6 三个关键交互如何穿进程边界

**中断（Interrupt）**
旧 web：`abortRef.abort()` 砍 HTTP 连接 → 正在跑的 shell 被腰斩，非优雅。
新设计：`POST /v1/sessions/:id/interrupt` → 内核 `AbortController.abort()` → `runAgent` 在 turn 边界检查 signal，yield `TurnEnd(reason: 'interrupted')` 优雅停。SSE 流正常关闭，前端收到 `TurnEnd` 后置 idle。

**工具确认（ConfirmTool）**
旧 web：发 `<continue:${id}>` 假 user 消息 → 污染 `session.messages` 落库。
新设计：`POST /v1/sessions/:id/confirm` `{callId, decision}` → 内核 `InProcessKernelClient.confirmTool()` → `ConfirmingToolPort` 的 `deferred.resolve('approve'/'deny')` → 同一条 SSE 流继续推后续事件（`tool_result` + 后续 `token`）。**不重新 runAgent、不发假消息、无 token 重生成。**

**流式输出（ToolProgress）**
`shell.exec` 执行时，`onProgress('stdout'/'stderr', chunk)` → 内核 yield `ToolProgress` → daemon 逐条 `formatSSE` → 前端 reader 实时收到。这是「像终端」的物理基础：后端管线已就绪（`packages/server/src/app.ts` 每事件都 `formatSSE`），问题只在渲染。

### 1.7 类型共享：零 drift

`Op`/`EventMsg`/`ToolCall`/`ToolResult` 定义在 `@liskin/core`，web 并入 workspace 后直接 `import type { ... } from '@liskin/core'`。删 `web/src/services/agentClient.ts` 手抄的 `AgentEvent`（已与 core drift：`done` 缺 `usage`、`tool_result` 多 `ok` 字段、`reason` 枚举不一致）。一处定义，所有消费者共享。

---

## 2. 前端完全重构设计

### 2.1 现状诊断

当前 web 不是 Coding Agent UI，是「ChatGPT 复制粘贴替代品」。三大病灶：

**病灶一：协议错位**——直连旧 `POST /v1/chat`（request/response），不用新 `KernelClient`/`EventMsg`。自己手抄 `AgentEvent`（drift），`interrupt` = 砍 HTTP 连接，`confirmTool` = 假消息。

**病灶二：渲染割裂**——assistant 文本流（顶部蓝框 `streamText`）和工具调用（底部独立侧栏 `toolLog`）分属两个区域，中间隔着消息列表。终端里是一条交织时间线：`token`→`tool_call`→`tool_progress`→`tool_result`→`token`，web 劈成两半。工具确认是全屏 modal 盖住时间线。

**病灶三：状态双轨 + drift**——`useChatStore.ts`（zustand 死代码，`draft` 默认 `'hello'`）与 `useLLMChat.ts`（11 个 useState + 3 个 useRef）并存；`services/` 下 6 个模块重叠；单 session、localStorage 存 id、刷新归空、无历史恢复。

### 2.2 设计原则

- **UI 是内核的纯渲染壳，自己不持业务状态**——会话真相在 server/SQLite，web 是它的视图
- **类型从 `@liskin/core` 直接 import，零 drift**——web 并入 workspace
- **传输抽象成 `KernelClient` 接口**——当前走 SSE，未来切真 SQ/EQ 只换 transport，UI 零改动
- **一条时间线**——token 和 tool_call 按真实发生顺序内联交织，工具执行时实时滚动 stdout/stderr，像终端日志

### 2.3 渲染模型：Turn → Steps

一个 `Turn` = 用户发一句话触发的一整轮。轮内所有事件按到达顺序聚合成 `Step[]`，每个 step 是时间线上的一个块：

```ts
type Step =
  | { kind: 'text'; id: string; parts: string[] } // assistant 流式文本（增量追加）
  | {
      kind: 'tool';
      id: string;
      call: ToolCall; // 工具调用
      status: 'pending' | 'confirm' | 'running' | 'done' | 'error';
      stdout: string[]; // ToolProgress stdout chunks
      stderr: string[]; // ToolProgress stderr chunks
      result?: ToolResult;
    };

interface Turn {
  id: string;
  userContent: string;
  steps: Step[];
  status: 'running' | 'done' | 'interrupted' | 'error';
}
```

`token` 和 `tool_call` 天然交织——模型先吐文字（"我来读 README"）→ `tool_call`(fs.read) → `tool_progress` → `tool_result` → 再吐文字（"总结如下"），在时间线上就是 text→tool→text，和终端完全一致。`tool_use`/`tool_result` 内联进 `steps`，不再是侧栏日志。

事件 → step 的归一化（纯函数 reducer，可单测，在 `web/src/kernel/events.ts`）：

| EventMsg              | 动作                                                       |
| --------------------- | ---------------------------------------------------------- |
| `Token`               | 追加到当前 turn 最后一个 text step（没有就建）             |
| `ToolCall`            | push 一个 tool step，status=pending                        |
| `ToolProgress`        | 对应 tool step 的 stdout/stderr 追加 chunk，status=running |
| `ToolResult`          | 写入 result，status=done/error                             |
| `ToolConfirmRequired` | 该 tool step status=confirm，turn 进 awaiting_confirm      |
| `TurnEnd`             | turn → done/interrupted                                    |

### 2.4 状态层：单一 store + 状态机

删 `useChatStore.ts` + `useLLMChat.ts`，换成一台 zustand store + 明确状态机（对齐 core 回合状态）：

```
idle ──send──▶ streaming ──tool_confirm_required──▶ awaiting_confirm
  ▲                │                                      │
  │ done/error      │ approve/deny
  └────────────────┴──────────────────────────────────────┘
```

Store 形状（只存视图态 + 当前 session）：

```ts
interface UIState {
  sessions: SessionInfo[]; // 左侧列表
  activeSessionId: string | null;
  turns: Turn[]; // 当前 session 的渲染单元
  status: 'idle' | 'streaming' | 'awaiting_confirm' | 'error';
  pendingConfirm: ToolCall | null;
  error: NormalizedError | null;
  draft: string;
}
```

客户端**不**自行 append user message 到本地数组再和 server 对账——会话真相在 kernel/Store，刷新 = `resumeSession` + 重放历史。

### 2.5 渲染层：统一时间线

```
<Timeline>                      // 虚拟化滚动
  <TurnItem>                    // 一轮
    <UserMessage />             // 用户输入
    <StepList>                  // token 和 tool_call 按顺序交织
      <TextStep />              // markdown + 代码高亮，流式增量渲染
      <ToolStep>                // 内联工具卡片
        <ToolHeader />          // 图标 + 工具名 + 状态徽标（spinner/✓/✗/🔒）
        <ToolArgs />            // 语义化：shell 显示命令，fs 显示路径
        <TerminalOutput />      // 实时 stdout/stderr，终端样式，自动吸底
        <ToolResult />          // 成功/失败 + 摘要；patch 类走 diff 视图
      </ToolStep>
      <ConfirmStep />           // 内联审批卡（非全屏 modal）
```

关键交互：

- **TerminalOutput 自动吸底**：工具 running 时输出区滚到最新 chunk，用户上滚则暂停吸底（和终端一致），出现「↓ 新输出」提示
- **流式 markdown**：`react-markdown` + `shiki`，token 边到边渲染，增量解析（只重渲最后一个未闭合代码块），避免每帧全量 reflow
- **工具确认内联**：`confirm` 状态的 ToolStep 直接渲染 `[批准] [拒绝]` 按钮，不弹 modal、不盖时间线
- **状态徽标**：pending(⏳) → running(◉ spinner + 计时) → done(✓ 绿)/error(✗ 红)/confirm(🔒 琥珀)

实时流式策略（像终端的关键，处理不好就卡）：

- **chunk 级追加不重建数组**：reducer 用 `step.stdout.push(chunk)`，避免长输出（如 `pnpm install`）每行 O(n) 复制
- **批量刷新**：SSE 事件密集（几十 ms 一个 chunk），用 `requestAnimationFrame` 合并渲染——事件进 reducer 队列，rAF 回调 flush 一次 state，保 60fps
- **虚拟化**：`@tanstack/react-virtual` 只渲染视口内 step；长 shell 输出单步内部截断（最后 N 行 + 展开全部）
- **stdout/stderr 分流但同区**：像真实终端，stderr 红字混排在 stdout 流里（按 chunk 到达顺序），不分两个框

### 2.6 工具语义化展示

替代无脑 `JSON.stringify`，集中在 `web/src/lib/tool-views.ts`：

| 工具                   | 展示                                                     |
| ---------------------- | -------------------------------------------------------- |
| `shell.exec`           | 头部显示 `$ <command>`，输出区就是终端                   |
| `fs.read` / `fs.write` | 头部显示文件路径（可点击），write 的 result 走 diff 视图 |
| 其他                   | 折叠的 JSON 参数                                         |

新工具加一条映射即可。

### 2.7 清理冗余

- 删 `services/chat`、`services/conversation`、`services/upload`、`services/llmGateway`、`services/http.ts`、`services/agentClient.ts` → 收敛进 `kernel/client.ts` + `kernel/api.ts`（REST: providers/sessions）
- 组件库二选一：保留 `@radix-ui`（headless 可控）+ `cva` + `tailwind-merge`，删 `@heroui`、`classnames`、`clsx`、`framer-motion`（首版不要动画）
- 删死代码 `useChatStore.ts`、`types/llm.ts`、`useConversationHealth.ts`、`LogPanel` 残留

### 2.8 重写后目录结构

```
web/
├── package.json              # 依赖 workspace @liskin/core
├── src/
│   ├── main.tsx
│   ├── App.tsx               # 路由: / (会话列表) / s/:id (聊天)
│   ├── kernel/
│   │   ├── client.ts         # KernelClient 接口（与 core 同形）
│   │   ├── http-sse.ts       # HttpSseKernelClient 实现
│   │   ├── events.ts         # EventMsg → Turn/Step reducer（纯函数，可单测）
│   │   └── api.ts            # REST: providers/sessions
│   ├── store/
│   │   └── session-store.ts  # 单一 zustand store + 状态机
│   ├── pages/
│   │   ├── SessionList.tsx
│   │   └── Chat.tsx
│   ├── components/
│   │   ├── turn/             # TurnItem, TextStep, ToolStep, ConfirmStep
│   │   ├── Composer.tsx      # 输入框 + 发送/中断
│   │   ├── Sidebar.tsx       # 会话列表
│   │   └── ProviderSettings.tsx
│   └── lib/
│       ├── utils.ts
│       └── tool-views.ts     # 工具名→语义化展示映射
```

---

## 3. 落地顺序

三步，每步可独立验证、可停。第 1 步是根因修复，后面两步即使不做，项目也已是「协议正确」状态。

### Step 3.1 — 协议对齐（地基）

- web 并入 `pnpm-workspace.yaml`
- 删 `agentClient.ts` 手抄类型，从 `@liskin/core` import `EventMsg`/`ToolCall`/`ToolResult`
- server 升级：`POST /v1/chat` → `POST /v1/sessions/:id/turns`(SSE) + `POST /v1/sessions/:id/interrupt` + `POST /v1/sessions/:id/confirm` + `POST /v1/sessions`(create) + `GET /v1/sessions`(list)
- 路由只做 transport 翻译，逻辑下沉 `InProcessKernelClient.submit()`
- 这步不动 UI，但堵住 drift 和 hack

### Step 3.2 — 状态机 + 传输抽象

- `HttpSseKernelClient` + `session-store` 替换 `useLLMChat` 散装 state
- 消息模型切 `Turn`/`Step`；tool 调用内联
- reducer（`events.ts`）+ 单测
- UI 仍纯文本渲染，但流程正确（真 interrupt、真确认、刷新可恢复）

### Step 3.3 — 渲染升级 + 多会话

- markdown/代码高亮/diff/终端式输出
- 左侧会话列表 + 历史加载（`resumeSession`）
- `requestAnimationFrame` 批量 flush + `@tanstack/react-virtual` 虚拟化
- 清理冗余依赖（`@heroui`/`framer-motion`/`classnames`/`clsx`）

---

## 4. 解耦校验

重构完成的判据——换 transport 时 UI 零改动：

| 变更                | core     | server         | web                                  |
| ------------------- | -------- | -------------- | ------------------------------------ |
| 加一个 LLM provider | llm 包   | ✗              | ✗                                    |
| 加一个工具          | tools 包 | ✗              | ✗（渲染映射可选）                    |
| 换 HTTP→WebSocket   | ✗        | server         | web（换 `HttpSseKernelClient` 实现） |
| 改终端渲染样式      | ✗        | ✗              | web                                  |
| 协议加一个 Op       | core     | server（翻译） | web（发送）                          |

「内核永远不知道是 Web 在调它」是成立的硬指标：`packages/core` 的依赖里没有 `hono`/`react`/`commander`，只暴露 `KernelClient` 接口。

---

## 5. 一句话总结

> 前端通过 `KernelClient` 接口与内核通信：投递 `Op`、订阅 `EventMsg` 流，经 HTTP/SSE 穿进程边界。
> 前端是内核的纯渲染壳：单一 store + `Turn`/`Step` reducer 把 `EventMsg` 聚合成终端式时间线，零业务状态、零类型 drift。
> 协议是资产，渲染是可替换的皮——重构先对齐协议（地基），再换渲染模型。
