#!/usr/bin/env bash
# liskin 本地开发脚本
#
# 用法：
#   ./scripts/dev.sh                  构建 + 启动 server + web（前台守护）
#   ./scripts/dev.sh --no-build       跳过构建直接启动
#   ./scripts/dev.sh exec "<prompt>"  用 agent exec 跑一次性任务（in-process，无 daemon）
#   ./scripts/dev.sh chat             启动交互式 REPL（in-process，无 daemon）
#   ./scripts/dev.sh watch            并行 tsup watch（core/tools/llm/server/client）
#   ./scripts/dev.sh stop             停掉本地 agent + web
#   ./scripts/dev.sh logs             tail 滚动看日志
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.run"
SERVER_LOG="$LOG_DIR/server.log"
WEB_LOG="$LOG_DIR/web.log"
SERVER_PID_FILE="$LOG_DIR/server.pid"
WEB_PID_FILE="$LOG_DIR/web.pid"

PORT_SERVER="${PORT_SERVER:-8787}"
PORT_WEB_PRIMARY="${PORT_WEB_PRIMARY:-5173}"
PORT_WEB_FALLBACK="${PORT_WEB_FALLBACK:-5174}"

# 抑制 Node 22 的 punycode 弃用警告（来自内置 url 模块的内部引用，非项目代码问题）
export NODE_OPTIONS='--no-deprecation'

mkdir -p "$LOG_DIR"

c_red()    { printf '\033[31m%s\033[0m' "$1"; }
c_green()  { printf '\033[32m%s\033[0m' "$1"; }
c_yellow() { printf '\033[33m%s\033[0m' "$1"; }
c_cyan()   { printf '\033[36m%s\033[0m' "$1"; }
c_dim()    { printf '\033[2m%s\033[0m' "$1"; }
log()  { echo "$(c_dim "[$(date '+%H:%M:%S')]") $*"; }
ok()   { log "$(c_green "✓") $*"; }
warn() { log "$(c_yellow "!") $*"; }
err()  { log "$(c_red "✗") $*"; }

# —— 加载 .env（不存在则告警但不阻塞 exec 之外的流程）——
load_env() {
  local env_file="$ROOT/.env"
  if [[ ! -f "$env_file" ]]; then
    warn ".env 不存在；参考 .env.example 创建。"
    return 0
  fi
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" | sed 's/^[[:space:]]*//;s/[[:space:]]*=[[:space:]]*=/=/')
  set +a
  ok "已加载 .env"
}

# —— 解析 LLM 配置：环境变量 > .env；exec 必须有 key ——
resolve_llm_config() {
  OPENAI_API_KEY="${OPENAI_API_KEY:-}"
  OPENAI_BASE_URL="${OPENAI_BASE_URL:-}"
  LISKIN_MODEL="${LISKIN_MODEL:-opensource/glm5.2}"
}

kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    warn "端口 $port 被占用 (PIDs: $pids)，尝试释放"
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
    sleep 0.3
  fi
}

free_ports() {
  kill_port "$PORT_SERVER"
  kill_port "$PORT_WEB_PRIMARY"
  kill_port "$PORT_WEB_FALLBACK"
}

stop_pidfile() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
}

cmd_stop() {
  log "正在停止 liskin 本地服务"
  stop_pidfile "$SERVER_PID_FILE"
  stop_pidfile "$WEB_PID_FILE"
  free_ports
  ok "已停止"
}

cmd_logs() {
  if [[ ! -f "$SERVER_LOG" && ! -f "$WEB_LOG" ]]; then
    err "暂无日志（先运行 ./scripts/dev.sh）"
    exit 1
  fi
  exec tail -F "$SERVER_LOG" "$WEB_LOG"
}

cmd_build() {
  log "构建 packages/* + client"
  pnpm -r --filter "./packages/**" run build >/dev/null
  pnpm --filter @liskin/client run build >/dev/null
  ok "构建完成"
}

cmd_start() {
  free_ports

  log "启动 agent server → http://127.0.0.1:$PORT_SERVER"
  : > "$SERVER_LOG"
  ( node "$ROOT/client/dist/cli.js" serve \
      --port "$PORT_SERVER" \
      --cors "http://localhost:$PORT_WEB_PRIMARY" \
      --cors "http://localhost:$PORT_WEB_FALLBACK" \
      >>"$SERVER_LOG" 2>&1
  ) &
  echo $! > "$SERVER_PID_FILE"

  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PORT_SERVER/healthz" >/dev/null 2>&1; then
      ok "agent server 就绪"
      break
    fi
    sleep 0.2
  done

  log "启动 web (vite) → http://localhost:$PORT_WEB_PRIMARY (FALLBACK: $PORT_WEB_FALLBACK)"
  : > "$WEB_LOG"
  ( cd "$ROOT/web" && pnpm dev >>"$WEB_LOG" 2>&1 ) &
  echo $! > "$WEB_PID_FILE"

  for _ in $(seq 1 50); do
    if grep -q "Local:" "$WEB_LOG" 2>/dev/null; then
      ok "web 就绪"
      break
    fi
    sleep 0.2
  done

  echo
  ok "全部启动完成"
  echo "  $(c_green '➜')  Agent : http://127.0.0.1:$PORT_SERVER"
  local web_url
  web_url=$(grep -oE 'http://localhost:[0-9]+/' "$WEB_LOG" | head -n1 || true)
  echo "  $(c_green '➜')  Web   : ${web_url:-http://localhost:$PORT_WEB_PRIMARY/}"
  echo "  $(c_dim '日志') : tail -F .run/server.log .run/web.log  (或 ./scripts/dev.sh logs)"
  echo "  $(c_dim '停止') : ./scripts/dev.sh stop"
  echo

  trap 'echo; cmd_stop; exit 0' INT TERM
  log "前台守护中，按 Ctrl+C 退出 ..."
  tail -F "$SERVER_LOG" "$WEB_LOG"
}

# —— agent exec：一次性任务，in-process，无 daemon ——
# 用法：./scripts/dev.sh exec "<prompt>" [-- cwd <path>] [-- max-turns N]
cmd_exec() {
  if [[ $# -lt 1 ]]; then
    err "用法：./scripts/dev.sh exec \"<prompt>\" [--cwd <path>] [--max-turns N]"
    exit 1
  fi
  local prompt="$1"
  shift

  local cwd="$ROOT"
  local max_turns="24"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        cwd="$2"
        shift 2
        ;;
      --max-turns)
        max_turns="$2"
        shift 2
        ;;
      *)
        warn "exec 忽略未知参数：$1"
        shift
        ;;
    esac
  done

  load_env
  resolve_llm_config

  if [[ -z "$OPENAI_API_KEY" ]]; then
    err "缺少 OPENAI_API_KEY：请在 .env 或环境变量里设置"
    exit 1
  fi

  # 确保 client 已构建
  if [[ ! -f "$ROOT/client/dist/cli.js" ]]; then
    log "client 未构建，先构建"
    pnpm --filter @liskin/client run build >/dev/null
  fi

  echo "$(c_cyan '▸') prompt : $(c_dim "$prompt")"
  echo "$(c_cyan '▸') model  : $LISKIN_MODEL @ $OPENAI_BASE_URL"
  echo "$(c_cyan '▸') cwd    : $cwd"
  echo

  cd "$cwd"
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  node "$ROOT/client/dist/cli.js" exec \
    --model "$LISKIN_MODEL" \
    --base-url "$OPENAI_BASE_URL" \
    --cwd "$cwd" \
    --max-turns "$max_turns" \
    "$prompt"
}

# —— agent chat：交互式 REPL，in-process，无 daemon ——
# 用法：./scripts/dev.sh chat [--model <model>] [--cwd <path>] [--confirm auto|ask|deny] [--no-save] [--resume <id>]
cmd_chat() {
  # 先加载 .env，再解析参数默认值——否则 local 变量在 load_env 前就求值了
  load_env
  resolve_llm_config

  local cwd="$ROOT"
  local model="${LISKIN_MODEL:-opensource/glm5.2}"
  local confirm="ask"
  local no_save=""
  local resume=""
  local system=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        cwd="$2"
        shift 2
        ;;
      --model)
        model="$2"
        shift 2
        ;;
      --confirm)
        confirm="$2"
        shift 2
        ;;
      --no-save)
        no_save="--no-save"
        shift
        ;;
      --resume)
        resume="--resume $2"
        shift 2
        ;;
      --system)
        system="--system $2"
        shift 2
        ;;
      *)
        warn "chat 忽略未知参数：$1"
        shift
        ;;
    esac
  done

  if [[ -z "$OPENAI_API_KEY" ]]; then
    err "缺少 OPENAI_API_KEY：请在 .env 或环境变量里设置"
    exit 1
  fi

  # 确保 client 已构建
  if [[ ! -f "$ROOT/client/dist/cli.js" ]]; then
    log "client 未构建，先构建"
    pnpm --filter @liskin/client run build >/dev/null
  fi

  echo "$(c_cyan '▸') model  : $model @ $OPENAI_BASE_URL"
  echo "$(c_cyan '▸') cwd    : $cwd"
  echo "$(c_cyan '▸') confirm: $confirm"
  echo

  cd "$cwd"
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  node "$ROOT/client/dist/cli.js" chat \
    --model "$model" \
    --base-url "$OPENAI_BASE_URL" \
    --cwd "$cwd" \
    --confirm "$confirm" \
    $no_save \
    $resume \
    $system
}

# —— watch：并行 tsup watch，改代码自动重建 ——
cmd_watch() {
  log "并行 tsup watch（core / tools / llm / server / client）"
  log "Ctrl+C 退出全部 watcher"
  # 并行跑所有 watch，-P 让任一退出都触发整体退出
  pnpm -r --parallel --filter "./packages/**" --filter "@liskin/client" run dev
}

cmd_help() {
  cat <<EOF
$(c_cyan 'liskin 本地开发脚本')

  $(c_green './scripts/dev.sh')                构建 + 启动 server + web（前台守护）
  $(c_green './scripts/dev.sh --no-build')     跳过构建直接启动
  $(c_green './scripts/dev.sh exec "<prompt>"')  用 agent exec 跑一次性任务
  $(c_green './scripts/dev.sh exec "<prompt>" --cwd /tmp/task --max-turns 30')
  $(c_green './scripts/dev.sh chat')            启动交互式 REPL（agent chat）
  $(c_green './scripts/dev.sh chat --confirm auto --no-save')
  $(c_green './scripts/dev.sh watch')          并行 tsup watch（改代码自动重建）
  $(c_green './scripts/dev.sh stop')           停掉本地 agent + web
  $(c_green './scripts/dev.sh logs')           tail 滚动看日志
  $(c_green './scripts/dev.sh help')           显示这条帮助

$(c_dim '环境变量（.env 或 shell）：')
  OPENAI_API_KEY     LLM key（exec 必填；serve 可选，缺省在 Web ⚙ 模型 里配）
  OPENAI_BASE_URL    OpenAI 兼容 endpoint
  LISKIN_MODEL       默认 model（默认 opensource/glm5.2）
  PORT_SERVER        agent server 端口（默认 8787）
  PORT_WEB_PRIMARY   web 主端口（默认 5173）
  PORT_WEB_FALLBACK  web 备用端口（默认 5174）

$(c_dim '示例：')
  cp .env.example .env && \$EDITOR .env
  ./scripts/dev.sh exec "用 matplotlib 画个柱状图存到 output/bar.png 并写 README 附图"
EOF
}

main() {
  local subcmd="${1:-}"
  case "$subcmd" in
    stop)
      cmd_stop
      ;;
    logs)
      cmd_logs
      ;;
    exec)
      shift
      cmd_exec "$@"
      ;;
    chat)
      shift
      cmd_chat "$@"
      ;;
    watch)
      cmd_watch
      ;;
    --no-build|no-build)
      load_env
      cmd_start
      ;;
    ''|start|up)
      load_env
      cmd_build
      cmd_start
      ;;
    -h|--help|help)
      cmd_help
      ;;
    *)
      err "未知子命令：${subcmd}（用 help 查看）"
      exit 1
      ;;
  esac
}

main "$@"
