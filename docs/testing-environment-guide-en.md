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

Admin GraphQL, the Dashboard, payment, business writes and browser flows require a separately issued staging test account, fixtures and task authorization. A Vendure administrator grants application-level access only; it does not grant VPS, SSH or Docker access. The owner issues credentials separately through an approved private channel; do not put them in this public guide, repository or public artifacts. Never use production credentials or production data.

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

## 6. Temporary access rules and current exception

The default remains least-privilege access scoped to a task. Because this Pipeline work is substantially overdue, the project owner has specifically authorized Maleeha to develop, debug and run tests autonomously inside the current staging/Runner sandbox, avoiding delays from repeated approvals. This is an exception for Maleeha and this sandbox, not the default for other contractors. See Section 10 for the exact scope and the offboarding checklist.

The current VPS does not host production. Future production will use a separate VPS; Maleeha is not authorized to access that future production host or the minipc. Do not carry the current staging-sandbox permissions over to production.

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

The public evaluation workflow remains on GitHub-hosted `ubuntu-latest`; arbitrary code from public pull requests is not automatically run on this self-hosted Runner. The current staging workflow is manually started with `workflow_dispatch` and its logic allows only the `main` and `codex/maleeha-pipeline` refs. The GitHub `staging` Environment currently has no Required reviewers and its deployment branch setting is No restriction. PR rules on the public `vendure-project-briefing/main` are effective; rules configured for the other three private repositories are not enforced under the current GitHub plan, so they must not be treated as effective approval or direct-push barriers. Maleeha separately has VPS host-administrator access, as detailed in Section 10; this does not change the fact that the Runner service itself runs as the unprivileged `gha-runner` account.

### 8.3 Controlled PostgreSQL gateway

The legacy helpers `setup_tax_rates.mjs` and `admin_delist_products.mjs` call Docker Compose and `psql` even in dry-run. They are supported through a narrow gateway, not through Docker socket or Docker-group access:

- Step-scoped `/opt/gha-runner/staging-bin/docker` allows only `docker compose ps -q postgres` and `docker exec -i <current-staging-postgres> psql -U vendure_staging -d vendure_staging ...`.
- `/usr/local/sbin/staging-postgres-ps` and `/usr/local/sbin/staging-postgres-exec` are the only sudo-allowlisted helpers in `/etc/sudoers.d/90-staging-postgres-gateway`.
- Other containers, other databases, `docker build`, `docker run`, volume operations, privileged mode and arbitrary Docker commands are rejected. Syslog records the operation type without SQL text or credentials.

Verification passed: the allowed path returned `SELECT 1`; a wrong database was rejected; `docker run --privileged` was rejected. This gateway is only for the two declared scripts and is not general Docker or PostgreSQL administration.

### 8.4 Auditable operations and identity status

- `/usr/local/sbin/pipeline-debug-status` and `/usr/local/sbin/pipeline-debug-runner-restart` remain owner-maintained status/Runner-restart tools; they are no longer the limit of Maleeha's current access.
- According to the 2026-10-13 access-change record, `maleeha-debug` uses Maleeha's personal SSH public key, has interactive SSH and unrestricted sudo, and belongs to the rootful `docker` group. This is effectively host-administrator access to the current VPS sandbox: he can manage staging, the Runner, containers, databases and host configuration on that machine, rather than being confined to one isolated container.
- This identity applies only to the current non-production VPS; it does not include the future separate production VPS or the minipc. The Linux/VPS identity is a different system-level account from a Vendure Dashboard administrator.
- This VPS permission description is based on the existing implementation record. This documentation update rechecked GitHub settings only; it did not log in to the VPS using Maleeha's private key. Never record SSH private keys, passwords or API-key values here.

### 8.5 Backup, rollback and current result

Root-only rollback markers are retained on the VPS: `/root/vps-pre-formal-config-latest.path`, `/root/vps-pre-archive-mount-latest.path` and `/root/vps-pre-resource-limits-latest.path`. The earlier VPS cleanup backup remains the legacy-site rollback point. The exact backup contents and credentials are not published in this guide.

Post-change verification passed:

1. both staging Compose layers are running; the Vendure API is healthy and `https://staging.tibella.eu/health` returns HTTP 200 with `{"status":"ok"}`;
2. the Runner service is enabled/active and rootless Docker reports version `29.3.1`;
3. the shared archive directory is writable by the Runner and staging non-root application user;
4. the controlled PostgreSQL gateway passes the allow case and rejects the negative cases;
5. the public-workflow boundary, production separation and no-MinicPC rule remain unchanged.

As of 2026-10-13, the GitHub collaborator roles, Environment reviewer/branch settings and workflow-allowed refs were checked as recorded in Section 10. This confirms access/entry configuration only; it is not a test PASS. Still pending and not to be reported as PASS: verification that the outbound-domain allowlist is actually enforced, formal long-chain Pipeline runs, Batch 1/Batch 2 business acceptance, load/pressure testing and authorized red-team testing. The current infrastructure result remains `STAGING_RUNNER_INFRASTRUCTURE_READY`, not final Pipeline acceptance.

## 9. Vendure staging administrator account (2026-10-11)

- The Vendure staging application had already completed its first-start bootstrap and already had a SuperAdmin. This operation did not reset the database, rebuild staging or change the existing administrator.
- A dedicated administrator account has now been added inside the isolated Vendure staging application for authorized staging development and acceptance work. Its privileges are at the Vendure application layer; it is not a VPS/Linux/SSH/Docker identity and grants no production access.
- The owner provides login credentials separately through an approved private channel. The password is not included in this guide, the GitHub repository, logs or public artifacts. Do not paste credentials into source code or task reports.
- The new account's Admin API login, administrator record and role were verified; staging health and the Dashboard page also responded successfully. This does not mean the Pipeline is complete or business tasks have passed.
- If GitHub Actions later needs this account, the owner must separately place its credentials in protected GitHub Environment secrets. This operation did not create or update those secrets.


## 10. Maleeha access record and offboarding checklist (2026-10-13)

To avoid further delays from repeated approvals on this overdue Pipeline work, the project owner authorized Maleeha to modify, debug, merge iterations and run authorized tests autonomously in the specified GitHub repositories and the current staging/Runner sandbox. GitHub settings below were checked in the signed-in UI on 2026-10-13. VPS privileges are recorded from the prior implementation log and were not re-tested by logging in with Maleeha's private key during this documentation update. No secret values are included here.

### 10.1 GitHub repository and branch permissions

GitHub account `Maleehaa06` is a direct collaborator, not an organization Owner:

| Repository | Current role | Project operations |
|---|---|---|
| `vendure-project-briefing` | Write | Modify Pipeline workflows, code and project docs; create PRs, start workflows and iterate where effective rules permit |
| `pipeline-contract` | Write | Modify and commit Pipeline code/contracts |
| `vendure-staging-baseline` | Write | Modify and commit staging Vendure source |
| `vendure-base-reference` | Write | Modify and commit Vendure base-reference source |
| `vendure-evaluation-input` | Read | Read the fixed acceptance inputs; cannot directly modify this repository |

Actual branch-rule behavior:

- `vendure-project-briefing/main` is public. Its PR, resolved-conversation, zero-required-approval and no-force-push/deletion rules are effective. No case-by-case owner approval is required; Maleeha may merge after satisfying the rules.
- `pipeline-contract/main`, `vendure-base-reference/main` and `vendure-staging-baseline/codex/staging-vendure-3.7.3` are private. Although PR/zero-approval/no-force-push/no-deletion rules are configured, the current GitHub plan does not enforce them. Do not describe them as effective barriers to direct push or protection; the Write role may permit direct pushes/merges.
- The GitHub `staging` Environment currently has no Required reviewers and deployment branches are set to No restriction. The staging workflow is manually started with `workflow_dispatch` and its code permits only `main` and `codex/maleeha-pipeline`. Maleeha can start authorized runs on an allowed ref without first merging the Pipeline into `main`.
- Write access does not expose Environment secret values in settings, but the ability to modify workflow code and start an authorized Runner job means executed code may use the test secrets made available to that job. Store staging/test credentials only; never store production credentials there.

### 10.2 Current VPS sandbox permissions

The current VPS is for staging and the Runner only. Future production will use a separate VPS; the minipc is outside this authorization. According to the existing implementation record, `maleeha-debug` has SSH login, unrestricted sudo and rootful Docker access. This is equivalent to host-administrator access on this VPS: he can independently inspect/change its Runner, staging services, containers, databases and system configuration. The Runner service still runs as the unprivileged `gha-runner` user, but this does not isolate the host-administrator account. A Vendure Dashboard account is a separate application identity; unless its credentials are separately delivered, do not treat an account having been created as proof that the contractor can log in to it.

### 10.3 Offboarding and verification

First preserve accepted code, PRs/commits, workflow runs, reports and reusable test fixtures. Then:

1. **Revoke GitHub access:** remove `Maleehaa06`'s direct roles from all five repositories above; check inherited team/org access, pending invitations, deploy keys, temporary integrations and project-issued tokens, and remove any no longer needed. Preserve required PR, branch, workflow and evidence records.
2. **Disable VPS login:** lock/delete `maleeha-debug`; remove its `authorized_keys` public key, sudoers entries, `docker`/other authorized group memberships and SSH configuration references; terminate existing SSH sessions and verify a new login is rejected.
3. **Audit host persistence:** because this identity has host-admin access, deleting the account alone does not prove there are no leftovers. Check users/SSH keys, sudoers, systemd services/timers, cron, Runner registration/configuration, startup items, Docker containers/images/volumes/networks, listening ports/firewall rules and staging configuration diffs. If any persistence cannot be explained or verified, rebuild staging/Runner from a trusted baseline before restoring required data.
4. **Reclaim Runner/workflow control:** check for added Runner registrations, services, tokens or workflow entry points; revoke/rotate Runner registration credentials and, if necessary, re-register under an owner-controlled identity. Review and retain workflows needed for the accepted delivery; remove temporary permissions and unused entry points.
5. **Revoke application accounts:** disable/delete the dedicated Vendure staging administrator (for example `maleeha-staging@invalid.example`, if it still exists) and rotate any staging SuperAdmin password that may have been exposed. Clean temporary accounts/data according to evidence-retention needs while preserving required fixed acceptance fixtures.
6. **Rotate test credentials:** revoke/rotate the Stripe test key, OpenRouter key, GitHub Environment secrets, staging-admin credentials, database credentials and other temporary credentials that Maleeha or his workflows could have used. Never reuse production credentials.
7. **Close out:** record operator, time and result; verify no GitHub access, rejected SSH login, invalidated old credentials, owner-controlled Runner operation, and healthy staging/required tests. Do not mark the environment clean while unexplained host-level changes remain.

This section records the approved/implemented access boundary and future offboarding steps. Editing this guide does not itself change GitHub roles, VPS accounts, SSH keys, the Runner, secrets or business state.
