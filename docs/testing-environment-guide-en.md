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

## 8. Formal VPS staging and Runner configuration (2026-10-03)

This section records the current Hostinger implementation. It describes the infrastructure boundary and verification results; it is not a product or Pipeline acceptance result.

### 8.1 Host and resource baseline

- Host: `srv748373.hstgr.cloud`, Ubuntu 24.04.2 LTS, x86_64, 2 vCPU, about 7.8 GiB RAM and about 96 GiB root storage.
- A 4 GiB `/swapfile` was created with mode `0600`, enabled, and added to `/etc/fstab`.
- The Runner already provides Node `v20.20.2` and npm `10.8.2`. Workflows must use that pinned toolchain or explicitly select Node 20/22; they must not depend on an undocumented host Node installation.
- `postgresql-client` was installed; `psql` is PostgreSQL 16.15. Playwright Chromium OS dependencies and browser binaries were installed under the Runner-owned cache.
- The VPS currently reports `REBOOT_REQUIRED_PENDING` after package installation. No reboot was performed in this configuration window; a reboot requires a separate owner-approved maintenance window.

The active container limits are:

| Component | CPU limit | Memory limit |
|---|---:|---:|
| Vendure API | 1.0 CPU | 2 GiB |
| Vendure worker | 0.75 CPU | 1.5 GiB |
| PostgreSQL | 1.25 CPU | 1.5 GiB |
| Redis | 0.5 CPU | 512 MiB |

Concurrency is one job. A resource kill, queue wait or dependency exhaustion is `DEPENDENCY_ENVIRONMENT`, never a Pipeline PASS. The full 8-Batch-1 plus 16-Batch-2 run is expected to be slow and must use an explicit extended timeout rather than silently increasing concurrency.

### 8.2 Staging/Runner separation

- Staging runs in the separate Compose projects `nail-staging` and `nail-patterns-staging-app` under `/opt/nail-patterns-staging`, with its own internal network, named data volumes and root-only secret files. The API remains bound to `127.0.0.1:3100` behind the staging HTTPS entry point.
- The GitHub Actions Runner is registered as `staging-vps-rootless-runner`, runs as unprivileged user `gha-runner`, and uses a separate rootless Docker daemon at `/run/user/1004/docker.sock`. Its systemd service is enabled and active.
- `gha-runner` is not in the rootful `docker` group, and SSH explicitly denies SSH login for that service user. Runner jobs cannot obtain the rootful Docker socket or use the Runner service account as a VPS login.
- `/opt/pipeline-archive` is a controlled shared archive/evidence directory owned by `root:pipeline-archive` with mode `2770`. The Runner user and the non-root staging `node` user both passed write checks. It is mounted into the staging API/worker and is not a database or secret volume.
- The Runner is not joined to `nail-staging-internal` and does not mount the staging PostgreSQL or Redis data volumes. Staging access must use the approved HTTPS/API entry point or an explicitly approved adapter.

The public evaluation workflow remains on GitHub-hosted `ubuntu-latest`. Public pull requests must not run arbitrary code on this self-hosted Runner. A staging workflow must be protected by the repository Environment and branch/PR controls.

### 8.3 Controlled PostgreSQL gateway

The legacy helpers `setup_tax_rates.mjs` and `admin_delist_products.mjs` call Docker Compose and `psql` even in dry-run. They are supported through a narrow gateway, not through Docker socket or Docker-group access:

- Step-scoped `/opt/gha-runner/staging-bin/docker` allows only `docker compose ps -q postgres` and `docker exec -i <current-staging-postgres> psql -U vendure_staging -d vendure_staging ...`.
- `/usr/local/sbin/staging-postgres-ps` and `/usr/local/sbin/staging-postgres-exec` are the only sudo-allowlisted helpers in `/etc/sudoers.d/90-staging-postgres-gateway`.
- Other containers, other databases, `docker build`, `docker run`, volume operations, privileged mode and arbitrary Docker commands are rejected. Syslog records the operation type without SQL text or credentials.

Verification passed: the allowed path returned `SELECT 1`; a wrong database was rejected; `docker run --privileged` was rejected. This gateway is only for the two declared scripts and is not general Docker or PostgreSQL administration.

### 8.4 Auditable operations and identity status

- `/usr/local/sbin/pipeline-debug-status` is a bounded read-only status wrapper for host resources, staging Compose, staging health, Runner state and a limited Runner journal tail.
- `/usr/local/sbin/pipeline-debug-runner-restart` can restart only the named Runner service and records the action through syslog.
- Both wrappers are available only through the empty `pipeline-debug` group and `/etc/sudoers.d/90-pipeline-debug-ops`.
- No `maleeha-debug` Linux account has been created yet. It requires Maleeha's individual SSH public key and a written start/expiry/revocation window. When created, it must never receive root, unrestricted sudo, Docker socket/group, database, Redis or production access.

### 8.5 Backup, rollback and current result

Root-only rollback markers are retained on the VPS: `/root/vps-pre-formal-config-latest.path`, `/root/vps-pre-archive-mount-latest.path` and `/root/vps-pre-resource-limits-latest.path`. The earlier VPS cleanup backup remains the legacy-site rollback point. The exact backup contents and credentials are not published in this guide.

Post-change verification passed:

1. both staging Compose layers are running; the Vendure API is healthy and `https://staging.tibella.eu/health` returns HTTP 200 with `{"status":"ok"}`;
2. the Runner service is enabled/active and rootless Docker reports version `29.3.1`;
3. the shared archive directory is writable by the Runner and staging non-root application user;
4. the controlled PostgreSQL gateway passes the allow case and rejects the negative cases;
5. the public-workflow boundary, production separation and no-MinicPC rule remain unchanged.

Still pending and intentionally not reported as PASS: Maleeha's SSH public-key onboarding, protected staging Environment reviewers/branch restrictions, a fully enforced outbound domain allowlist, the actual custom Pipeline workflow, business E2E, load/pressure testing and authorized red-team testing. The current infrastructure result is `STAGING_RUNNER_INFRASTRUCTURE_READY`, not final Pipeline acceptance.
