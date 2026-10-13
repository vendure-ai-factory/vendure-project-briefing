#!/usr/bin/env bash
# Public, credential-free CSV shipment adapter for the Vendure evaluation tree.
#
# The script deliberately does not contain credentials, private paths, or a
# default internal API URL.  Provide those values through the environment when
# running against an explicitly authorized staging instance.

set -Eeuo pipefail

CSV_FILE="${ORDERS_EXPORT_CSV:-${1:-"$(pwd)/artifacts/orders_export.csv"}}"
API_URL="${VENDURE_ADMIN_API_URL:-}"
TOKEN="${VENDURE_ADMIN_TOKEN:-}"
DRY_RUN="${DRY_RUN:-false}"
HANDLER_CODE="${FULFILLMENT_HANDLER_CODE:-manual-fulfillment}"
SHIPMENT_METHOD="${SHIPMENT_METHOD:-CSV Batch}"
TRACKING_PREFIX="${TRACKING_PREFIX:-CSV-}"
MARK_BATCH_EXPORTED="${MARK_BATCH_EXPORTED:-true}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

[[ -f "$CSV_FILE" ]] || die "CSV file not found: $CSV_FILE"
require_command curl
require_command jq
require_command python3

if [[ "$DRY_RUN" != "true" && "$DRY_RUN" != "false" ]]; then
  die "DRY_RUN must be true or false"
fi

if [[ "$DRY_RUN" == "false" ]]; then
  [[ -n "$API_URL" ]] || die "VENDURE_ADMIN_API_URL is required unless DRY_RUN=true"
  [[ -n "$TOKEN" ]] || die "VENDURE_ADMIN_TOKEN is required unless DRY_RUN=true"
fi

echo "=== CSV-Based Bulk Shipping Tool (public adapter) ==="
echo "CSV: $CSV_FILE"

mapfile -t CODES < <(python3 - "$CSV_FILE" <<'PY'
import csv
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8-sig", newline="") as handle:
    reader = csv.DictReader(handle)
    required = {"已发货", "订单号"}
    missing = required.difference(reader.fieldnames or [])
    if missing:
        raise SystemExit("Missing CSV columns: " + ", ".join(sorted(missing)))

    seen = set()
    for row in reader:
        if (row.get("已发货") or "").strip() != "1":
            continue
        code = (row.get("订单号") or "").strip()
        if code and code not in seen:
            print(code)
            seen.add(code)
PY
)

if ((${#CODES[@]} == 0)); then
  echo "No orders marked with '1' in the 已发货 column."
  exit 0
fi

echo "Found ${#CODES[@]} order(s) marked for shipment."
printf '  %s\n' "${CODES[@]}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY_RUN=true; no API request was sent."
  exit 0
fi

graphql() {
  local payload="$1"
  curl --fail-with-body --silent --show-error \
    --request POST "$API_URL" \
    --header "Content-Type: application/json" \
    --header "Authorization: Bearer $TOKEN" \
    --header "vendure-auth-token: $TOKEN" \
    --data "$payload"
}

SUCCESS_COUNT=0
FAIL_COUNT=0

for code in "${CODES[@]}"; do
  echo "Processing order $code..."

  order_payload=$(jq -n --arg code "$code" '{
    query: "query GetOrder($code: String!) { orders(options: { filter: { code: { eq: $code } } }) { items { id lines { id quantity } fulfillments { id } } } }",
    variables: { code: $code }
  }')
  order_data=$(graphql "$order_payload") || {
    echo " -> [FAIL] API request failed while reading order $code" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  }

  if jq -e '(.errors // []) | length > 0' >/dev/null <<<"$order_data"; then
    echo " -> [FAIL] API returned an error for $code: $(jq -c '.errors' <<<"$order_data")" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  order_id=$(jq -r '.data.orders.items[0].id // empty' <<<"$order_data")
  if [[ -z "$order_id" ]]; then
    echo " -> [FAIL] Order $code was not found" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  fulfillment_count=$(jq '.data.orders.items[0].fulfillments | length' <<<"$order_data")
  if [[ "$fulfillment_count" != "0" ]]; then
    echo " -> [SKIP] $code already has fulfillment records"
    continue
  fi

  lines=$(jq -c '.data.orders.items[0].lines | map({orderLineId: .id, quantity: .quantity})' <<<"$order_data")
  tracking="${TRACKING_PREFIX}$(date -u +%Y%m%d%H%M%S)-${code}"
  fulfill_payload=$(jq -n \
    --arg handler "$HANDLER_CODE" \
    --arg method "$SHIPMENT_METHOD" \
    --arg tracking "$tracking" \
    --argjson lines "$lines" '{
      query: "mutation Fulfill($input: FulfillmentInput!) { addFulfillmentToOrder(input: $input) { __typename ... on ErrorResult { message } } }",
      variables: {
        input: {
          lines: $lines,
          handler: {
            code: $handler,
            arguments: [
              { name: "method", value: $method },
              { name: "trackingNumber", value: $tracking }
            ]
          }
        }
      }
    }')
  fulfillment_data=$(graphql "$fulfill_payload") || {
    echo " -> [FAIL] API request failed while fulfilling $code" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  }

  result_type=$(jq -r '.data.addFulfillmentToOrder.__typename // empty' <<<"$fulfillment_data")
  if [[ "$result_type" != "Fulfillment" ]]; then
    message=$(jq -r '.data.addFulfillmentToOrder.message // .errors[0].message // "Unknown error"' <<<"$fulfillment_data")
    echo " -> [FAIL] $code: $message" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  echo " -> [SUCCESS] $code marked shipped"
  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))

  if [[ "$MARK_BATCH_EXPORTED" == "true" ]]; then
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    mark_payload=$(jq -n --arg id "$order_id" --arg ts "$timestamp" '{
      query: "mutation MarkExported($id: ID!, $ts: DateTime!) { setOrderCustomFields(input: { id: $id, customFields: { batchExportedAt: $ts } }) { id } }",
      variables: { id: $id, ts: $ts }
    }')
    if graphql "$mark_payload" >/dev/null; then
      echo "    [MARKED] batchExportedAt=$timestamp"
    else
      echo "    [WARN] Could not write batchExportedAt for $code" >&2
    fi
  fi
done

echo "Done. Success: $SUCCESS_COUNT; failed: $FAIL_COUNT"
((FAIL_COUNT == 0))
