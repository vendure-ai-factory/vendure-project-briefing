# AI Automation Pipeline: Technical Requirements and Implementation Boundaries (Buzz / OpenHands / ClawAI Reference)

> ## Read This First: Executive Summary
>
> We are not looking for a chatbot that merely generates code. We need an autonomous Linux-based software-delivery pipeline that accepts a task card containing only an end-to-end business goal, converts that goal into expert-verifiable technical metrics, decomposes the work, reads code, debugs, writes code, tests, uses surrounding tools, researches solutions when necessary, and produces reviewable evidence. We recommend that the contractor first consider OpenHands or ClawAI as the pipeline framework, but this is not mandatory. The contractor may adapt a pipeline, Agent framework, or other technical solution that the contractor knows well, provided that the final result meets this document’s capabilities, boundaries, and verifiable outcomes. Buzz coordinates messages and branch tasks; Codex is the preferred coding IDE/backend; and Vendure is the primary technology target. The client does not provide technical guidance during execution and participates only in business-goal confirmation, necessary authorization, and final acceptance. The pipeline must complete real E2E validation, load testing, and red-team testing. Before formal delivery, the contractor must select and automatically complete at least 3 long-chain tasks from the project overview’s E2E validation tasks and submit evidence. This is a capability/delivery gate, not final acceptance or a payment event by itself. After receiving the pipeline, the client will use it to attempt the complete migration within the agreed scope. If problems appear, the contractor must continue tuning and rerunning it until the migration is complete and the pipeline runs the agreed scenarios reliably and automatically; only then will final acceptance and payment occur. There is no arbitrary small limit on tuning rounds for in-scope Pipeline defects; new features, Vendure versions, environments, or acceptance scenarios require written scope agreement.
>
> **Important when reading the rest of this document:** The many pipeline software, framework, and tool descriptions below are records of our past trials or research and are provided for contractor reference only. They are not a requirement to use every item, and they do not mean that every item is currently installed or ready for direct delivery.
>
> Current minipc baseline: Ubuntu 24.04.4 LTS, x86_64, 16 logical CPUs, 22 GiB RAM, Docker 29.1.3, PostgreSQL 16.15, and default Node.js v20.20.2. Codex CLI was not found in the default PATH, and the root filesystem was approximately 85% full at the time of inspection. Legacy code and test fixtures on GitHub are pipeline inputs; the customer SSD is only a post-run output target.

**Document type:** Project introduction, reference architecture, and capability-acceptance boundaries for the contractor  
**Prepared:** 2026-09-04  
**Primary business:** Vendure e-commerce secondary development, migration, debugging, and end-to-end validation  
**Software-catalog basis:** [Final surrounding-software inventory report](C:/Users/zhang/Documents/Codex/2026-08-18/new-chat-2/outputs/mcp_software_audit_report.md)

## 1. Project Objective

We want to build an AI software-development pipeline that runs on Linux. The pipeline accepts a task card written in human language, understands the business goal, fills in technical acceptance criteria, analyzes the code and runtime environment, decomposes and executes subtasks, calls suitable surrounding software, changes the code, runs tests, performs end-to-end verification, and leaves verifiable delivery evidence.

The primary use case is secondary development of a Vendure commerce system. The objective is not for AI to produce code that merely looks plausible. The objective is for the pipeline to complete a real engineering loop without technical guidance from the client: 

```text
Human-language task card
    -> Technical requirements and acceptance metrics
    -> Code, environment, and dependency analysis
    -> Controlled decomposition and subtask execution
    -> Sandboxed changes, debugging, and tests
    -> Real storefront/backend/database/integration verification
    -> Load testing and red-team testing
    -> Evidence aggregation, failure explanation, and delivery conclusion
```

The client is a business owner, not a professional programmer. The client can describe what a user should do and what result the user should see, but should not be required to tell the AI which class, API, database query, plugin, selector, or command to use during execution. The pipeline must make ordinary technical decisions itself. It may stop and ask the client only when the matter involves real credentials, an irreversible operation, an out-of-scope action, a dangerous resource, or a business choice that cannot be inferred from the task.

## 2. Overall Buzz + OpenHands Concept

### 2.1 A reference concept, not a mandatory implementation

Our original idea was to combine open-source software from GitHub wherever practical, producing a replaceable, auditable, and maintainable AI-development pipeline. We recommend evaluating OpenHands or ClawAI first, but this is only a reference direction. The contractor may reorganize a familiar framework or pipeline. The reference combination is:

- **Buzz:** The messaging, coordination, and information-sharing layer between Agents. It lets the main task start branch tasks and lets different roles share context, progress, and results.
- **OpenHands / ClawAI:** Candidate autonomous development-team or autonomous-execution frameworks. They turn technical work into engineering actions: read code, plan changes, call tools, write code, run tests, and continue investigating and repairing ordinary technical failures.
- **Codex:** Our primary coding IDE and preferred pipeline-development tool. We would like the contractor to use Codex first to build, debug, and deliver the pipeline itself. If the pipeline calls a coding Agent internally, Codex should also be evaluated as the implementation backend.
- **skill-doctor (warpdotdev/common-skills):** An optional pipeline-development retrospective and skill-quality analysis tool. It analyzes selected local Agent conversations and skill configurations, then produces efficiency/code-quality/skill-coverage findings, a report, and candidate `SKILL.md` diffs so recurring debugging experience can become reviewable project assets. It does not execute business code, replace tests or validators, or automatically modify the real skills.
- **Vendure capabilities and surrounding software:** Specialist tools for databases, GraphQL, frontend browsers, payments, email, observability, performance, security, and load testing.
- **A thin code-owned boundary:** A small amount of code protects task identity, permissions, scope, resources, irreversible actions, and evidence integrity. A validator derives the final PASS/BLOCK; a model sentence saying “completed” does not.

This structure is the direction we would like the contractor to consider, not a mandatory list of components. The contractor does not have to reproduce Buzz, OpenHands, ClawAI, or our previous scripts word for word. The contractor may use a more suitable open-source framework, a familiar Agent runtime, or a different composition of components, as long as the final pipeline meets the capabilities, boundaries, and acceptance requirements in this document. The many software descriptions later in this document come from past trials or research and are provided only to help the contractor understand possible tool directions. They are not a purchasing list or mandatory technology stack.

### 2.2 Problems the pipeline must solve

Our previous pipeline attempts were unsatisfactory mainly because:

- too much process-control code produced a complicated state machine and tasks became stuck in intermediate states;
- every exception had to be hard-coded in advance, so new situations stopped the pipeline or caused repeated retries;
- Agents were over-constrained and could not adapt their route to the actual code, tool output, and failure cause;
- the client is a non-expert and cannot provide continuous technical guidance;
- “it compiles,” “the API returned 200,” or “the model said it was done” was sometimes mistaken for real business completion;
- many surrounding tools were available, but they were not connected to roles, capabilities, and evidence requirements.

This project should delegate routine technical route selection and recovery to OpenHands or an equivalent autonomous development-team framework, while retaining a thin code-owned layer for safety and evidence. This avoids rebuilding a large state machine without abandoning permissions, dangerous-operation controls, false-PASS protection, and delivery evidence.

### 2.3 Recommended control boundaries

| Layer | Main responsibility | Must not be responsible for |
|---|---|---|
| Buzz/coordination layer | Pass task context, share messages, start branch tasks, aggregate role results | Declaring business PASS from model text alone |
| OpenHands/autonomous-team layer | Plan actions, select technical routes, use tools, code, debug, test, and recover from ordinary failures | Bypassing permissions/evidence boundaries or expanding write scope |
| Codex/coding backend | Concrete code understanding, modification, command execution, and tests | Replacing the independent final validator |
| Code-owned safety/evidence kernel | Identity, scope, permissions, resources, irreversible operations, evidence integrity, and circuit breaking | Reimplementing every technical workflow or making every technical choice for the Agent |
| Independent validator | Check required tool evidence, test output, changes, and cleanup; derive PASS/BLOCK | Accepting an Agent self-report as the only proof |
| skill-doctor/retrospective layer | Analyze selected local conversations and skills and propose reviewable workflow/skill improvements | Executing business work, changing business source, or declaring PASS from a score |

This is a reference model of “adaptive coordination plus code-owned boundaries.” The contractor may use different names for these responsibilities, but may not remove the final evidence validation or dangerous-operation boundary.

## 3. Contractor Implementation Freedom

### 3.1 We provide goals and a reference direction

We will provide the contractor with:

- a human-language end-to-end task card;
- the legacy Vendure secondary-development code and test fixtures at fixed GitHub locations and revisions;
- the target Linux environment and Vendure technology-stack information;
- our Buzz, OpenHands, ClawAI, and surrounding-software concept;
- the real task and acceptance criteria that the pipeline must be able to complete.

We do not require the contractor to reproduce our previous process-control code. The contractor may use our decomposition, tool catalog, and evidence requirements as references, or may base the solution on the contractor’s own OpenHands practice, Codex workflow, or another GitHub open-source framework.

### 3.2 Required outcomes

Regardless of the implementation route, the delivered pipeline must be able to:

1. start from a task card that contains a business goal but no detailed technical solution;
2. automatically expand the business goal into expert-verifiable technical metrics and acceptance conditions;
3. identify the required code, runtime, database, browser, payment, email, and other dependencies;
4. decompose a large task into dependent subtasks and execute them in a controlled sandbox or workspace;
5. choose suitable debugging, coding, browser, database, observability, security, or load-testing tools for the task;
6. inspect ordinary technical failures, research solutions, modify the code, and run regression checks without waiting for technical instructions from the client;
7. complete the read-code, write-code, test, and evidence loop without client technical guidance;
8. adapt to and verify Vendure’s real storefront, backend, GraphQL, database, order, inventory, tax, currency, payment, and local production-material flows;
9. run the agreed load and red-team tests after the business validation;
10. report a clear COMPLETE, BLOCK, or client-decision-needed result with its basis, failure cause, change scope, and next action.

### 3.3 Open-source preferred, not open-source mandatory

Our original preference is to use open-source GitHub software wherever practical, reducing lock-in and improving auditability. The contractor may choose alternatives, but must explain:

- the source, version, license, and maintenance status of each selected component;
- which capability in this catalog it replaces;
- how it produces equivalent or stronger evidence;
- which permissions, credentials, and resources it requires;
- how it is cleaned up, upgraded, replaced, and rolled back.

Any paid software or external service must be disclosed in advance and may not create unapproved customer expenditure. Installation success, a running process, help output, or a version number is not by itself proof that a tool has the capability required by this project.

### 3.4 Contractor path from public hands-on testing to formal delivery

After seeing the advertisement and becoming interested, the Contractor should open the public repository [vendure-project-briefing](https://github.com/vendure-ai-factory/vendure-project-briefing), read the project overview, acceptance targets, sanitized `evaluation-demo/` source, the [sanitized migration-input package](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/migration-input), and the `evaluation-demo/assets/nail-patterns/` image tree, and run the public demo on the Contractor’s own computer, clone, fork, or Codespace. The public package is published on branch `codex/github-refactor-20260904`; the original image subdirectory structure must be preserved. The public hands-on experience does not require access to private repositories, the minipc, or the production environment.

Based on the actual hands-on result, the Contractor submits a quote, delivery period, scope, assumptions, and risks. The Client selects one Contractor from the received quotes and signs the Agreement. After signature, the Contractor may develop and run the candidate Pipeline in the Contractor’s own isolated Linux environment or another agreed isolated runner, then submits the formal Pipeline package to the Client-designated private working branch or candidate repository. The package should include a `Dockerfile` and `compose.yaml` or equivalent runner definition, pinned dependencies, start/stop/check/cleanup scripts, a no-secret `.env.example`, tool/MCP permissions, and an immutable revision or digest. The Client freezes an Acceptance Manifest, pins a fixed revision, sends task prompts remotely through authenticated GitHub Actions `workflow_dispatch` or an equivalent API, and runs the validation in a clean Client-controlled temporary Linux environment or agreed independent-verifier environment. The Contractor repairs issues based on reproducible failure evidence and submits identified revisions; the independent validator derives `PASS` or `BLOCK` from real test, browser/API/backend, cleanup, and rollback evidence. SSH is not the normal task interface. A PR or fork is only a public hands-on submission method; it does not require merging and does not grant permission to modify the Client’s `main`, private repositories, minipc, or production environment. If a required tool can run only on the minipc, the Client exposes it through a narrow allowlisted adapter rather than unrestricted host access.

## 4. Codex Requirement

Codex is the IDE we primarily use for real programming work. Therefore, the contractor should preferably use Codex to build, debug, test, and package the pipeline.

“Use Codex” does not mean that every role must be hard-coded as Codex. It means that the contractor should first evaluate this combination:

- use Codex to read and understand the pipeline source;
- use Codex to build the Buzz/OpenHands adapters, role configuration, tool calls, and evidence collection;
- use Codex to debug the pipeline instead of relying only on manual terminal experimentation;
- if OpenHands calls another coding backend, evaluate Codex first as the concrete implementation backend;
- use Codex to run a real small Vendure repair task, proving that the pipeline can read code, use surrounding tools, write code, test, load-test, red-team-test, and leave evidence.

The current minipc read-only baseline did not find a `codex` command in the default login-shell PATH. If the contractor intends to run Codex CLI directly on the minipc, the contractor must legally install/configure it and verify its capability. If the contractor uses Windows Codex to control a Linux workspace, the remote boundary, permissions, and evidence paths must be documented. “Codex works on another client computer” is not proof that Codex is configured on the minipc.

## 5. Linux Target and Current Baseline

### 5.1 Target environment

The Pipeline must execute on Linux. The minipc is a possible Client-controlled target for approved runtime adapters or a final run, but it is not the Contractor’s unrestricted development host and is not automatically the only acceptance environment. The Contractor should develop first in an isolated Linux environment equivalent to the target. Final capability verification must run in a clean, isolated Linux environment whose owner, network boundary, credentials, lifetime, cleanup, and evidence path are recorded in the Acceptance Manifest. Where the Client uses the minipc, the Pipeline must enter it through a narrow owner-controlled interface rather than unrestricted SSH or host access.

### 5.2 Live read-only minipc baseline

The following information came from a read-only minipc probe on 2026-08-31. It is a starting reference for the contractor, not proof that every service has passed a business-health check:

| Item | Observed value |
|---|---|
| Hostname | `minipc` |
| Operating system | Ubuntu 24.04.4 LTS, Noble Numbat |
| Kernel | Linux `7.0.0-30-generic` |
| Architecture | `x86_64` |
| CPU | AMD Ryzen 7 7735HS with Radeon Graphics |
| Logical CPUs | 16 |
| Memory | 22 GiB; approximately 6.8 GiB available during the probe |
| Swap | 8 GiB |
| Root filesystem | Approximately 468 GiB; about 374 GiB used, 71 GiB free, approximately 85% used |
| Default Node.js | `/usr/bin/node`, v20.20.2 |
| Default npm | `/usr/bin/npm`, 10.8.2 |
| Additional NVM Node.js | `/home/zyy/.nvm/versions/node/v22.22.3/bin/node`, v22.22.3; corresponding npm 10.9.8, but not the default PATH |
| Python | Python 3.12.3 |
| Git | 2.43.0 |
| Docker | 29.1.3 |
| Docker Compose | 2.40.3 |
| PostgreSQL client | psql 16.15 |
| systemd | 255 |
| tmux | 3.4 |
| jq | 1.7 |
| curl | 8.5.0 |
| GitHub CLI | gh 2.45.0 |
| SSH | OpenSSH 9.6p1 |
| OpenSSL | 3.0.13 |

### 5.3 Observed environment cautions

The following matters must be addressed in the implementation plan:

- `pnpm`, `yarn`, and `redis-cli` were not found in the default PATH. If the pipeline depends on them, it must state their installation location, invocation method, or replacement.
- `codex` was not found in the default PATH; Codex CLI must not be assumed ready on the minipc.
- The Docker endpoint was reachable; the read-only probe saw Docker Server 29.1.3, approximately 36 containers, and 93 images. This proves only endpoint reachability, not the health of a specific Vendure or pipeline container.
- The PostgreSQL systemd unit was inactive, while `127.0.0.1:5432` was listening. The database may be running another way; the contractor must confirm the real database identity, container, and connection target rather than relying only on systemd.
- Port `6379` was listening, but `redis-cli` was not available. Redis must be checked through an actual client or adapter before use.
- Ports `3000`, `3001`, `6379`, and `24800` were observed listening. Historical ports must not be assumed free. The current clean-Vendure profile convention is API `3100` and frontend `5173`, but every real task must still verify port ownership and environment identity.
- `/home/zyy/mutiagent_Pipeline`, `/home/zyy/mutiagent_Pipeline_build`, `/home/zyy/ai_Pipeline/vendure-product`, and `/home/zyy/antigravity(old)/vendure商城/二开功能/流水线外包` currently exist, but they have different roles: runtime, build/planning, formal Vendure mainline, and historical/outsourcing materials. They must not be mixed.
- `/media/zyy/SU70022` exists, but the read-only probe showed that it is not a separate mount point; it is a directory under the root filesystem owned by `root:root` with `drwx------` permissions. The contractor must not treat path existence as proof that the SSD is mounted or writable. If a task must write to the customer SSD, the client must provide a controlled write method, and the pipeline must verify mount, permissions, capacity, and output.
- Root filesystem usage was approximately 85%. The pipeline needs a cleanup/retention policy for temporary workspaces, containers, browsers, logs, build artifacts, and evidence.

### 5.4 Baseline information is not a health proof

This section helps the contractor prepare the environment. It is not a software-capability acceptance. At delivery, every declared capability must still be smoke-tested with a real operation: real create/update/query, real browser action, real target-database connection, real report generation, and real cleanup. A version, help output, startup line, listening port, or running process cannot alone prove that a function is healthy.

## 6. Pipeline Entry: Start from a Task Card

### 6.1 Client-provided task card

The business entry point is one task card. The client uses a task-card-formatting skill mounted into Codex to write the card. The client card describes only:

- the end-to-end user actions desired;
- the business result expected to be visible;
- which result constitutes acceptance;
- necessary business restrictions, accounts, countries, products, data, or environment information.

The client does not need to write class names, function names, SQL migrations, browser selectors, or concrete repair steps. The card may contain business terminology and an acceptance sequence, but the pipeline must provide the technical implementation details.

### 6.2 Product Manager Agent / scenario compiler

The pipeline first starts a Product Manager Agent, also called an E2E scenario compiler. It does not write business code. It translates “what I want” into “how a machine determines that it has been achieved.” It must produce a technical task card or scenario specification containing at least:

- goal, task type, target repository, and target revision;
- runtime environment, database, containers, public entry point, ports, and identity;
- preconditions, actions, expected visible feedback, and failure conditions for every human action;
- browser, network/API, GraphQL, backend, database, queue, log, and filesystem evidence;
- required capability categories rather than an unjustified hard-coded single-tool choice;
- positive assertions, negative assertions, boundary conditions, and security constraints;
- test-data creation, validation, cleanup, and rollback;
- unresolved business assumptions, client decisions, and automatic circuit-break conditions.

It may compile and explain acceptance requirements, but may not write an unexecuted verification as PASS or replace actual later testing with reasoning.

### 6.3 Execution loop

The reference execution loop is:

```text
Task card
  -> Product Manager Agent / E2E scenario compilation
  -> Technical analysis and Vendure adaptation brief
  -> Buzz coordination and branch-task dispatch
  -> OpenHands autonomous development team
  -> Codex or another qualified Worker for coding/debugging
  -> Action-level evidence from surrounding tools
  -> Code-owned evidence relay
  -> Independent validator derives PASS/BLOCK
  -> Load testing/red-team testing
  -> Cleanup, rollback, delivery, and reflection
```

Large work may be decomposed into compatibility inventory, environment audit, backend changes, frontend changes, database migration, browser E2E, observability, load testing, red-team testing, and closeout. Branch tasks may run in parallel or serially, but each must have a defined scope, dependency, input, output, and evidence location. Introducing OpenHands must not allow arbitrary Agents to share the entire minipc filesystem.

### 6.4 Autonomous recovery

For an ordinary technical failure, the Agent should:

1. preserve the failed scene and original error;
2. classify the failure as code, environment, dependency, tool, credential, business rule, permission, resource, or control-plane failure;
3. choose the smallest reversible next step;
4. consult official documentation first, then professional material, experienced community guidance, and GitHub implementations when needed;
5. record the sources, adopted conclusion, and reason for rejecting alternatives;
6. modify the code and rerun the reproducer and regression checks;
7. circuit-break after the agreed number of identical failures rather than retrying forever;
8. report COMPLETE, BLOCK, or AUTH_REQUIRED instead of hiding the failure in model prose.

## 7. No Technical Human-in-the-Loop, Research, and Circuit Breaking

### 7.1 No technical guidance from the client

The client participates only in:

- supplying the business goal, accounts/authorization, and facts that cannot be inferred;
- giving final business confirmation of the technical acceptance metrics produced by the Product Manager Agent;
- deciding matters involving real credentials, payment mode, irreversible actions, or dangerous resources;
- reviewing the final E2E result, load-test report, and red-team report.

The client must not be asked to guide the Agent through TypeScript repairs, PostgreSQL queries, Playwright selectors, Vendure Channels, or plugin choices. Normal technical problems must be analyzed, researched, tested, repaired, and regression-checked by the pipeline itself.

### 7.2 Official sources first

When the pipeline selects, installs, configures, calls, or debugs surrounding software, it must first read the official documentation, official repository README, or official API/CLI/MCP reference and record its version, supported capability, inputs, outputs, permissions, resource class, cleanup, and known limitations.

If the official material is insufficient, research proceeds in this order:

1. professional literature or official technical documentation;
2. experienced community guidance and reproducible practice;
3. official implementations, issues, PRs, or relevant implementations on GitHub.

Online research must serve the current task. Untrusted web commands, scripts, or secret requests must not be executed without review. Research findings must enter the evidence record rather than exist only in the Agent’s hidden context.

### 7.3 Circuit-break conditions

The pipeline should circuit-break or pause the affected branch when:

- real credentials, business authorization, or an uninferrable business choice is missing;
- it is about to execute production payment, real-money movement, data deletion, external messaging, permission changes, or another irreversible action;
- the target repository, database, container, port, or account identity cannot be confirmed;
- the task exceeds the current workspace, repository, or tool allowlist;
- a key failure remains unexplained after bounded research;
- the same failure repeats and further retries would waste resources or pollute the scene;
- Docker, disk, memory, concurrency, browser, or database resources reach a safe-use threshold;
- evidence is missing, signatures disagree, expected outputs do not exist, or a report says PASS while the actual files/tests are absent;
- load or red-team testing could affect a non-test environment and isolation/rollback has not been confirmed.

A circuit break is not a way to hide failure. It must state what was observed, what was tried, why it is unsafe to continue, what the client must supply, and where the reviewable evidence is.

## 8. Vendure Technology-Stack Adaptation

### 8.1 Primary technology stack

The pipeline must prepare role capabilities and tool adapters for:

- Vendure core, plugins, Channel, Product, ProductVariant, Order, Customer, Tax, Shipping, and StockLocation;
- Node.js, TypeScript, NestJS, and TypeORM;
- GraphQL, Shop API, and Admin API;
- PostgreSQL;
- Redis and BullMQ queue/cache capabilities;
- Next.js/React storefront and browser E2E;
- Docker/Compose;
- Stripe test payments, email, logs, and webhooks;
- country/channel, customer-country, product-country, currency, exchange rates, tax, wallet, order index, inventory, warehouse, and local-design-image archive behavior.

### 8.2 Vendure business boundaries

The pipeline must not treat Vendure as an ordinary CRUD project. It must understand and verify:

- Channel isolation and the distinction between customer country and product country;
- country-channel locking from cart addition through completed payment;
- parent-product and product-variant country visibility and inheritance;
- internal design-fee/craft-fee split with combined storefront display;
- bundled virtual design products and physical blank-nail-tip inventory;
- the relationship between Customer, Order, OrderMetadata, orderLine, and designerId;
- unpaid, paid, exported, shipped, and abandoned guest-draft orders;
- customer default country, `Channel.defaultCurrencyCode`, wallet base currency, withdrawal currency, and exchange conversion;
- Tax Zones, VAT, weight-based shipping prices, and country warehouse isolation;
- one-to-one effect-image/design-image naming and the production path from an order selection to a local design image.

### 8.3 Plugin-first migration

The legacy secondary-development code was built on an older Vendure version, and the new base has more plugins. The pipeline must inventory versions, plugins, and current behavior before deciding what to migrate, rewrite, or reimplement with a target-base plugin.

If a function was previously implemented with custom code but direct migration would overwrite or damage current plugin behavior, the pipeline should rebuild the business adapter on the current plugin capability instead of mechanically overlaying old code. Every decision needs compatibility reasoning and regression testing.

Legacy code and test images are obtained from fixed GitHub revisions as pipeline inputs:

- **Public test-image fixture:** [vendure-project-briefing/evaluation-demo/assets/nail-patterns/](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/assets/nail-patterns), on the latest commit of branch `codex/github-refactor-20260904`;
- **Public sanitized source snapshot:** `evaluation-demo/migration-input/legacy/`, accompanied by the sanitized task inputs and repository-relative fixtures; suitable for inspection and contractor-owned experiments, not formal acceptance;
- **Formal legacy-code archive:** the Client-controlled private `vendure-evaluation-input` repository. The exact relative path and fixed revision will be provided in a controlled manner after signature and before the Acceptance Manifest is frozen; private history and owner-controlled formal inputs are not public;
- **Directory constraint:** the original subdirectory structure of the test images is part of the input contract. The pipeline must read the original relative paths and must not mix all images into one directory.

The pipeline must check out a fixed GitHub revision into an isolated workspace; the GitHub URL is the input source, not an executable local path.

## 9. Agent Role Model

A role is a responsibility boundary; it does not necessarily require one permanent process. OpenHands may dynamically choose roles, order, parallelism, and recovery. Buzz may share information and start branch tasks. Codex or another Worker may perform the concrete implementation.

| Role | Main responsibility | Typical input | Typical output/evidence | Tool direction |
|---|---|---|---|---|
| Business Product Manager Agent | Understand human-language goals and fill in technical acceptance metrics and negative conditions | Original task card and business description | Technical task card, E2E scenario, unresolved questions | sequential-thinking, fetch, exa-mcp, OpenHands planning, `mcp-test-harness-notes` |
| E2E Scenario Compiler Agent | Convert a human journey into action nodes, evidence bindings, cleanup, and risks | Task card, Vendure environment, accounts/fixtures | Read-only scenario specification and action/assertion/evidence matrix | Playwright, Chrome DevTools MCP, GraphQL, Mailpit, Stripe, `vendure-e2e-verification-pack` |
| System Architecture/Migration Agent | Analyze legacy code, target base, plugins, dependencies, and migration order | GitHub legacy code, target base, stack | Compatibility report, migration plan, risks, rollback boundary | git, gitnexus, code-graph, repowise, codebase-memory-mcp, OpenHands |
| Vendure Backend Agent | Modify plugins, NestJS, TypeScript, TypeORM, orders, channels, and business rules | Technical task card, backend source, database schema | Code changes, migrations, backend tests, tool receipts | nestjs-mcp, typeorm, postgres-mcp, GraphQL MCP, npm_manager, Docker |
| GraphQL/API Agent | Design, inspect, and execute Shop API/Admin API operations | GraphQL schema and API task | Query/mutation evidence, schema diff, interface regression | graphql-mcp, GraphQL Inspector, graphql-schema, graphql-operations, Postman |
| Frontend/Browser Agent | Modify Next.js/React pages and perform real browser routes | Frontend task, public entry point, browser scenario | Screenshots, traces, network/console evidence, UI regression | Playwright, Chrome DevTools MCP, Next.js DevTools MCP, Storybook, MSW, react-doctor |
| Database/Data-Migration Agent | Handle PostgreSQL, TypeORM, Redis, queues, and data consistency | Schema, migration target, fixtures | Before/after schema, query results, consistency and cleanup | postgres-mcp, PostgreSQL auto_explain, postgresai, Redis MCP, Testcontainers, BullMQ |
| Runtime/Environment Agent | Prepare Linux, Docker, services, ports, workspaces, snapshots, and recovery | Runtime identity and environment contract | Environment identity, container/service probes, baseline, rollback evidence | Docker, minipc-environment-boot, vendure-runtime-boot, minipc-remote-control, tmux |
| Observability/Diagnostics Agent | Collect traces, issues, logs, and performance profiles | Failure reproducer and runtime identity | Trace, issue, profile, root-cause analysis | OpenTelemetry, GlitchTip, Jaeger, sentry-mcp, clinic.js, Codspeed |
| Code Quality/Review Agent | Check changes, static quality, dependencies, dead code, and commit discipline | Git diff, source, dependencies | Review, static analysis, dependency risks, repair suggestions | Qodo Merge, open-code-review, SonarQube, ESLint, Husky, Knip, OSV Scanner, CodeQL |
| Contract/Integration-Test Agent | Check frontend/backend and service-to-service contracts and replay | Provider/consumer, API, mocks | Pact, MockServer, contract, and replay results | Pact/PactFlow, Playwright+MockServer, Checkly, Testcontainers |
| Security/Red-Team Agent | Verify vulnerabilities, authorization, injection, and overreach on isolated targets | Target scope, test accounts, risk boundary | Red-team report, reproduction, severity, cleanup result | semgrep, sqlmap, trivy, CodeQL, `redteam-flow`, `/owasp-audit` |
| Load/Capacity Agent | Verify throughput, latency, errors, resource use, and degradation | Target service, concurrency/load budget | Load report, resource curves, bottlenecks, recommendations | artillery, autocannon, k6, clinic.js, `pressure-test-flow` |
| Evidence/Validation Agent | Independently check expected outputs, signed receipts, changes, tests, and cleanup | Staged evidence from all roles | PASS/BLOCK, evidence index, missing items | Pipeline validator, Harness Starter Kit, observability/test-harness notes |
| Control-Plane Maintenance Agent | Repair templates, routing, adapters, skills, versions, and validators only | Control-plane BLOCK | Control-plane repair and regression evidence | `pipeline-engineering-sop`, `pipeline-task-contract`, `pipeline-agent-gate-playbook` |
| Reflection/Optimization Agent | Record version deltas, failure patterns, and next improvements | Run results, reports, client feedback | Reflection/version delta and follow-up | self-iteration, DSPy, promptfoo, Codex |
| Skill Doctor / Skill-Quality Agent | Reflection/Optimization Agent, Control-Plane Maintenance Agent | Run closeout, skill-quality analysis, and experience-asset updates | Analyzes selected local Agent conversations and skills and generates scores, findings, a report, and candidate `SKILL.md` diffs; it cannot change business source, directly edit real skills, or derive PASS | `skill-doctor` (warpdotdev/common-skills) |

The main Agent plans, supervises, explains, and routes. It must not bypass the control plane and write business code directly. A business Worker performs the concrete work; the validator decides whether the evidence is sufficient. A control-plane maintenance Worker may not modify current business source or turn the current BLOCK into PASS.

## 10. Surrounding Software Catalog by Role and Pipeline Position

This catalog is rewritten from the [Final surrounding-software inventory report](C:/Users/zhang/Documents/Codex/2026-08-18/new-chat-2/outputs/mcp_software_audit_report.md). The report contained 22 MCP sections and 25 distinct names; the tables below and the legacy-entry mapping retain these names and their capability ownership. This is a capability registry, not a requirement to start every tool on every task. A task card declares the capability it needs, and the pipeline chooses a healthy tool that can produce equivalent evidence. Under `guided-flex`, an equivalent tool may be used when the reason is recorded.

Status meanings:

- **Verified:** Real capability output or reliable callable evidence exists; it is a production candidate, subject to task-level receipts.
- **Checked:** Basic availability has been established, but a task-level live smoke should be added before making it a default mainline tool.
- **Migrated:** The old entry/path is now represented by a current capability; the old file must not be the only entry point.
- **Historical/retired:** Retained for reference only and not assembled into the current mainline.
- **Deferred/excluded:** Not part of the current mainline unless explicitly enabled and re-qualified.

### 10.1 Coordination, execution, and resource control

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| Buzz | Main Agent, Product Manager Agent, branch Workers | Entry, coordination, messaging, branch tasks | Shares context, passes messages, and starts branches. The report treats it as verified, but the current mainline remains manual/semi-automatic and must not be called unattended without proof. |
| CAO | Main Agent, control-plane maintenance | Routing and coordination decisions | Selects roles, capabilities, sequence, and recovery from the task contract; cannot replace the validator or manufacture PASS through an authorization conversation. |
| OpenHands | Autonomous development team, execution Worker | Technical execution after requirement expansion | Reads code, plans, uses tools, codes, debugs, tests, and recovers. It is the key candidate framework, but this report does not treat a current installation as verified; the contractor must qualify it with a real task. |
| Codex | Contractor development Agent, coding Worker, supervisory Agent | Pipeline construction and concrete implementation | Preferred coding IDE/backend. The current minipc default PATH did not contain `codex`; the contractor must configure it or document Windows-Codex-to-Linux control. |
| self-iteration / self-iteration-master | Reflection/optimization Agent | Closeout and next-round optimization | Records failure patterns, version deltas, and improvements; it is not a scheduler, validator, or business Worker. |
| `skill-doctor` (warpdotdev/common-skills) | Reflection/optimization Agent, Control-Plane Maintenance Agent | Retrospective, skill-quality analysis, and optimization capture | Analyzes selected local conversations and skills and outputs scores, concrete findings, a report, and candidate `SKILL.md` diffs; optional auxiliary tooling that must be qualified in isolation, not a pipeline runtime, test tool, or PASS authority. |
| parallel-task-orchestrator | Main Agent, branch Workers | Controlled decomposition and limited concurrency | Controls short tasks and named lanes under dependency, scope, resource, and evidence boundaries. |
| HyperQueue / `hq` | Resource/concurrency Agent | Worker admission and resource queue | Intended to queue shared minipc resources. The report found no verifiable `hq` CLI, so it is not currently a formally healthy capability and must not be an undisclosed production dependency. |
| minipc-remote-control | Runtime Agent, supervisory Agent | Remote Linux boundary | Uses controlled SSH/tmux-style access to minipc; arbitrary Workers must not receive the entire filesystem. |
| minipc-environment-boot | Runtime Agent | Preflight and recovery | Restores and validates supporting tools and services. Startup success is not a health proof. |
| vendure-runtime-boot | Vendure runtime Agent | Backend/frontend/runtime recovery | Starts and verifies the formal Vendure runtime boundary and distinguishes service start, port listening, and real business E2E. |

### 10.2 Requirement understanding, code maps, and research

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| `git` / `@modelcontextprotocol/server-git` | Architecture/Migration Agent, all Workers | Version, baseline, diff, rollback | Reads Git state, establishes baselines, and checks changes. The original MCP package is a checked/registry-remap candidate; the current callable entry must be pinned. |
| `gitnexus` | Architecture/Migration Agent, code-map Agent | Code reading and dependency relations | Code graph, full-text search, and vector index. Live doctor output showed these stores available; verified. |
| `code-graph` | Architecture/Migration Agent | Structural code understanding | Graph/index support for modules and call relations; the report found the index DB and registered graph store; verified. |
| `repowise` | Architecture/Migration Agent | Repository understanding and map | Repository understanding and code map; MCP connection and serverVersion 1.27.1 were observed; verified. |
| `codebase-memory-mcp` | Architecture/Migration Agent, Reflection Agent | Code memory and cross-task context | Stores reusable code facts and prevents long-task forgetting; facts, inference, and stale context must remain distinct. |
| `memory-mcp` | Reflection/Context Agent | Memory read/write | Maintains cross-task context; must not store passwords, tokens, private keys, connection strings, or sensitive data. Checked in the report. |
| `sequential-thinking` | Product Manager Agent, Architecture Agent | Requirement decomposition and complex reasoning | Decomposes business requirements into constraints, assumptions, and verification points; cannot replace real execution. |
| `fetch` | Product Manager Agent, Research Agent | Official documentation and web research | Retrieves official documentation, API references, and public technical information; sources and conclusions must be retained. |
| `exa-mcp` | Research Agent | Solution search | Helps find technical references when official sources are insufficient; third-party commands must not be executed without review. |
| `npm-registry-mcp` | Dependency/Migration Agent | Package and source verification | Checks Node/NPM package versions, upstream, and installation source; does not replace security scanning. |
| `mcp-architect-guardian` | Architecture/Control-Plane Agent | Scope, boundary, and architecture checks | The old entry was not found; its responsibility appears to be carried by current boundary-guard and code-map routes. Treat it as migrated, not as a required old JS path. |

### 10.3 Vendure backend, API, database, and queues

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| `npm_manager` | Vendure Backend Agent, Dependency Agent | Packages, scripts, and workspace | Reads manifests, installs dependencies, and runs scripts. Versions/workspace must be pinned; global pollution of the formal base is not allowed. |
| Docker / `@modelcontextprotocol/server-docker` | Runtime Agent, Database Agent | Isolated services, databases, and test dependencies | Starts/destroys containers and isolated environments. The original Docker MCP is a checked/registry-remap candidate; Docker endpoint reachability does not prove a target container is healthy. |
| `nestjs-mcp` / NestJS Suites | Vendure Backend Agent | NestJS service understanding and testing | Adapts Vendure/NestJS modules, services, subscribers, and tests. The old `NestJsMcp/dist/index.js` entry has migrated; do not rely only on the old path. |
| `graphql-mcp` | GraphQL/API Agent | Shop API/Admin API execution | Executes and verifies GraphQL. The report observed successful startup against `http://localhost:3000/admin-api`; task-level target identity and port must still be confirmed. |
| GraphQL Inspector | GraphQL/API Agent, Review Agent | Schema and contract checks | Compares schemas and detects breaking changes; verified candidate. |
| `graphql-schema` / `graphql-operations` | GraphQL/API Agent | Query design and regression | Designs, checks, and executes GraphQL operations with correct channel and identity context. |
| TypeORM logging | Database Agent, Vendure Backend Agent | Query diagnostics and migration | Observes SQL, transactions, query sources, and performance; verified diagnostic capability. |
| PostgreSQL `auto_explain` | Database Agent, Performance Agent | Slow-query and execution-plan evidence | Produces query plans and slow-query evidence; diagnostic support, not a replacement for business E2E. |
| `postgres-mcp` | Database Agent, Vendure Backend Agent | Database read/write and analysis | The report observed successful pool initialization against the Vendure database; verified. Writes require authorization, backup, and rollback. |
| `pg-analyzer-mcp` | Database Diagnostic Agent | Historical candidate/specialist diagnosis | Explicitly deferred/excluded from the current mainline; not a production-required tool. |
| `postgresai` | Database Diagnostic Agent | PostgreSQL analysis and advice | Assists PostgreSQL analysis; add task-level live smoke before default use. |
| Redis MCP / `redis-mcp` / `@redis/mcp-server` | Database/Queue Agent | Redis, cache, and queue checks | The report verified `redis-mcp` connectivity to localhost:6379 but noted an aging version; `@redis/mcp-server` is a registry-remap candidate. Confirm the real Redis identity. |
| `redis/agent-skills`, `redis-core`, `redis-connections` | Database/Queue Agent | Redis design and connection practice | Provides Redis modeling, connection, and failure-handling methods; not independent service-health proof. |
| MCP Toolbox for Databases | Database Agent | Controlled database-tool access | Provides a controlled collection of database tools; connections and write permissions must be declared. |
| Xata Agent | Database/Data Agent | Data retrieval and data tasks | Assists data access and Agent data operations; target database and write scope must be limited. |
| Testcontainers | Database/Integration-Test Agent | Temporary databases, dependencies, and integration tests | Creates isolated, cleanable PostgreSQL/Redis/service dependencies; verified candidate. |
| BullMQ / `bullmq-specialist` | Queue Agent, Runtime Agent | Async jobs, retries, and queue diagnosis | Adapts Vendure surrounding queues and verifies job state, retry, dead-letter, and cleanup; must not become a second unbounded pipeline state machine. |

### 10.4 Frontend, browser, email, payments, and integration tests

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| `playwright` / `@playwright/mcp` | Frontend Agent, E2E Scenario Agent | Real browser E2E | Performs homepage, search, detail, login, cart, payment, and customer-center actions. `@playwright/mcp` was reported active and without known vulnerability; suitable as a baseline. |
| Chrome DevTools MCP | Frontend/Browser Agent | Browser network, console, and page observation | `list_pages` returned a page in the report; verified. Bind page actions to network, screenshots, traces, and backend results. |
| Next.js DevTools MCP | Frontend Agent | Next.js routes, metadata, and debugging | Metadata/routes output was observed from local sandbox 3011; verified. It cannot replace real browser acceptance. |
| Playwright + MockServer | E2E/Integration-Test Agent | External-dependency isolation and replay | Provides deterministic tests when real external services are unavailable; mock success must be separated from real E2E success. |
| Checkly | E2E/Monitoring Agent | Optional cloud monitoring or replay | `checkly-auth`/Private Location remains a separate boundary and the current app did not have Checkly installed; cloud coverage must not be reported as complete. |
| Storybook | Frontend Agent, Component-Review Agent | Component visual regression | Checks component states and boundaries; cannot replace the cross-page purchase journey. |
| MSW | Frontend-Test Agent | Frontend API mocks | Isolates frontend development and deterministic tests; mock pass must be distinguished from real-backend pass. |
| `react-doctor` | Frontend-Quality Agent | React structure and runtime diagnosis | Provides frontend diagnostic signals; it does not independently grant business PASS. |
| Postman / `postman` MCP | API Agent, Integration-Test Agent | API debugging and regression | The report observed connection and tool loading after a `POSTMAN_API_KEY` was supplied; the key must never enter evidence. |
| Stripe / `stripe` MCP | Payment Agent, E2E Agent | Test payment and webhooks | Verifies test-mode payment, callbacks, order state, and amounts. Use an explicit Stripe test project; never default to live mode. |
| Mailpit / `mailpit-mcp` | E2E Agent, Order Agent | Email, receipts, and credentials | The report observed `mailpit_mcp` startup; verified candidate for checking receipts, notifications, and email content. |
| Pact / PactFlow | Contract-Test Agent | Consumer/provider contracts and replay | Verifies service contracts. Broker publish/deploy checks are distinct from real deployment and browser E2E. |

### 10.5 Observability and performance diagnostics

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| OpenTelemetry + GlitchTip + Jaeger | Observability Agent, Diagnostics Agent | Traces, spans, errors, and call chains | Reported as the verified primary observability stack; connects frontend action, API, queue, database, and external-service evidence. |
| `sentry-mcp` / Sentry | Observability Agent | Issues, events, and replay | The report showed a connection and Sentry MCP 0.35.0; verified. A Sentry issue alone does not prove a repair passed. |
| `sentry-otel-exporter-setup` | Observability Agent | OTel-to-Sentry configuration | Maintains the observability export path; record endpoint, sampling, version, and credential boundaries. |
| Codspeed | Performance Agent | Performance baseline and regression | Six local probes did not produce a local report; status `service_or_credential_required`. Installation must not be treated as health. |
| `clinic.js` | Performance/Diagnostics Agent | Node CPU, event loop, and memory profiling | The report observed v13.0.0 through `/home/zyy/.nvm/versions/node/v22.22.3/bin/clinic`; verified, but it depends on an absolute path or login shell. |
| `/performance-profile` | Performance Agent | Migrated old performance entry | The old entry was not found; current responsibility is carried by `clinic.js` and the load-testing lane. |

### 10.6 Code quality, dependency security, and review

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| Qodo Merge | Code-Review Agent | Local Git diff review after Worker completion | The local Qodo route was verified; it does not connect to GitHub/Qodo Cloud and must review local changes. |
| `open-code-review` | Review/Validation Agent | Code-review gate | `ocr` v1.9.8 was resolved and callable; verified. |
| `open-code-review-delegate` | Review Agent | Host-agent review entry | Mounted as a review entry without extra LLM configuration; not a replacement for business tests. |
| SonarQube | Quality Agent | Static quality and code smells | Checks complexity, duplication, vulnerability signals, and quality gates; distinguish diagnostic warnings from acceptance blocks. |
| ESLint | Frontend/Backend Quality Agent | TypeScript/JavaScript static check | Checks style and error patterns; cannot replace runtime verification. |
| Husky | Quality/Commit Agent | Git commit and local gates | Runs agreed checks before delivery; must not depend on a developer remembering to trigger it manually. |
| Knip | Quality Agent | Unused dependencies, exports, and files | Separates real redundancy from accepted migration exceptions; must not delete unknown code automatically. |
| `osv-scanner-mcp` | Security/Dependency Agent | Dependency vulnerability scan | The report observed `osv-scanner experimental-mcp --help`; verified capability candidate. Task-level scans must produce a report. |
| CodeQL | Security/Quality Agent | Security static analysis | Version 2.26.1 was verified; suitable for security static analysis. |
| `semgrep` | Security/Red-Team Agent | Fast rule scan | Version 1.172.0 was verified; a P0 security-tool candidate. |
| `trivy` | Security/Container Agent | Image, dependency, and configuration scan | Version 0.73.0 was verified; should cover target images and dependencies. |

### 10.7 Security, red team, and load testing

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| `/owasp-audit` | Security/Red-Team Agent | OWASP risk and attack-surface checks | The old responsibility is carried by `redteam-flow`, semgrep, sqlmap, trivy, and CodeQL; treat it as migrated. |
| `redteam-flow` | Security/Red-Team Agent | Security testing after business validation | Defines target scope, accounts, attack actions, evidence, cleanup, and report. |
| `sqlmap` | Security/Red-Team Agent | Injection and database-exposure testing | Version 1.10.7 was verified; use only against isolated authorized targets. |
| `artillery` | Load-Test Agent | API/business-flow load | Version 2.0.21 was verified; report throughput, latency, errors, and resources. |
| `autocannon` | Load-Test Agent | Fast Node HTTP baseline | Version 8.0.0 was verified; useful for quickly finding bottlenecks, not a replacement for complete business load tests. |
| `k6` | Load/Security Agent | Scenario load and capacity regression | Version 2.0.0 was verified. The report also classified an old k6 integration as historical/retired; this means the old entry/integration is retired, not that the current k6 binary is unusable. |
| `pressure-test-flow` | Load-Test Agent | Vendure load-testing process | Defines test identity, load, cleanup, reporting, and safety boundaries. |
| `clinic.js` | Performance Agent | Node profiling before/after load | Explains CPU, event-loop, and memory bottlenecks together with artillery/autocannon/k6. |
| `dspy` | Reflection/Evaluation Agent, security-testing support | Experimental prompt/process evaluation | Python package v3.2.1 was verified; experimental only and cannot independently grant business PASS. |
| `promptfoo` | Prompt-Evaluation/Red-Team Support Agent | Prompt-injection, model-output, and regression evaluation | The project-local `node_modules/.bin/promptfoo` was executable, v0.121.18; do not confuse project-local PATH with global installation. |

### 10.8 Experimental enhancements and historical capabilities

| Software/capability | Roles | Pipeline position | Function and status |
|---|---|---|---|
| AutoGen | Research/Experiment Agent | Optional multi-Agent experiments | Verified in the report, but must not become a second unbounded scheduler. |
| `TheGreenCedar/codex-autoresearch` | Reflection/Experiment Agent | Codex automated-research experiments | Verified in the report; an optimization experiment, not a business-PASS component. |
| OpenAPI vacuum static audit | API/Quality Agent | OpenAPI static audit | Checks API-description quality; cannot replace real API calls. |
| Highlight.io | Observability Agent | Historical reference | Deleted/retired from the active line; reference only. |
| OpenReplay | Observability/Replay Agent | Historical reference | Deleted/retired from the active line; reference only. |
| OpenASE | Legacy-pipeline Agent | Historical architecture reference | The old pipeline is retired and must not be mixed with the current Buzz/OpenHands/adaptive pipeline. |

### 10.9 Legacy entries and current capability mappings

The final report also recorded the following old paths. They are not the locations from which the contractor should assume current software is installed. The contractor should use the current capability entry and retain this mapping in the migration notes:

| Historical path | Current capability | Treatment |
|---|---|---|
| `/home/zyy/ai_Pipeline/mcp-architect-guardian.js` | Current boundary guard, code map, and control-plane checks | Treat as migrated; absence of the old file does not prove that the responsibility disappeared. |
| `/home/zyy/ai_Pipeline/mcp-performance-profile.js` | `clinic.js`, Performance Agent, and `pressure-test-flow` | Treat as migrated; current performance reports are the capability proof. |
| `/home/zyy/ai_Pipeline/mcp-owasp-audit.js` | `redteam-flow`, `semgrep`, `sqlmap`, `trivy`, and CodeQL | Treat as migrated; do not make the old OWASP script path the current security capability. |
| `/home/zyy/ai_Pipeline/mcp-mailpit.js` | `mailpit-mcp` | Treat as migrated; prove it with a real test email and readback result. |
| `/home/zyy/ai_Pipeline/infrastructure/NestJsMcp/dist/index.js` | Current `nestjs-mcp`/NestJS capability entry | Treat as migrated; the report observed the old stdio entry start, but mainline integration should use the current registered entry. |

These are responsibility mappings, not proof that every old implementation was fully rewritten. The contractor must record the current entry, version, invocation method, and capability receipt in the actual pipeline.

## 11. Relationship Between Skills and Software

Several names in the final report are not independent runtime programs; they are AI operating methods or role handbooks. They should be mounted by role, but “the skill file exists” must not be reported as a live smoke of the underlying tool.

### 11.1 General control and methods

- `software-onboarding-sync`: tool inventory, installation/mount records, capability, and evidence synchronization.
- `workspace-boundary-memory`: workspace boundaries, path roles, and durable context.
- `mcp-code-map-notes`: code-map, graph, and repository-understanding methods.
- `mcp-observability-notes`: observation, traces, issues, and readback methods.
- `mcp-test-harness-notes`: fixtures, verification, and evidence methods.
- `pipeline-engineering-sop`: converts task type, stack, and tool catalog into an execution brief; it is not a scheduler or validator.
- `pipeline-task-contract` and `pipeline-agent-gate-playbook`: task contract, role boundaries, receipts, and validation gates. If the contractor reuses the current mainline rules, the evidence boundary must remain compatible.
- `skill-doctor` ([warpdotdev/common-skills](https://github.com/warpdotdev/common-skills/tree/main/.agents/skills/skill-doctor)): optional local retrospective tooling that analyzes Agent conversations and skill quality and generates candidate edits. It is not a business Worker, scheduler, tester, or validator, and its score cannot be treated as PASS.

When enabled, run `skill-doctor` only after a run has produced real results, failure evidence, and a validator conclusion, and prefer selected, redacted project conversations. Its report and candidate diffs go to an isolated scratch directory first. A Control-Plane Maintenance Agent may promote useful findings into versioned skills, rules, templates, or playbooks only after checking the runtime evidence, confirming that no secrets or business source are included, running regression checks, and creating a Git backup. `skill-doctor` does not commit to Git, push to GitHub, or change the current run's PASS/BLOCK result.

### 11.2 Quality, contract, and browser methods

- `sonarqube-practice-notes`, `eslint-practice-notes`, `husky-practice-notes`: static quality and commit checks.
- `qodo-merge-practice-notes`, `open-code-review`, `open-code-review-delegate`: code review and review delegation.
- `pactflow`, `pactflow-practice-notes`: contract testing and broker/replay practice.
- `checkly:checkly`, `checkly:playwright-best-practices-for-agents`: Checkly and Playwright practice; uninstalled cloud capability must not be presented as verified.
- `vendure-e2e-verification-pack`: Vendure E2E account, fixture, storefront, backend, and evidence boundaries.
- `vendure-final-closeout-browser-review`: final browser readback and manual-equivalence confirmation.

### 11.3 Vendure and runtime methods

- `vendure-stack-practice-notes`: Vendure stack, plugin, and integration boundaries.
- `nextjs-react-typescript`: Next.js/React/TypeScript frontend.
- `nestjs-clean-typescript`: NestJS/TypeScript backend.
- `typeorm`: TypeORM, migration, and query practice.
- `graphql-schema`, `graphql-operations`: GraphQL schema and operations.
- `postgresql-database-engineering`: PostgreSQL design, queries, and operations.
- `bullmq-specialist`: BullMQ queues and Redis-backed jobs.
- `opentelemetry`: OpenTelemetry and Grafana/Jaeger/GlitchTip observability.
- `minipc-remote-control`, `minipc-environment-boot`, `vendure-runtime-boot`: Linux remote control, environment recovery, and Vendure runtime.

### 11.4 Security, load, and self-improvement methods

- `redteam-flow`: red-team testing process.
- `pressure-test-flow`: Vendure load-testing process.
- `self-iteration-master`: self-iteration and reflection coordination.
- `buzz-model-switch`: Buzz/Codex model routing and fallback; model changes require version and configuration evidence.
- `hyperqueue-practice-notes`: HyperQueue practice; the `hq` CLI remains unverified.

These method packages guide roles. They do not bypass task contracts, scope, tool receipts, evidence relay, or the final validator.

## 12. Tool Selection and Evidence Rules

### 12.1 Do not use every tool on every task

The surrounding-software catalog is a capability registry, not a fixed workflow. Each task first identifies required capabilities and then selects the smallest healthy tool set. For example:

- a backend-only change normally needs code maps, Vendure/NestJS/TypeORM, database, and quality capabilities;
- a real user journey needs scenario compilation, Playwright, browser observation, and possibly email/Stripe;
- a performance target needs load tools, observability, and database profiling;
- a security target needs red-team tools with strict target and data boundaries.

If the preferred tool is unavailable, an equivalent may be selected, but the pipeline must record the reason, capability equivalence, expected output, observed output, permissions, and cleanup. Extra read-only tools are not automatically a failure; omitting a task-declared required capability is a block.

### 12.2 Every active role needs a tool-use record

Every active lane must leave at least:

- `tool_usage_manifest.md`;
- the required empty marker file `tool_usage_manifest`;
- a signed `PIPELINE-TOOL-RECEIPT-V1`;
- expected output files;
- Worker staging evidence;
- shared evidence written by the code-owned relay;
- validator-owned closeout.

The tool receipt must state what was loaded, what was actually used, why it was selected, what capability evidence it produced, what side effects occurred, and how it was cleaned up or retained. A Worker may report its execution, but a file containing `status: PASS` cannot replace the validator.

### 12.3 Main Agent, Worker, and validator boundary

- **Main Agent:** Read-only planning, profile selection, dispatch submission, supervision, and reporting; it cannot bypass CAO/control-plane rules to write business code.
- **Worker:** Observes, changes, tests, and writes staging evidence only within the isolated workspace and declared write scope.
- **Relay:** The code-owned runtime reconciler writes staged evidence into the shared sink.
- **Validator:** Checks signed receipts, expected outputs, changes, evidence integrity, cleanup, and closeout, then derives final PASS/BLOCK.
- **Control-plane maintenance Worker:** Repairs templates, routing, adapters, skills, versions, or entry indexes only; it cannot touch current business source.

## 13. Direction for Formal Pipeline Capability Acceptance

This section separates “the contractor may deliver the Pipeline” from “the Client finally accepts the project and releases payment.” The first is a Pipeline capability gate; the second is the final result gate for the complete migration. Passing the first gate does not mean that the project is complete or ready for payment.

The current migration scope is the two-batch scope in `PROJECT_OVERVIEW_EN.md`: Batch 1 covers country/channel behavior, currency, customer country, product visibility, cart restrictions, checkout/payment channel locking, and dependent frontend, database, and configuration work. Batch 2 covers the remaining listed secondary-development capabilities, including custom press-on-nail publication, the complete effect-image/design-image tree and local archive behavior, standard and custom purchase, wallet/payment, order merging, size, inventory/restocking, shipping, tax/order-index behavior, and the other listed E2E flows. Accounting-related functionality and WorldFirst-related functionality are excluded from this phase; coupons and marketing remain deferred where the project overview marks them as to-be-developed. A new feature, Vendure version, execution environment, or acceptance scenario is a written scope change, not an implicit tuning request.

### 13.1 Before contractor delivery: at least 3 long-chain E2E tasks must pass

Before formally delivering the Pipeline, the Contractor must select at least 3 representative long-chain tasks from the end-to-end validation tasks in the Chinese or English project overview, run them completely with the Contractor’s own Pipeline, and submit evidence. In principle, the set should cover at least one task from Batch 1 and one from Batch 2; the Contractor proposes the third task and the Client confirms it. A long-chain task cannot be merely a successful build, an HTTP 200 response, or a single unit test. It must start from a human-language task card and automatically proceed through code understanding/modification, runtime preparation, real storefront or admin actions, database or other required-tool verification, evidence collection, and cleanup/rollback.

Possible directions include, without limitation:

- Batch 1: country/channel behavior, customer country and currency, product visibility, country restrictions in the cart, and checkout or order-validation chains;
- Batch 2: press-on-nail publication, reading the complete effect-image/design-image tree, purchase, order export, and local production archiving;
- Batch 2: wallet/payment, order merging, inventory, or shipping-script cross-module chains.

For each passing task, the Contractor must submit reviewable execution evidence, including task input, actual code changes, test and E2E results, browser/API/database or other action evidence, failure handling, cleanup, and rollback. Model prose, a screenshot, a zero exit code, or a statement that the task is complete cannot independently prove acceptance. The Contractor may deliver the formal Pipeline only after all 3 long-chain tasks pass. This proves the Pipeline has reached the delivery gate; it does not prove that the complete Vendure migration is finished.

### 13.2 After the Client receives the Pipeline: run the complete migration and continue tuning

After receiving the Contractor’s Pipeline, the Client will use it to attempt the complete Vendure migration within the scope defined by the project overview. Batch 1 and Batch 2 will still be executed and recorded separately, and then combined for the judgment of the complete agreed scope. Separate records help locate problems; they do not reduce the final amount of work.

If the run reveals a failure, omission, false pass, insufficient evidence, inability to roll back, or a need for the Client to perform technical steps manually on behalf of the Pipeline, the Client will give the Contractor the actual failure result and evidence. The Contractor must use that evidence to continue tuning the Pipeline, adapters, tool calls, task decomposition, or recovery logic, submit a new candidate revision, and rerun the affected tasks. The Client is not responsible for continuously telling the Contractor which code to write or which command to run. Credentials, authorization, and business confirmation supplied by a human do not count as the Pipeline performing the technical work.

There is no arbitrary small limit on tuning rounds for defects that belong to the frozen scope and are caused by the Pipeline, its adapters, evidence handling, rollback, or automation. Each cycle must identify the failure, candidate revision or image/package digest, changed behavior, rerun scope, and result. The tuning loop continues until the agreed migration scope and acceptance conditions pass. New features, new Vendure versions, new environments, or new E2E scenarios are not hidden tuning work; they are scope changes requiring written agreement before implementation.

### 13.3 Final pass and payment conditions

The project is finally accepted and enters handover, key delivery, and payment only when all of the following are true:

1. All migration tasks within the current scope of the project overview are complete. Features explicitly marked as later-stage or excluded remain outside the scope and must not be silently added or omitted.
2. Starting from a human-language task card, the Pipeline automatically completes task decomposition, code work, tests, real E2E validation, evidence organization, failure handling, and cleanup/rollback in the agreed Linux, GitHub, Vendure, and fixture environment.
3. For the declared acceptance scenarios, the Pipeline has no unresolved Pipeline defects, can run reliably and repeatedly, and does not require the Client to replace its capability with manual technical work.
4. Independent validation results, code changes, test results, run evidence, versions, cleanup, and handover materials are complete and reviewable.

“The Pipeline no longer has problems” means stable completion within this project’s agreed migration scope, environment, and acceptance scenarios. It is not a promise that the Pipeline will never fail on every future unknown project.

Final acceptance does not check whether the Contractor used OpenHands, ClawAI, Buzz, or another named tool. It checks whether the chosen implementation actually achieves the required result.

### 13.4 Common automated-loop requirements for all three stages

All three stages must meet the following common requirements. They define that the Pipeline actually performed the work, rather than merely showing a UI or script:

1. Give the Pipeline only a human-language task card; the Product Manager Agent fills in the technical details.
2. The Pipeline identifies the GitHub legacy code, test fixtures, target Vendure base, and runtime identity.
3. It forms subtasks, dependencies, and role assignments automatically.
4. It enters an isolated Linux workspace or sandbox, establishes a Git baseline, and defines rollback boundaries.
5. It reads the legacy and current code and understands Vendure versions, plugins, and business boundaries.
6. It calls suitable tools to change and debug code rather than only outputting advice.
7. It runs static quality, unit/integration tests, and real storefront/backend end-to-end flows.
8. It uses database, browser, email, payment, or observability tools to produce action-linked evidence.
9. When it fails, it preserves the failure, performs official-first research, and repairs and regresses safely.
10. When required, it runs load tests and reports load, throughput, latency, error rate, resources, and bottlenecks.
11. It runs red-team tests against an isolated authorized target and reports risk, reproduction, repair status, and cleanup.
12. It packages changes, tests, logs, screenshots, traces, reports, versions, and cleanup results as a delivery package.
13. An independent validator derives COMPLETE or BLOCK; model prose and a zero exit code cannot alone pass acceptance.

The E2E target uses “manual equivalence within the declared scope”: for the account, fixture, public entry point, runtime/build identity, and action sequence stated in the task card, the evidence chain must support the same result a real human user would see. This is not a promise to cover every possible account or environment; it requires the declared acceptance scenario to be complete, reproducible, and auditable.

## 14. Contractor Deliverables

The final delivery must include:

- pipeline source code and configuration;
- reproducible runner packaging: `Dockerfile` plus `compose.yaml` or an equivalent definition, pinned dependencies/lockfiles, start/stop/check/cleanup scripts, and a no-secret `.env.example`;
- tool and MCP inventory with permissions, data-handling limits, capability evidence, and a declared fallback or owner-controlled adapter for any host-only tool;
- candidate image digest, package hash, or equivalent immutable version identifier for every delivered revision;
- architecture description assigning responsibilities to Buzz, OpenHands, Codex, and any replacement components;
- Linux installation, startup, upgrade, rollback, and cleanup instructions;
- role registry, tool-capability registry, and selection rules;
- Vendure adaptation notes for Node/NestJS/TypeORM/GraphQL/PostgreSQL/Redis/Next.js/Stripe and related boundaries;
- task-card input format and Product Manager Agent technical-metric conversion format;
- subtask, sandbox, branch-task, retry, circuit-break, and permission model;
- GitHub input repository, fixed revision, and checkout method;
- official-documentation summary, version, capability, permissions, output, and limitations for surrounding software;
- tool receipts, tool-use manifests, evidence relay, validator, and closeout formats;
- complete execution evidence from at least 3 long-chain E2E tasks;
- end-to-end validation report;
- load-testing report;
- red-team testing report;
- failure, circuit-break, unresolved-item, and recovery documentation;
- an unattended technical-guidance explanation stating that the client supplies the business task card and final business acceptance but does not guide technical details during execution.

## 15. Parameters to Confirm Before Formal Execution

The following information must be filled in or authorized by the client before a formal run. The contractor must not guess it:

| Parameter | Current status |
|---|---|
| GitHub repository URL | Public demo: `https://github.com/vendure-ai-factory/vendure-project-briefing`; formal private repositories are provided under the Agreement |
| Repository-relative path of the test images | `evaluation-demo/assets/nail-patterns/` and `evaluation-demo/migration-input/fixtures/美甲图案/`; current public hands-on revision: `codex/github-refactor-20260904` @ `d544405f9534c65f57502da8668326845a5622ca` |
| Repository-relative path of `projects_backup_full.tar` | Private `vendure-evaluation-input`; controlled confirmation after signature; must not be published |
| Acceptance commit/tag | To be locked |
| GitHub URL and fixed revision of the new Vendure base | To be supplied/confirmed |
| Test accounts, roles, and country channels | Provided by the Vendure test task |
| Test database, containers, and ports | Must be verified before execution; never guessed |
| Execution environment owner and runner type | Contractor isolated runner for capability gate; Client-controlled temporary Linux environment or agreed independent verifier for final acceptance |
| Workflow trigger and authenticated interface | `workflow_dispatch` or equivalent API; exact identifier to be locked |
| Minipc-only tools | Must be exposed through a Client-controlled allowlisted adapter; unrestricted SSH is not part of the default path |
| Stripe test project and webhook | Authorization required; live mode prohibited by default |
| Mailpit or other test mailbox | To be confirmed |
| Customer-side SSD write method | Path exists but separate mount and write access are unconfirmed; controlled method required |
| Load-test target, concurrency, and duration | To be specified by the task card |
| Red-team target scope and permitted actions | Authorization required |
| Codex execution location | Codex preferred; CLI not found in the current minipc default PATH, so the contractor must propose configuration |

This document defines pipeline capabilities and implementation boundaries. Buzz plus OpenHands or ClawAI is our preferred reference direction, but it is not mandatory; the contractor may use another familiar technical solution that achieves the same result. The many software descriptions in this document are records of past trials or research and are provided for reference only, not as a mandatory tool list. The final standard is whether the pipeline can start from a business task card on Linux, without client technical guidance, and genuinely complete Vendure code debugging, surrounding-tool use, E2E validation, load testing, red-team testing, and evidence-based delivery.
