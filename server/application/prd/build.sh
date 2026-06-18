#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${SERVER_ROOT}"

go mod tidy
CGO_ENABLED=0 go build -o "${SCRIPT_DIR}/prd" "${SCRIPT_DIR}/main.go"

echo "build success: ${SCRIPT_DIR}/prd"
