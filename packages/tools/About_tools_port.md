```text
 ---
  ToolPort 实现详解

  架构总览

  ┌─────────────────────────────────────────────────────────────────
  ┐
  │  core 层 (接口)
   │
  │
  │
  │  ToolPort {
  │
  │    list(): ToolDefinition[]
  │
  │    invoke(call, opts?): Promise<ToolResult>
  │
  │  }
  │
  │
  │
  │  ConfirmRequiredError  ← 特殊异常，抛给上层
    │
  │  ToolInvokeOptions {
  │
  │    confirmedCallId?   ← 用户已确认，跳过二次弹窗
    │
  │    onProgress?        ← 实时 stdout/stderr 回调
   │
  │  }
  │
  └──────────────────────────────┬──────────────────────────────────
  ┘
                                 │ implements
  ┌──────────────────────────────┴──────────────────────────────────
  ┐
  │  tools 层 (实现)
   │
  │
  │
  │  ToolRegistry {
  │
  │    tools: Map<name, ToolImpl>
  │
  │    register(impl)     → 注册工具
   │
  │    list()             → 返回所有 ToolDefinition[]
   │
  │    invoke(call, opts) → 执行工具 (preflight → execute)
  │
  │  }
  │
  │
  │
  │  ToolImpl {
  │
  │    definition: ToolDefinition   ← 给 LLM 看的 schema
  │
  │    preflight?(call, ctx)        ← 沙箱拦截 + 参数校验
   │
  │    execute(args, ctx, cb)       ← 真正干活
   │
  │  }
  │
  │
  │
  │  defineTool({name, argsSchema, preflight, execute}) → ToolImpl
  │
  │    ↑ 工厂层：自动参数校验 + 类型推断 + 标准化错误
     │
  └─────────────────────────────────────────────────────────────────
  ─┘

  ---
  一层：接口 (core/ports/tool-port.ts)

  interface ToolPort {
    list(): ToolDefinition[];
    invoke(call: ToolCall, opts?: ToolInvokeOptions):
  Promise<ToolResult>;
  }

  只有两个方法。关键设计：

  - ToolResult 永远不抛异常（除了
  ConfirmRequiredError）。即使工具执行失败也返回 {ok: false,
  content: "reason"}，交给 LLM 自己决策。
  - ConfirmedCallId 是确认后重入的通行证。用户确认过一次后，第二轮
  invoke 用同一个 confirmedCallId 调用，preflight
  跳过确认弹窗但仍跑路径白名单和危险命令检查 — 确认只跳过
  "问用户"，不跳过安全。

  ---
  二层：注册表 (tools/registry.ts) — invoke 的完整流程

  invoke(call, opts):
    │
    ├─ 1. 查工具
    │   impl = tools.get(call.name)
    │   → 未找到: return { ok: false, "unknown tool" }
    │
    ├─ 2. 构建执行上下文 (ToolExecContext)
    │   ctx = { cwd, confirmPolicy, pathWhitelist, signal }
    │
    ├─ 3. preflight（如果工具有）
    │   skipConfirm = opts.confirmedCallId === call.id
    │   preflightCtx = skipConfirm ? { ...ctx, confirmPolicy: 'auto'
  } : ctx
    │   impl.preflight(call, preflightCtx)
    │   │
    │   ├─ 抛 ConfirmRequiredError → 透传给上层（runAgent → kernel →
  用户）
    │   ├─ 抛其他 Error           → return { ok: false, "preflight
  error: ..." }
    │   └─ 通过                  → 继续
    │
    ├─ 4. execute
    │   impl.execute(args, ctx, { onProgress })
    │   ├─ 成功 → return { ok: true, content }
    │   └─ 失败 → return { ok: false, content: error.message }

  skipConfirm 的语义：
  const skipConfirm = opts?.confirmedCallId === call.id;
  const preflightCtx = skipConfirm ? { ...ctx, confirmPolicy: 'auto'
  } : ctx;
  确认过不代表可以绕过一切 — 它只是把 confirmPolicy 换成 'auto'，路
  径白名单和危险命令拦截仍然生效。这是有意为之：用户点了一次
  "allow"，不代表这个工具后续可以写 /etc/passwd。

  ---
  三层：Sandbox 三件套

  Path Policy — 防止路径穿越：
  // path-policy.ts
  checkPathAllowed(target, cwd, { whitelist }):
    abs = resolve(target)               // 先 resolve 掉 ../../
    for allowed in whitelist:
      if abs === allowed || abs.startsWith(allowed + '/')
        → allowed
    → denied

  默认 whitelist 只有 cwd 自身，文件只能在工作目录内读/写。

  Command Policy — 危险命令拦截（9 条默认黑名单）：
  // command-policy.ts
  DEFAULT_BLOCKED_PATTERNS = [
    /\brm\s+-rf?\s+\/(?!\S)/u,     // rm -rf /
    /\brm\s+-rf?\s+~/u,            // rm -rf ~
    /\bcurl|wget\s+.*\|\s*sh\b/u,  // curl|wget ... | sh
    /\bmkfs\.\w+/u,                // mkfs.*
    /\bdd\s+if=.*of=\/dev\//u,    // dd 写设备
    />\s*~\/\.ssh\//u,              // > ~/.ssh/
    />\s*\.env\b/u,                 // > .env
    ...
  ]
  原则：宁可漏过偏门、不误伤正常。echo hello > /tmp/x.txt
    />\s*\.env\b/u,                 // > .env
    ...
  ]
  原则：宁可漏过偏门、不误伤正常。echo hello > /tmp/x.txt 这样合法的重定向不会被拦截。

  Confirm Policy — 三档决策：
  // confirm-policy.ts
  applyConfirmPolicy(call, policy):
    'auto' → return          // 什么都不做，直接通过
    'deny' → throw Error     // 拒绝执行
    'ask'  → throw ConfirmRequiredError(call)  // 抛给上层，等用户决定

  ---
  四层：内置工具实现

  fs.read（只读，不触发确认）：
  preflight: FsReadArgs.parse + checkPathAllowed（只跑路径白名单）
  execute:   readFile → 可选行号范围裁剪

  fs.write（写入，触发 ask）：
  preflight: FsWriteArgs.parse + checkPathAllowed + applyConfirmPolicy('ask')
             → 路径越界抛 Error
             → 策略 ask 抛 ConfirmRequiredError
  execute:   mkdir -p + writeFile

  shell.exec（执行命令，触发 ask + 危险拦截）：
  preflight: ShellExecArgs.parse + checkCommandAllowed + applyConfirmPolicy('ask')
             → 危险命令抛 Error
             → 策略 ask 抛 ConfirmRequiredError
  execute:   child_process.spawn(cmd, {shell: true})
             用 StringDecoder 实时解码 stdout/stderr
             通过 onProgress 回调流式输出给 runAgent
             非零退出码不抛错，而是返回 "exit code N\n..." 让 LLM 自己决策

  shell.exec 的流式实现是三个内置工具中最复杂的：用 spawn +
  StringDecoder（处理多字节字符边界），onProgress 回调每个数据块推给 runAgent → yield
  tool_progress 事件 → 终端实时打印。

  ---
  五层：defineTool() 工厂（最新添加）

  在旧 ToolImpl 基础上的一层类型安全的语法糖：

  const fsReadTool = defineTool({
    name: 'fs_read',
    argsSchema: FsReadArgs,          // zod schema → 自动类型推断
    preflight(call, ctx) { ... },
    async execute(args, ctx) {       // args 类型自动推断为 z.infer<typeof FsReadArgs>
      return {
        output: "formatted content",  // 给模型看
        metadata: { truncated: true }  // 给 UI 渲染提示，不发给 LLM
      };
      };
    },
  });

  工厂自动做了四件事：
  1. 参数校验：有 argsSchema 就自动 parse，失败抛 InvalidArgumentsError（消息格式含 "Please rewrite the
  input" 提示给 LLM）
  2. 类型推断：execute(args) 的 args 自动获得 zod schema 的类型
  3. 标准化返回：接受 string 或 ToolExecResult，统一转换为 ToolRegistry 期望的 string
  4. metadata 分离：output 给 LLM，metadata 给 UI — 模型看不到 truncated: true，但前端可以据此渲染
  "截断提示"

  目前已有三个 defineTool 实现的工具：fsReadTool、fsEditTool、grepTool，加上老实现的
  fsWrite、shellExec，共 5 个内置工具。

  ---
  整条链路回顾

  runAgent
    │
    ├─ tools.list()           → ToolDefinition[] → 传给 LLM 的 tools 参数
    │
    └─ tools.invoke(call)     → ToolResult
         │
         └─ ToolRegistry.invoke()
              ├─ preflight: 路径白名单 + 危险命令 + confirm 三档
              ├─ execute:   干活，onProgress 回调实时推送
              └─ 错误统一为 ToolResult，不抛异常（ConfirmRequiredError 除外）

  核心原则：runAgent 不知道工具是 fs.read 还是远程 MCP 服务。它只知道调 ToolPort.invoke()，拿到
  ToolResult，塞回 messages 继续。这才是 Port 模式真正发挥作用的地方。



```
