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

## Implementation freedom

OpenHands, ClawAI, Docker, GitHub Actions, Node.js, Python, and other tools are optional choices. A contractor may reuse an existing Pipeline or combine suitable open-source components, provided that licenses, versions, permissions, costs, limitations, and replacement/rollback methods are stated. The public demo is a small evaluation workload; it is not the complete formal Pipeline.

## What a proposal should show

Please explain which component performs each responsibility above, how you tested the public demo, what evidence is produced, how three genuinely long-chain tasks will be run before delivery, and how the final private acceptance run will be separated from the contractor's public fork or pull request. A fork or PR is only a submission/demo surface and does not grant access to private repositories, the minipc, production, or credentials.
