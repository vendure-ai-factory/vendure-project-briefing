# Contractor Quickstart

## Public hands-on step

Work only in your own clone or fork:

```bash
git clone --branch codex/github-refactor-20260904 --single-branch https://github.com/vendure-ai-factory/vendure-project-briefing.git
cd vendure-project-briefing
node evaluation-demo/scripts/run-demo.mjs
bash evaluation-demo/scripts/verify.sh --baseline
```

The public hands-on package is currently published on the `codex/github-refactor-20260904` branch. Use the branch-pinned command above until the package is merged into `main`; cloning without `--branch` may retrieve the minimal `main` README instead of the test package.

Read the task, inspect the starter source and tests, then implement the task in your own copy. Run:

```bash
bash evaluation-demo/scripts/verify.sh --acceptance
```

Optional visual test materials are available at [`evaluation-demo/assets/nail-patterns/`](../evaluation-demo/assets/nail-patterns/). Inspect or use them only in your own clone or fork; they are public sanitized inputs, not private production data. Preserve the complete subdirectory structure and relative paths; do not flatten or rename the files because some Vendure second-development scripts depend on them.

Submit either a fork URL and commit SHA or a pull request. Do not put secrets in the repository. Do not assume that a pull request will be merged.

## Read before quoting

- [English one-time acceptance contract](CONTRACT_EN.md) — proposed commercial terms, delivery gate, final acceptance, handover, and payment condition.
- [English project overview](PROJECT_OVERVIEW_EN.md) — the complete migration scope and the two batches of end-to-end tasks.
- [English pipeline technical requirements](PIPELINE_TECHNICAL_REQUIREMENTS_EN.md) — required automation behavior, evidence, safety boundaries, and the owner-controlled remote validation loop.

OpenHands or ClawAI are recommended reference frameworks, but they are not mandatory. You may use a pipeline you already know if it achieves the required outcome. The long software/framework/tool descriptions in the pipeline document describe previous trials and research and are reference material only.

## Information to send with a quote

- whether the public demo ran successfully;
- the approach and tools you would reuse;
- fixed price and delivery period;
- included and excluded scope;
- assumptions, risks, and dependencies;
- link to your fork, PR, or result evidence.

## Contracted delivery step

After selection and contract signing, the contractor may build and run the candidate Pipeline in the contractor's own isolated Linux environment or another agreed isolated runner. The contractor must first automatically run at least three representative long-chain tasks from the project overview, in principle covering at least one task from Batch 1 and one from Batch 2, with the third task proposed by the contractor and confirmed by the owner. This is the Pipeline capability/delivery gate; it is not completion of the full migration and is not, by itself, final acceptance or a payment event.

The project owner will then identify the private input and contract revisions, provide the approved development access, and name the destination private branch or candidate repository. The contractor uploads the Pipeline, configuration, pinned dependencies, and evidence package there. The package must include a `Dockerfile` plus `compose.yaml` or an equivalent reproducible runner definition, lockfiles or version pins, start/stop/check/cleanup scripts, a no-secret `.env.example`, declared tool/MCP permissions, and a version or digest that identifies each candidate.

Before the formal run, the owner freezes an Acceptance Manifest covering the candidate revision, private input revision, target environment, fixtures, workflow trigger, expected browser/backend results, evidence, cleanup, and rollback. The preferred control path is authenticated GitHub Actions `workflow_dispatch` or an equivalent API. The actual migration runs in a clean isolated Linux environment controlled by the owner or an agreed independent verifier; GitHub is the versioned control/evidence surface, not the complete Vendure runtime. SSH is not the normal task interface. A minipc-only tool must be reached through a narrow owner-controlled allowlisted adapter, not unrestricted minipc access.

The project owner remotely starts separate Batch 1 and Batch 2 runs and attempts the complete agreed migration. Issues found by the formal run are returned with reproducible evidence for the contractor to repair, identify with a new revision, and rerun. Defects inside the frozen scope are part of the agreed tuning loop and are not limited to an arbitrary small number of rounds. New features, new Vendure versions, new environments, or new acceptance scenarios require written scope confirmation. Final acceptance and payment happen only after the agreed migration scope is complete and the Pipeline runs the agreed scenarios reliably and automatically.

The contractor does not receive direct minipc or production access for this process. Project-owned secrets are supplied and managed by the project owner in a controlled environment.
