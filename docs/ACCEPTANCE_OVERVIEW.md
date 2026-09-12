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

## Three stages of acceptance

1. **Public hands-on stage:** the contractor clones or forks this public repository, runs the no-secret demo, and inspects the larger sanitized migration-input package in the contractor's own environment. This proves that the contractor can understand the task shape and produce evidence; it does not expose private Git history or prove the formal migration.
2. **Pipeline capability/delivery gate:** after contract signing, the contractor automatically completes at least three representative long-chain E2E tasks from the project overview, with at least one from each migration batch and a third agreed with the owner. The contractor submits the code revision, environment identity, task inputs, actual changes, test/browser/backend evidence, cleanup, and rollback evidence. This gate proves capability and permits delivery of the candidate Pipeline; it is not final acceptance and is not, by itself, a payment event.
3. **Client-controlled final acceptance:** the owner freezes the Acceptance Manifest and runs the remaining complete migration in a clean isolated Linux environment. Batch 1 and Batch 2 are recorded separately and then judged together. If a Pipeline defect appears, the owner returns reproducible evidence and the contractor submits a new identified revision and reruns the affected scenarios. Defects within the frozen scope remain in the tuning loop until the acceptance conditions pass; new features, versions, environments, or scenarios require written scope agreement.

The Acceptance Manifest is the plain-language freeze of what is being tested: exact code and input revisions, runner/environment identity, fixtures and accounts, workflow trigger, expected browser/backend results, evidence files, cleanup, and rollback. GitHub provides the versioned control/evidence surface, while the actual run occurs in an isolated Linux runtime. A project-owner-controlled adapter is required for any tool that can run only on the minipc.

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

The public demo and the public sanitized migration-input package are not formal private acceptance. They allow feasibility review and hands-on experiments. The formal run additionally checks the frozen owner-controlled input revision, runtime identity, browser and service evidence, authorized resource use, cleanup, and the project-owned validator result.

## Public test image path

The sanitized effect and design image materials for optional hands-on experiments are stored at [`evaluation-demo/assets/nail-patterns/`](../evaluation-demo/assets/nail-patterns/). These assets supplement the deterministic JSON fixture and do not expose the private evaluation input.
