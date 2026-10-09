
#!/bin/bash
set -e

EXPORT_SCRIPT="${EXPORT_SCRIPT:-./tools/run_export.sh}"
MARK_SHIPPED_SCRIPT="${MARK_SHIPPED_SCRIPT:-./tools/mark_shipped_from_csv.sh}"

if [[ ! -x "$EXPORT_SCRIPT" ]]; then
  echo "ERROR: EXPORT_SCRIPT is not executable: $EXPORT_SCRIPT"
  exit 2
fi
if [[ ! -x "$MARK_SHIPPED_SCRIPT" ]]; then
  echo "ERROR: MARK_SHIPPED_SCRIPT is not executable: $MARK_SHIPPED_SCRIPT"
  exit 2
fi

echo "=== 🚀 Starting Full Multi-Country Verification Flow ==="

# 1. Run Verification Setup (Create products, users, orders)
echo ""
echo "[Step 1] Running TypeScript Setup & Order Creation..."
npx ts-node scripts/verify_multi_country_setup.ts

# 2. Export Orders to CSV
echo ""
echo "[Step 2] Exporting Orders to CSV..."
# Use the checked-out helper or set EXPORT_SCRIPT to an approved local helper.
"$EXPORT_SCRIPT" --country ALL

# 3. Simulate User Edit (Fill '1' in CSV)
echo ""
echo "[Step 3] Simulating User Marking Orders as Shipped..."
python3 scripts/simulate_csv_edit.py

# 4. Mark Shipped based on CSV
echo ""
echo "[Step 4] Running Batch Shipment..."
# Use the checked-out helper or set MARK_SHIPPED_SCRIPT to an approved local helper.
# Pipe 'y' to auto-confirm
printf 'y\n' | "$MARK_SHIPPED_SCRIPT"

echo ""
echo "=== ✅ Full Verification Sequence Complete ==="
echo "Please check the logs above for specific pass/fail details."
