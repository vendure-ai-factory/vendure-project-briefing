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

After the project owner selects a contractor and signs a contract, the contractor receives only the approved private development access needed for the formal pipeline. Before formal delivery, the contractor must automatically run at least three representative long-chain tasks from the project overview, in principle covering at least one task from each migration batch plus a third task agreed with the owner. The contractor then uploads the pipeline to a designated private branch or candidate repository.

The project owner supplies the task prompt and starts the controlled run, running the agreed migration batches separately and attempting the complete migration. If failures appear, the owner returns the actual evidence and the contractor tunes and reruns the pipeline. Final acceptance and payment happen only after the agreed migration scope is complete and the pipeline runs the agreed scenarios reliably and automatically. The contractor does not directly operate the minipc, production environment, or shared evidence sink.

## Important distinction

The public demo can prove that your pipeline can work with a small, sanitized case. It cannot prove access to or success against the private formal case. Formal acceptance uses frozen private input and contract revisions and is decided by the project-owned validator.

## Public image materials

The demo includes sanitized effect and design images in [../evaluation-demo/assets/nail-patterns/](../evaluation-demo/assets/nail-patterns/). You may inspect or use them in your own fork. Their original subdirectory structure is part of the test input contract: do not flatten or rename the files. They are supplementary materials; the deterministic acceptance test continues to use the checked-in JSON fixture.
