# Public Evaluation Demo

This is a small, no-secret, runnable case for testing a contractor's pipeline approach before a quote. It is intentionally separate from the private Vendure legacy source.

## The case

The starter contains a legacy catalog fixture and an incomplete migration adapter. The task is to transform active legacy records into a stable public shape while removing internal notes. The tests define the acceptance target.

The starter is expected to fail the real acceptance check. That is intentional: it gives a pipeline a bounded change to make and a precise failure to diagnose.

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
