# Vendure Project Briefing

This is the public, sanitized entry point for the Vendure migration and pipeline-acceptance project.

## Start here

1. Read [docs/START_HERE.md](docs/START_HERE.md).
2. Read the public acceptance target in [docs/ACCEPTANCE_OVERVIEW.md](docs/ACCEPTANCE_OVERVIEW.md).
3. Open the runnable, no-secret hands-on case in [evaluation-demo/](evaluation-demo/).
4. Inspect the public test image materials in [evaluation-demo/assets/nail-patterns/](evaluation-demo/assets/nail-patterns/).
5. If you are considering the work, run the demo in your own clone or fork and then send a quote and timeline.

The public demo is deliberately small and sanitized. It shows the shape of the migration task, the verification contract, the evidence that a pipeline must produce, and the safe failure boundary. It is not the private legacy source and it is not a production environment.

## Run the hands-on demo

Requirements: Git, Node.js 20 or newer, and optionally Docker.

```bash
git clone https://github.com/vendure-ai-factory/vendure-project-briefing.git
cd vendure-project-briefing
node evaluation-demo/scripts/run-demo.mjs
```

The reference run produces a successful result in a temporary copy. To see the intentionally incomplete starter and its expected stop condition:

```bash
bash evaluation-demo/scripts/verify.sh --baseline
```

After implementing the task in your own copy, run the real acceptance check:

```bash
bash evaluation-demo/scripts/verify.sh --acceptance
```

The verifier writes a local `evaluation-demo/results/<run_id>/` directory containing the run manifest, status, logs, diff, summary, and rollback note. Results are local evidence; they are not a promise that a PR will be merged.

## Test image materials

The public hands-on package includes sanitized effect and design images at [evaluation-demo/assets/nail-patterns/](evaluation-demo/assets/nail-patterns/). Their original subdirectory structure is preserved because some Vendure second-development scripts depend on relative paths; do not flatten or rename them. They are available for inspection and optional pipeline experiments; the core acceptance test remains deterministic and uses the checked-in JSON fixture.

## Repository boundaries

- `vendure-project-briefing` is public and contains only sanitized project information, the hands-on demo, and approved test image materials.
- `vendure-evaluation-input` is private and contains the formal legacy source, fixtures, and acceptance inputs.
- `pipeline-contract` is private and contains the complete pipeline interface, evidence rules, runtime constraints, and acceptance contract.

The formal test run is controlled by the project owner. A contractor must not receive minipc, production, shared-runner, password, API-key, or SSH-key access merely to try the public demo.

## Submitting a pipeline

You may fork this repository, modify your own copy, and open a pull request or provide a fork URL and commit SHA. A pull request is a submission and review surface only; it does not grant merge rights and does not mean the code will be merged.

See [docs/CONTRACTOR_QUICKSTART.md](docs/CONTRACTOR_QUICKSTART.md) for the handoff from public hands-on work to quote, contract, private delivery, remote run, and acceptance.

## 中文说明

这是公开入口。承包商可以先看任务和代码，再在自己的电脑或 fork 中运行、修改和测试。正式旧二开代码仍在私有仓库；PR 只是提交作业，不等于合并。正式远程验证由项目方控制。
