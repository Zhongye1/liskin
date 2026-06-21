能,而且这是个非常稳健的演进路线——**先用 Claude/OpenCode 方案打底(成本低、对模型友好、快速可用),再分阶段叠加 CodeRAG 和 AST/LSP 检索**。这两者不冲突,后者是前者的「检索能力增强层」,不是替换。我给你一套分阶段的设计。

## 一、为什么这个组合是对的

先理清三层各自解决什么问题,它们正交、可叠加:

| 层                           | 解决的问题                             | 类比         |
| ---------------------------- | -------------------------------------- | ------------ |
| **Claude/OpenCode 基础工具** | 怎么**读/写/改**文件(已知路径)         | 手和眼       |
| **CodeRAG(语义检索)**        | 在大仓库里**找到相关代码**(不知道在哪) | 模糊记忆     |
| **AST/LSP(结构检索)**        | **精确**找定义/引用/调用关系           | 编译器级理解 |

基础工具是地基,RAG 和 AST/LSP 是「让 agent 在不知道文件路径时也能定位到正确代码」的两种检索增强。OpenCode 本身就已经集成了 LSP——你之前看的源码里 `read.ts` 就 `yield* LSP.Service`,改完文件能拿诊断。所以这条路线 OpenCode 已经验证过。

## 二、分阶段路线图

### 阶段 0:Claude/OpenCode 基础工具(立即做)

直接照抄上几轮聊的那套,这是你 `packages/tools` 的核心:

- `fs_read` — 2000 行 / 2000 字符 / 50KB 三重截断 + 行号 + 分页 + miss fuzzy 提示
- `fs_edit` — 字符串/行号匹配 + fuzzy 兜底(对模型友好、省 token)
- `fs_write` / `fs_list`
- `grep` — 文本正则检索(大文件走持久化+preview,符合你之前的弱契约判断)
- `bash` — 沙箱执行 + ask 审批
- `glob` — 按模式找文件名

**这一层让 agent「能干活」**,且对中小模型友好,先把数据飞轮转起来。

### 阶段 1:LSP 检索(优先于 RAG)

我建议 **LSP 先于 RAG**,因为它 ROI 更高、更确定:

- **新增工具**:`lsp_definition`(跳转定义)、`lsp_references`(查所有引用)、`lsp_symbols`(列文件/工作区符号)、`lsp_diagnostics`(错误/警告)
- **价值**:agent 想改一个函数,先 `lsp_references` 拿到所有调用点,改完不漏。比让模型 grep 函数名(会误匹配字符串、注释)**精确得多**
- **实现**:挂 `tsserver`(你是 TS 项目,原生支持)、`rust-analyzer` 等,通过 LSP 协议拿结构信息
- **架构落点**:做成独立工具,经 ToolPort 暴露给内核,和文件工具同级

LSP 是**确定性的、零幻觉的**——它返回的引用就是编译器认定的引用,没有 RAG 的召回不准问题。

### 阶段 2:AST 检索(轻量,可与 LSP 并行)

LSP 偏重(要起 language server),AST 更轻、更快,适合做**结构化代码切分和快速符号提取**:

- **工具**:用 `tree-sitter` 解析,提供「按函数/类/方法切分」「提取所有函数签名」「找某个类的所有方法」
- **价值**:
  - 给 RAG 做**语义分块**(按函数边界切,而不是按固定行数切——分块质量直接决定 RAG 效果)
  - 让 agent 拿「文件的结构骨架」(只看函数签名,不读全文)→ 省 token 的 outline 模式
- **优势**:tree-sitter 多语言、无需起 server、毫秒级,适合做 read 的「结构化摘要」变体

### 阶段 3:CodeRAG(语义检索,最后做)

RAG 最复杂、最不确定,放最后,且**建立在 AST 分块之上**:

- **流程**:AST 按函数/类切块 → embedding → 向量库 → 查询时检索 top-k 相关代码块
- **工具**:`code_search(query: 自然语言)` → 返回最相关的代码片段 + 路径
- **价值**:大仓库里「找处理支付的逻辑在哪」这种**语义查询**,grep/LSP 都做不到,只有 RAG 能
- **难点**(为什么放最后):
  - 索引要维护(文件改了要重新 embedding,增量更新)
  - 召回质量不稳定(可能返回不相关代码,污染上下文)
  - 多端架构下,索引存哪、谁来建、怎么同步——又是状态管理问题
  - embedding 成本、向量库选型(本地 sqlite-vec / lancedb vs 外部服务)

## 三、关键架构原则(贯穿所有阶段)

让这套演进不返工的核心约束:

1. **全部走统一 ToolPort 抽象**:无论 fs_read、lsp_references 还是 code_search,对内核都是「一个 Tool」。内核不关心它底层是文件 IO、LSP 还是向量检索。这样加新检索工具**不动内核**。

2. **检索与读取分离**:RAG/LSP/AST 负责「找到 → 返回路径+位置」,真正读内容仍走 `fs_read`(保持你之前定的"Read 是强契约内容源")。**检索工具不直接吐大段内容**,只给定位,让模型再决定读哪些——省 token 且保持内容契约单一。

3. **检索是「弱契约」工具**:RAG/grep 的结果是衍生数据,可以走持久化+preview+分页(对应你之前 Bash/Grep 的分类)。只有 `fs_read` 是强契约。

4. **索引状态放内核或独立服务,别放外壳**:呼应你「内核不感知端」——RAG 索引、LSP server 实例都挂在内核侧或独立 sidecar,CLI/Web/IDE 共用,不在外壳各建一份。

## 四、给 Liskin 的落地建议

```
packages/tools/src/
├── fs/          # 阶段0:read/write/edit/list/glob
├── grep/        # 阶段0:文本检索
├── bash/        # 阶段0:沙箱执行
├── lsp/         # 阶段1:definition/references/symbols/diagnostics
├── ast/         # 阶段2:tree-sitter 切分/outline
└── coderag/     # 阶段3:语义检索(依赖 ast 分块)
```

**优先级**:阶段 0 → 1(LSP)→ 2(AST)→ 3(RAG)。理由:确定性高的先上(LSP/AST 零幻觉),不确定的(RAG)最后上且可选。很多场景 **LSP+AST+grep 已经覆盖 80% 检索需求**,RAG 是锦上添花,不是必需——别一开始就陷进向量库的工程泥潭。

**和你 eval 飞轮的配合**:阶段 0 先跑起来收数据,用 eval 看「agent 在哪些任务上因为'找不到代码'而失败」——**用数据决定到底要不要上 RAG、先上哪种检索**,而不是凭感觉堆能力。这正是你「eval-driven」哲学的应用。

一句话:**完全可行,而且推荐——Claude/OpenCode 基础工具打底(对模型友好、省 token、快速起飞),然后按"LSP(确定性最高)→ AST(轻量分块)→ CodeRAG(最复杂、可选)"分阶段叠加。关键是全走统一 ToolPort、检索只给定位不吐大内容、索引状态放内核侧,这样每加一层都不动内核。让 eval 数据告诉你 RAG 到底值不值得上。**

要我把这套分阶段的工具层架构(含 ToolPort 接口、各阶段工具签名、检索↔读取分离的协议)整理成一份 Liskin 的 roadmap 设计文档吗?

```


Liskin 检索与读取能力 — 工具层分阶段架构设计
范围:packages/tools 的「读取 / 检索」能力演进。
原则:检索负责定位，读取负责取内容；两者分离、各走弱 / 强契约；新增能力不动内核。
现状对齐：基于现有 ToolImpl / ToolExecContext / ToolPort / ConfirmPolicy / preflight+execute 双阶段抽象，不引入新顶层概念。
0. 设计公理
内核不感知工具底层: 文件 IO、LSP、AST、向量检索，对内核都只是「一个 ToolImpl」, 经 ToolPort(由 ToolRegistry 实现) 统一暴露。
检索 ↔ 读取分离: 检索类工具 (grep /lsp/ast /coderag)只返回「定位信息」(路径 + 行号范围 + 摘要), 不返回大段文件正文；真正取内容统一走 fs_read。
强契约 vs 弱契约:
fs_read 是强契约—— 输出必须等于磁盘真实字节，禁止「落盘→读回」, 直接来自 readFile。
grep /lsp/ast /coderag 是弱契约—— 结果是衍生数据，可截断、分页、摘要、走 preview。
状态归内核 /sidecar, 不归外壳:LSP server 实例、AST 缓存、RAG 索引一律挂内核侧或独立 sidecar,CLI/Web/IDE 共用同一份，杜绝跨端重复与漂移。
eval 驱动取舍: 每阶段先收 eval 数据，用「因找不到代码而失败」的样本占比，决定是否推进下一阶段。
1. 复用现有抽象 (不新增顶层概念)
现有 ToolImpl(摘自 packages/tools/src/types.ts):
export interface ToolImpl {
  definition: ToolDefinition;
  execute(args: unknown, ctx: ToolExecContext, callbacks?: ToolExecCallbacks): Promise<string>;
  preflight?(call: ToolCall, ctx: ToolExecContext): void; // 校验入参 / 路径白名单 / ConfirmRequiredError
}

export interface ToolExecContext {
  cwd: string;
  signal?: AbortSignal;
  confirmPolicy: ConfirmPolicy;
  pathWhitelist: string[];
}
新增能力一律实现 ToolImpl, 经 ToolRegistry(ToolPort) 注册。检索类工具复用同一套 preflight(路径白名单校验)+ execute(只读、可 auto-approve)。
为承载「检索 sidecar 状态」, 后续可在 ToolExecContext 增补可选只读句柄 (不破坏现有签名):
export interface ToolExecContext {
  cwd: string;
  signal?: AbortSignal;
  confirmPolicy: ConfirmPolicy;
  pathWhitelist: string[];
  // —— 阶段 1+ 增补(全部可选,旧工具无感)——
  lsp?: LspService;       // 阶段1:LSP 句柄(内核侧单例)
  ast?: AstService;       // 阶段2:tree-sitter 解析器
  index?: CodeIndex;      // 阶段3:RAG 向量索引
}
2. 检索 ↔ 读取分离协议 (贯穿所有阶段)
所有检索工具返回统一的定位结构 Location[], 而非正文:
// 建议放 packages/protocol 或 packages/tools/src/types.ts
export interface CodeLocation {
  path: string;        // 相对工作区根
  startLine: number;   // 1-indexed
  endLine: number;
  preview: string;     // 单行/数行摘要,非完整正文(弱契约)
  kind?: 'definition' | 'reference' | 'symbol' | 'match' | 'semantic';
  score?: number;      // RAG/排序用,可选
}
调用闭环(模型视角):
检索工具 (grep/lsp/ast/coderag)
    └─▶ 返回 CodeLocation[](只给定位 + 摘要)
            └─▶ 模型挑选 N 处真正需要的
                    └─▶ 调 fs_read(path, offset=startLine, limit=…)
                            └─▶ 取回字节级精确正文(强契约)
收益:① 检索结果小、省 token;② 正文来源唯一 (fs_read), 内容契约不被多个工具稀释；③ 模型决定「读哪些」, 而非检索工具替它决定。
3. 阶段 0 — 基础读写 (立即落地)
参照 Claude Code / OpenCode 方案，对模型友好、省 token、容错高。现有 builtin/ 已有 fs-read.ts / fs-write.ts / shell-exec.ts, 本阶段把 fs_read 做到位。
3.1 fs_read(强契约核心)
入参 schema (zod, 实现内校验):
const FsReadArgs = z.object({
  path: z.string().min(1),                       // 相对工作区根
  offset: z.number().int().positive().optional(),// 起始行,1-indexed
  limit: z.number().int().positive().max(5000).optional(),
});
硬约束 (抄 OpenCode 常量，三重截断):
const DEFAULT_LIMIT = 2000;   // 默认行数上限
const MAX_LINE_LEN  = 2000;   // 单行字符上限,超出加 "... (line truncated)"
const MAX_BYTES     = 50*1024;// 文件字节上限
行为:
实时 readFile,绝不缓存内容、绝不落盘读回。
输出带行号:<n>: <content>, 供后续 edit 精确引用。
三重截断任一触发 → 截断并明确标注 [文件共 N 行,已显示 a-b,使用 offset 继续]。
二进制嗅探 (前 4096 字节)→ 命中则 ok:false, "二进制文件,无法以文本读取"。
文件不存在 → fuzzy 匹配同目录最多 3 个近似名返回 (OpenCode miss 模式)。
preflight: 路径规范化 + pathWhitelist 前缀校验 + 符号链接 realpath 解析，防越界；只读，默认 auto-approve。
3.2 grep(弱契约，阶段 0 的检索)
const GrepArgs = z.object({
  pattern: z.string(),
  glob: z.string().optional(),
  maxMatches: z.number().int().positive().max(500).default(200),
});
返回 CodeLocation[](kind:'match',preview = 匹配行)。匹配量大 → 截断 + 分页提示，走 preview, 不吐全文。
3.3 阶段 0 工具清单
工具	契约	审批	说明
fs_read	强	auto	行号 + 三重截断 + 分页 + miss 提示
fs_write	—	ask	写入走确认
fs_edit	—	ask	字符串 / 行号匹配 + fuzzy 兜底 (对模型友好)
fs_list / glob	弱	auto	列目录 / 找文件名
grep	弱	auto	文本检索，返回 Location
shell_exec	—	ask	沙箱执行
出口标准:agent 能在已知 / 可 grep 的前提下完成读改任务；eval 跑通，数据飞轮启动。
4. 阶段 1 — LSP 检索 (确定性最高，优先于 RAG)
OpenCode 已验证:read 时挂 LSP service 取诊断。LSP 返回编译器认定的结果，零幻觉。
4.1 新增工具签名
// 全部返回 CodeLocation[],只给定位,正文仍走 fs_read
lsp_definition(args: { path: string; line: number; col: number }): CodeLocation[]; // 跳定义
lsp_references(args: { path: string; line: number; col: number }): CodeLocation[]; // 查所有引用
lsp_symbols(args:    { path?: string; query?: string }):           CodeLocation[]; // 文件/工作区符号
lsp_diagnostics(args:{ path: string }): Array<{ loc: CodeLocation; severity: string; message: string }>;
4.2 实现要点
tsserver(TS 项目原生)、rust-analyzer 等，内核侧单例 LspService, 经 ctx.lsp 注入。
价值: 改函数前 lsp_references 拿全部调用点，改完不漏；比 grep 函数名精确 (不误匹配注释 / 字符串)。
弱契约，auto-approve;preflight 仍做路径白名单。
出口标准:eval 显示「改动遗漏调用点 / 误改」类失败显著下降。
5. 阶段 2 — AST 检索 (轻量，可与阶段 1 并行)
tree-sitter, 多语言、无需起 server、毫秒级。两大用途:
5.1 工具签名
ast_outline(args: { path: string }): Array<{ name: string; kind: 'func'|'class'|'method'; loc: CodeLocation }>;
// 返回文件结构骨架(签名级),让模型先看 outline 再决定读哪段 → 省 token
ast_chunks(args: { path: string }): CodeLocation[];
// 按函数/类边界切块,供阶段3 RAG 做语义分块(分块质量决定 RAG 效果)
5.2 要点
ast_outline 是 fs_read 的「结构化摘要」变体：只给签名，不读全文，大文件理解省 token。
ast_chunks 是阶段 3 的前置依赖——RAG 必须按语义边界切，而非固定行数。
弱契约，auto-approve。
出口标准: 大文件理解 token 下降；为 RAG 提供高质量分块。
6. 阶段 3 — CodeRAG 语义检索 (最复杂，可选，最后做)
仅当 eval 数据表明「因语义层面找不到相关代码而失败」占比显著时才推进。
6.1 工具签名
code_search(args: { query: string; topK?: number }): CodeLocation[];
// 自然语言查询 → 返回最相关代码块定位(kind:'semantic', 带 score),正文仍走 fs_read
6.2 管线
ast_chunks 切块 → embedding → 向量库(本地 sqlite-vec / lancedb 优先)
                                   └─▶ query 时检索 top-k → CodeLocation[]
6.3 难点与对策 (为什么放最后)
难点	对策
索引随文件变更失效	文件 mtime 触发增量 re-embedding; 监听写工具事件
召回不准污染上下文	只返回 Location + score,不直接灌正文; 低分阈值过滤
多端索引存哪	索引归内核 /sidecar (ctx.index),CLI/Web/IDE 共用一份
embedding 成本 / 选型	默认本地向量库，外部服务可插拔
出口标准: 语义查询任务成功率提升，且索引维护成本可控。
7. 目录规划
packages/tools/src/
├── types.ts            # ToolImpl / ToolExecContext(增补可选 lsp/ast/index)
├── registry.ts         # ToolPort 实现,所有阶段工具在此注册
├── sandbox/            # confirm-policy / 路径白名单(全阶段共用 preflight)
├── builtin/            # 阶段0:fs-read / fs-write / fs-edit / fs-list / glob / grep / shell-exec
├── lsp/                # 阶段1:definition / references / symbols / diagnostics
├── ast/                # 阶段2:outline / chunks(tree-sitter)
└── coderag/            # 阶段3:code_search + 索引管线(依赖 ast/chunks)
8. 优先级与决策门
阶段	能力	确定性	成本	推进条件
0	fs_read/write/edit + grep + bash	高	低	立即
1	LSP 检索	最高 (零幻觉)	中	阶段 0 跑通后立即
2	AST outline/chunks	高	低	与阶段 1 并行
3	CodeRAG 语义检索	低 (召回不稳)	高	eval 证明必要后才做
核心判断:LSP + AST + grep 通常已覆盖约 80% 检索需求，CodeRAG 是锦上添花而非必需。不要一开始陷入向量库工程泥潭；让 eval 数据决定 RAG 的取舍与优先级 —— 这是 eval-driven 哲学在工具层的落地。
9. 不变式 (任何阶段都不得违反)
fs_read 永远强契约：实时读磁盘、字节级精确、禁止落盘读回。
检索工具只给 CodeLocation[], 不吐大段正文；正文唯一来源是 fs_read。
所有工具实现 ToolImpl, 经 ToolPort 暴露；新增能力不修改内核。
路径安全统一在 preflight + pathWhitelist, 不在各工具重复实现。
检索状态 (LSP/AST/RAG) 归内核 /sidecar, 不进任何外壳。Liskin 检索与读取能力 — 工具层分阶段架构设计
范围:packages/tools 的「读取 / 检索」能力演进。
原则:检索负责定位，读取负责取内容；两者分离、各走弱 / 强契约；新增能力不动内核。
现状对齐：基于现有 ToolImpl / ToolExecContext / ToolPort / ConfirmPolicy / preflight+execute 双阶段抽象，不引入新顶层概念。
0. 设计公理
内核不感知工具底层: 文件 IO、LSP、AST、向量检索，对内核都只是「一个 ToolImpl」, 经 ToolPort(由 ToolRegistry 实现) 统一暴露。
检索 ↔ 读取分离: 检索类工具 (grep /lsp/ast /coderag)只返回「定位信息」(路径 + 行号范围 + 摘要), 不返回大段文件正文；真正取内容统一走 fs_read。
强契约 vs 弱契约:
fs_read 是强契约—— 输出必须等于磁盘真实字节，禁止「落盘→读回」, 直接来自 readFile。
grep /lsp/ast /coderag 是弱契约—— 结果是衍生数据，可截断、分页、摘要、走 preview。
状态归内核 /sidecar, 不归外壳:LSP server 实例、AST 缓存、RAG 索引一律挂内核侧或独立 sidecar,CLI/Web/IDE 共用同一份，杜绝跨端重复与漂移。
eval 驱动取舍: 每阶段先收 eval 数据，用「因找不到代码而失败」的样本占比，决定是否推进下一阶段。
1. 复用现有抽象 (不新增顶层概念)
现有 ToolImpl(摘自 packages/tools/src/types.ts):
export interface ToolImpl {
  definition: ToolDefinition;
  execute(args: unknown, ctx: ToolExecContext, callbacks?: ToolExecCallbacks): Promise<string>;
  preflight?(call: ToolCall, ctx: ToolExecContext): void; // 校验入参 / 路径白名单 / ConfirmRequiredError
}

export interface ToolExecContext {
  cwd: string;
  signal?: AbortSignal;
  confirmPolicy: ConfirmPolicy;
  pathWhitelist: string[];
}
新增能力一律实现 ToolImpl, 经 ToolRegistry(ToolPort) 注册。检索类工具复用同一套 preflight(路径白名单校验)+ execute(只读、可 auto-approve)。
为承载「检索 sidecar 状态」, 后续可在 ToolExecContext 增补可选只读句柄 (不破坏现有签名):
export interface ToolExecContext {
  cwd: string;
  signal?: AbortSignal;
  confirmPolicy: ConfirmPolicy;
  pathWhitelist: string[];
  // —— 阶段 1+ 增补(全部可选,旧工具无感)——
  lsp?: LspService;       // 阶段1:LSP 句柄(内核侧单例)
  ast?: AstService;       // 阶段2:tree-sitter 解析器
  index?: CodeIndex;      // 阶段3:RAG 向量索引
}
2. 检索 ↔ 读取分离协议 (贯穿所有阶段)
所有检索工具返回统一的定位结构 Location[], 而非正文:
// 建议放 packages/protocol 或 packages/tools/src/types.ts
export interface CodeLocation {
  path: string;        // 相对工作区根
  startLine: number;   // 1-indexed
  endLine: number;
  preview: string;     // 单行/数行摘要,非完整正文(弱契约)
  kind?: 'definition' | 'reference' | 'symbol' | 'match' | 'semantic';
  score?: number;      // RAG/排序用,可选
}
调用闭环(模型视角):
检索工具 (grep/lsp/ast/coderag)
    └─▶ 返回 CodeLocation[](只给定位 + 摘要)
            └─▶ 模型挑选 N 处真正需要的
                    └─▶ 调 fs_read(path, offset=startLine, limit=…)
                            └─▶ 取回字节级精确正文(强契约)
收益:① 检索结果小、省 token;② 正文来源唯一 (fs_read), 内容契约不被多个工具稀释；③ 模型决定「读哪些」, 而非检索工具替它决定。
3. 阶段 0 — 基础读写 (立即落地)
参照 Claude Code / OpenCode 方案，对模型友好、省 token、容错高。现有 builtin/ 已有 fs-read.ts / fs-write.ts / shell-exec.ts, 本阶段把 fs_read 做到位。
3.1 fs_read(强契约核心)
入参 schema (zod, 实现内校验):
const FsReadArgs = z.object({
  path: z.string().min(1),                       // 相对工作区根
  offset: z.number().int().positive().optional(),// 起始行,1-indexed
  limit: z.number().int().positive().max(5000).optional(),
});
硬约束 (抄 OpenCode 常量，三重截断):
const DEFAULT_LIMIT = 2000;   // 默认行数上限
const MAX_LINE_LEN  = 2000;   // 单行字符上限,超出加 "... (line truncated)"
const MAX_BYTES     = 50*1024;// 文件字节上限
行为:
实时 readFile,绝不缓存内容、绝不落盘读回。
输出带行号:<n>: <content>, 供后续 edit 精确引用。
三重截断任一触发 → 截断并明确标注 [文件共 N 行,已显示 a-b,使用 offset 继续]。
二进制嗅探 (前 4096 字节)→ 命中则 ok:false, "二进制文件,无法以文本读取"。
文件不存在 → fuzzy 匹配同目录最多 3 个近似名返回 (OpenCode miss 模式)。
preflight: 路径规范化 + pathWhitelist 前缀校验 + 符号链接 realpath 解析，防越界；只读，默认 auto-approve。
3.2 grep(弱契约，阶段 0 的检索)
const GrepArgs = z.object({
  pattern: z.string(),
  glob: z.string().optional(),
  maxMatches: z.number().int().positive().max(500).default(200),
});
返回 CodeLocation[](kind:'match',preview = 匹配行)。匹配量大 → 截断 + 分页提示，走 preview, 不吐全文。
3.3 阶段 0 工具清单
工具	契约	审批	说明
fs_read	强	auto	行号 + 三重截断 + 分页 + miss 提示
fs_write	—	ask	写入走确认
fs_edit	—	ask	字符串 / 行号匹配 + fuzzy 兜底 (对模型友好)
fs_list / glob	弱	auto	列目录 / 找文件名
grep	弱	auto	文本检索，返回 Location
shell_exec	—	ask	沙箱执行
出口标准:agent 能在已知 / 可 grep 的前提下完成读改任务；eval 跑通，数据飞轮启动。
4. 阶段 1 — LSP 检索 (确定性最高，优先于 RAG)
OpenCode 已验证:read 时挂 LSP service 取诊断。LSP 返回编译器认定的结果，零幻觉。
4.1 新增工具签名
// 全部返回 CodeLocation[],只给定位,正文仍走 fs_read
lsp_definition(args: { path: string; line: number; col: number }): CodeLocation[]; // 跳定义
lsp_references(args: { path: string; line: number; col: number }): CodeLocation[]; // 查所有引用
lsp_symbols(args:    { path?: string; query?: string }):           CodeLocation[]; // 文件/工作区符号
lsp_diagnostics(args:{ path: string }): Array<{ loc: CodeLocation; severity: string; message: string }>;
4.2 实现要点
tsserver(TS 项目原生)、rust-analyzer 等，内核侧单例 LspService, 经 ctx.lsp 注入。
价值: 改函数前 lsp_references 拿全部调用点，改完不漏；比 grep 函数名精确 (不误匹配注释 / 字符串)。
弱契约，auto-approve;preflight 仍做路径白名单。
出口标准:eval 显示「改动遗漏调用点 / 误改」类失败显著下降。
5. 阶段 2 — AST 检索 (轻量，可与阶段 1 并行)
tree-sitter, 多语言、无需起 server、毫秒级。两大用途:
5.1 工具签名
ast_outline(args: { path: string }): Array<{ name: string; kind: 'func'|'class'|'method'; loc: CodeLocation }>;
// 返回文件结构骨架(签名级),让模型先看 outline 再决定读哪段 → 省 token
ast_chunks(args: { path: string }): CodeLocation[];
// 按函数/类边界切块,供阶段3 RAG 做语义分块(分块质量决定 RAG 效果)
5.2 要点
ast_outline 是 fs_read 的「结构化摘要」变体：只给签名，不读全文，大文件理解省 token。
ast_chunks 是阶段 3 的前置依赖——RAG 必须按语义边界切，而非固定行数。
弱契约，auto-approve。
出口标准: 大文件理解 token 下降；为 RAG 提供高质量分块。
6. 阶段 3 — CodeRAG 语义检索 (最复杂，可选，最后做)
仅当 eval 数据表明「因语义层面找不到相关代码而失败」占比显著时才推进。
6.1 工具签名
code_search(args: { query: string; topK?: number }): CodeLocation[];
// 自然语言查询 → 返回最相关代码块定位(kind:'semantic', 带 score),正文仍走 fs_read
6.2 管线
ast_chunks 切块 → embedding → 向量库(本地 sqlite-vec / lancedb 优先)
                                   └─▶ query 时检索 top-k → CodeLocation[]
6.3 难点与对策 (为什么放最后)
难点	对策
索引随文件变更失效	文件 mtime 触发增量 re-embedding; 监听写工具事件
召回不准污染上下文	只返回 Location + score,不直接灌正文; 低分阈值过滤
多端索引存哪	索引归内核 /sidecar (ctx.index),CLI/Web/IDE 共用一份
embedding 成本 / 选型	默认本地向量库，外部服务可插拔
出口标准: 语义查询任务成功率提升，且索引维护成本可控。
7. 目录规划
packages/tools/src/builtin/tool_Read/
├── types.ts            # ToolImpl / ToolExecContext(增补可选 lsp/ast/index)
├── registry.ts         # ToolPort 实现,所有阶段工具在此注册
├── sandbox/            # confirm-policy / 路径白名单(全阶段共用 preflight)
├── builtin/            # 阶段0:fs-read / fs-write / fs-edit / fs-list / glob / grep / shell-exec
├── lsp/                # 阶段1:definition / references / symbols / diagnostics
├── ast/                # 阶段2:outline / chunks(tree-sitter)
└── coderag/            # 阶段3:code_search + 索引管线(依赖 ast/chunks)
8. 优先级与决策门
阶段	能力	确定性	成本	推进条件
0	fs_read/write/edit + grep + bash	高	低	立即
1	LSP 检索	最高 (零幻觉)	中	阶段 0 跑通后立即
2	AST outline/chunks	高	低	与阶段 1 并行
3	CodeRAG 语义检索	低 (召回不稳)	高	eval 证明必要后才做
核心判断:LSP + AST + grep 通常已覆盖约 80% 检索需求，CodeRAG 是锦上添花而非必需。不要一开始陷入向量库工程泥潭；让 eval 数据决定 RAG 的取舍与优先级 —— 这是 eval-driven 哲学在工具层的落地。
9. 不变式 (任何阶段都不得违反)
fs_read 永远强契约：实时读磁盘、字节级精确、禁止落盘读回。
检索工具只给 CodeLocation[], 不吐大段正文；正文唯一来源是 fs_read。
所有工具实现 ToolImpl, 经 ToolPort 暴露；新增能力不修改内核。
路径安全统一在 preflight + pathWhitelist, 不在各工具重复实现。
检索状态 (LSP/AST/RAG) 归内核 /sidecar, 不进任何外壳。

```
