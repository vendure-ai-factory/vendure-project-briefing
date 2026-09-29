#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "Usage: ./check_order.sh <order-code>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERY_SCRIPT="${QUERY_ORDER_REVENUE_SCRIPT:-$SCRIPT_DIR/query_order_revenue.js}"

if [[ ! -f "$QUERY_SCRIPT" ]]; then
  echo "Missing query helper: $QUERY_SCRIPT" >&2
  exit 1
fi

exec node "$QUERY_SCRIPT" "$1"
