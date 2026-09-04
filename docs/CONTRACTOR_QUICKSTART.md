# Contractor Quickstart

## Public hands-on step

Work only in your own clone or fork:

```bash
git clone https://github.com/vendure-ai-factory/vendure-project-briefing.git
cd vendure-project-briefing
node evaluation-demo/scripts/run-demo.mjs
bash evaluation-demo/scripts/verify.sh --baseline
```

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

After selection and contract signing, the contractor must first automatically run at least three representative long-chain tasks from the project overview, in principle covering at least one task from Batch 1 and one from Batch 2, with the third task proposed by the contractor and confirmed by the owner. This is the pipeline-delivery gate; it is not completion of the full migration.

The project owner will then identify the private input and contract revisions, provide the approved development access, and name the destination private branch or candidate repository. The contractor uploads the pipeline and its configuration there. The project owner remotely starts separate Batch 1 and Batch 2 runs and attempts the complete agreed migration. Issues found by the formal run are returned with actual evidence for the contractor to repair, tune, and rerun. Final acceptance and payment happen only after the agreed migration scope is complete and the pipeline runs the agreed scenarios reliably and automatically.

The contractor does not receive direct minipc or production access for this process. Project-owned secrets are supplied and managed by the project owner in a controlled environment.
