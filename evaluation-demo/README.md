# Public Evaluation Demo

This is a small, no-secret, runnable case for testing a contractor's pipeline approach before a quote. The larger sanitized source and task package is available separately under [`migration-input/`](migration-input/); the two layers serve different purposes.

## The case

The starter contains a legacy catalog fixture and an incomplete migration adapter. The task is to transform active legacy records into a stable public shape while removing internal notes. The tests define the acceptance target.

The starter is expected to fail the real acceptance check. That is intentional: it gives a pipeline a bounded change to make and a precise failure to diagnose.

## Test image materials

Sanitized effect and design images are available under [`assets/nail-patterns/`](assets/nail-patterns/). They are optional visual inputs for pipeline experiments. The minimal acceptance test remains deterministic and uses the JSON fixture under `app/fixtures/`.

## Larger sanitized migration input

[`migration-input/`](migration-input/) contains a clean-tree, public-safe snapshot of the sanitized Vendure source, migration task documents, and the repository-relative fixture tree. It lets a contractor inspect more of the actual task context and test path handling in a personal clone or fork. It does not include private Git history, production data, credentials, or the owner-controlled formal acceptance environment. Preserve `migration-input/fixtures/美甲图案/` and all nested directories when testing scripts that depend on relative paths.

## Run the reference demonstration

From the repository root:

```bash
node evaluation-demo/scripts/run-demo.mjs
```

This runs the published reference solution in a temporary copy and creates a PASS evidence bundle under `evaluation-demo/results/`.

## Test your own implementation

```bash
bash evaluation-demo/scripts/verify.sh --baseline
# modify app/src/catalog.mjs in your own clone or fork
bash evaluation-demo/scripts/verify.sh --acceptance
```

`--baseline` passes only when the incomplete starter is correctly recognized as an expected block. `--acceptance` passes only when all acceptance tests pass.

The verifier never needs a token, password, database, production service, or network access.

## Execution boundary

Run this demo only in your own clone, fork, computer, Codespace, or isolated no-secret runner. GitHub stores the reviewed source and evidence instructions; the repository page or GitHub Pages is not the runtime for the complete Vendure migration. Do not connect the public package to the private evaluation repository, the minipc, production, or any shared runner. The public materials are a hands-on feasibility step before quoting, not the three-task capability gate and not final acceptance.
