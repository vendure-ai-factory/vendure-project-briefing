# DELIVERY.md

## What is delivered

The pipeline repository ships the following components:

| Component | Path | Role |
|---|---|---|
| Pipeline engine | `src/cli.js` + `src/run.js` | CLI entry point, task orchestration, protected-path gating |
| Evidence collector | `src/evidenceCollector.js` | Writes and verifies all evidence through `writeEvidenceFile` and `writeTaskRecord` |
| Report generator | `src/reportGenerator.js` | Produces `compliance-report.json` and `compliance-report.md` from evidence |
| Pipeline-review Skill | `skills/pipeline-review/SKILL.md` + `skills/pipeline-review/review.js` | Independent verdict derivation from evidence; the authoritative gate |
| Staging entrypoint | `pipeline/run-staging.mjs` | Preflight checks, archive assembly, review invocation; the controlled runner interface |
| Executors | `src/executors/` | Per-task readiness modules wired into `cli.js` |

Current executors (each a **readiness subset**, not a full pass — see §Verdicts):

| Executor | Task | Scope key |
|---|---|---|
| `readOnlyShopApi.js` | CAN-B1-03 | `readiness` |
| `readOnlyShopApi.js` | CAN-B1-04 | `readiness` |
| `commissionTiers.js` | CAN-B2-08 | `commission-tiers` |
| `imageArchive.js` | CAN-B2-04 | `image-archive` |
| `shippingDryRun.js` | CAN-B2-16 | `shipping-dryrun` |

All other canonical tasks are **NOT_IMPLEMENTED** (no executor registered).

**Coverage rule:** Every executor above is a **readiness subset** (coverage: "readiness-subset"). An executor never claims a full PASS. Only a task record that explicitly shows `coverage: "full"` and `result: PASS` counts as full coverage. As of this delivery, no task record shows full coverage; the pipeline cannot produce a passing overall verdict in its current state.

---

## Exact run commands

### Single task (repo-relative paths)

```bash
# Single task, default outDir
node bin/pipeline.js run --manifest manifest/acceptance-manifest.v0.4.json --task CAN-B2-04

# With explicit scope (scope must be valid for the task — see VALID_SCOPES in cli.js)
node bin/pipeline.js run --manifest manifest/acceptance-manifest.v0.4.json --task CAN-B2-04 --scope image-archive

# With custom output directory
node bin/pipeline.js run --manifest manifest/acceptance-manifest.v0.4.json --task CAN-B2-16 --out ./reports/my-run
```

### All tasks

```bash
node bin/pipeline.js run --manifest manifest/acceptance-manifest.v0.4.json --task all
```

`--task all` iterates every task in the manifest. Run evidence lands in `evidence/<runId>/` and reports in `reports/<runId>/`.

### Pipeline-review Skill

```bash
# Review a specific run
node skills/pipeline-review/review.js <runId>

# Override evidence/reports base directories
PIPELINE_REVIEW_EVIDENCE_DIR=./evidence node skills/pipeline-review/review.js <runId>
```

### staging entrypoint (pipeline/run-staging.mjs)

```bash
# Minimal preflight only (default mode=preflight)
node pipeline/run-staging.mjs

# Full run with preflight first
PIPELINE_MODE=full PIPELINE_TASK=all \
  PIPELINE_ARCHIVE_ROOT=/opt/pipeline-archive \
  PIPELINE_RUN_ID=<run-id> \
  PIPELINE_STAGING_URL=https://staging.example.com \
  PIPELINE_SHOP_API_URL=https://staging.example.com/shop-api \
  node pipeline/run-staging.mjs
```

The staging entrypoint runs preflight checks (git HEAD, node version, free disk, archive writability, health, shop-API probe), then in `full` mode spawns `node bin/pipeline.js run` with the supplied task and the generated `PIPELINE_RUN_ID` injected into the child environment.

---

## Environment variable names

Only the **names** of environment variables used by the pipeline are recorded in evidence and logs. No secret values ever appear.

| Variable | Role |
|---|---|
| `PIPELINE_ARCHIVE_ROOT` | Archive mount point for run-staging.mjs (default `/opt/pipeline-archive`) |
| `PIPELINE_MODE` | `preflight` (default) or `full` |
| `PIPELINE_TASK` | Task selector passed to the pipeline (default `all`) |
| `PIPELINE_RUN_ID` | Run identifier; injected by run-staging.mjs into the pipeline child process |
| `PIPELINE_STAGING_URL` | Base URL of the staging Vendure instance |
| `PIPELINE_SHOP_API_URL` | Shop API base URL (defaults to `PIPELINE_STAGING_URL` + `/shop-api`) |
| `PIPELINE_EVIDENCE_BASE_DIR` | Base directory for evidence output (default `evidence`) |
| `CHANNEL_TOKENS` | JSON map of country-code or nominal token to channel token (e.g. `{"DE":"…","AT":"…","HU":"…","GB":"…"}`) |
| `STAGING_URL` | Alias for `PIPELINE_STAGING_URL` (used by readOnlyShopApi executor) |
| `CAN_B1_04_PLANT_MISMATCH` | Set truth-control in CAN-B1-04 executor (never in production) |
| `OPENROUTER_API_KEY` | LLM provider key (never forwarded to child scripts; only the name is logged) |
| `VENDURE_ADMIN_API_URL`, `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD`, `VENDURE_ADMIN_TOKEN`, `VENDURE_AUTH_TOKEN_HEADER` | Admin credentials; names listed in evidence, values never forwarded to executors |

---

## How to read compliance-report.md and Skill verdicts

### compliance-report.md

Written by `src/reportGenerator.js` into `reports/<runId>/compliance-report.md`. Every task row shows:

- **outcome** — derived from the task record's `result` field
- **result** — the terminal result string (`PASS`, `READINESS_PASS`, `BLOCK`, etc.)
- **classification** — the failure class if the result is not a pass
- **cause** — the specific cause within that class
- **protectedHashesMatch** — `true` only when start and end hashes are identical; null when not comparable
- **endHashMatchesPinned** — `true` only when the end hash matches the pinned hash in `index.json`

A `verifyOk: false` in the report header means the evidence index integrity check failed (hash mismatch, tampered file, or missing file). A `protectedPathMismatch` entry means at least one task's protected hash changed between task start and end.

### Skill verdicts (review.js)

The Skill runs after every formal run and writes its analysis to `archive/<runId>/review.txt`. It **never trusts the compliance report** — it re-derives every verdict from evidence hashes and record fields.

The possible verdicts are:

| Verdict | Meaning |
|---|---|
| **PASS** | Every assertion in the task's `expectedResult` is verified from real evidence. The record shows `result: PASS` and `coverage: "full"`. No unmet blocks, no missing evidence. |
| **READINESS_PASS** | The task ran and every in-scope assertion is verified. The record shows `result: READINESS_PASS` and `coverage: "readiness-subset"`. This is a **readiness subset**, not a full pass. |
| **BLOCK <class>** | A failure that cannot be resolved by the pipeline. `<class>` is one of `PIPELINE_DEFECT`, `APPLICATION_DEFECT`, `SAFETY_AUTHORIZATION`. The record's `result: BLOCK` with `classification` and `cause` fields explain the failure. |
| **MISSING_EVIDENCE** | A required evidence file, hash, or record field is absent, mismatched, or tampered. A task with `MISSING_EVIDENCE` can never resolve to a passing outcome. |
| **UNRESOLVED_ASSUMPTION** | The task depends on a value marked `PENDING_CLIENT`, a missing protected-hash pin, or another unconfirmed assumption. Never resolves to a passing outcome without client action. |

Overall precedence: `MISSING_EVIDENCE` → `BLOCK` (unmet) → `UNRESOLVED_ASSUMPTION` → `BLOCK` (pending only) → passing verdict.

A passing overall verdict additionally requires all 24 acceptance tasks to be present (CAN-B1-01 through CAN-B2-16). CAN-DEMO-01 is not an acceptance task.

---

## Protected paths and the freeze step

### Protected paths

The pipeline tracks five roots against a pinned hash before and after every run:

| Protected root | Rationale |
|---|---|
| `manifest/acceptance-manifest.v0.4.json` | The authoritative task definition — must not change mid-run |
| `manifest/inputs-registry.json` | Input freeze registry |
| `evaluation-demo/migration-input/` | Full isolated snapshot of the legacy source |
| `evaluation-demo/migration-input/legacy/vendure-store/scripts/` | Supplied scripts that executors call |
| `evaluation-demo/migration-input/legacy/vendure-store/tools/` | Supplied tools (shell scripts) that executors call |

Computed hashes are written to `evidence/<runId>/run-level/protected-end.json` (task-level entries carry `protectedStartHash`/`protectedEndHash` in their `record.json`). The end hash for each task must match its start hash unless the task is the one that intentionally changed a protected path.

### The freeze step

Before the first formal run, the protected-path hashes must be **frozen** by running:

```bash
node scripts/freeze-protected-hashes.js
```

This computes hashes for every file under the five protected roots and writes `manifest/protected-hashes.json`. On every subsequent run the pipeline verifies that `manifest/protected-hashes.json` matches the live protected-path hash; any discrepancy is a `BLOCK / SAFETY_AUTHORIZATION / PINNED_HASH_DIFF`.

If `manifest/protected-hashes.json` is absent, the run records an `UNRESOLVED_ASSUMPTION` for every task and can only produce a passing overall verdict after the freeze step is completed.

---

## Task table (24 acceptance tasks)

Readiness: executor present or **NOT_IMPLEMENTED**, and coverage. Every task with an executor is a **readiness-subset** unless the task record explicitly shows `coverage: "full"`.

| Task | Title | Executor | Coverage |
|---|---|---|---|
| CAN-B1-01 | Country terminology and cross-country browsing | NOT_IMPLEMENTED | — |
| CAN-B1-02 | New-country propagation and full regression | NOT_IMPLEMENTED | — |
| CAN-B1-03 | Currency and numeric-price alignment | `readOnlyShopApi.js` | readiness-subset |
| CAN-B1-04 | Product visibility and variant isolation | `readOnlyShopApi.js` | readiness-subset |
| CAN-B1-05 | Cart and checkout country locking | NOT_IMPLEMENTED | — |
| CAN-B1-06 | Payment callback and order-state consistency | NOT_IMPLEMENTED | — |
| CAN-B1-07 | Clean environment, rollback and restart behavior | NOT_IMPLEMENTED | — |
| CAN-B1-08 | Customer country selection and wallet currency | NOT_IMPLEMENTED | — |
| CAN-B2-01 | Platform design publication | NOT_IMPLEMENTED | — |
| CAN-B2-02 | Customer design publication form and pairing | NOT_IMPLEMENTED | — |
| CAN-B2-03 | Multiple-country publication and virtual inventory | NOT_IMPLEMENTED | — |
| CAN-B2-04 | Image synchronization and local archive | `imageArchive.js` | readiness-subset |
| CAN-B2-05 | Standard product flow | NOT_IMPLEMENTED | — |
| CAN-B2-06 | Custom press-on-nail purchase | NOT_IMPLEMENTED | — |
| CAN-B2-07 | Wallet and payment currency conversion | NOT_IMPLEMENTED | — |
| CAN-B2-08 | Platform and designer financial split | `commissionTiers.js` | readiness-subset |
| CAN-B2-09 | Order display and cross-channel index | NOT_IMPLEMENTED | — |
| CAN-B2-10 | Order merging | NOT_IMPLEMENTED | — |
| CAN-B2-11 | Customer nail-size page and automatic matching | NOT_IMPLEMENTED | — |
| CAN-B2-12 | Inventory and replenishment | NOT_IMPLEMENTED | — |
| CAN-B2-13 | Shipping and weight | NOT_IMPLEMENTED | — |
| CAN-B2-14 | Tax and country | NOT_IMPLEMENTED | — |
| CAN-B2-15 | Account, delisting and administrative operations | NOT_IMPLEMENTED | — |
| CAN-B2-16 | Platform scripts | `shippingDryRun.js` | readiness-subset |

Every task above shows **NEEDS_CLIENT_INPUT** in the manifest. The pipeline cannot produce a passing overall verdict until all 24 acceptance tasks are addressed.

---

## Known gaps

| Gap | What it needs from the client |
|---|---|
| 20 tasks have no executor (all CAN-B1 except 03/04, all CAN-B2 except 04/08/16) | Executor implementations; these are PIPELINE_DEFECT/NOT_IMPLEMENTED until written |
| Four executors exist but are readiness subsets only | `stagingUrl` (PIPELINE_STAGING_URL), channel tokens (CHANNEL_TOKENS), and test accounts must be supplied for these to run beyond stub verification |
| `CHANNEL_TOKENS` not yet confirmed | Four tokens (DE, AT, HU, GB) needed for readOnlyShopApi executor |
| `manifest/protected-hashes.json` not yet frozen | Run `node scripts/freeze-protected-hashes.js` once before the first formal run; every task is UNRESOLVED_ASSUMPTION until then |
| `CAN-B1-03` / `CAN-B1-04` readiness scope: `image-archive` scope not in VALID_SCOPES | The `image-archive` scope key is registered for CAN-B2-04 but not enumerated in `VALID_SCOPES`; the executor runs without `--scope`; scope validation for this key is a pipeline defect to fix |
| CAN-DEMO-01 (public demo) is separate from acceptance | It is not one of the 24 tasks above and does not contribute to the passing overall verdict |
| No executor verifies `check_order` DB access | Required by several tasks; needs DB credentials and a test-order fixture |
| Stripe callback URL and secret not wired into any executor | Needed by CAN-B1-06 and CAN-B2-06 at minimum |
| Runner design (staging runner architecture) acknowledged but implementation not verified | Confirm the runner host has Node ≥ 20, write access to `PIPELINE_ARCHIVE_ROOT`, and that `run-staging.mjs` is installed at the expected path |