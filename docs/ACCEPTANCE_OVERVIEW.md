# Acceptance Overview

## What a successful pipeline must demonstrate

For a declared input revision and task, the pipeline must:

1. identify the exact source, task, contract, environment, and run;
2. read the task and make only bounded changes in the allowed workspace;
3. run the required build and tests, including browser evidence where the task needs a user-visible check;
4. record what tools were loaded and used and why they were selected;
5. retain the changed-file summary, diff, test output, browser or API evidence, and rollback method;
6. return `PASS` only from an independent validator with the required evidence, or return a precise `BLOCK`;
7. stop and clean up when authorization, identity, safety, or required evidence is missing.

## Public demo mapping

The demo maps these requirements to a small migration adapter:

| Requirement | Public demonstration |
| --- | --- |
| fixed input | `evaluation-demo/app/fixtures/legacy-catalog.json` |
| bounded task | `evaluation-demo/task.md` |
| code change | `evaluation-demo/app/src/catalog.mjs` |
| acceptance assertions | `evaluation-demo/app/tests/acceptance.test.mjs` |
| run identity and evidence | `evaluation-demo/scripts/verify.mjs` |
| known-good reference | `evaluation-demo/expected-results/reference-catalog.mjs` |
| safe stop | baseline mode records the expected `BLOCK` before a fix |

## PASS and BLOCK are different

The starter is intentionally incomplete. A baseline run should stop with `BASELINE_BLOCKED_EXPECTED`; this demonstrates that the verifier can recognize a task that has not been completed. After the contractor implements the task in their own copy, `--acceptance` should return `PASS` and write the evidence bundle.

The public demo is not formal private acceptance. The formal run additionally checks frozen private input, runtime identity, browser and service evidence, authorized resource use, cleanup, and the project-owned validator result.
