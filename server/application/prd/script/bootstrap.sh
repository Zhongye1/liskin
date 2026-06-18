#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

if ! command -v go >/dev/null 2>&1; then
  echo "go is required but not installed"
  exit 1
fi

cd "${SERVER_ROOT}"
go mod tidy

cd "${APP_DIR}"
go run ./main.go
