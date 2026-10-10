# AGENTS.md

## What this repository is

`vendure-project-briefing` is a **public, sanitized contractor-eviction/briefing repository**, not the running application. Its purpose is to let a contractor evaluate the feasibility of building an autonomous pipeline that migrates a legacy Vendure storefront, then quote for the work. There is no production code, no secrets, and no full runtime here.

The repo has three layers, in increasing size/detail:

1. **Documents** (`docs/`, `README.md`) - the commercial contract, project scope, pipeline technical requirements, acceptance overview, and testing-environment guides. These are the source of truth for the project's rules. Start at `docs/START_HERE.md`.
2. **`evaluation-demo/`** - the actively maintained, runnable code in this repo. Contains a small deterministic "public demo" that a contractor runs to smoke-test a pipeline approach.
3. **`evaluation-demo/migration-input/`** - a large, sanitized, **clean-tree snapshot** of the legacy source (Vendure 3.5.3 backend + Next.js storefront). It is *reference material for inspection only*; it is not runnable as published (no dependencies, DB, `.env`) and is not the target runtime.

The current work branch is `codex/github-refactor-20260904`. **`main` is minimal** (only a top-level README); cloning without the `--branch` flag retrieves the minimal main and you will miss the test package. Always work on the `codex/github-refactor-20260904` branch.

## Key non-obvious rules (read these carefully)

- **The public demo starter is intentionally incomplete and is expected to fail the acceptance check.** `evaluation-demo/app/src/catalog.mjs` returns `[]`. This is by design so the verifier can demonstrate a bounded change with a precise failure. Do not "fix" it in the canonical repo; contractors fix it in their own fork.
- **Three related private repositories exist but are NOT in this repo**: `vendure-evaluation-input` (private, owner-controlled formal revisions) and `pipeline-contract` (private, full pipeline interface/contract). This public repo does not mirror their history and grants no access. See `docs/REPOSITORY_MAP.md`.
- **This repo is not the runtime.** GitHub stores reviewed source, task inputs, workflow entry points, and redacted evidence. The actual migration must run in a clean isolated Linux environment (contractor's own runner for development; owner-controlled for final acceptance). SSH is not the normal task interface. See `README.md` "How the execution boundary works".
- **No secrets, ever.** Do not commit tokens, passwords, `.env`, DB files, SSH keys, or customer data. The migration-input package is already sanitized; keep it that way.
- **Preserve the image fixture directory structure.** `evaluation-demo/assets/nail-patterns/` and `evaluation-demo/migration-input/fixtures/美甲图案/` must keep their nested subdirectory layout (one dir per design, `1/0` as the master image, etc.) because some Vendure scripts resolve image inputs by relative path. Do not flatten or rename. The deterministic acceptance test does NOT depend on these images; it uses the checked-in JSON fixture.
- **Run paths must be repository-relative or environment-variable driven**, never machine-specific (no `C:\Users\...` or owner-computer paths). The `PUBLICATION_SANITIZATION_REPORT.md` documents the required env vars and default dirs.

## Essential commands (the public demo)

Run from the repository root. Requires Git, Node.js >= 20; Docker optional.

```bash
# Reference demonstration: runs the known-good solution in a temp copy -> writes PASS evidence
node evaluation-demo/scripts/run-demo.mjs

# Verify the incomplete starter is recognized as an expected block (expected to PASS in this mode)
bash evaluation-demo/scripts/verify.sh --baseline

# After implementing the task in your own fork: real acceptance check (PASS only if all assertions pass)
bash evaluation-demo/scripts/verify.sh --acceptance

# Direct unit test run (used by the above)
cd evaluation-demo/app && node --test tests/acceptance.test.mjs
```

Evidence is written to `evaluation-demo/results/<run_id>/` (run-manifest.json, status.json, stdout.log, stderr.log, diff.patch, summary.md, rollback.md). The `results/` directory is gitignored. The verifier needs no token, network, DB, or production service.

The only CI is `.github/workflows/validate-public-demo.yml`, which on push/PR to `main` or `codex/github-refactor-20260904` runs `verify.sh --baseline` then `run-demo.mjs` on ubuntu with Node 20.

## The demo task itself

`evaluation-demo/task.md` defines it: implement `migrateCatalog` in `app/src/catalog.mjs` to transform `app/fixtures/legacy-catalog.json` into the public shape. Requirements: keep only `active` records; URL-safe lowercase `slug` from name; decimal price to integer `price_cents`; `image_count`; preserve `sku`; drop `internalNote` and all internal-only fields; stable SKU order; do not mutate the input; no new dependencies or network calls.

`evaluation-demo/app/tests/acceptance.test.mjs` is the authority on the expected output. `evaluation-demo/expected-results/reference-catalog.mjs` is the known-good reference implementation (an agent may read it, but the task expects a contractor to derive it from the test).

## `evaluation-demo/migration-input/` structure

- `legacy/vendure-store/` - sanitized old Vendure 3.5.3 backend source (`src/vendure-config.ts`, `src/plugins/`, many ad-hoc `scripts/*.ts` diagnostic/publish/migration scripts).
- `legacy/storefront/` - sanitized old Next.js 16 storefront source (App Router, `src/app/`, `src/lib/vendure/`, `src/components/ui/` shadcn-style components) plus `e2e/*.spec.ts` Playwright tests, `playwright.config.ts` (baseURL `http://localhost:3001`, workers 1).
- `fixtures/美甲图案/` - image fixture tree (do not flatten).
- `acceptance-inputs/*.docx` - migration task (`测试任务.docx`) and pipeline requirements (`流水线诉求描述.docx`).
- `PUBLICATION_SANITIZATION_REPORT.md` - the sanitization audit and env-var guidance (always read before touching this layer).
- `SOURCE_LAYOUT.md` - path conventions.

## Gotchas in the migration-input source

- The `legacy/` tree is **not runnable as published**: no `node_modules`, no DB, no `.env`. Many scripts import `@vendure/core` and a `@ts-nocheck` pragma; several are quick ad-hoc diagnostic scripts with hard-coded Chinese business data and test strings. Treat any script that writes to the DB/orders/passwords as a controlled action that must run only against an isolated test database.
- `legacy/vendure-store/src/vendure-config.ts` contains injected marker tokens at the top and end (`// LTS_LOCKDOWN_TEST`, `LTS_INTERNAL_TEST`, `FAIL_TEST`, `// [LTS] PHYSICAL_LOCKDOWN_VERIFIED_SUCCESSFULLY`). These are intentional artifacts (probably from the owner's pipeline trials / hardening), not something to "fix". They are plain tokens, not valid TS, and the file is a reference snapshot.
- Multi-country logic was removed in favor of native channels (comment in `vendure-config.ts`). The storefront uses a `COUNTRY_CHANNEL_MAP` and channel tokens like `germany-channel`; the shop API default is `http://127.0.0.1:54321/shop-api` with a client-side handshake fix that swaps `127.0.0.1` for the current hostname.
- Naming: files mix `.ts` and `.mjs`, camelCase components, kebab-case pages. Numerous near-duplicate versioned scripts (`publish_product.ts`, `_v8`, `_v9`, `_v10`; `diagnostic_check.ts`, `_v4`, `_v5`) reflect prior iterative trials - don't assume only the latest is canonical.

## Document conventions

- Docs are largely bilingual (English primary, with Chinese `## 中文说明` / inline Chinese notes for the contractor-facing material). Match whichever language a given document already uses.
- `README.md` "中文说明" section confirms this is a public entry point and clarifies that PRs are submission surfaces, not merges.
- Line endings: `.sh` files are forced to `LF` via `.gitattributes`. When editing shell scripts on Windows, keep LF.
- `.gitignore` excludes `evaluation-demo/results/*` and any `.psd` design sources under `migration-input/`.
