```text
---
  一切从哪里开始 — 完整调用链路

  全景架构图

  ┌──────────────────────────────────────────────────────────────────────┐
  │  接入层 (L4)                                                          │
  │  ┌───────────────┐   ┌───────────────┐   ┌──────────────────────┐   │
  │  │ client/chat   │   │ client/exec   │   │ web/                 │   │
  │  │ (REPL 交互)   │   │ (一次性任务)   │   │ (浏览器 SPA)         │   │
  │  └───────┬───────┘   └───────┬───────┘   └──────────┬───────────┘   │
  │          │                   │                       │               │
  │          │   InProcessKernelClient (同进程)  HttpSseKernelClient     │
  └──────────┼───────────────────┼───────────────────────┼───────────────┘
             │                   │                       │
             ▼                   ▼                       ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  协议边界: KernelClient 接口 (packages/protocol)                      │
  │                                                                       │
  │  • createSession / resumeSession / closeSession                      │
  │  • submit(SubmitOp) → AsyncIterable<EventMsg>   ← 唯一回合入口        │
  │  • interrupt(sessionId)   ← Ctrl-C                                     │
  │  • confirmTool(sessionId, callId, 'approve'|'deny')  ← 确认回执      │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │
                                  ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  InProcessKernelClient (packages/core/kernel/in-process.ts)           │
  │                                                                       │
  │  这是所有 in-process 场景的"集中入口"。每一次 submit() 做三件事:        │
  │                                                                       │
  │  1. 从 store 加载历史 messages，追加 user 消息                         │
  │  2. 创建 AsyncQueue + AbortController                                 │
  │  3. 异步启动 driveTurn() → 内部调用 runAgent()                        │
  │  4. 把 AsyncQueue 作为 AsyncIterable 返回给上层消费                    │
  │                                                                       │
  │  submit() 核心代码:                                                    │
  │  ┌──────────────────────────────────────────────────────────┐        │
  │  │ const queue = new AsyncQueue<EventMsg>()                  │        │
  │  │ this.driveTurn({sessionId, messages, queue, signal, ...})│        │
  │  │ // driveTurn 在后台消费 runAgent，往 queue 里 push 事件    │        │
  │  │ for await (const ev of queue) { yield ev }  // 前台流式送出│       │
  │  └──────────────────────────────────────────────────────────┘        │
  │                                                                       │
  │  ⚠️ 关键: driveTurn 里的 ToolPort 不是原始的——它被 wrapToolsForConfirm│
  │     包了一层，把工具确认的"暂停/恢复"翻译成 AsyncQueue 的事件+Deferred │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │
                                  ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  runAgent() — 纯 async generator (packages/core/agent/loop.ts)       │
  │                                                                       │
  │  输入: LLMPort + ToolPort + initialMessages + maxTurns + signal      │
  │  输出: AsyncGenerator<AgentEvent>                                    │
  │                                                                       │
  │  不 import 任何 CLI/Web/Server 代码。内核的最内层。                    │
  │                                                                       │
  │  while (turn < maxTurns):                                             │
  │    ├─ 调 llm.chatStream(messages, tools) → 流式消费                  │
  │    │   ├─ token → yield token                                        │
  │    │   ├─ tool_call → 收集到 pendingToolCalls，先 yield              │
  │    │   └─ done → break                                               │
  │    ├─ push assistant 消息到 messages                                  │
  │    ├─ 无 toolCall → yield done('completed') → return                │
  │    └─ 有 toolCall → 逐个 invokeWithProgress():                       │
  │        ├─ yield tool_progress (实时 stdout/stderr)                   │
  │        ├─ ConfirmRequiredError → yield tool_confirm_required → return│
  │        └─ 成功 → yield tool_result → push tool 消息 → 下一轮         │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │
                      ┌───────────┼───────────┐
                      ▼           ▼           ▼
                LLMPort      ToolPort     StorePort
            (接口在 core)  (接口在 core)  (接口在 core)
            (实现在 llm/)  (实现在 tools/)(实现在 server/)

  三个"集中入口"

  ┌────────┬────────────────────────────┬───────────────────────────────────┬──────────────────────┐
  │  层级  │            入口            │           所在的包/文件           │         角色         │
  ├────────┼────────────────────────────┼───────────────────────────────────┼──────────────────────┤
  │ 协议接 │ KernelClient.submit()      │ packages/protocol/src/kernel-clie │ 所有接入层的唯一抽象 │
  │ 口     │                            │ nt.ts                             │ 契约                 │
  ├────────┼────────────────────────────┼───────────────────────────────────┼──────────────────────┤
  │ 内核实 │ InProcessKernelClient.subm │ packages/core/src/kernel/in-proce │ in-process           │
  │ 现     │ it()                       │ ss.ts                             │ 场景的集中实现       │
  ├────────┼────────────────────────────┼───────────────────────────────────┼──────────────────────┤
  │ Agent  │ runAgent()                 │ packages/core/src/agent/loop.ts   │ 纯状态机 +           │
  │ 循环   │                            │                                   │ 流式循环，最内层     │
  └────────┴────────────────────────────┴───────────────────────────────────┴──────────────────────┘

  一次 UserTurn 的完整数据流

  以 client/exec.ts 为例（最简洁的一次性路径）：

  1. 装配依赖
     llm    = createProvider({apiKey, model, ...})    // LLMPort 实现
     tools  = new ToolRegistry({cwd, confirmPolicy})  // ToolPort 实现
     store  = new InMemoryStore()                     // StorePort 实现
     kernel = new InProcessKernelClient({llm, tools, store})

  2. 创建会话
     session = await kernel.createSession({system})

  3. 投递用户输入 → 拿到事件流
     stream = kernel.submit({ type: 'UserTurn', sessionId, content })

          ┌──── 内部发生的事情 ────┐
          │                        │
          │  InProcessKernelClient.submit():
          │    加载历史消息 + 追加 user 消息
          │    创建 AsyncQueue
          │    driveTurn() 在后台:
          │      for await (ev of runAgent({llm, tools, messages, ...})) {
          │        handleEvent(ev) → 翻译 AgentEvent → EventMsg → push 到 queue
          │      }
          │    返回 queue 的 AsyncIterable
          │                        │
          └────────────────────────┘

  4. 消费事件流（渲染到终端）
     for await (const ev of stream) {
       switch (ev.type) {
         'Token'     → writeToken(ev.text)       // 逐字打印
         'ToolCall'  → writeToolCall(ev.call)    // 展示工具调用
         'ToolResult'→ writeToolResult(ev.result) // 展示结果
         'TurnEnd'   → 记录 reason，结束
       }
     }

  确认流程的暂停/恢复机制

  这是整个设计中最精妙的部分，涉及三个组件协作：

                     InProcessKernelClient
                     ┌──────────────────────────────────────────────┐
  runAgent           │  wrapToolsForConfirm (包一层 ToolPort)        │    AsyncQueue
    │                │                                              │      │
    ├─ invoke(call) ─┼→ inner.invoke(call)                          │      │
    │                │    ↓ ConfirmRequiredError                    │      │
    │                │  catch → push ToolConfirmRequired ───────────┼──→ 上层消费
    │                │         + Deferred (pendingConfirms)          │      │
    │                │         + await deferred.promise   ← 阻塞在这  │      │
    │                │                ↑                             │      │
    │                │          用户回 confirmTool('approve') ──────┘      │
    │                │          → deferred.resolve('approve')              │
    │                │          → inner.invoke(call, {confirmedCallId})    │
    │  ← result ─────┼────────────────────────────────────────────────    │
    │                │                                              │      │
    │  继续下一轮 ──→                                               │      │

  关键点：wrapToolsForConfirm 是在 InProcessKernelClient 层做的，runAgent 本身只认识原始的
  ToolPort.invoke() 接口（抛 ConfirmRequiredError）。kernel 层把异常翻译成"push 事件 + await
  Deferred"，实现了流自然暂停，无需重新 runAgent，不产生假消息。

  总结

  - 唯一协议入口：KernelClient.submit() — 所有接入层的统一契约
  - 唯一实现入口：InProcessKernelClient — 装配 LLMPort + ToolPort + StorePort，驱动 runAgent
  - 唯一循环入口：runAgent() — 纯 async generator，内核最内层，零外部依赖
  - Tools 和 Loop 的连接：runAgent 只依赖 ToolPort 接口（list() + invoke()），实现在 packages/tools 的
  ToolRegistry，通过 kernel 构造函数注入。确认语义在 kernel 层通过 wrapToolsForConfirm 翻译，loop
  层对此无感知。

✻ Worked for 25s


  ---
  Liskin 开发 Roadmap（基于 git 记录）

  总览时间线

  2026-06-19          2026-06-20               2026-06-21
    │                    │                        │
    ▼                    ▼                        ▼
  Phase 0 MVP           Phase 1 启动              Phase 1 深入
  M0→M4 一口气完成      协议层/REPL/类型收敛       Web重构/Tool抽象

  ---
  Phase 0 MVP — 6月19日凌晨（~4 小时内连续提交）

  这是整个项目的奠基之夜，按严格的自底向上顺序推进：

  02:03  M0  pnpm monorepo 骨架
         │   packages/{core,llm,tools,server} + client/
         │   tsconfig.base.json + .dependency-cruiser.cjs
         │   五层架构依赖红线落地，5 个空包可编译
         │
         ▼
  02:03  M1  Agent Core 状态机 + Port 接口
         │   runAgent() async generator
         │   3 个 Port 接口：LLMPort / ToolPort / StorePort
         │   HarnessPort + NoopHarness
         │   6 个 mock 单测
         │
         ▼
  02:04  M2  OpenAI Provider 实现 LLMPort
         │   stream.ts — 流式增量拼接（按 index 跟踪 tool_call）
         │   translate.ts — Msg/ToolDef ↔ OpenAI 协议互转
         │   errors.ts — 15 种错误码归一化
         │   30 个单测
         │
         ▼
  02:05  M3  Tool Registry + Sandbox
         │   ToolRegistry implements ToolPort
         │   三件套 Sandbox：路径白名单 / 危险命令黑名单 / confirm 三档
         │   builtins: fs.read / fs.write / shell.exec
         │   40 个单测
         │
         ▼
  02:05  M4  Server (Hono+SSE) + CLI + Web 前端
         │   POST /v1/chat SSE 端点
         │   SqliteStore 实现 StorePort
         │   CLI: agent serve + agent exec
         │   Web: React SPA + SSE 消费 + 工具确认弹窗
         │
         ▼
  02:06  docs + 开发脚本
  02:08  搁置 Go 服务端 (LEGACY.md)

  关键规律：M0→M1→M2→M3→M4 严格按底层→上层的依赖方向推进。每层只依赖已完工的下层，core 永远是最先写的。

  ---
  Phase 1（上半场）— 6月20日

  Phase 0 把链路跑通后，开始解决"协议规范化 + 真正可用的 CLI"：

  11:41  实现 CLI 交互式 REPL (agent chat)
         │  之前只有 agent exec（一次性任务）
         │  现在有了多轮对话、Ctrl-C 中断、/help /sessions 命令
         │  SIGINT 双段式：先中断 turn → 再退出 REPL
         │
  12:27  REPL 启动修复
  12:39  修复 Agent 工具名映射（sanitize: . → _ 往返）
  12:56  Node 22 升级
         │
  14:29  拆包 — @liskin/protocol 从 core 中独立出来
         │  之前协议类型混在 core 里
         │  现在是零依赖包（仅 zod），前后端共享
         │  Op / EventMsg / KernelClient / wire.ts
         │
  17:25  文档更新
  17:34  Web 端 axios 集中封装 + 流式自动重连
         │
  18:24  协议层 Zod 化 + Wire 编解码
         │  encodeOp/decodeOp/encodeEvent/decodeEvent/toSseFrame
         │  跨网络帧全部走 zod parse() 校验
         │
  18:27  RTD 修复
  18:46  类型收敛 — 跨网络类型全部迁入 @liskin/protocol

  ---
  Phase 1（下半场）— 6月21日

  01:46  Web feature-based 目录分层 + sessionId 迁入 URL 路由
         │  之前 sessionId 存在 localStorage
         │  现在 /chat/:sessionId → 可分享/多 tab 独立
         │
  03:14  文档更新
         │
  16:49  Tool 抽象层 defineTool
         │  defineTool({ name, description, schema, execute })
         │  工具定义收口为一个工厂函数，统一 preflight + 错误模型
         │
  21:25  补充 lockfile
  21:26  文档转移

  ---
  一张图看实现顺序 vs 依赖方向

                   实现顺序（时间）→→→
                   ┌──────────────────────────────────────────────┐
  依赖方向          │ M0 → M1 → M2 → M3 → M4 │ 拆包 │ CLI │ Web │
  (代码层)          │                        │protocol│REPL│ 重构 │
    ↓               │                        │       │    │     │
  L4 接入   最晚写 ──┼────────────────────────M4──────┼────┼──Web│
  L3 模型          ──┼──────────────────M2─────────────┼────┼─────│
  L2 工具          ──┼─────────────M3──────────────────┼────┼─────│
  L1 内核   最先写 ──┼───────M1────────────────────────┼────┼─────│
  L0 协议          ──┼─────────────────────protocol ───┼────┼─────│
                    └──────────────────────────────────────────────┘
                     Day 1 (6/19)    │  Day 2 (6/20)  │ Day 3 (6/21)

  核心规律：
  - 先内后外 — M1(core) 定义了 Port 接口后，M2(llm) 和 M3(tools) 可以并行做，但实际是顺序做的（M2→M3），因为 M3
  需要跑通端到端测试
  - 先跑通再拆 — Phase 0 是"功能先上线"，Phase 1 才拆 @liskin/protocol、做类型收敛
  - 先 headless 再交互 — agent exec（一次性）在 M4 就有了，agent chat（REPL）是 Phase 1 才做的
  - 先旧 Web 再重构 — Phase 0 的 Web 是原型，Phase 1 做 feature-based 分层 + 协议对齐

  当前分支 feat/cros_02p 的位置

  从这个 roadmap 看，当前分支处在 Phase 1 接近尾声的阶段 — 核心架构（协议拆包、类型收敛、Web 重构、Tool
  抽象）已落地，docs/roadmap/0x02.md 列出的 Phase 1 剩余项（MCP、多 Provider、Harness、沙箱加固、协议
  v2）是下一步的方向。


```
