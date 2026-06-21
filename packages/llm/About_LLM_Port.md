```txt
  ---
  LLMPort 设计详解

  一句话定位

  LLMPort 是内核定义的唯一 LLM 抽象接口，把
  OpenAI/Anthropic/DeepSeek 等具体厂商协议统一翻译成内核能消费的
  LLMEvent 流。内核不 import 任何厂商 SDK。

  ---
  接口定义（core 层，零依赖）

  // packages/core/src/ports/llm-port.ts

  interface ChatRequest {
    messages: Msg[];       // 内核标准消息格式
    tools?: ToolDefinition[];  // 内核标准工具定义
    signal?: AbortSignal;     // 取消信号
  }

  interface LLMPort {
    chatStream(req: ChatRequest): AsyncIterable<LLMEvent>;
  }

  只此一个方法。输入是内核的 Msg[] + ToolDefinition[]，输出是统一的
  LLMEvent 流。

  LLMEvent — 7 种统一事件

  // packages/core/src/types/events.ts

  type LLMEvent =
    | { kind: 'token';          text: string }
      // 逐字输出
    | { kind: 'tool_call';      call: ToolCall }
      // 模型想调工具
    | { kind: 'tool_progress';  callId: string; stream:
  'stdout'|'stderr'; chunk: string }
    | { kind: 'done';           usage?: { inputTokens?;
  outputTokens? } } // 本轮结束
    | { kind: 'error';          error: { message: string; code?:
  string } } // 错误

  这是从各厂商协议抽象出的最小公共面。无论是 OpenAI 的
  delta.content、Anthropic 的 content_block_delta，最终都归一为
  token 事件。

  ---
  实现层（llm 包）— 以 OpenAIProvider 为例

  OpenAIProvider.chatStream()
  │
  ├─ 1. translate.ts — 内核格式 → OpenAI 格式
  │   ├─ toOpenAIMessages(Msg[])     → ChatCompletionMessageParam[]
  │   └─ toOpenAITools(ToolDef[])    → ChatCompletionTool[] +
  nameMap
  │
  ├─ 2. 调 OpenAI SDK
  │   client.chat.completions.create({stream: true, ...})
  │
  ├─ 3. stream.ts — OpenAI SSE → LLMEvent
  │   parseOpenAIStream(stream, signal, nameMap)
  │   │
  │   ├─ delta.content        → yield { kind: 'token', text }
  │   ├─ delta.tool_calls     → Map<index, PendingToolCall> 增量拼接
  │   │   finish_reason='tool_calls' → drainPending → yield
  tool_call
  │   ├─ finish_reason='stop' → drainPending → yield done
  │   ├─ finish_reason='length'/'content_filter' → yield error
  │   └─ usage chunk          → 收集后塞进 done 事件
  │
  └─ 4. errors.ts — 异常归一化
      catch(err) → normalizeError(err) → 6 级匹配 → ErrorEvent

  关键设计点

  1. Tool Call 增量拼接（stream.ts）

  OpenAI 流式下发 tool_call 时，args（JSON 字符串）是分 chunk
  的，不同 tool_call 由 index 区分：

  chunk 1: delta.tool_calls[{index:0, id:"call_1",
  function:{name:"fs_read"}}]
  chunk 2: delta.tool_calls[{index:0,
  function:{arguments:'{"filePath"'}}]
  chunk 3: delta.tool_calls[{index:0,
  function:{arguments:':"/tmp/a.txt"}'}}]
  chunk 4: finish_reason='tool_calls'  ← 触发 drainPending → yield
  tool_call

  stream.ts 用 Map<index, PendingToolCall>
  跟踪每个槽位的拼接，finish_reason 到达时才一次性 JSON.parse +
  yield。如果 JSON 非法，不抛异常，而是 yield
  error{code:'invalid_tool_args'} — 上层 runAgent 自然处理。

  2. 工具名 Sanitize 往返（translate.ts）

  内核的工具名可以是 fs.read（含 .），但 OpenAI API 要求
  [a-zA-Z0-9_-]。translate 层做透明映射：

  发请求时：toOpenAITools() → fs.read → fs_read，存到 nameMap:
  {fs_read → fs.read}
  收响应时：resolveOriginalName(fs_read, nameMap) → fs.read

  对 runAgent 完全透明 — 它永远不知道自己传的 fs.read 在网络上是
  fs_read。

  3. 错误归一化（errors.ts）— 6 级优先级匹配

  normalizeError(error):
    1. APIUserAbortError       → code: 'aborted'       // 用户取消
    2. APIConnectionTimeoutError → code: 'timeout'      //
  网络超时（必须先于父类！）
    3. APIConnectionError      → code: 'connection'      // 网络错误
    4. APIError                → code: '401'|'429'|...  //
  透传服务端消息
    5. Error                   → code: 'unknown'
    6. 非 Error                 → code: 'unknown'

  注意第 2 步的分支顺序敏感：APIConnectionTimeoutError extends
  APIConnectionError，先匹配子类再匹配父类，否则超时会被错误归类为普
  通连接错误。

  4. 取消的静默语义（provider.ts）

  catch(err) → normalizeError → isAbortedEvent? → 直接 return（不
  yield error）
              → signal.aborted?                → 同样静默 return
              → 其他错误                       → yield error 事件

  用户 Ctrl-C 不是错误 — runAgent 不需要看到 error 事件，它通过
  AbortSignal 的 aborted 状态自己判断。

  5. length / content_filter 不产生残缺 tool_call

  // stream.ts handleChoice()
  if (choice.finish_reason === 'length' || choice.finish_reason ===
  'content_filter') {
    yield { kind: 'error', error: { code: choice.finish_reason, ...
  } };
    return 'terminated';  // ← 直接终止，不 drainPending
  }

  如果模型因为 token 限制 (length) 被截断，此时 pendingByIndex
  里有不完整的 tool_call。之前的老实现在这里 drain 会产出缺 id/name
  的假 tool_call。修复后直接 yield error + 终止。

  ---
  工厂模式（factory.ts）

  createProvider(config: ProviderConfig): LLMPort
    switch config.protocol:
      'openai-compatible' → new OpenAIProvider({...})
      未来: 'anthropic'   → new AnthropicProvider({...})

  没有引入 IoC 容器，只是一个纯 switch 路由。ProviderConfig 多了一个
  protocol 字段来路由实现 — 同一个 openai-compatible 协议覆盖了
  OpenAI / DeepSeek / Ark / OpenRouter 所有兼容接口。

  ---
  现在的状态 vs 未来

  当前:
    LLMPort ─── OpenAIProvider (openai-compatible 协议)
                ├─ 30 测试覆盖
                ├─ 15 种错误码归一化
                └─ tool call 增量拼接 + sanitize 往返

  未来可加（不改 LLMPort 接口）:
    LLMPort ─── AnthropicProvider  (anthropic 协议)
    LLMPort ─── GoogleProvider     (gemini 协议)
    LLMPort ─── MockProvider       (测试用)

  每加一个 Provider 只是一个实现了 LLMPort 的新类 — core 的 runAgent
  零改动，这就是 Port 模式的红利。






==================================================================





OpenAI 流式标准格式 vs 本项目处理方式

  一、OpenAI 原始流式格式 (ChatCompletionChunk)

  OpenAI 的 stream: true 返回的是 SSE（Server-Sent Events），每个
  chunk 是这样一个 JSON 对象：

  // openai SDK 反序列化后的 ChatCompletionChunk 结构
  {
    id: "chatcmpl-xxx",
    object: "chat.completion.chunk",
    created: 1719000000,
    model: "gpt-4o-mini",
    choices: [{
      index: 0,
      delta: {
        content?: string,          // 文本增量
        tool_calls?: [{            // 工具调用增量
          index: number,           // ★ 槽位编号，区分并行调用
          id?: string,
          type: "function",
          function?: {
            name?: string,
            arguments?: string     // ★ JSON 分片，不是完整 JSON
          }
        }]
      },
      finish_reason: null | 'stop' | 'tool_calls' | 'length' |
  'content_filter'
    }],
    usage?: {                      // ★ 独立 chunk，与 choices 互斥
      prompt_tokens: number,
      completion_tokens: number,
      total_tokens: number
    }
  }

  二、OpenAI 流式的四大难点

  难点 1：文本和 tool_call 可以出现在同一个 chunk 里

  chunk: delta.content="让我读一下文件", delta.tool_calls=[{index:0,
  ...}]

  模型可以边说边调 — 我们的处理：先 yield token，再累加
  tool_call，互不干扰。

  难点 2：tool_call 的 arguments 是分片的，且多个调用通过 index
  交叉下发

  chunk 1: tool_calls[{index:0, id:"call_a",
  function:{name:"fs.read"}}]
  chunk 2: tool_calls[{index:1, id:"call_b",
  function:{name:"fs.write", arguments:'{"path"'}}]
  chunk 3: tool_calls[{index:0,
  function:{arguments:'{"path":"/tmp/a"}'}}]   ← 切回 index:0
  chunk 4: tool_calls[{index:1, function:{arguments:':"/tmp/b"}'}}]
           ← 切回 index:1
  chunk 5: finish_reason='tool_calls'  ←
  到这里才知道两个调用都发完了

  这就是为什么不能"收到一个 chunk 就 JSON.parse 一个 tool_call"。

  难点 3：usage 是独立 chunk，且可能在中间

  OpenAI 的 usage（token 统计）不在最后的 chunk 里，而是作为
  choices: [] 的独立 chunk
  插入在流的任意位置。需要在看到时收集，最后塞进 done 事件。

  难点 4：错误终止可能留下不完整的 tool_call

  finish_reason='length'（token 限制截断）或
  'content_filter'（内容审查拦截）时，可能存在一半的
  tool_call。此时不能 drainPending，否则会产出缺 id/name 的假
  tool_call。

  ---
  三、本项目的处理架构

  parseOpenAIStream(stream, signal, nameMap)
    │
    │  维护三个跨 chunk 的状态：
    │  ├─ pendingByIndex: Map<index, PendingToolCall>  // 按 index
  跟踪 tool_call 拼接
    │  ├─ usage: { inputTokens?, outputTokens? }       // 收集 token
  统计
    │  └─ earlyTerminated: bool                         //
  标记是否被 length/content_filter 打断
    │
    ├─ for each chunk:
    │   ├─ chunk.usage? → 收集 usage（不 yield）
    │   └─ chunk.choices[0] → handleChoice()
    │       ├─ delta.content       → yield { kind:'token', text }
    │       ├─ delta.tool_calls[]  → 按 index 累积到 pendingByIndex
    │       ├─ finish_reason='length'/'content_filter'
    │       │   → yield error → return 'terminated'（不
  drainPending！）
    │       └─ finish_reason='stop'/'tool_calls'
    │           → drainPending(pendingByIndex) → yield tool_call[]
    │           → return 'flushed'
    │
    └─ 流自然结束:
        ├─ pendingByIndex 有残留? → yield
  error{code:'incomplete_stream'}
        └─ 无残留                → yield { kind:'done', usage }

  ---
  四、具体场景走读

  TC1：纯文本流

  原始 chunk 序列:
  ┌──────────────────────────────────────────────────────┐
  │ chunk1: delta.content="Hel",  finish_reason=null     │ → yield
  token("Hel")
  │ chunk2: delta.content="lo",   finish_reason=null     │ → yield
  token("lo")
  │ chunk3: delta={},             finish_reason='stop'   │ → flush,
  break
  │ chunk4: choices=[], usage={prompt:7, completion:2}   │ → 收集
  usage
  └──────────────────────────────────────────────────────┘

  最终输出:
    token("Hel") → token("lo") → done({inputTokens:7,
  outputTokens:2})

  处理逻辑：delta.content 逐字 yield，finish_reason='stop' 触发
  drainPending（此时为空），流结束时 yield done 并附上 usage。

  TC2：单个 tool_call 增量拼接

  原始 chunk 序列:
  ┌──────────────────────────────────────────────────────────────┐
  │ chunk1: tool_calls[{index:0, id:"call_1", name:"fs.read"}]  │
  │            → pendingByIndex: {0: {id:"call_1", name:"fs.read",
  argsBuffer:""}}
  │                                                              │
  │ chunk2: tool_calls[{index:0, arguments:'{"pa'}]             │
  │            → pendingByIndex: {0: {...argsBuffer: '{"pa'}}
  │                                                              │
  │ chunk3: tool_calls[{index:0, arguments:'th":"a.ts"}'}]      │
  │            → pendingByIndex: {0: {...argsBuffer:
  '{"path":"a.ts"}'}}
  │                                                              │
  │ chunk4: delta={}, finish_reason='tool_calls'                 │
  │            → drainPending → JSON.parse('{"path":"a.ts"}')   │
  │            → yield tool_call{id:"call_1", name:"fs.read",
  │                               args:{path:"a.ts"}}           │
  │                                                              │
  │ chunk5: usage={prompt:10, completion:5}                      │
  │            → 收集 usage                                      │
  └──────────────────────────────────────────────────────────────┘

  最终输出:
    tool_call(fs.read, {path:"a.ts"}) → done({inputTokens:10,
  outputTokens:5})

  这里 arguments 分两个 chunk 下发（'{"pa' + 'th":"a.ts"}'），靠
  argsBuffer 拼接。finish_reason='tool_calls' 到达时一次性
  JSON.parse 完整字符串。

  TC3：多个并行 tool_call（交叉下发）

  原始 chunk 序列:
  ┌──────────────────────────────────────────────────────────────┐
  │ chunk1: tool_calls[{index:0, id:"call_a", name:"fs.read",   │
  │                      arguments:'{"path":"a.ts"}'}]          │
  │            → pendingByIndex: {0: {id:"call_a", name:"fs.read",
  │
  argsBuffer:'{"path":"a.ts"}'}}
  │                                                              │
  │ chunk2: tool_calls[{index:1, id:"call_b", name:"fs.write",  │
  │                      arguments:'{"path":"b.ts"'}]           │
  │            → pendingByIndex: {0: ..., 1: {id:"call_b",
  │                                    name:"fs.write",
  │                                    argsBuffer:'{"path":"b.ts"'}}
  │                                                              │
  │ chunk3: tool_calls[{index:1, arguments:',"data":"x"}'}]     │  ←
  注意：index:1
  │            → pendingByIndex: {0: ..., 1: {argsBuffer:       │
  │                '{"path":"b.ts","data":"x"}'}}               │
  │                                                              │
  │ chunk4: finish_reason='tool_calls'                           │
  │            → drainPending → 按 index 排序 0→1                │
  │            → yield tool_call(fs.read, {path:"a.ts"})        │
  │            → yield tool_call(fs.write, {path:"b.ts",data:"x"})│
  └──────────────────────────────────────────────────────────────┘

  最终输出:
    tool_call(fs.read) → tool_call(fs.write) → done()

  关键：index 0 和 1 在 chunk 之间来回切换，pendingByIndex 的 Map
  结构让每个槽位独立累积。drainPending 时按 index 升序 yield（0 先于
  1），保证确定性顺序。

  TC4：token 与 tool_call 混合

  原始 chunk 序列:
  ┌──────────────────────────────────────────────────────────────┐
  │ chunk1: delta.content="thinking..."                          │
  │            → yield token("thinking...")                      │
  │                                                              │
  │ chunk2: delta.content=" calling tool",                      │
  │         delta.tool_calls[{index:0, id:"call_x", name:"noop",│
  │                            arguments:'{}'}]                 │
  │            → yield token(" calling tool")                    │
  │            → pendingByIndex: {0: {id:"call_x", name:"noop", │
  │                                    argsBuffer:'{}'}}        │
  │                                                              │
  │ chunk3: finish_reason='tool_calls'                           │
  │            → drainPending → JSON.parse('{}') → {}           │
  │            → yield tool_call(noop, {})                       │
  └──────────────────────────────────────────────────────────────┘

  最终输出:
    token("thinking...") → token(" calling tool") → tool_call(noop)
  → done()

  一个 chunk 里同时有 content 和 tool_calls — 这是 OpenAI
  的常见行为。我们先 yield token，再累加
  tool_call。这样用户先看到文字"thinking... calling
  tool"，然后看到工具被调用。

  TC5：非法 JSON 参数

  原始 chunk 序列:
  ┌──────────────────────────────────────────────────────────────┐
  │ chunk1: tool_calls[{index:0, id:"call_bad", name:"broken",  │
  │                      arguments:'{not json'}]                │
  │            → pendingByIndex: {0: {id:"call_bad", name:"broken",
  │                                    argsBuffer:'{not json'}}
  │                                                              │
  │ chunk2: finish_reason='tool_calls'                           │
  │            → drainPending → JSON.parse('{not json') → 💥    │
  │            → yield error{code:'invalid_tool_args',           │
  │                           message:'...{not json'}            │
  │            → return（该 tool_call 被跳过，不产出）            │
  └──────────────────────────────────────────────────────────────┘

  最终输出:
    error(invalid_tool_args) → done()

  老实现会 fallback 为 {_raw: '{not json'} 的假
  tool_call。修复后直接 yield error — 让上层 runAgent
  自然感知为错误轮次。

  TC6：中途取消

  原始 chunk 序列:
  ┌──────────────────────────────────────────────────────────────┐
  │ chunk1: delta.content="a" → yield token("a")                │
  │          随后调用 ac.abort()                                 │
  │                                                              │
  │ chunk2: delta.content="b" → signal.aborted → return         │
  │ chunk3: finish_reason='stop' → 永远不会到达                  │
  └──────────────────────────────────────────────────────────────┘

  最终输出:
    token("a")  （只有这一个）

  AbortSignal 在 chunk 循环的每次迭代开头检查。取消后流直接停止，不
  yield done、不 drainPending。

  ---
  五、整体数据流和关键状态机

                      ┌─────────────────────────────┐
                      │       parseOpenAIStream       │
                      │                               │
    OpenAI SSE ──────→│  pendingByIndex: Map<         │
    (ChatCompletion   │    index,                     │
     Chunk[])         │    {id, name, argsBuffer}     │  ──→
  LLMEvent[]
                      │  >                             │
                      │                               │
                      │  usage: {input, output}       │
                      │                               │
                      │  handleChoice() 状态机:       │
                      │    'continue'   — 继续读 chunk│
                      │    'flushed'    — tool_call已 │
                      │                   全部产出    │
                      │    'terminated' — length/     │
                      │                   content_    │
                      │                   filter 终结 │
                      │    'aborted'    — 用户取消    │
                      └─────────────────────────────┘

  handleChoice 核心决策树：

  delta.content?        → yield token, 继续
  delta.tool_calls[]?   → 按 index 累积到 pendingByIndex, 继续
  finish_reason?
    ├─ 'length'|'content_filter' → yield error, 返回 terminated
    ├─ 'stop'|'tool_calls'       → drainPending (JSON.parse + yield
  tool_call), 返回 flushed
    └─ null                      → 继续读下一个 chunk

  drainPending 的安全校验：

  对每个 pending:
    ├─ id 为空 或 name 为空 → 跳过（不产出残缺 tool_call）
    ├─ argsBuffer 为空       → args = {}
    ├─ JSON.parse 成功        → yield tool_call（name 反查原名）
    └─ JSON.parse 失败        → yield
  error{code:'invalid_tool_args'}, 跳过

  流自然结束（没有 finish_reason）时还要补一个兜底：

  流自然结束 + pendingByIndex 有残留 → yield
  error{code:'incomplete_stream'}
  流自然结束 + pendingByIndex 空      → yield done

  一句话总结：parseOpenAIStream 本质上是一个 跨 chunk 状态机，把
  OpenAI 的增量式、跨槽位、非原子的流式格式，翻译为内核可以直接消费
  的原子化事件流（每个 token/tool_call/done/error 都是完整可用的）。

✻ Churned for 42s
```
