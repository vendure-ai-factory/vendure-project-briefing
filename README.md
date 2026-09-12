# Vendure Project Briefing

This is the public, sanitized entry point for the Vendure migration and pipeline-acceptance project.

## Start here

1. Read [docs/START_HERE.md](docs/START_HERE.md).
2. Read the public acceptance target in [docs/ACCEPTANCE_OVERVIEW.md](docs/ACCEPTANCE_OVERVIEW.md).
3. Open the runnable, no-secret hands-on case in [evaluation-demo/](evaluation-demo/).
4. Inspect the public test image materials in [evaluation-demo/assets/nail-patterns/](evaluation-demo/assets/nail-patterns/).
5. Inspect the larger [sanitized migration input package](evaluation-demo/migration-input/), including the source tree and migration task documents.
6. If you are considering the work, run the demo in your own clone or fork and then send a quote and timeline.

The public repository now has two complementary hands-on layers. `evaluation-demo/app/` is a small deterministic smoke case. `evaluation-demo/migration-input/` is a larger, sanitized snapshot of the source and task inputs so that a contractor can inspect the real task shape. It is a clean-tree publication, not a mirror of private Git history and not a production environment.

## How the execution boundary works

GitHub is the versioned control and evidence surface: it carries the reviewed source revision, task inputs, workflow entry point, run status, and redacted evidence. GitHub Pages or a repository page is not the environment that runs the complete Vendure migration. The actual work must run in a clean, isolated Linux environment such as a temporary container or ephemeral runner.

The public demo and sanitized migration-input package run or are inspected in the contractor's own clone, fork, computer, Codespace, or isolated runner and contain no secrets. After a contract, the contractor may develop and run the capability in the contractor's own isolated environment or another agreed isolated runner. Final acceptance is performed by the project owner in a project-controlled temporary environment. The normal control path is an authenticated GitHub Actions `workflow_dispatch` or equivalent API; SSH is not the normal task interface and may be used only as a separately approved, limited diagnostic channel. A tool that can run only on the minipc must be exposed through a project-owner-controlled, allowlisted adapter rather than unrestricted minipc access.

## English contractor documents

Read these documents before deciding whether to quote:

- [English one-time acceptance contract](docs/CONTRACT_EN.md) — the proposed scope, delivery obligations, acceptance gates, handover requirements, and payment condition.
- [English project overview](docs/PROJECT_OVERVIEW_EN.md) — the Vendure secondary-development migration scope, two migration batches, and the end-to-end tasks used for validation.
- [English pipeline technical requirements](docs/PIPELINE_TECHNICAL_REQUIREMENTS_EN.md) — the expected pipeline behavior, evidence, safety boundaries, and remote validation process. OpenHands or ClawAI are recommended reference frameworks but are not mandatory; an equivalent familiar pipeline is acceptable if it achieves the required outcome.

The detailed descriptions of software and frameworks later in the pipeline document record previous trials and research and are provided for reference only.

## Run the hands-on demo

Requirements: Git, Node.js 20 or newer, and optionally Docker.

```bash
git clone --branch codex/github-refactor-20260904 --single-branch https://github.com/vendure-ai-factory/vendure-project-briefing.git
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

The larger sanitized package also contains a matching repository-relative fixture tree at `evaluation-demo/migration-input/fixtures/美甲图案/` for scripts that expect the legacy source layout. These are public test inputs only. Use the path from the checked-out repository, not a path from the owner's computer.

## Repository boundaries

- `vendure-project-briefing` is public and contains sanitized project information, the hands-on demo, and a reviewed clean-tree publication of the migration inputs.
- `vendure-evaluation-input` remains private and is the owner-controlled source of formal revisions, private history, and final acceptance inputs. The public package is not a history mirror and does not grant access to the private repository.
- `pipeline-contract` is private and contains the complete pipeline interface, evidence rules, runtime constraints, and acceptance contract.

The formal test run is controlled by the project owner. A contractor must not receive minipc, production, shared-runner, password, API-key, or SSH-key access merely to try the public demo.

The delivery gate is separate from final acceptance: after contract signing, at least three representative long-chain E2E tasks must pass with reviewable evidence before the contractor delivers the candidate Pipeline. This is a capability gate, not a separate public-demo result and not, by itself, a payment or final-acceptance event. The project owner then runs the remaining migration within the frozen scope. Defects in the Pipeline's agreed scope are returned with reproducible evidence and must be repaired and rerun without an arbitrary small limit on tuning rounds. New features, Vendure versions, environments, or acceptance scenarios are scope changes and require written agreement.

## Submitting a pipeline

You may fork this repository, modify your own copy, and open a pull request or provide a fork URL and commit SHA. A pull request is a submission and review surface only; it does not grant merge rights and does not mean the code will be merged.

See [docs/CONTRACTOR_QUICKSTART.md](docs/CONTRACTOR_QUICKSTART.md) for the handoff from public hands-on work to quote, contract, private delivery, remote run, and acceptance.

## 中文说明

这是公开入口。承包商可以先看任务和代码，再在自己的电脑或 fork 中运行、修改和测试。正式旧二开代码仍在私有仓库；PR 只是提交作业，不等于合并。正式远程验证由项目方控制。
