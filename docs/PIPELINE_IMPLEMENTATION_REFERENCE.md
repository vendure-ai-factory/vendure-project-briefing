# Pipeline Implementation Reference

This page explains the technical shape we use when comparing contractor proposals. It is a capability and evidence reference, not a requirement to use one named framework.

## The required loop

The delivered Pipeline is not only a GitHub CI/CD workflow and not manual migration work. Within the agreed task, environment, permission, and acceptance boundaries, it should:

1. compile a natural-language end-to-end goal into preconditions, action nodes, positive/negative assertions, evidence requirements, cleanup, and rollback conditions;
2. establish a Git baseline in an isolated workspace or container and perform bounded code changes;
3. preserve failures, classify code/environment/dependency/tool/permission/data causes, apply a small reversible repair, and rerun the reproducer plus regression checks;
4. circuit-break repeated failures instead of retrying forever;
5. connect browser, API/GraphQL, database, logs, screenshots, and traces to concrete acceptance assertions;
6. use an independent validator to derive `PASS` or `BLOCK` from artifacts, rather than trusting model prose, a green CI job, or a zero exit code;
7. document separate rollback paths for code and for data/runtime state.

## Minimum proof for each responsibility

The following table turns the required loop into checkable implementation points. A proposal may use different component names, but it must identify an equivalent implementation and the resulting evidence.

| Responsibility | Required behavior | Minimum evidence | BLOCK condition |
| --- | --- | --- | --- |
| Goal compiler | Convert the natural-language goal into preconditions, ordered actions, positive/negative assertions, cleanup, rollback triggers, and measurable thresholds before execution. | Versioned task card and compiled plan linked to the run ID. | The Pipeline starts coding without a compiled acceptance target, or the plan has no failure/cleanup rule. |
| Isolated executor | Pin the repository revision, create a Git baseline, prepare the declared Linux/container workspace, and restrict writes to the allowed scope. | Commit/hash, environment identity, dependency versions, baseline diff, and workspace boundary. | The run uses an unknown revision/environment or modifies outside the declared workspace. |
| Debugging and repair | Preserve the original failure; classify code, environment, dependency, tool, permission, and data causes; apply a small reversible repair; rerun the reproducer and regression checks. | Original failure, classification, patch/diff, rerun result, and new candidate revision. | The system overwrites the original failure, makes an unexplained broad change, or skips regression verification. |
| Retry and safe stop | Retry only according to a declared policy; circuit-break repeated or unsafe failures and leave the run reviewable. | Retry count, stop reason, last error, cleanup result, and `BLOCK` record. | Infinite retry, silent retry, or a human must perform a routine technical step. |
| Real validation | Check the user-visible browser result, API/GraphQL result, and persisted database/runtime state when the task requires them. | Assertion-to-artifact index linking each assertion to screenshots/trace, requests/responses, database result, and logs. | Green CI, HTTP 200, screenshot, or model text is the only proof. |
| Independent decision | A validator outside the executing Agent reads machine-readable artifacts and derives `PASS` or `BLOCK`. | Validator version/hash, input artifact list, decision, and reason. | The executor or model declares its own success without independent evidence. |
| Recovery and cleanup | Restore code to the Git baseline when needed, and separately restore/rebuild database, test data, and runtime state; clean temporary resources. | Code rollback record, data/runtime recovery record, environment destruction/cleanup record. | Rollback is only a documented command, or code recovery is confused with data recovery. |
| Reproducible handover | Package the pipeline, configuration, task cards, evidence schema, setup/cleanup instructions, limitations, and version identifiers so another run can be repeated. | Package hash, clean-environment command/result, evidence index, and known-limitations list. | The result depends on an undocumented personal machine or cannot be reproduced from the handover package. |

These points are deliberately more specific than a tool list. OpenHands, ClawAI, Docker, GitHub Actions, Playwright, Jest, PostgreSQL, Redis, or equivalent tools may implement the rows, but naming a tool does not prove that the row is satisfied.

## Optional implementation variants

These are additions to, not replacements for, the required loop above. If a proposal uses one, it must record the choice, impact, evidence, and `BLOCK` conditions in the task card and Acceptance Manifest:

1. **Cross-layer consistency:** For a task with browser, API/GraphQL, and database effects, the three observed results may be required to agree. Any inconsistency is `BLOCK`.
2. **Agent failover:** A primary and fallback Agent may be used. Switching must preserve the original failure, task card, permissions, acceptance rules, and evidence format, and must record the reason and old/new versions.
3. **Model-service preflight:** Before code changes, check the controlled Secret, model endpoint, route, quota/rate limits, and fallback route. Failure must stop before modification with `MODEL_PROVIDER_UNAVAILABLE` or an equivalent `BLOCK`; Secrets never enter logs.
4. **External-side-effect isolation:** Payment, email, and notification tests use test mode or a sandbox unless a real external action is expressly authorized and evidenced.
5. **Serial or parallel execution:** Serial execution remains the default. Parallel execution is allowed only for genuinely independent stages with separate task IDs, workspaces, databases/queues, logs, and evidence directories.
6. **Task-scoped evidence:** An equivalent of `evidence/<run-id>/<task-id>/` may organize the task card, logs, browser/API/database evidence, screenshots, traces, diffs, rollback records, and validator result so every artifact is traceable.

## Optional control-plane variants

These are additions to, not replacements for, the required loop and the optional variants above. If a proposal uses one, it must record the selected design, impact, evidence, and `BLOCK` conditions in the task card and Acceptance Manifest:

1. **Separate control/safety/evidence kernel:** A layer outside the Agent may own task identity, scope, workspace lifecycle, permissions, execution/time limits, retries, circuit breaking, and evidence collection. The Agent may not change control rules, expand permissions, or self-report `PASS`. Evidence includes the control-layer version, task/run ID, effective permissions, workspace creation/destruction, limits, tool calls, and evidence-write records.
2. **Agent handoff protocol:** Handoff between multiple Agents or parallel branches must carry the task ID, task-card version, current commit, completed actions, unresolved issues, allowed tools/permissions, existing evidence, next-step proposal, and whether writing is allowed. Missing fields, version mismatch, or untraceable evidence produces `BLOCK`; a verbal summary is not a substitute.
3. **Replaceable model-backend qualification:** A fixed backend, local Ollama, OpenRouter, or another controlled backend may be used. After a switch, the same task card must qualify code reading, tool calls, debugging, regression, evidence, and safe-stop behavior. The switch may not change the goal, permissions, acceptance conditions, or evidence format. Record the endpoint, version/route, reason, and comparison result; Secrets never enter logs.

## Implementation freedom

OpenHands, ClawAI, Docker, GitHub Actions, Node.js, Python, and other tools are optional choices. A contractor may reuse an existing Pipeline or combine suitable open-source components, provided that licenses, versions, permissions, costs, limitations, and replacement/rollback methods are stated. The public demo is a small evaluation workload; it is not the complete formal Pipeline.

## What a proposal should show

Please explain which component performs each responsibility above, how you tested the public demo, what evidence is produced, how three genuinely long-chain tasks will be run before delivery, and how the final private acceptance run will be separated from the contractor's public fork or pull request. A fork or PR is only a submission/demo surface and does not grant access to private repositories, the minipc, production, or credentials.
