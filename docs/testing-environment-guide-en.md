# Public Contractor Testing Environment Guide

> This is the public, sanitized guide for contractor evaluation and authorized staging validation. It contains no passwords, tokens, private keys, database connection strings, production data or private-source links.

## 1. Purpose and two execution phases

The public hands-on phase lets a contractor clone the public `vendure-project-briefing` repository, inspect the sanitized task and run the deterministic demo in the contractor's own computer, clone, fork, Codespace or isolated Linux runner.

The formal validation phase is different. The project owner freezes the candidate revision, task inputs, environment identity, fixtures, workflow interface, evidence requirements, cleanup and rollback rules. The owner then runs the candidate through a controlled workflow against the authorized staging environment. A successful public demo is evidence of feasibility; it is not formal acceptance of the private Vendure work.

## 2. Public hands-on materials

Public repository:

`https://github.com/vendure-ai-factory/vendure-project-briefing`

Use the public branch `codex/github-refactor-20260904` and follow the repository README, `docs/START_HERE.md`, `docs/ACCEPTANCE_OVERVIEW.md`, `docs/CONTRACTOR_QUICKSTART.md` and `evaluation-demo/task.md`.

From a clone, the no-secret demo can be run with:

```bash
node evaluation-demo/scripts/run-demo.mjs
bash evaluation-demo/scripts/verify.sh --acceptance
```

The contractor may inspect the larger sanitized migration-input package, modify the contractor's own clone or fork, and submit a branch, commit or pull request for review. A public pull request does not grant access to private repositories, the VPS, production or the project's `main` branch.

## 3. Authorized staging entry points

The project-owned staging service is separate from production. When the project owner authorizes a task and provides a temporary test account, the contractor may use these public entry points:

| Purpose | Address | Boundary |
|---|---|---|
| Staging entry | `https://staging.tibella.eu` | Staging only; not production |
| Health check | `https://staging.tibella.eu/health` | Read-only preflight; expected HTTP 200 and `{"status":"ok"}` |
| Shop GraphQL | `https://staging.tibella.eu/shop-api` | POST GraphQL; the minimal identity check is `{ __typename }` |

Admin GraphQL, Dashboard, payment, business writes and browser business flows require a separately issued staging test account, fixture and task authorization. Never use production credentials or production data.

## 4. How code reaches staging

The normal controlled path is:

```text
contractor revision or approved private candidate branch
        -> owner review and frozen Acceptance Manifest
        -> protected GitHub Actions workflow
        -> immutable image or pinned artifact
        -> project-owned staging VPS
        -> API / GraphQL / browser / evidence checks
```

The staging source repository and deployment credentials remain project-controlled. A contractor does not need private-source access merely to run the public demo or to submit a candidate Pipeline. If a formal task requires private-source access, the owner may issue a time-limited GitHub collaborator identity limited to the agreed repository and branch or pull-request flow.

## 5. Test-location matrix

### Contractor-owned or GitHub Actions environment

- dependency installation from the lockfile;
- type checks, linting, unit tests and deterministic integration tests;
- builds of the candidate Pipeline and disposable test containers;
- code-level E2E that does not depend on the staging domain, persistent staging data, VPS identity, TLS, reverse proxy or VPS resource limits;
- public-demo and sanitized-input evidence generation.

### Project-owned staging VPS

- exact image/deployment identity checks;
- staging-domain, TLS, CORS, public-routing and persistence checks;
- migration, reset, recovery, worker-queue and PostgreSQL/Redis identity checks;
- browser/API flows requiring staging fixtures or the staging domain;
- load/pressure tests and authorized non-destructive security tests.

A GitHub Actions pass cannot replace a staging result when the task depends on the staging domain, persistent data, proxy, VPS identity or resource limits. Load/pressure and red-team work requires written scope, a test window, rate limits, cleanup and explicit authorization; it must never target production.

## 6. Temporary access rules

If the owner decides that the contractor must operate a formal staging run directly, access is granted as separate, temporary permissions:

1. a GitHub identity limited to the agreed repository and branch or PR flow, only if source access is necessary;
2. a staging-only test account with the minimum required permissions;
3. an explicit task card, test window, rate limit and cleanup method.

The contractor does not receive production access, VPS SSH/root access, unrestricted Docker or self-hosted-runner access, database/Redis access, repository secrets, private keys or credentials stored in deployment files. Access is revoked after the agreed work or acceptance window.

## 7. Required delivery evidence

Each formal run should identify the candidate commit or digest, task input, environment identity, commands or workflow run, API/GraphQL/browser evidence, logs and traces, data creation and cleanup, rollback or safe-stop result, failed checks and reproduction steps. Logs and evidence must not contain passwords, tokens, cookies, private keys or complete connection strings.

`STAGING_ENVIRONMENT_READY` means that the staging API/worker environment is available. It does not claim that the product, the custom Pipeline, business E2E, load/pressure testing or red-team testing has passed.
