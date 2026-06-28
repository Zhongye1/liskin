# Kernel Protocol Design — Liskin Coding Agent

> 路径：`docs/architecture/kernel-protocol.md`
> 状态：Draft（与 M2 现状对齐，面向 Phase 1+ 升级）
> 版本：v0.1
> 关联文档：
>
> - `docs/architecture/coding-agent-design.md`（路线图与整体架构）
> - `docs/architecture/kernel-sqeq-protocol.md`（内核 ↔ 客户端 SQ/EQ 协议，外层）

---

## 内核三大边界总览（Cross-Doc Map）

> ⭐ Liskin 内核有且只有三条协议边界。本文覆盖前两条（向内），第三条（向外）见 `kernel-sqeq-protocol.md`。

| 边界              | 文档                      | 接口                                             | 范围                       | 形态                         |
| ----------------- | ------------------------- | ------------------------------------------------ | -------------------------- | ---------------------------- |
| 内核 ↔ 模型适配器 | 本文 §3                   | `LLMProvider.stream(req)`                        | 包内 `packages/llm`        | `AsyncIterable<StreamEvent>` |
| 内核 ↔ 工具来源   | 本文 §4                   | `Tool.execute(input, ctx)` / `ToolSource.list()` | 包内 `packages/tools`      | `Promise<ContentBlock[]>`    |
| 内核 ↔ 客户端 UI  | `kernel-sqeq-protocol.md` | `submit(op)` + `subscribe(events)`               | **跨进程**（多 transport） | SQ/EQ 双队列                 |

性质上的差异：

- 前两条是**包内**接口（同一进程的依赖注入边界），用 TS interface 表达即可
- 第三条是**跨进程**接口，必须可序列化、必须有重连语义、必须支持多订阅 —— 因此选 SQ/EQ 范式

三条边界各管一头：Loop 不感知 Provider；Provider 不感知 Tool 如何被执行；Kernel 不感知客户端是 CLI/Web/IDE。

---

## 0. 文档定位

### 0.1 目的

本文档**钉死内核里三个最核心的边界**：

1. `Loop ↔ Provider`：内核与任意大模型之间的协议边界
2. `Loop ↔ Tool`：内核与任意可调用能力之间的协议边界
3. `Provider ↔ Tool`：模型看到的工具描述与执行端实际工具实现之间的边界

并通过这三个边界，证明「**toolcall / MCP / skills 在内核层就是同一件事**」、「**OpenAI / Anthropic / 后端网关在内核层就是同一件事**」。

### 0.2 读者

- **Agent Core 维护者**：理解为什么 Loop 不能写任何 provider-specific / tool-source-specific 分支
- **Provider 适配器实现者**（OpenAI / Anthropic / Gateway / Mock 等）：理解需要把什么翻译成什么
- **Tool / MCP / Skill 接入者**：理解能力收敛到 `Tool` 抽象的契约

### 0.3 与主架构文档的关系

| 维度     | `coding-agent-design.md`               | 本文档                                     |
| -------- | -------------------------------------- | ------------------------------------------ |
| 关注点   | 路线图、Phase 划分、包边界、状态机骨架 | Loop/Provider/Tool 三个协议的契约细节      |
| 读法     | 自顶向下："我们要做成什么"             | 横切剖面："各模块之间怎么对话"             |
| 内容重叠 | 状态机/Loop 形态在主文档               | 协议形态、错误归一化、命名空间策略在本文档 |

凡是路线图层面的内容（Phase 0/1/2/3、M1~M5 排期），本文只引用，不重写。

### 0.4 版本与状态

- v0.1（当前）：与 M2 已落地代码对齐，面向 Phase 1 升级
- 一旦 Phase 1 落地，本文 §2/§3 的「目标」部分会成为「现状」，§9 的迁移路径会被裁掉

---

## 1. 设计哲学

### 1.1 一句话

> **对内规范，对外翻译。**
>
> 内核只跟「规范化的 Message / StreamEvent / Tool」打交道，把任何一家 provider 或任何一种工具来源的恶心差异，全部塞进各自的适配层。

### 1.2 三个不变量

整套协议要保证以下三件事在任何时刻都成立：

1. **Loop 不知道用哪家模型**
   - Loop 里不存在 `if (provider === 'openai')`、不存在 `if (model.startsWith('claude'))`
2. **Loop 不知道工具来自哪里**
   - Loop 里不存在 `if (tool.source === 'mcp')`、不存在 `if (tool instanceof SkillTool)`
3. **Provider 与 Tool 互不感知对方实现**
   - Provider 拿到的工具是 `ToolSchema`（无 `execute`），ToolSource 拿到的输入是规范 `unknown`，不感知模型 vendor

任何一个 PR 引入了违反这三条的代码，应当在 review 阶段就被拒绝。

### 1.3 反例（明确不做的事）

- ❌ 直接用 OpenAI 的 `ChatCompletionMessageParam` 当内核 Message 类型
- ❌ 在 Loop 里直接 `import OpenAI from 'openai'`
- ❌ 给 `LLMProvider` 接口加 `temperature_scale_for_anthropic` 这种字段
- ❌ 在 Tool 里读 `process.env.OPENAI_API_KEY`
- ❌ Provider 直接执行 Tool（必须由 Loop 编排）

---

## 2. Canonical Message Protocol（规范消息协议）

### 2.1 ContentBlock union（目标形态）

```ts
// packages/core/src/protocol/v2/messages.ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: ContentBlock[]; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'image'; source: ImageSource };

export type ImageSource =
  { kind: 'base64'; mediaType: string; data: string } | { kind: 'url'; url: string };
```

`ContentBlock` 是一个**封闭的 discriminated union**。新增能力 = 新增 variant，**绝不**改已有 variant 的字段含义。

### 2.2 Message

```ts
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
}
```

注意 `role` 只有三种，不存在 `'tool'`。**工具结果以 `tool_result` block 嵌入 user 消息**（详见 2.3）。

### 2.3 设计要点

#### (a) 为什么 content 是 `ContentBlock[]` 而不是 `string`

- Anthropic 原生就是多 block 模型；OpenAI 的单 string 在投影时只是 `[{type:'text', text:...}]`
- 单 string 对未来不友好：reasoning / multimodal / interleaved tool_use 都需要分段表达
- 反过来从 block[] 投影到单 string 是 trivial 的（filter + join），但反向没法无损还原

#### (b) 为什么 `tool_result` 嵌入 user 消息（而不是单独的 `role: 'tool'`）

- 语义对：tool_result 本质是「环境/用户向模型反馈了一段执行结果」
- 与 Anthropic 一致，OpenAI 适配器再做一次 fan-out 投影即可（一个 user 消息 → 多个 `role: 'tool'` 消息）
- 避免 OpenAI 那种"tool 结果是平级的 message"造成的多轮上下文穿插混乱

#### (c) 为什么 `thinking` 是单独 block

- reasoning 模型（o1 / Claude extended thinking 等）有独立的 reasoning content，不属于 user-visible 文本
- 单独 block 让 UI 可以选择「折叠/隐藏/单独 tab 展示」
- 避免在 text 里塞 `<thinking>...</thinking>` 这种 stringly-typed 的脏标记

#### (d) 为什么 tool_result 的 content 仍是 `ContentBlock[]`

- 工具可能返回结构化结果（截图 + 文本 + 多段输出），用 string 会损失信息
- 嵌套不会真的递归——`tool_result` 内的 block 不会再出现 `tool_use` / `tool_result`，是约定层面的限制（不在类型上强制，避免 union 复杂度爆炸）

### 2.4 现状 vs 目标

#### 现状（M1/M2 已固化，6 + 15 测试覆盖）

```ts
// packages/core/src/types/messages.ts（不要改）
export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
```

这是「**简化版 canonical protocol**」：content 是 string、tool_result 用独立 role、没有 thinking/image。

#### 迁移路径

- M3/M4 期间不动 `Msg`，让它继续承载状态机骨架
- Phase 1 接入 Anthropic 时，新增 `protocol/v2` 目录，引入 `Message` + `ContentBlock`
- 旧 `Msg` 与新 `Message` 之间提供双向适配函数（参考 §9.3）
- 新写的 Provider 直接面向 v2，老的 OpenAIProvider 在 Phase 1 中切到 v2

---

## 3. Provider 抽象（LLMProvider 接口）

### 3.1 完整接口（目标形态）

```ts
// packages/core/src/protocol/v2/provider.ts
export interface LLMProvider {
  /** 用作日志/路由判断（如 'openai' / 'anthropic' / 'gateway'）；不影响 Loop 行为 */
  readonly name: string;

  /** 规范流：输入规范消息+规范工具，输出规范事件 */
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;

  /** 可选：用于上下文窗口管理。未实现时 Loop 退化为按字节估算 */
  countTokens?(messages: Message[]): Promise<number>;
}

export interface ChatRequest {
  messages: Message[];
  tools: ToolSchema[];
  model: string;
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** 透传扩展位：Loop 不读、Provider 自己识别（例：anthropic cache control 标记） */
  extra?: Record<string, unknown>;
}
```

### 3.2 StreamEvent union（规范流事件）

```ts
export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; argsDelta: string }
  | { type: 'tool_use_stop'; id: string }
  | { type: 'message_stop'; stopReason: StopReason; usage?: Usage }
  | { type: 'error'; error: NormalizedError };

export type StopReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'content_filter';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}
```

#### 为什么这九种类型？

- `message_start` / `message_stop` 框定一次完整生成
- `text_delta` / `thinking_delta` 区分两种文本流（reasoning 模型需要）
- `tool_use_start/delta/stop` 三段式：完美匹配 Anthropic `input_json_delta`，也能干净包装 OpenAI 的「同一个 toolcall 被分多段拼起来」
- `error` 作为流内事件，而不是 throw —— 这样 Loop 可以「收到 error 后做完收尾再 throw」

#### tool_use 增量的 invariant

- 一个 `tool_use_start{id}` 之后，所有 `tool_use_delta` 隐含归属于该 id（Anthropic 风格）
- Provider 必须保证两次 `tool_use_start` 之间的 `tool_use_delta` 不交叉
- 直到 `tool_use_stop{id}` 触发，Loop 才把累积的 `argsDelta` 串拼接、JSON.parse 后挂到该 tool_use 上

### 3.3 接口窄度纪律

- 接口只暴露 Loop 真正需要的字段
- **禁止**给接口加 provider-specific 字段（如 `anthropicSystemMessages`、`openaiResponseFormat`）
- 这类需求一律走 `extra` 透传 —— Loop 不解释 `extra`，Provider 自己识别
- `name` 仅用于 telemetry / 日志 / 路由 provider 包装层判断（如 RetryProvider 跳过对 `'mock'` 的重试），**不允许** Loop 根据 `name` 改行为

### 3.4 Provider 实现职责

每个 Provider 的 `stream()` 干且只干三件事：

1. **请求翻译**：`Message[]` + `ToolSchema[]` → 自家 HTTP body
2. **流解析**：消费自家 SSE / chunked response
3. **流翻译**：把自家 chunk 翻成 `StreamEvent`

错误层面：**所有抛错最终归一化为 `NormalizedError`**（详见 §5），通过 `{type: 'error'}` 事件吐出，而不是 throw。

### 3.5 现状 vs 目标

#### 现状（M2 已落地）

```ts
// packages/core/src/types/events.ts（M1 现状）
export type LLMEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { kind: 'error'; error: { message: string; code?: string } };

// packages/core/src/ports/llm-port.ts（M1 现状）
export interface LLMPort {
  chatStream(req: ChatRequest): AsyncIterable<LLMEvent>;
}
```

`LLMEvent` 是**简化版 StreamEvent**：把 `tool_use_start/delta/stop` 折叠成一个完整的 `tool_call`（OpenAI Provider 内部已经累积好了）。能跑 happy path、过测试、阻塞少。

#### 升级是叠加而非替换

- Phase 1 新增 `LLMProviderV2 + StreamEvent`，**不删** `LLMPort + LLMEvent`
- 同一个 OpenAIProvider 实例同时实现两个接口（参考 §9.3 桥接 wrapper）
- 内核状态机改造完成后再废弃 v1

---

## 4. Tool / ToolSource / ToolRegistry 三件套

### 4.1 Tool 接口

```ts
// packages/core/src/protocol/v2/tool.ts
export interface Tool {
  /** 在 ToolRegistry 里的最终全名（已经带命名空间前缀，例：'local__fs.read'） */
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ContentBlock[]>;
}

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;
  /** 危险操作前置确认（写文件 / 执行 shell 等）；返回 false 视为用户拒绝 */
  confirm?: (call: { name: string; input: unknown }) => Promise<boolean>;
  /** 留给 sandbox / log / userId / sessionId 等的注入点 */
  env?: Record<string, unknown>;
}

/** 投影后供 Provider 使用的 schema 视图 —— 不带 execute */
export type ToolSchema = Omit<Tool, 'execute'>;

export type JSONSchema = Record<string, unknown>;
```

#### 关键决策：`execute` 返回 `ContentBlock[]` 而不是 `string`

理由：

- 工具天然可能返回结构化（截图 + 文本、多文件输出、错误段 + 标准输出段）
- 反向投影到 string 容易；正向「string → 多段 block」会损失语义
- `tool_result.content` 类型本来就是 `ContentBlock[]`（§2.1），保持同构最省事

### 4.2 ToolSource

```ts
export interface ToolSource {
  /** 命名空间前缀（'local' / 'mcp_github' / 'skill_commit'）。在 ToolRegistry 内全局唯一 */
  readonly id: string;
  list(): Promise<Tool[]>;
}
```

三种实现（细节由具体模块实现，本文只钉契约）：

```ts
// 内置 fs.read / fs.write / shell.exec / search.grep / git.* 等
export class LocalToolSource implements ToolSource {
  readonly id = 'local';
  async list(): Promise<Tool[]> {
    /* 直接列出已注册的本地 Tool */
  }
}

// 连一或多个 MCP Server，list 出 server 暴露的 tools
export class McpToolSource implements ToolSource {
  readonly id: string; // 例：'mcp_github'
  async list(): Promise<Tool[]> {
    // 1. JSON-RPC 调用 server.list_tools
    // 2. 把每个 mcp tool 包成本地 Tool（execute 内做 JSON-RPC call）
    // 3. 把响应转成 ContentBlock[]
  }
}

// 把 .liskin/skills/<skill>/manifest.json 暴露成 Tool
export class SkillToolSource implements ToolSource {
  readonly id: string; // 例：'skill_commit'
  async list(): Promise<Tool[]> {
    /* 读 manifest，每个 skill 一个 Tool */
  }
}
```

#### 为什么 `list()` 是 async

- MCP server 是远程的，列工具需要 JSON-RPC 一次
- Skill 可能要扫文件系统、解析 manifest、做 schema 验证
- 即使 LocalToolSource 是同步可得的，统一签名换来「ToolRegistry 不必区分 source 类型」

### 4.3 ToolRegistry

```ts
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  async register(source: ToolSource): Promise<void> {
    const list = await source.list();
    for (const t of list) {
      const fullName = `${source.id}__${t.name}`;
      if (this.tools.has(fullName)) {
        throw new Error(`tool name collision: ${fullName}`);
      }
      this.tools.set(fullName, { ...t, name: fullName });
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 投影：丢掉 execute，给 Provider */
  toSchemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ execute, ...rest }) => rest);
  }

  /** 用于 UI 展示 / 权限管理 / 调试 */
  list(): Tool[] {
    return [...this.tools.values()];
  }
}
```

冲突在 `register` 时**硬失败**而不是静默覆盖，避免 MCP server 升级时悄悄替换本地工具的语义。

### 4.4 命名空间策略

- 前缀方案：`<source.id>__<tool.name>`，**双下划线**分隔
- 双下划线参考 MCP 习惯，避免与工具名内的 `.` `_` `-` 冲突
- 举例：
  - `local__fs.read`
  - `local__shell.exec`
  - `mcp_github__create_issue`
  - `skill_commit__run`
- 模型看到的就是带前缀的全名，**不做 alias / 短名**（避免歧义）

### 4.5 收敛逻辑（关键论点）

| 视角       | toolcall（本地函数）                     | MCP（远程 server）                  | Skill（脚本/manifest）                   |
| ---------- | ---------------------------------------- | ----------------------------------- | ---------------------------------------- |
| 模型视角   | 收到一个 `tool_use` block，名字 + input  | **完全相同**                        | **完全相同**                             |
| Loop 视角  | `registry.get(name).execute(input, ctx)` | **完全相同**                        | **完全相同**                             |
| 不同点位置 | `LocalToolSource.execute` 直接调函数     | `McpToolSource.execute` 走 JSON-RPC | `SkillToolSource.execute` 加载并运行脚本 |

**结论**：三种来源的差异被压缩到 `ToolSource` 实现内部，对 Loop 和 Provider 完全透明。这是「Tool 是唯一抽象」这个论点的实质。

---

## 5. 错误归一化协议

### 5.1 ErrorCode 完整枚举

```ts
// packages/core/src/protocol/v2/errors.ts
export type ErrorCode =
  // 控制流
  | 'aborted' // 用户/AbortSignal 取消（Loop 应静默处理，不向 UI 弹错）
  // 网络/重试类
  | 'timeout'
  | 'connection'
  // HTTP 状态映射
  | '401'
  | '403'
  | '404'
  | '422'
  | '429'
  | '500'
  | '502'
  | '503'
  | '504'
  // 模型行为类
  | 'length' // 输出被 max_tokens 截断
  | 'content_filter' // 被内容过滤拦截
  | 'incomplete_stream' // 流自然结束但 tool_use 不完整
  | 'invalid_tool_args' // 模型生成的 args 不是合法 JSON
  // 兜底
  | 'unknown';
```

### 5.2 RETRIABLE_LLM_ERROR_CODES

```ts
export const RETRIABLE_LLM_ERROR_CODES = [
  'timeout',
  'connection',
  '429',
  '500',
  '502',
  '503',
  '504',
  'incomplete_stream',
] as const;

export type RetriableErrorCode = (typeof RETRIABLE_LLM_ERROR_CODES)[number];

export function isRetriable(code: ErrorCode): boolean {
  return (RETRIABLE_LLM_ERROR_CODES as readonly string[]).includes(code);
}
```

`RetryProvider`（§6.3）直接消费这个常量决定是否重试，避免重试逻辑散落各处。

### 5.3 NormalizedError 三字段

```ts
export interface NormalizedError {
  message: string; // 必须包含服务端真实信息（透传 OpenAI/Anthropic 的 error.message）
  code: ErrorCode;
  retriable: boolean; // 由 code 派生（避免上层重复判断）
}
```

#### 为什么 retriable 是字段而不是函数

- 让消费侧零成本判断（`if (e.retriable)`）
- Provider 在归一化时一次性算好，不必跨层重复执行映射
- 同时仍保留 `isRetriable(code)` 工具函数给非 NormalizedError 场景

### 5.4 length / content_filter 的处理（用户已敲定）

- **决策 A**：length 和 content_filter 一律 yield `{type:'error', error: {code:'length'|'content_filter', retriable: false}}`
- 不当作正常 `message_stop` 处理，避免 Loop 拿到不完整 tool_use 还硬着头皮 dispatch
- UI 层根据 code 决定提示文案

### 5.5 Provider 实现错误归一化的责任

每家适配器必须实现自己的 `errors.ts`，至少覆盖：

| 来源                                 | 映射到                       |
| ------------------------------------ | ---------------------------- |
| `AbortError` / `APIUserAbortError`   | `aborted`                    |
| 网络层 `ETIMEDOUT` / `fetch` timeout | `timeout`                    |
| 网络层 `ECONNRESET` / `ENOTFOUND`    | `connection`                 |
| HTTP 401 / 403 / 404 / 422 / 429     | 同号 code                    |
| HTTP 5xx                             | 同号 code（500/502/503/504） |
| OpenAI `finish_reason='length'`      | `length`                     |
| Anthropic `stop_reason='max_tokens'` | `length`                     |
| 流断了但累积 args 非法 JSON          | `invalid_tool_args`          |
| 流断了但 tool_use 半截               | `incomplete_stream`          |
| 其余                                 | `unknown`                    |

`message` 字段必须保留服务端原始错误信息（包括 request id），供 telemetry 与排查使用。

---

## 6. 依赖注入：ProviderRegistry

### 6.1 接口

```ts
// packages/core/src/protocol/v2/registry.ts
export interface ProviderConfig {
  type: string; // 'openai' | 'anthropic' | 'gateway' | 'mock' | ...
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, unknown>; // provider 私有配置
}

export class ProviderRegistry {
  private factories = new Map<string, (cfg: ProviderConfig) => LLMProvider>();

  register(name: string, factory: (cfg: ProviderConfig) => LLMProvider): void {
    if (this.factories.has(name)) {
      throw new Error(`provider already registered: ${name}`);
    }
    this.factories.set(name, factory);
  }

  resolve(cfg: ProviderConfig): LLMProvider {
    const f = this.factories.get(cfg.type);
    if (!f) throw new Error(`unknown provider type: ${cfg.type}`);
    return f(cfg);
  }
}
```

### 6.2 组装阶段（client / server 包内）

```ts
// 例如 packages/client/src/bootstrap.ts
const registry = new ProviderRegistry();
registry.register('openai', (cfg) => new OpenAIProvider(cfg));
registry.register('anthropic', (cfg) => new AnthropicProvider(cfg)); // Phase 1
registry.register('gateway', (cfg) => new GatewayProvider(cfg)); // Phase 2
registry.register('mock', (cfg) => new MockProvider(cfg)); // 测试

const baseProvider = registry.resolve(userConfig);
const provider = new RetryProvider(new LoggingProvider(baseProvider));

const loop = new AgentLoop({ provider, tools: toolRegistry });
```

注入发生在**组装根（composition root）**，而非 Loop 内部 —— Loop 永远是被动接收 `LLMProvider` 接口的消费者。

### 6.3 三个直接收益

#### (a) 测试

```ts
const mock = new MockProvider({
  type: 'mock',
  scripts: [
    { event: 'text_delta', text: 'hello' },
    { event: 'tool_use_start', id: '1', name: 'local__fs.read' },
    { event: 'tool_use_delta', argsDelta: '{"path":"/tmp/a"}' },
    { event: 'tool_use_stop', id: '1' },
    { event: 'message_stop', stopReason: 'tool_use' },
  ],
});
const loop = new AgentLoop({ provider: mock, tools: registry });
// Loop 编排逻辑可以做完全确定性测试
```

#### (b) 后端无缝切换

```ts
// 本地直连
{ type: 'openai', apiKey: '...', model: 'gpt-4o' }
// 切到自建网关，仅改 type 和 baseUrl
{ type: 'gateway', baseUrl: 'https://gw.internal/v1', model: 'gpt-4o' }
```

Loop / Tool / UI 全部零感知。

#### (c) 包装 provider 即 provider

```ts
class RetryProvider implements LLMProvider {
  readonly name: string;
  constructor(private inner: LLMProvider) {
    this.name = inner.name;
  }
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    let attempt = 0;
    while (true) {
      try {
        for await (const ev of this.inner.stream(req)) {
          if (ev.type === 'error' && ev.error.retriable && attempt < MAX) {
            attempt++;
            break; // 退避 + 重试
          }
          yield ev;
        }
        return;
      } catch (e) {
        /* 兜底归一化 */
      }
    }
  }
}
```

`FallbackProvider`（一家挂了切下一家）/ `LoggingProvider` / `RecordReplayProvider` 同理。**重试、降级、灰度都是装饰器**，不是 Loop 的事。

### 6.4 不做的事

- ❌ 不上 InversifyJS / tsyringe / awilix 等重型 DI 容器（工厂 + 显式组装就够）
- ❌ 不做"自动选 provider"（用户必须显式选择，避免不可预期行为）
- ❌ ProviderRegistry **不持有 Provider 实例**（只持有工厂，避免共享 state、避免生命周期管理）

---

## 7. 闭环：完整数据流

### 7.1 一次完整对话回合的事件流

```
用户输入
   │
   ▼
Loop 准备:
   - messages: Message[]
   - tools:    toolRegistry.toSchemas()
   │
   ▼
provider.stream(req) ─────────────────────────────────┐
   │                                                  │
   │ for await (const ev of stream):                  │ Provider 内部:
   │   message_start                                  │   1. 请求体翻译
   │   text_delta       → UI 实时渲染                 │   2. SSE 解析
   │   thinking_delta   → UI 折叠区                   │   3. 流事件归一化
   │   tool_use_start   → 新建 pending block          │
   │   tool_use_delta   → 累积 argsDelta              │
   │   tool_use_stop    → 对该 id 做 JSON.parse       │
   │   message_stop{stopReason, usage}                │
   │   error            → 归一化处理                  │
   │                                                  │
   ▼                                                  │
Loop 攒出完整的 ContentBlock[]（assistant 消息）     │
   │                                                  │
   ▼                                                  │
对 stopReason 决策：                                  │
   - end_turn          → 回合结束，等用户            │
   - tool_use          → 进入工具执行环节            │
   - max_tokens        → yield error('length')       │
   - content_filter    → yield error('content_filter')│
   │                                                  │
   ▼                                                  │
对每个 tool_use block：                               │
   tool   = registry.get(block.name)                  │
   result = await tool.execute(block.input, ctx)      │ ─→ ToolSource.execute
                                                      │     可能是本地/MCP/Skill
   │                                                  │
   ▼                                                  │
构造下一轮 user 消息：                                │
   { role: 'user', content: [                         │
       { type: 'tool_result', toolUseId, content: result },
       ... // 多个 tool_use 的结果合并到同一条 user 消息
   ]}                                                 │
   │                                                  │
   ▼                                                  │
回到 provider.stream(req)... 直到 stopReason='end_turn' 或 error 终止
```

### 7.2 Loop 主循环伪码

```ts
async function* runTurn(input: Message, ctx: LoopContext): AsyncGenerator<AgentEvent> {
  let messages = [...ctx.history, input];

  while (true) {
    const assistantBlocks: ContentBlock[] = [];
    const pendingTools = new Map<string, { name: string; argsBuf: string }>();
    let stopReason: StopReason | undefined;

    for await (const ev of provider.stream({ messages, tools: registry.toSchemas(), ... })) {
      switch (ev.type) {
        case 'text_delta':
          assistantBlocks.push({ type: 'text', text: ev.text });  // 简化：实际要合并
          yield { kind: 'text', text: ev.text };
          break;
        case 'thinking_delta':
          assistantBlocks.push({ type: 'thinking', text: ev.text });
          yield { kind: 'thinking', text: ev.text };
          break;
        case 'tool_use_start':
          pendingTools.set(ev.id, { name: ev.name, argsBuf: '' });
          break;
        case 'tool_use_delta':
          // ev 隐含归属于「最近一次 tool_use_start」的 id
          break;
        case 'tool_use_stop': {
          const pt = pendingTools.get(ev.id)!;
          const input = JSON.parse(pt.argsBuf);
          assistantBlocks.push({ type: 'tool_use', id: ev.id, name: pt.name, input });
          break;
        }
        case 'message_stop':
          stopReason = ev.stopReason;
          break;
        case 'error':
          yield { kind: 'error', error: ev.error };
          if (!ev.error.retriable) return;
          break;
      }
    }

    messages.push({ role: 'assistant', content: assistantBlocks });

    if (stopReason !== 'tool_use') return;  // end_turn / length / content_filter 结束

    const toolUses = assistantBlocks.filter(b => b.type === 'tool_use');
    const resultBlocks: ContentBlock[] = [];
    for (const tu of toolUses) {
      const tool = registry.get(tu.name);
      if (!tool) {
        resultBlocks.push({ type: 'tool_result', toolUseId: tu.id,
          content: [{type:'text', text:`unknown tool: ${tu.name}`}], isError: true });
        continue;
      }
      const blocks = await tool.execute(tu.input, ctx.toolCtx);
      resultBlocks.push({ type: 'tool_result', toolUseId: tu.id, content: blocks });
    }
    messages.push({ role: 'user', content: resultBlocks });
    // 进入下一轮 provider.stream(...)
  }
}
```

状态机：`idle → streaming → awaiting_tools → 回灌 → streaming ...`，本质是简单的回合制 while 循环 —— **不是** LangGraph 那种 DAG。

---

## 8. 未来扩展场景验证

逐项验证「在哪些扩展场景下，Loop 完全不需要改」：

| 扩展场景                   | 改动范围                                       | Loop 是否改        |
| -------------------------- | ---------------------------------------------- | ------------------ |
| 加 Anthropic               | 新增 `AnthropicProvider` + 注册                | ❌                 |
| 加 Qwen / DeepSeek         | 新增对应 Provider                              | ❌                 |
| 接 MCP server              | 注册 `McpToolSource`                           | ❌                 |
| 接 skill 系统              | 注册 `SkillToolSource`                         | ❌                 |
| 加 reasoning 模型支持      | `ContentBlock` 已含 `'thinking'`，UI 处理即可  | ❌                 |
| 加多模态 image **输入**    | `ContentBlock` 已含 `'image'`，Provider 翻译   | ❌                 |
| 加多模态 image **输出**    | 工具/Provider 返回 image block 即可            | ❌                 |
| 加 prompt caching          | Provider 内部用 `extra` 字段透传               | ❌                 |
| 加重试 / 降级 / 灰度       | 新增 `RetryProvider` / `FallbackProvider` 包装 | ❌                 |
| 接后端网关                 | 新增 `GatewayProvider`（实质是 HTTP client）   | ❌                 |
| 录制/回放调试              | 新增 `RecordReplayProvider` 装饰器             | ❌                 |
| 把另一个 Agent 当工具      | 把 sub-Agent 包成 `ToolSource`                 | ❌                 |
| 增加 audio block           | 新增 `ContentBlock` variant                    | ❌（但 UI 要适配） |
| 工具二次确认（写盘/shell） | 走 `ToolContext.confirm`                       | ❌                 |

每一条都意味着「这套设计今天的克制为未来某个真实需求买了单」。

---

## 9. 落地路线（不破坏现状）

### 9.1 当前状态（M2 完成时）

- `LLMPort` + `LLMEvent` + `Msg` + `ToolDefinition` 已固化（M1 6 测试 + M2 OpenAI 15 测试）
- `OpenAIProvider` 已实现：
  - `packages/llm/src/openai/provider.ts`
  - `packages/llm/src/openai/translate.ts`
  - `packages/llm/src/openai/stream.ts`
  - `packages/llm/src/openai/errors.ts`
- 这套是**简化版 canonical protocol**，能跑 happy path

### 9.2 阶段升级（与主架构文档 Phase 划分对齐，仅引用）

- **Phase 0 MVP（M3/M4）**：**保持现状，不做协议升级**。先把 Tool + Sandbox + Server 跑通（M3 局部工具 + M4 本地后端）
- **Phase 1**：升级到 `ContentBlock + LLMProviderV2 + StreamEvent`，配合接入 Anthropic
- **Phase 2**：引入 `ToolSource` 层（local + mcp），`ToolRegistry` 投影
- **Phase 3**：`SkillToolSource` + `GatewayProvider` + Provider 包装（Retry/Fallback/Logging）

### 9.3 兼容策略

#### (a) 双接口并存

```ts
// packages/core/src 同时导出
export { LLMPort } from './ports/llm-port'; // v1（M1 现状）
export { LLMProvider, ChatRequest, StreamEvent } from './protocol/v2/provider'; // v2（Phase 1）
```

#### (b) Provider 双实现

```ts
class OpenAIProvider implements LLMProvider, LLMPort {
  // v2 主接口
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> { ... }
  // v1 桥接：在内部聚合 v2 事件
  async *chatStream(req: V1ChatRequest): AsyncIterable<LLMEvent> {
    for await (const ev of this.stream(toV2Req(req))) {
      yield* v2EventToV1Events(ev);  // 复用 v2 实现，避免双份维护
    }
  }
}
```

或反过来：v1 是主实现、v2 是桥接 wrapper —— 取决于 Phase 1 启动时哪边代码量更小。

#### (c) Message 双向适配

```ts
function v1MsgToMessage(m: Msg): Message { ... }
function messageToV1Msg(m: Message): Msg[] { /* 一对多：tool_result block 拆出 role:'tool' */ }
```

#### (d) 节奏

- 内部分阶段迁移，对外（client / web）零感知
- v1 接口在 Phase 2 末废弃，给上层留至少一个 minor 版本号缓冲

---

## 10. 决策记录与不做的事

### 10.1 关键决策

| 决策                                      | 理由                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 不直接用 OpenAI messages 格式             | OpenAI 的 string content + 平级 role:'tool' 模型未来不友好；ContentBlock 既能投影到 OpenAI 也能投影到 Anthropic |
| 不在 Loop 里加重试                        | 重试是策略不是协议；包装 Provider（`RetryProvider`）是单一职责的正确归宿                                        |
| `ToolSource.list` 是 async                | 兼容 MCP / Skill 的远程加载/磁盘扫描；少数同步场景的代价可忽略                                                  |
| 命名空间用双下划线 `__`                   | 参考 MCP 习惯；避免与工具名内的 `.` `_` `-` 冲突；可被 `split('__', 2)` 干净反解析                              |
| 不做"自动 Provider 路由"                  | 显式优于隐式；用户对账单/性能/隐私敏感，必须知道在调谁                                                          |
| length / content_filter → error           | 这两个状态下 tool_use 通常不完整，当作错误处理避免 Loop 误 dispatch（详见用户已敲定决策 A）                     |
| `retriable` 作为 `NormalizedError` 字段   | 避免每个消费侧重复 `isRetriable(code)`；Provider 归一化时一次性算好                                             |
| `tool_use` 三段式事件（start/delta/stop） | 干净匹配 Anthropic `input_json_delta`；OpenAI 累积逻辑也可被装入这个三段式而不损失信息                          |
| `extra` 字段透传                          | 避免 provider-specific 字段污染主接口；又能容纳 cache_control 等长尾需求                                        |

### 10.2 明确不做

- ❌ **LangChain / LangGraph 风格的 DAG**：Loop 是简单的回合制 while 循环，不需要图调度
- ❌ **prompt 模板系统**：用户传的 `messages` 就是真相，模板是上层应用的事
- ❌ **"通用 Agent 平台"**：本项目场景是 Coding Agent，不在通用性上过度设计
- ❌ **`Tool` 类继承体系**（BaseTool、AsyncTool、StreamingTool …）：`Tool` 就一个 interface，差异落在 `execute` 实现里
- ❌ **Provider plugin 的运行时热加载**：组装根静态注册足够，避免动态加载带来的安全/调试代价

---

## 11. 附录：核心类型完整 TS 定义

> 未来 Phase 1 实施时，以下内容可直接拷入 `packages/core/src/protocol/v2/`，按文件拆分。

```ts
// =====================================================================
// packages/core/src/protocol/v2/messages.ts
// =====================================================================

export type ImageSource =
  { kind: 'base64'; mediaType: string; data: string } | { kind: 'url'; url: string };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: ContentBlock[]; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'image'; source: ImageSource };

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
}

// =====================================================================
// packages/core/src/protocol/v2/errors.ts
// =====================================================================

export type ErrorCode =
  | 'aborted'
  | 'timeout'
  | 'connection'
  | '401'
  | '403'
  | '404'
  | '422'
  | '429'
  | '500'
  | '502'
  | '503'
  | '504'
  | 'length'
  | 'content_filter'
  | 'incomplete_stream'
  | 'invalid_tool_args'
  | 'unknown';

export const RETRIABLE_LLM_ERROR_CODES = [
  'timeout',
  'connection',
  '429',
  '500',
  '502',
  '503',
  '504',
  'incomplete_stream',
] as const;

export type RetriableErrorCode = (typeof RETRIABLE_LLM_ERROR_CODES)[number];

export function isRetriable(code: ErrorCode): boolean {
  return (RETRIABLE_LLM_ERROR_CODES as readonly string[]).includes(code);
}

export interface NormalizedError {
  message: string;
  code: ErrorCode;
  retriable: boolean;
}

// =====================================================================
// packages/core/src/protocol/v2/events.ts
// =====================================================================

export type StopReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'content_filter';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; argsDelta: string }
  | { type: 'tool_use_stop'; id: string }
  | { type: 'message_stop'; stopReason: StopReason; usage?: Usage }
  | { type: 'error'; error: NormalizedError };

// =====================================================================
// packages/core/src/protocol/v2/provider.ts
// =====================================================================

export interface ChatRequest {
  messages: Message[];
  tools: ToolSchema[];
  model: string;
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  extra?: Record<string, unknown>;
}

export interface LLMProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  countTokens?(messages: Message[]): Promise<number>;
}

// =====================================================================
// packages/core/src/protocol/v2/tool.ts
// =====================================================================

export type JSONSchema = Record<string, unknown>;

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;
  confirm?: (call: { name: string; input: unknown }) => Promise<boolean>;
  env?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ContentBlock[]>;
}

export type ToolSchema = Omit<Tool, 'execute'>;

export interface ToolSource {
  readonly id: string;
  list(): Promise<Tool[]>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  async register(source: ToolSource): Promise<void> {
    const list = await source.list();
    for (const t of list) {
      const fullName = `${source.id}__${t.name}`;
      if (this.tools.has(fullName)) {
        throw new Error(`tool name collision: ${fullName}`);
      }
      this.tools.set(fullName, { ...t, name: fullName });
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  toSchemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ execute, ...rest }) => rest);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}

// =====================================================================
// packages/core/src/protocol/v2/registry.ts
// =====================================================================

export interface ProviderConfig {
  type: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  extra?: Record<string, unknown>;
}

export class ProviderRegistry {
  private factories = new Map<string, (cfg: ProviderConfig) => LLMProvider>();

  register(name: string, factory: (cfg: ProviderConfig) => LLMProvider): void {
    if (this.factories.has(name)) {
      throw new Error(`provider already registered: ${name}`);
    }
    this.factories.set(name, factory);
  }

  resolve(cfg: ProviderConfig): LLMProvider {
    const f = this.factories.get(cfg.type);
    if (!f) throw new Error(`unknown provider type: ${cfg.type}`);
    return f(cfg);
  }
}
```

---

**END of `kernel-protocol.md`**
