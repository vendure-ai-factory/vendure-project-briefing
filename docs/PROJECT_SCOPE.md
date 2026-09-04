# Project Scope

## In scope

- A repeatable pipeline entry for a bounded Vendure migration or debugging task.
- Suitable debugging, coding, unit or integration testing, browser E2E testing, and evidence collection capabilities.
- Explicit source, input, environment, and dependency identities.
- Controlled code changes, test execution, failure stopping, rollback information, and result reporting.
- Optional inspection and pipeline experiments using the sanitized public image materials in `evaluation-demo/assets/nail-patterns/`.
- A maintainer-controlled remote run against the private formal evaluation input after contract.

## Out of scope for the public demo

- The real legacy Vendure source and client-specific configuration.
- Production data, production deployments, personal credentials, minipc login, or shared runner access.
- Treating a green GitHub workflow, a zero exit code, a model message, or a submitted PR as formal acceptance.
- Giving a contractor write access to a canonical `main` branch.

## Delivery expectation

The final pipeline must be source-controlled, reproducible, documented, and able to leave evidence that another maintainer can inspect. The acceptance target is scoped manual equivalence: for the declared input, environment identity, account or fixture, public entry point, and action sequence, the evidence must support the same user-visible result a human would see.
