/**
 * agent exec 默认系统提示词。
 *
 * 仅当用户未通过 --system 参数提供自定义提示词时使用。
 * 设计原则：精简、只声明可用工具和行为偏好，不角色扮演。
 *
 * ---
 *
 * ## agent exec 命令参数
 *
 * ```
 * agent exec <prompt> [options]
 * ```
 *
 * | 参数 | 类型 | 默认值 | 说明 |
 * |------|------|--------|------|
 * | `<prompt>` | string | **必填** | 任务描述，直接作为首条 user 消息发送给 LLM |
 * | `--cwd <path>` | string | `process.cwd()` | 工作目录，同时作为沙箱路径白名单的根 |
 * | `--model <model>` | string | `gpt-4o-mini` | LLM 模型 ID，最终传给 Provider |
 * | `--base-url <url>` | string | — | LLM API 地址（OpenAI 兼容协议），覆盖默认 endpoint |
 * | `--max-turns <n>` | number | `24` | 单次任务最大 LLM 回合数，防止无限循环 |
 * | `--system <text>` | string | 本文件的值 | 系统提示词，注入为 messages[0]（role: "system"） |
 *
 * ## 配置来源优先级
 *
 * ```
 * apiKey:   OPENAI_API_KEY  >  LISKIN_API_KEY  >  ~/.liskin/config.json
 * baseURL:  --base-url       >  OPENAI_BASE_URL  >  ~/.liskin/config.json
 * model:    --model          >  LISKIN_MODEL     >  ~/.liskin/config.json  >  gpt-4o-mini
 * system:   --system         >  本文件 DEFAULT_SYSTEM_PROMPT
 * ```
 *
 * ---
 *
 * ## 标准配置示例
 *
 * ### 示例 1：最简调用（只设环境变量）
 *
 * ```bash
 * export OPENAI_API_KEY="sk-xxx"
 * agent exec "修复 src/utils.ts 的类型错误"
 * ```
 *
 * ### 示例 2：指定模型和自定义 system prompt
 *
 * ```bash
 * agent exec "解释 ./packages/core 的架构" \
 *   --model gpt-4o \
 *   --system "你是一个资深 TypeScript 架构师，回答应包含代码示例。"
 * ```
 *
 * ### 示例 3：使用兼容 OpenAI 协议的第三方 API
 *
 * ```bash
 * agent exec "写一个快速排序" \
 *   --base-url https://api.openrouter.ai/v1 \
 *   --model anthropic/claude-sonnet-4 \
 *   --max-turns 10
 * ```
 *
 * ### 示例 4：指定工作目录
 *
 * ```bash
 * agent exec "检查所有 ts 文件的 lint 错误" --cwd /home/user/my-project
 * ```
 *
 * ### 示例 5：配置文件方式（~/.liskin/config.json）
 *
 * ```json
 * {
 *   "apiKey": "sk-xxx",
 *   "baseURL": "https://api.openai.com/v1",
 *   "model": "gpt-4o-mini"
 * }
 * ```
 *
 * ```bash
 * agent exec "重构 ./src 下的模块"   # 自动读取 ~/.liskin/config.json
 * ```
 */

export const DEFAULT_SYSTEM_PROMPT =
  'You are a coding agent. Use fs.read/fs.write/shell.exec tools to complete tasks. Prefer writing files then running them. Be concise.';
