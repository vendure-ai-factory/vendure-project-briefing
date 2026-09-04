# Start Here

This page gives a contractor the shortest path from the public advertisement to a reproducible hands-on decision.

## What this project is

The project owner wants a pipeline that can take a bounded Vendure secondary-development task, inspect the code, make controlled changes, start the declared test environment, run verification, collect durable evidence, and stop safely when a required condition is not met.

The public case is a small catalog migration example. It is representative of the required reasoning and evidence shape, but it is not a copy of the private client code.

## What you should do

1. Read [PROJECT_SCOPE.md](PROJECT_SCOPE.md).
2. Read [ACCEPTANCE_OVERVIEW.md](ACCEPTANCE_OVERVIEW.md).
3. Read [../evaluation-demo/task.md](../evaluation-demo/task.md).
4. Run `node ../evaluation-demo/scripts/run-demo.mjs` from this directory, or use the commands in the repository README.
5. Inspect the generated `evaluation-demo/results/<run_id>/` evidence.
6. Fork the repository if you want to modify the starter and prove your own approach.
7. Send the project owner your feasibility judgment, fixed quote, delivery period, scope, assumptions, risks, and fork or commit link.

## What happens after a contract

After the project owner selects a contractor and signs a contract, the contractor receives only the approved private development access needed for the formal pipeline. The contractor uploads the pipeline to a designated private branch or candidate repository. The project owner supplies the task prompt and starts the controlled run. The contractor can inspect the agreed result and fix issues, but does not directly operate the minipc, production environment, or shared evidence sink.

## Important distinction

The public demo can prove that your pipeline can work with a small, sanitized case. It cannot prove access to or success against the private formal case. Formal acceptance uses frozen private input and contract revisions and is decided by the project-owned validator.
