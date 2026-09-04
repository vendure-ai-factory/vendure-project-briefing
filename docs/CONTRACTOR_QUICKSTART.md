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

## Information to send with a quote

- whether the public demo ran successfully;
- the approach and tools you would reuse;
- fixed price and delivery period;
- included and excluded scope;
- assumptions, risks, and dependencies;
- link to your fork, PR, or result evidence.

## Contracted delivery step

After selection and contract signing, the project owner will identify the private input and contract revisions, provide the approved development access, and name the destination private branch or candidate repository. The contractor uploads the pipeline and its configuration there. The project owner remotely starts the run and reviews the evidence. Issues found by the formal run are returned for repair through the agreed channel.

The contractor does not receive direct minipc or production access for this process. Project-owned secrets are supplied and managed by the project owner in a controlled environment.
