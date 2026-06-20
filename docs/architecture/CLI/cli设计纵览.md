CLI 设计详解

▎ CLI 通过 InProcessKernelClient 把内核包装成服务，用 Op 投递意图、用 EventMsg 消费事实。agent exec 是 headless 消费者（CI 可用），agent serve 是 Web 的 daemon host，agent chat（规划中）是协议的第一个交互式验收用例。三种模式共享同一份协议、同一个 rt = 换实现，内核代码一行不动。

1. 整体定位

CLI 是 Liskin 的 L4 接入层，位于五层架构的最外层。它的核心设计原则是：

▎ CLI 是协议的第一个消费者，不感知内核实现，只依赖 KernelClient 接口 + Op/EventMsg 类型。

当前 CLI 有两个子命令，一个已实现、一个规划中：

```
┌─────────────┬───────────┬──────────────────────────────────────────┐
│    命令     │   状态    │                   用途                   │
├─────────────┼───────────┼──────────────────────────────────────────┤
│ agent serve │ ✅ 已实现 │ 启动 HTTP/SSE daemon，供 Web 前端连接    │
├─────────────┼───────────┼──────────────────────────────────────────┤
│ agent exec  │ ✅ 已实现 │ headless 一次性任务，in-process 直连内核 │
├─────────────┼───────────┼──────────────────────────────────────────┤
│ agent chat  │ ❌ 规划中 │ 交互式 REPL，终端内多轮对话              │
└─────────────┴───────────┴──────────────────────────────────────────┘
```

---

-
-
-
-
- =========================================================================
-
-
-
-
-
-
-

# P2

Thought for 5s, read 6 files

CLI 设计详解

1. 整体定位

CLI 是 Liskin 的 L4 接入层，位于五层架构的最外层。它的核心设计原则是：

▎ CLI 是协议的第一个消费者，不感知内核实现，只依赖 KernelClient 接口 + Op/EventMsg 类型。

当前 CLI 有两个子命令，一个已实现、一个规划中：

```
┌─────────────┬───────────┬──────────────────────────────────────────┐
│    命令     │   状态    │                   用途                   │
├─────────────┼───────────┼──────────────────────────────────────────┤
│ agent serve │ ✅ 已实现 │ 启动 HTTP/SSE daemon，供 Web 前端连接    │
├─────────────┼───────────┼──────────────────────────────────────────┤
│ agent exec  │ ✅ 已实现 │ headless 一次性任务，in-process 直连内核 │
├─────────────┼───────────┼──────────────────────────────────────────┤
│ agent chat  │ ❌ 规划中 │ 交互式 REPL，终端内多轮对话              │
└─────────────┴───────────┴──────────────────────────────────────────┘
```

---

2. 命令详解

2.1 agent serve — daemon 模式

client/src/cli.ts:48-130，启动一个 Hono HTTP 服务器：

用户 → agent serve --port 8787 --cwd /myproject --confirm ask
↓
CLI 组装依赖：- 从 ~/.liskin/config.json 或环境变量读 API key - 创建 ToolRegistry（cwd + 路径白名单 + 确认策略）- 调用 startServer() 启动 daemon
↓
Web 前端通过 POST /v1/chat (SSE) 连接

关键设计点：

- 配置优先级：环境变量 > ~/.liskin/config.json > 命令行参数默认值
- envSeed 机制：如果提供了 API key，会在 SQLite 中植入一条 id='env' 的 Provider 记录（仅首次，后续用户可在 Web UI 修改）
- 优雅关闭：监听 SIGINT/SIGTERM，调用 server.close() 后退出

  2.2 agent exec — headless 模式

client/src/exec.ts，一次性任务执行器，设计目标是 CI 可用的无 UI 消费者：

// 核心流程（exec.ts:34-76）
const kernel = new InProcessKernelClient({ llm, tools, store }); // ① 装配依赖
const session = await kernel.createSession({ cwd, system }); // ② 创建会
const stream = kernel.submit({ type: 'UserTurn', ... }); // ③ 投递 Op
for await (const ev of stream) { // ④ 消费事
render(ev); // Token→stdout, ToolCall→带颜色的终端输出, Error→stderr
}
return { ok: lastReason === 'completed' };

渲染策略（render 函数，exec.ts:79-116）：

```
┌─────────────────────┬─────────────────────────────────────────────────────────────┐
│      事件类型       │                          渲染方式
├─────────────────────┼─────────────────────────────────────────────────────────────┤
│ Token               │ 直接 process.stdout.write(ev.text)，逐字流式打印
├─────────────────────┼─────────────────────────────────────────────────────────────┤
│ ToolCall            │ 青色 ▸ 工具名 + 语义化参数（shell 显示 $ cmd，fs 显示
├─────────────────────┼─────────────────────────────────────────────────────────────┤
│ ToolProgress        │ 实时透传 stdout/stderr chunk
├─────────────────────┼─────────────────────────────────────────────────────────────┤
│ ToolResult          │ 绿色✓（成功）或红色✓（失败）+ 截断内容
├─────────────────────┼─────────────────────────────────────────────────────────────┤
│ ToolConfirmRequired │ stderr 提示 auto-approved（exec 模式 confirmPolicy=au
├─────────────────────┼─────────────────────────────────────────────────────────────┤
│ Error               │ 红色 ✗ + 错误信息到 stderr
└─────────────────────┴─────────────────────────────────────────────────────────────┘
```

关键特点：

- confirmPolicy: 'auto'（硬编码）— headless 场景无需人工确认
- InMemoryStore — 不做持久化，任务结束即丢弃
- 返回 ExecResult { ok, turnEndReason } — 适合脚本判断成功/失败

---

3. 核心机制：InProcessKernelClient

这是 CLI 与内核解耦的关键。packages/core/src/kernel/in-process.ts（432 行）实现了 KernelClient 接口，把 runAgent 的 async generator 包装成「服务」：

CLI (client/src/exec.ts)
│
│ import { InProcessKernelClient } from '@liskin/core'
│ kernel.submit({ type: 'UserTurn', ... })
│
▼
InProcessKernelClient.submit() ← 返回 AsyncIterable<EventMsg>
│
│ ① load session from StorePort
│ ② 追加 user 消息，落库
│ ③ 创建 AsyncQueue + AbortController
│ ④ 异步调用 driveTurn() → runAgent()
│ ⑤ 逐个 yield EventMsg（TurnStart → Token → ToolCall → ... → TurnEnd）
│
▼
driveTurn() → runAgent() ← async generator, yield AgentEvent
│
│ handleEvent() 翻译：
│ AgentEvent.token → EventMsg.Token
│ AgentEvent.tool_call → EventMsg.ToolCall
│ AgentEvent.tool_result → EventMsg.ToolResult + flush assistant 消息落 messages
│ AgentEvent.done → EventMsg.TurnEnd
│
▼
AsyncQueue<EventMsg> → 被 submit() 的 for-await 消费

确认流程（消除假消息 hack）：

当前 Web 的做法（有问题）：
工具需要确认 → 用户点确认 → 发一条 <continue:callId> 假 user 消息 → 污染 me

InProcessKernelClient 的做法（正确）：
工具需要确认 →
① wrapToolsForConfirm() 捕获 ConfirmRequiredError
② flush assistant，push ToolConfirmRequired 事件到 queue
③ 创建 Deferred，await 用户决策（此时事件流暂停但 runAgent 不重跑）
④ confirmTool(approve) → deferred.resolve('approve')
⑤ 把 callId 加入 confirmedCallIds，重新调用 tool.invoke()
⑥ 继续 push 后续事件到 queue

这保证了 确认不产生假消息、不重新生成 token。

---

4. 配置体系

优先级（高→低）：

1. 命令行参数 --port 8787 --confirm ask
2. 环境变量 OPENAI_API_KEY / LISKIN_API_KEY / LISKIN_MODEL
3. 配置文件 ~/.liskin/config.json
4. 硬编码默认值 port=8787, host=127.0.0.1, model=gpt-4o-mini

~/.liskin/config.json 结构（cli.ts:12-22）：
interface Config {
apiKey?: string;
baseURL?: string;
model?: string;
port?: number;
host?: string;
dbPath?: string;
pathWhitelist?: string[];
corsOrigin?: string | string[];
confirmPolicy?: 'auto' | 'ask' | 'deny';
}

---

5. 依赖关系

client/package.json:
"@liskin/core" → KernelClient 接口 + InProcessKernelClient + 类型
"@liskin/llm" → createProvider() 工厂（exec 模式用）
"@liskin/server" → startServer()（serve 模式用）
"@liskin/tools" → ToolRegistry（两个模式都用）
"commander" → CLI 参数解析

CLI 是唯一同时依赖四个 workspace 包的模块——它作为「装配器」把所有组件连起来。

---

6. 尚未完成：agent chat（交互式 REPL）

根据 docs/architecture/kernel-client-protocol.md §6.3 Step 2，这是 Phase 1 的

agent chat 的形态：

```
  ┌──────────────────────────────────────────┐
  │ > 帮我修 src/utils.ts 的类型错误          │  ← readline 输入
  │                                          │
  │ 让我先看一下这个文件…                      │  ← Token 流式打印
  │ ▸ fs.read src/utils.ts                   │  ← ToolCall 青色
  │ ✓ 15 lines                               │  ← ToolResult 绿色
  │ 问题在第 8 行，类型应该是 string…          │  ← 继续流式
  │ ▸ fs.write src/utils.ts                  │
  │ ⚠ confirm? [y/n] █                       │  ← 内联确认（非 modal）
  └──────────────────────────────────────────┘
```

核心特点：

- 用 InProcessKernelClient，不走 daemon、不碰 HTTP——比 agent exec 多一个 readline 输入循环
- Ctrl-C → interrupt() 优雅中断（而非杀进程）
- 工具确认在终端内联（[y/n]），不弹 modal
- 比 Web 少一层 transport，是协议的最简验收用例

---

---

client/src/cli.ts — CLI 入口（187 行）

这是 bin.agent 的入口文件，负责解析命令行参数、装配依赖、分发到子命令。

结构总览

1-5 shebang + imports
6-11 import 内部模块
12-22 Config 接口定义
24-35 loadConfig() —— 读 ~/.liskin/config.json
37-43 defaultDbPath() —— 确保 ~/.liskin/ 目录存在
45-46 new Command('agent')
48-130 agent serve 子命令
132-176 agent exec 子命令
178-180 collect() 辅助函数
183-186 program.parseAsync() 启动

逐段解析

① 配置加载（24-35）

function loadConfig(): Config {
const configPath = join(homedir(), '.liskin', 'config.json');
if (!existsSync(configPath)) return {}; // 不存在不报错，返回空对象
try {
return JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
console.error(...); return {}; // 解析失败只警告，不崩
}
}

设计意图：配置文件永远可选——没有也能跑，格式坏了也只警告。所有关键值都有环境变量或命令行参数的兜底路径。

② agent serve（48-130）

agent serve [--port 8787] [--host 127.0.0.1] [--db <path>]
[--cwd <path>] [--confirm auto|ask|deny] [--cors <origin>]

执行流程：

1.  loadConfig() // 读 ~/.liskin/config.json
2.  解析 apiKey（env > config） // OPENAI_API_KEY > LISKIN_API_KEY > config.apiKey
3.  解析 port/host/db/cwd/confirm // 命令行 > config > 默认值
4.  确保 dbPath 的父目录存在 // mkdirSync recursive
5.  构造 envSeed ProviderConfig // 如果 apiKey 存在，生成 id='env' 的种子配置
6.  new ToolRegistry({ cwd, pathWhitelist, confirmPolicy })
7.  startServer({ port, host, dbPath, tools, envSeed, corsOrigin })
8.  注册 SIGINT/SIGTERM → server.close()

一个值得注意的细节（88-98 行）：

const envSeed: ProviderConfig | undefined = apiKey
? {
id: 'env',
name: 'Env (seeded)',
protocol: 'openai-compatible',
apiKey,
model: model ?? 'gpt-4o-mini',
...(baseURL ? { baseURL } : {}),
}
: undefined;

if (!apiKey) {
console.warn('[liskin] no API key found ... Configure one via Web UI');
}

- 没有 API key 也能启动——server 照样跑，用户通过 Web UI 的 POST /v1/providers 手动配
- id='env' 是固定值，SQLite 里 INSERT OR REPLACE——用户之后在 Web UI 改 env provider 的 model/baseURL，重启不会覆盖

③ agent exec（132-176）

agent exec <prompt> [--cwd <path>] [--model <model>]
[--base-url <url>] [--max-turns 24] [--system <text>]

执行流程：

1.  读 config + 环境变量，拼出 apiKey/baseURL/model/cwd/maxTurns/system
2.  检查 apiKey 是否存在 → 不存在直接 process.exit(1)
3.  调用 runExec(prompt, opts) → ExecResult
4.  result.ok === false → process.exit(1)

对比 serve 的差异：

- serve 没有 API key 也能起来，exec 必须有——因为 exec 要立刻跑任务
- exec 不碰 ToolRegistry/server——它把依赖装配委托给 runExec()
- exec 的 confirmPolicy 硬编码为 auto——headless 无人交互

---

client/src/exec.ts — headless 消费者（141 行）

这是 agent exec 的实际执行体，也是 协议的 headless 验收用例。

结构

1-9 文件头注释（引用设计文档）
10-12 imports
14-23 ExecOptions / ExecResult 接口
25-76 runExec() 主函数
78-116 render() 事件→终端输出
119-140 辅助函数：formatArgs / truncate

核心：runExec()（34-76）

export async function runExec(prompt: string, opts: ExecOptions): Promise<ExecResult> {
// ① 装配三个 Port 实现
const llm = createProvider({ protocol: 'openai-compatible', ... });
const tools = new ToolRegistry({ cwd, pathWhitelist: [cwd], confirmPolicy: 'auto' });
const store = new InMemoryStore(); // 不持久化

// ② 创建 InProcessKernelClient（这就是 CLI 不碰 daemon 的关键）
const kernel = new InProcessKernelClient({ llm, tools, store, maxTurns });

// ③ 创建 session
const session = await kernel.createSession({ cwd, system });

// ④ 投递 UserTurn Op，拿到事件流
const stream = kernel.submit({ type: 'UserTurn', sessionId: session.id, content: prompt });

// ⑤ 消费事件流——每个事件渲染成终端输出
let lastReason = 'unknown';
for await (const ev of stream) {
lastReason = render(ev, lastReason);
}

return { ok: lastReason === 'completed', turnEndReason: lastReason };
}

这里体现了协议设计的核心思想：

▎ CLI 只依赖 KernelClient 接口。runExec() 不知道 runAgent 的存在，不知道 OpenAI 的 SSE 协议，不知道 SQLite——它只知道「投递 Op，消费 EventMsg」。

渲染器：render()（79-116）

这是一个纯函数，把 EventMsg 翻译成终端输出：

┌─────────────────────┬────────────────────────────────┬────────────────────────────────┐
│ 事件 │ 渲染代码 │ 效果 │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ TurnStart │ return prevReason │ 不输出，仅透传状态 │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Token │ process.stdout.write(ev.text) │ 逐字流式打印，无换行 │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ ToolCall │ \n▸ 工具名 $ cmd │ 青色前缀 + 语义化参数（shell │
│ │ │ 显示命令，fs 显示路径） │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ ToolProgress │ process.stdout.write(ev.chunk) │ 透传 shell 的实时输出 │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ ToolResult │ ✓ 截断内容（绿=成功，红=失败） │ 单行，内容截断 500 字符 │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ ToolConfirmRequired │ [confirm required] 工具名 │ 输出到 stderr，标记 auto │
│ │ (auto-approved) │ │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ TurnEnd │ return ev.reason │ 不输出，返回结束原因给调用方 │
├─────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Error │ ✗ 错误信息（红色，stderr） │ 返回 reason='error' │
└─────────────────────┴────────────────────────────────┴────────────────────────────────┘

三个辅助函数（119-140）：

- formatArgs()：语义化工具参数——{ cmd: 'ls' } → $ ls，{ path: 'a.ts' } → a.ts，其他 fallback 到 JSON
- truncate()：工具结果截断到 500 字符，换行转空格——终端里一行一个工具结果
- render() 的返回值：始终返回当前已知的 turn 结束原因，TurnEnd 事件到来时才更新

---

两者的协作关系

用户敲入: agent exec "修 src/utils.ts 的类型错误"

cli.ts (132-176)
│ 解析参数、读 config、检查 apiKey
│ 调用 runExec(prompt, opts)
▼
exec.ts (34-76)
│ new InProcessKernelClient(...) ← 装配 llm/tools/store
│ kernel.createSession(...) ← 创建会话
│ kernel.submit({UserTurn...}) ← 投递 Op
│
▼
InProcessKernelClient (core)
│ load session → 追加 user msg → driveTurn()
│ └─ runAgent() → yield AgentEvent
│ └─ handleEvent() → 翻译成 EventMsg → push 到 AsyncQueue
│
▼
exec.ts for-await 循环
│ render(ev):
│ Token → stdout.write 用户看到逐字输出
│ ToolCall → ▸ fs.read ... 用户看到青色工具标签
│ ToolResult → ✓ 15 lines 用户看到结果
│ TurnEnd → return 'completed'
│
▼
cli.ts 收到 ExecResult
│ ok ? exit(0) : exit(1)

设计上的刻意选择

1. exec.ts 是纯 ESM、零外部依赖——只依赖 @liskin/core 的类型和一个 createProvider 工厂。函数签名干净，方便单测。
2. cli.ts 是唯一引入 commander 的文件——所有 CLI 框架的噪音隔离在入口层，exec.ts 完全是 library-agnostic。
3. InMemoryStore 而非 SqliteStore——agent exec 定位是一次性任务，不留历史。这也证明了 StorePort 接口的价值：换实现不需要改任何业务代码。
4. confirmPolicy: 'auto' 硬编码——headless 不需要交互确认。对比 agent serve 默认 ask，因为 Web 有人可以点确认按钮。
5. render() 返回 lastReason 的模式——因为事件是流式的，TurnEnd 可能在任意时刻到达，不能用局部变量捕获。这个累加器模式比闭包更显式、更好测。
