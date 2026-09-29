# Maleeha v0.4 public script inventory

This directory contains credential-free public copies of the scripts found in the client-side working materials and archive. API URLs, credentials, database paths, archive roots, and other environment-specific values must be provided through the authorized staging environment; they are not embedded here.

## Uploaded scripts

- `scripts/run_publish_product_v11.sh` and `scripts/publish_product_v11.mjs`: platform design publication.
- `scripts/run_export.sh` and `scripts/run_export.mjs`: paid-order export and optional state transition.
- `scripts/set_craft_fee.mjs`: country/channel craft-fee configuration.
- `scripts/admin_delist_products.mjs`: authorized administrator delisting with dry-run support.
- `scripts/sync_vendor_uploads.sh` and `scripts/sync_vendor_uploads.mjs`: design/effect archive synchronization.
- `tools/check_order.sh` and `tools/query_order_revenue.js`: read-only order/design-fee inspection by order code.

The public branch already contains sanitized `scripts/setup_tax_rates.mjs`, `scripts/process_shipping_csv.mjs`, and `tools/mark_shipped_from_csv.sh`.

## Deliberately not fabricated

`set_commission_tiers.ts` was not present in the inspected client archive. It is therefore not represented by a guessed script. It is a Pipeline-authoring target: the Pipeline must generate or update the implementation from the agreed end-to-end commission requirements, execute it in the authorized environment, and record the generated path, revision, inputs, and evidence in the Acceptance Manifest.

## Safety boundary

The copies in this public evaluation repository are not production credentials or production paths. A contractor must confirm the exact staging configuration, permissions, revision, invocation, evidence, and cleanup in the v0.4 Acceptance Manifest before any state-changing execution.
