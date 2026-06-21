agent chat 交互式 REPL 设计方案

```
agent exec vs agent chat 对比

┌──────────────┬────────────────────────────┬────────────────────────────────────┐
│     维度     │            exec            │                chat                │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ 交互模式     │ 一次性，输完 prompt 等结果 │ REPL 循环，多轮对话                │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ confirm 策略 │ auto（硬编码）             │ ask（终端内联询问）                │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ 持久化       │ InMemoryStore（用完即丢）  │ SqliteStore（保留历史，可恢复）    │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ 中断         │ 不支持                     │ Ctrl-C → interrupt()，优雅停       │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ 退出         │ 跑完自动退出               │ /exit / Ctrl-D / 双击 Ctrl-C       │
├──────────────┼────────────────────────────┼────────────────────────────────────┤
│ 传输         │ in-process                 │ in-process（同 exec，不走 daemon） │
└──────────────┴────────────────────────────┴────────────────────────────────────┘

---
核心流程

agent chat 启动
  │
  ├─ ① 装配：InProcessKernelClient + SqliteStore + ToolRegistry(confirm='ask')
  ├─ ② 创建 session（持久化到 SQLite）
  ├─ ③ 安装 SIGINT handler（标记中断，不杀进程）
  │
  └─ ④ REPL 循环 ──────────────────────────────────────────────┐
       │                                                        │
       │  readline.question('> ')   ← 等用户输入                  │
       │  ├─ 空行 / '/exit' → 退出循环                           │
       │  ├─ '/help' → 打印命令列表 → 回到 ④                     │
       │  └─ 正常文本 → 进入 turn 消费                            │
       │                                                        │
       │  kernel.submit({ UserTurn, content })                   │
       │  for await (ev of stream) {                             │
       │    Token              → stdout.write 逐字流式打印         │
       │    ToolCall           → ▸ 工具名 + 语义化参数            │
       │    ToolProgress       → stdout.write 实时透传            │
       │    ToolResult         → ✓/✗ + 结果摘要                  │
       │                                                        │
       │    ToolConfirmRequired → ┌────────────────────┐         │
       │                          │ 暂停事件流           │         │
       │                          │ rl.question('[y/n]')│         │
       │                          │ kernel.confirmTool()│         │
       │                          │ 事件流自动恢复       │         │
       │                          └────────────────────┘         │
       │                                                        │
       │    TurnEnd → 打印原因 → break 内层循环                    │
       │  }                                                     │
       │  回到 ④ ◄──────────────────────────────────────────────┘

---
关键技术点

① 确认流程（最重要的设计）

现有机制已经自然支持——不需要改内核任何代码：

时序：
  CLI (chat.ts)                    InProcessKernelClient              runAgent
  ──────────────────────────────────────────────────────────────────────────
  for await (ev of stream) {
    ...                             AsyncQueue 里有事件 →
    yield Token, Token, ...
    ...                             ← ConfirmRequiredError 被捕获
                                    wrapToolsForConfirm:
                                      flush + persist
                                      push ToolConfirmRequired
                                      await deferred.promise ⏸️ 阻塞
    ← 收到 ToolConfirmRequired
    rl.question('[y/n]') ──────┐    （仍在阻塞中）
    用户输入 'y'               │
    confirmTool(sessionId,     │
      callId, 'approve') ─────┼──→ deferred.resolve('approve')
                              │     │
                              │     ├→ confirmedCallIds.push(callId)
                              │     ├→ inner.invoke(call, opts)  ← 真正执行
                              │     └→ push ToolResult / Token / ...
                              │
    ← 收到 ToolResult            ←  push ToolResult
    ← 收到后续 Token ...          ←  push Token ...
    continue;
  }

关键：confirmTool() 在 for-await 循环体内被调用，而非循环外。 因为 wrapToolsForConfirm 里 await deferred.promise 阻塞的是 AsyncQueue 的写入端——消费端的 for-await 正在等待下一个事件入队。调用 confirmTool() → deferred.resolve() → 写入端恢复 → 新事件入队 → 消费端取到下一个事件。循环是同一个，没有重入。

② 中断处理（Ctrl-C）

SIGINT →
  ├─ 第一次：kernel.interrupt(sessionId)
  │           → AbortController.abort()
  │           → runAgent 在 turn 边界停止
  │           → TurnEnd(reason: interrupted)
  │           → 回到 prompt
  │
  └─ 双击（1 秒内两次）：process.exit(0)
     或者在空 prompt 时按 Ctrl-C → process.exit(0)

与 exec 的关键区别：exec 收到 SIGINT 直接死，chat 优雅中断当前 turn 后回到 prompt。

③ 持久化与恢复

agent chat                          # 新建 session，保存到 ~/.liskin/sessions.sqlite
agent chat --resume <sessionId>     # 恢复历史会话，messages 数组完整加载
agent chat --no-save                # 用 InMemoryStore，退出即丢

SqliteStore 已在 packages/server 中实现，chat 模式下直接复用——每轮 turn 结束后自动落库，LLM 能看到完整对话历史。

---
文件结构

client/src/
  cli.ts              ← 新增 'agent chat' 子命令（加参数，调 runChat）
  exec.ts             ← 不动（headless 消费者保持独立）
  chat.ts             ← 新增：交互式 REPL 消费者
  prompts/
    default-system.ts ← 不动（chat 也复用同一个默认 system prompt）

cli.ts 新增子命令

program
  .command('chat')
  .description('Start interactive REPL (in-process, no daemon)')
  .option('--cwd <path>', 'working directory', process.cwd())
  .option('--model <model>', 'model id')
  .option('--base-url <url>', 'LLM base URL')
  .option('--max-turns <n>', 'max LLM turns per round', (v) => Number.parseInt(v, 10), 24)
  .option('--system <text>', 'system prompt')
  .option('--resume <id>', 'resume a previous session')
  .option('--no-save', 'do not persist session (use in-memory store)')
  .action(async (raw) => { /* 装配 → runChat() */ });

chat.ts 核心结构

export async function runChat(opts: ChatOptions): Promise<void> {
  // ① 装配 Port 实现
  const llm = createProvider({ ... });
  const tools = new ToolRegistry({ cwd, pathWhitelist, confirmPolicy: 'ask' });
  const store = opts.noSave ? new InMemoryStore() : new SqliteStore(dbPath);

  // ② 创建或恢复 session
  const session = opts.resume
    ? await kernel.resumeSession(opts.resume)
    : await kernel.createSession({ cwd, system });

  // ③ REPL 循环
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let turnInProgress = false;
  process.on('SIGINT', () => {
    if (turnInProgress) {
      kernel.interrupt(session.id);  // 优雅中断
    } else {
      process.exit(0);               // 空 prompt 时退出
    }
  });

  while (true) {
    const line = await question(rl, '> ');
    if (line === null || line === '/exit') break;
    if (!line.trim()) continue;

    turnInProgress = true;
    const stream = kernel.submit({ type: 'UserTurn', sessionId: session.id, content: line });

    for await (const ev of stream) {
      switch (ev.type) {
        case 'Token':
          process.stdout.write(ev.text);
          break;
        case 'ToolCall':
          process.stdout.write(`\n\x1b[36m▸ ${ev.call.name}\x1b[0m ${formatArgs(ev.call.args)}\n`);
          break;
        case 'ToolProgress':
          process.stdout.write(ev.chunk);
          break;
        case 'ToolResult':
          process.stdout.write(`\x1b[${ev.result.ok ? '32' : '31'}m✓\x1b[0m ${truncate(ev.result.content)}\n`);
          break;
        case 'ToolConfirmRequired':
          const answer = await askConfirm(rl, ev.call);
          await kernel.confirmTool(session.id, ev.call.id, answer);
          break;
        case 'TurnEnd':
          if (ev.reason !== 'completed') {
            process.stdout.write(`\n\x1b[33m[${ev.reason}]\x1b[0m\n`);
          }
          break;
        case 'Error':
          process.stderr.write(`\n\x1b[31m✗ ${ev.error.message}\x1b[0m\n`);
          break;
      }
    }
    turnInProgress = false;
  }

  rl.close();
  await kernel.closeSession(session.id);
}

askConfirm 内联确认（非 modal）：

async function askConfirm(rl: readline.Interface, call: ToolCall): Promise<'approve' | 'deny'> {
  const name = call.name;
  const args = formatArgs(call.args);
  const answer = await question(rl, `\x1b[33m⚠ ${name} ${args}\x1b[0m [y/n] `);
  return answer.toLowerCase().startsWith('y') ? 'approve' : 'deny';
}

渲染效果：

> 修复 src/utils.ts
让我先看看这个文件的内容…

▸ fs.read src/utils.ts
✓ export function foo(a: number): string { return String(a); }

类型错误在第 3 行，a 应该是 string 类型。
▸ fs.write src/utils.ts
⚠ fs.write src/utils.ts [y/n] y
✓ wrote 1 line

已修复。✅
> █                                          ← 回到 prompt

---
与 exec 的代码复用

exec.ts 和 chat.ts 的渲染逻辑高度重合（formatArgs、truncate、Token/ToolCall/ToolResult 的终端输出）。这部分应该抽到共享模块：

client/src/
  exec.ts             ← 保留，删 render/formatArgs/truncate → 从 render.ts import
  chat.ts             ← 新增，同样从 render.ts import
  render.ts           ← 新增：共享渲染函数
    formatArgs()
    truncate()
    renderToken()
    renderToolCall()
    renderToolResult()
    renderToolProgress()

---
为什么应该先做 agent chat

1. 比 Web 少一层：in-process 不碰 HTTP/SSE/CORS/序列化。agent chat 只依赖 KernelClient 接口，出问题立刻知道是协议层还是 transport 层。
2. 强制验证协议的确认路径：终端里 [y/n] 是最简陋的确认 UI，它迫使 Op.ConfirmTool → ToolPort.confirmedCallId → Deferred 这条链路必须正确。Web 可以用 modal 遮住协议缺陷，终端藏不住。
3. 中断路径验证：Ctrl-C → interrupt() → AbortController → TurnEnd(interrupted) 这条链路，在终端里是即时反馈——按下去立刻看到反应。Web 需要跨 SSE 传输，更难排错。
4. agent exec 复用 80% 的渲染代码：两个消费者共享同一套 render() 函数族，chat.ts 只多一个 readline 循环 + askConfirm。

✻ Churned for 1m 14s


 ---
  需求分层

  agent chat 的终端 UI 有三个层次：

  Layer 1 — 基础输入输出
    ├─ 读用户输入（多行？单行？）
    ├─ 流式打印 Token
    ├─ 内联确认 [y/n]
    └─ Ctrl-C 中断

  Layer 2 — 交互体验增强
    ├─ 输入时自动补全（路径、命令、sessionId）
    ├─ 历史记录（↑↓ 翻历史）
    ├─ 工具执行时 spinner 动画
    ├─ 流式输出时隐藏光标
    └─ 多行输入（粘贴代码块）

  Layer 3 — 复杂 TUI 布局
    ├─ 分栏（左：对话 / 右：文件浏览）
    ├─ 可滚动的时间线
    ├─ 内联 diff 预览
    └─ 类似 Claude Code 的交互体验

  ---
  技术选型对比

  ┌─────────────────────┬────────┬────────┬────────┬──────────────┬────────────┐
  │        方案         │  体积  │ 复杂度 │ Layer  │   Layer 2    │  Layer 3   │
  │                     │        │        │   1    │              │            │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ Node readline 原生  │ 0      │ 低     │ ✅     │ 手动实现     │ ❌         │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ readline + ANSI     │ 0      │ 中     │ ✅     │ ✅           │ ❌         │
  │ 控制                │        │        │        │              │            │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ Inquirer.js         │ ~300KB │ 低     │ 部分   │ ❌           │ ❌         │
  │                     │        │        │        │ 不适合流式   │            │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ blessed             │ ~500KB │ 高     │ ✅     │ ✅           │ ✅ 但老旧  │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ neo-blessed         │ ~400KB │ 高     │ ✅     │ ✅           │ ✅         │
  │                     │        │        │        │              │ 但不维护   │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ Ink (React)         │ ~2MB   │ 很高   │ ✅     │ ✅           │ ✅         │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ kittik              │ 小     │ 中     │ ✅     │ 部分         │ ✅ 年轻    │
  ├─────────────────────┼────────┼────────┼────────┼──────────────┼────────────┤
  │ terminal-kit        │ ~1MB   │ 中     │ ✅     │ ✅           │ ✅         │
  └─────────────────────┴────────┴────────┴────────┴──────────────┴────────────┘

  ---
  推荐路径：渐进式，不上重型框架

  理由

  设计文档里有一条核心原则：

  ▎ 终端里最难做，逼你把 Op 模型设计对。终端做对了，Web 只是换渲染器。

  如果在 Layer 1 就引入 Ink/React，会导致：

  1. 依赖污染：CLI 拉进 React → bundle 膨胀 2MB+ → 作为 bin 入口不体面
  2. 协议验证失真：Ink 组件化会掩盖协议事件→渲染的映射是否干净。Token 事件应该直接 write，不该通过 React reconciler
  3. 与 exec 割裂：exec 用原生 write，chat 用 React 组件树，共享的 render() 函数族不复存在
  4. 调试变难：出了问题你分不清是协议层 bug 还是 React fiber 调度问题

  具体方案

  Phase 1（当前，MVP）— 原生 readline，零新依赖

  依赖：Node built-in readline + process.stdout.write
  新增包：无
  文件：client/src/chat.ts (~200 行)

  做的事情：
  - readline.createInterface() 读用户输入
  - process.stdout.write() 流式输出（同 exec）
  - rl.question() 做内联确认
  - process.on('SIGINT') 做中断

  这就是上面设计的 chat.ts 方案。不含任何第三方 UI 库。

  终端效果：

  > 修复 src/utils.ts
  让我看看…
  ▸ fs.read src/utils.ts
  ✓ 15 lines
  问题在第 8 行。
  ▸ fs.write src/utils.ts
  ⚠ fs.write src/utils.ts [y/n] y
  ✓ done
  > █

  Phase 2（有需求时）— 轻量 ANSI 控制，零新依赖

  在 render.ts 里加 ANSI escape codes：

  // render.ts 新增
  const CSI = '\x1b[';

  // 隐藏/显示光标（流式输出时不闪）
  export function hideCursor(): void    { process.stdout.write(`${CSI}?25l`); }
  export function showCursor(): void    { process.stdout.write(`${CSI}?25h`); }

  // 清除当前行
  export function clearLine(): void     { process.stdout.write(`${CSI}2K\r`); }

  // 光标上移 N 行 + 清除
  export function clearLines(n: number): void {
    for (let i = 0; i < n; i++) process.stdout.write(`${CSI}F${CSI}2K`);
  }

  // spinner 帧（工具执行时）
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  export function spinnerFrame(i: number): string { return SPINNER[i % SPINNER.length]; }

  此时 render.ts 只多了 ~30 行，零依赖。效果提升明显：

  > 重构 src/utils.ts
  ⠴ fs.read src/utils.ts        ← spinner 替代静态 ▸
✓ 15 lines
⠹ fs.write src/utils.ts
⚠ fs.write src/utils.ts [y/n] █

Phase 3（极少数场景）— terminal-kit，非 Ink

如果将来真的需要分栏布局（聊天 + 文件树 + diff 视图），选 terminal-kit 而非 Ink：

┌────────────────────┬──────────────────────────┬─────────────────────────────┐
│                    │       terminal-kit       │         Ink (React)         │
├────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 范式               │ 命令式，直接操作         │ 声明式，React reconciler    │
│                    │ terminal                 │                             │
├────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 与现有 render()    │ ✅ 可渐进替换单个函数    │ ❌ 全部塞进组件树           │
│ 兼容               │                          │                             │
├────────────────────┼──────────────────────────┼─────────────────────────────┤
│ bundle             │ ~200KB（按需加载）       │ ~2MB+（React + reconciler)  │
├────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 学习成本           │ 低（接近原生 ANSI）      │ 高（需理解 React + Ink      │
│                    │                          │ 两层）                      │
├────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 适合场景           │ 流式输出 + 偶尔 prompt   │ 静态/低刷新 TUI             │
└────────────────────┴──────────────────────────┴─────────────────────────────┘

---
结论

Phase 1（现在）    → 原生 readline，零新依赖
                    → 文件：chat.ts + render.ts（从 exec.ts 抽共享函数）
                    → 这是"协议的终端验收用例"，UI 越裸越好

Phase 2（以后）    → render.ts 加 ANSI escape codes
                    → 也是零依赖，只是多了几十行光标控制
                    → 触发条件：有人抱怨"光标闪得难受"

Phase 3（很久以后）→ terminal-kit，只有需要分栏布局才引入
                    → 不引入 React/Ink，保持 CLI 轻量

Phase 1 的总代价：chat.ts ~200 行 + render.ts ~80 行（其中 60 行从 exec.ts 搬），零新依赖，零新概念。内核一行不改。

```
