# Project Scope

## In scope

- A repeatable pipeline entry for a bounded Vendure migration or debugging task.
- Suitable debugging, coding, unit or integration testing, browser E2E testing, and evidence collection capabilities.
- Explicit source, input, environment, and dependency identities.
- Controlled code changes, test execution, failure stopping, rollback information, and result reporting.
- Optional inspection and pipeline experiments using the sanitized public image materials in `evaluation-demo/assets/nail-patterns/`.
- A maintainer-controlled remote run against the private formal evaluation input after contract.

## Current formal migration scope

The current phase has two sequential batches. Batch 1 covers the foundation: country and channel behavior, currency, customer country, product visibility, cart country restrictions, checkout/payment channel locking, and the dependent frontend, database, and configuration work. Batch 2 covers the remaining listed secondary-development capabilities, including custom press-on-nail product publishing, the complete effect-image/design-image directory and local-archive behavior, standard and custom purchase flows, wallet and payment, order merging, size, inventory and restocking, shipping, tax/order-index behavior, and the other end-to-end flows listed in the project overview. Accounting-related functionality and WorldFirst-related functionality are excluded from this phase; coupons and marketing remain explicitly deferred where the project overview marks them as to-be-developed.

The two batches remain separately traceable, but both are part of the complete agreed migration attempted after delivery. New features, a new Vendure version, a new execution environment, or a new acceptance scenario is not silently included in this scope; it requires written agreement.

## Out of scope for the public demo

- The real legacy Vendure source and client-specific configuration.
- Production data, production deployments, personal credentials, minipc login, or shared runner access.
- Treating a green GitHub workflow, a zero exit code, a model message, or a submitted PR as formal acceptance.
- Giving a contractor write access to a canonical `main` branch.

## Delivery expectation

The final pipeline must be source-controlled, reproducible, documented, and able to leave evidence that another maintainer can inspect. It must be packaged so that a clean isolated Linux environment can be created and removed reproducibly. The normal control path is an authenticated GitHub workflow/API; GitHub is not a substitute for the runtime, and SSH is not the normal task interface.

The acceptance target is scoped manual equivalence: for the declared input, environment identity, account or fixture, public entry point, and action sequence, the evidence must support the same user-visible result a human would see. After the three-task capability gate, the owner runs the remaining migration and reports reproducible failures. The contractor must continue repairing and rerunning defects in the frozen scope until the agreed acceptance conditions pass; there is no arbitrary small tuning-round limit for Pipeline defects. Scope changes require written agreement.
