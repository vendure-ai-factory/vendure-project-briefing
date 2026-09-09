# Start Here

This page gives a contractor the shortest path from the public advertisement to a reproducible hands-on decision.

## What this project is

The project owner wants a pipeline that can take a bounded Vendure secondary-development task, inspect the code, make controlled changes, start the declared test environment, run verification, collect durable evidence, and stop safely when a required condition is not met.

The public case is a small catalog migration example. It is representative of the required reasoning and evidence shape, but it is not a copy of the private client code.

## What you should do

1. Read [PROJECT_SCOPE.md](PROJECT_SCOPE.md).
2. Read [ACCEPTANCE_OVERVIEW.md](ACCEPTANCE_OVERVIEW.md).
3. Read the [English one-time acceptance contract](CONTRACT_EN.md), [English project overview](PROJECT_OVERVIEW_EN.md), and [English pipeline technical requirements](PIPELINE_TECHNICAL_REQUIREMENTS_EN.md).
4. Read [../evaluation-demo/task.md](../evaluation-demo/task.md).
5. Inspect the public test image materials in [../evaluation-demo/assets/nail-patterns/](../evaluation-demo/assets/nail-patterns/).
6. Run `node ../evaluation-demo/scripts/run-demo.mjs` from this directory, or use the commands in the repository README.
7. Inspect the generated `evaluation-demo/results/<run_id>/` evidence.
8. Fork the repository if you want to modify the starter and prove your own approach.
9. Send the project owner your feasibility judgment, fixed quote, delivery period, scope, assumptions, risks, and fork or commit link.

## What happens after a contract

After the project owner selects a contractor and signs a contract, the contractor receives only the approved private development access needed for the formal pipeline. The contractor may build and run the candidate Pipeline in the contractor's own isolated Linux environment or another agreed isolated runner. Before formal delivery, the contractor must automatically run at least three representative long-chain tasks from the project overview, in principle covering at least one task from each migration batch plus a third task agreed with the owner. The contractor then uploads the Pipeline, pinned configuration, and evidence to a designated private branch or candidate repository.

The project owner freezes an Acceptance Manifest containing the candidate revision, input revisions, environment identity, fixtures, workflow interface, expected results, evidence requirements, cleanup, and rollback. The owner then starts the controlled run through an authenticated `workflow_dispatch` or equivalent API. The real work runs in a clean, isolated Linux environment; GitHub stores the versioned interface and evidence but does not replace that runtime. If a tool works only on the minipc, the owner supplies a narrow allowlisted adapter. The contractor does not directly operate the minipc, production environment, or shared evidence sink.

The owner runs Batch 1 and Batch 2 separately and then attempts the complete agreed migration. If the run reveals a Pipeline defect, omission, false pass, insufficient evidence, rollback failure, or a need for manual technical work, the owner returns reproducible evidence and the contractor submits a new identified revision and reruns the affected scenarios. There is no arbitrary small limit on tuning rounds for defects inside the frozen scope. New features, new Vendure versions, new environments, or new acceptance scenarios are scope changes and require written agreement. Final acceptance and payment happen only after the current agreed migration scope is complete and the Pipeline runs the agreed scenarios reliably and automatically.

The three-task pre-delivery gate proves capability; it is not final project acceptance or, by itself, a payment event.

## Important distinction

The public demo can prove that your pipeline can work with a small, sanitized case. It cannot prove access to or success against the private formal case. Formal acceptance uses frozen private input and contract revisions and is decided by the project-owned validator.

## Public image materials

The demo includes sanitized effect and design images in [../evaluation-demo/assets/nail-patterns/](../evaluation-demo/assets/nail-patterns/). You may inspect or use them in your own fork. Their original subdirectory structure is part of the test input contract: do not flatten or rename the files. They are supplementary materials; the deterministic acceptance test continues to use the checked-in JSON fixture.
