# One-Time Fixed-Price Agreement for an AI Automation Pipeline (OpenHands / ClawAI Optional)

**Status:** Discussion draft for Contra / legal review — not legal advice  
**Version:** 2026-09-04, Draft 3 (three long-chain delivery gate and post-delivery tuning added)  
**Acceptance model:** At least 3 long-chain capability validations before pipeline delivery; iterative tuning after delivery; one final formal automated acceptance; no milestone payment

> This document is a commercial and technical contract proposal. It should be reviewed and adapted by a qualified lawyer for the parties' jurisdictions and by Contra's then-current platform terms before signature.

> The post-delivery reproducibility warranty is a mandatory commercial term. If it is blank, this Agreement should not be signed.

## 0. Commercial variables to complete before signature

| Item | Value |
|---|---|
| Client | `[CLIENT LEGAL NAME]` |
| Contractor / Independent | `[CONTRACTOR LEGAL NAME]` |
| Contra project ID / URL | `[TO BE COMPLETED]` |
| Fixed project fee | `[AMOUNT AND CURRENCY]` |
| Project start date | `[DATE]` |
| Final submission deadline | `[DATE AND TIME ZONE]` |
| Client-controlled GitHub organization | `[GITHUB ORGANIZATION]` |
| Legacy Vendure repository and commit | `[PRIVATE REPOSITORY / COMMIT]` |
| New Vendure base and commit | `[REPOSITORY / COMMIT]` |
| Contractor GitHub Workflow Interface identity | `[NON-SECRET IDENTIFIER]` |
| Automated acceptance workflow identifier / URL | `[TO BE COMPLETED]` |
| Maximum lifetime of ephemeral preview environment | `[E.G. 4 HOURS]` |
| Acceptance evidence retention period | `[E.G. 90 DAYS OR PLATFORM MAXIMUM]` |
| Client Terminal Computer Adapter identity | `[NON-SECRET IDENTIFIER]` |
| Acceptance Manifest version/hash | `[TO BE COMPLETED]` |
| Codex acceptance profile/version/hash | `[TO BE COMPLETED]` |
| Probe version/hash | `[TO BE COMPLETED]` |
| Governing law and venue | `[TO BE COMPLETED]` |
| Post-delivery reproducibility warranty (MANDATORY BEFORE SIGNATURE) | `[E.G. 30 CALENDAR DAYS]` |

## 1. Parties and purpose

This Agreement is between the Client and the Contractor identified above.

The Contractor shall design, build, configure, document, and deliver a reproducible autonomous coding pipeline (the **Pipeline**) that may be implemented with OpenHands, ClawAI, or another suitable technology. The Pipeline shall receive an authorized task through the Contractor GitHub Workflow Interface, coordinate coding work, call approved surrounding tools, use the Client Terminal Computer Adapter where required for approved operations, and produce machine-checkable evidence.

After the formal acceptance task starts, the Client shall participate only in acceptance of the final end-to-end business result and shall not provide technical guidance during the run. Code reading, diagnosis, solution selection, code modification, debugging, tool selection, test execution, failure recovery, and evidence generation must be completed automatically by the Pipeline without intermediate technical instructions from the Client.

The principal acceptance objective is:

> Starting from the specified legacy Vendure secondary-development code and the specified new Vendure base, the Pipeline shall autonomously perform the agreed migration task, achieve the agreed end-to-end result, and produce the agreed load-testing and authorized red-team reports.

This is a one-time fixed-price project. Before delivering the formal Pipeline, the Contractor must pass automated capability validation on at least 3 long-chain end-to-end tasks; this validation does not create a staged payment and does not mean that the project has been finally accepted. After delivery, the Client may use the Pipeline to attempt the complete agreed migration and require continued tuning and reruns based on recorded failure evidence. Only after the agreed migration scope is complete, the Pipeline runs the agreed scenarios reliably and automatically, and the final formal acceptance passes will handover and payment proceed. No milestone payments apply.

## 2. Definitions

**Acceptance Authority** means the Client-controlled local Codex acceptance profile together with the code-owned validator, the Acceptance Manifest, and the Probe. Codex may supervise and summarize; the validator and signed evidence determine `PASS` or `FAIL`.

**Acceptance Manifest** means the immutable machine-readable description of the task, repository revisions, environment identity, fixtures, permitted tools, acceptance tests, thresholds, evidence schema, and stop conditions in Annex A.

**Final Acceptance Run** means the final formal, automatically triggered run, after the pre-delivery capability validation and post-delivery tuning are complete and the final candidate version is frozen, used to determine whether the Pipeline passes this Agreement. The 3 long-chain capability validations and tuning runs before that point are not the Final Acceptance Run.

**Candidate Pipeline** means the version submitted by the Contractor for the Acceptance Run, identified by an immutable Git commit, release tag, container digest, or equivalent cryptographic hash.

**Client Repositories** means the Client-controlled GitHub repositories containing the legacy code, the new-base reference, the acceptance harness, and acceptance metadata. The Contractor receives only the access expressly granted in this Agreement.

**Contractor Repository** means the Contractor-controlled private GitHub repository containing the Pipeline before payment and final handover.

**Contractor GitHub Workflow Interface** means the controlled workflow, API, or equivalent interface in the Contractor's private GitHub repository through which the Client's local Codex submits a task, starts the Pipeline, and receives status and evidence. It must not expose the Pipeline source code.

**Client Terminal Computer Adapter** means the Client-controlled, allowlisted adapter through which approved tasks may use approved tools and services on the Client's terminal computer. It is not an unrestricted shell or remote administration channel.

**Evaluation Interface** means the fixed entry point through which the Client's Codex invokes the Contractor GitHub Workflow Interface and obtains status and evidence. It must not expose the Pipeline source code.

**Probe** means the read-only, Client-controlled monitoring component that records workflow identifiers, commit hashes, job states, manual actions, tool receipts, network-policy events, artifacts, and timestamps.

**Ephemeral Acceptance Environment** means a clean, isolated Linux execution environment created for one automatic acceptance run. It may be a GitHub-hosted runner, temporary container, Codespace, or another written-approved temporary environment. It is used to obtain the source, start the database and Vendure services, run the agents and automated tests, and must be stopped and cleaned up after the run. It is not a persistent service on the Client terminal computer.

**Ephemeral Preview Environment** means a temporary Vendure storefront/admin environment started so that the Client can inspect the result in a browser. It may be the same as, or separate from, the Ephemeral Acceptance Environment. Its URL is valid only while the environment exists and it must have a stated maximum lifetime and an automatic cleanup record. Opening the preview is auxiliary human observation and does not replace automated E2E acceptance.

**One-click Run** means that the Client can click `Run workflow` in the agreed GitHub Actions page, or the Client's local Codex can start a run through an authenticated `workflow_dispatch`/API request. The start action must not require the Client to choose a technical approach, edit code, approve routine tool calls, or manually retry intermediate failures.

**Delivery Package** means the complete source code, configuration, prompts, role definitions, skills, plugins, adapters, deployment instructions, dependency locks, tests, and evidence schemas necessary to operate and reproduce the accepted Pipeline, excluding secrets that must be rotated or injected separately.

**PASS Attestation** means the machine-readable, tamper-evident acceptance record produced by the Acceptance Authority and containing the Acceptance Run ID, hashes, results, and evidence references.

## 3. Scope of work

The Contractor shall provide:

1. An autonomous programming Pipeline suitable for the agreed Vendure migration and future tasks of the same declared class, which may be implemented with OpenHands, ClawAI, or another suitable technology.
2. A stable one-click Evaluation Interface that can be invoked by the Client's local Codex through GitHub Actions API, an equivalent authenticated API, or another agreed interface, and that returns run status, evidence, and, if enabled, an ephemeral preview URL.
3. Integration with the approved surrounding tools, including the Contractor GitHub Workflow Interface and Client Terminal Computer Adapter, only within the permissions in Annex B.
4. Autonomous task execution after `RUN_START`, without a human selecting the next step, editing code, approving a routine tool call, or manually rerunning a failed task.
5. E2E verification with browser, API, backend, and runtime evidence appropriate to the declared scenario.
6. Authorized load-testing and red-team execution against the agreed non-production target and the agreed thresholds.
7. A Probe-compatible event and evidence stream.
8. The Delivery Package after the Acceptance Run passes.
9. Documentation sufficient for the Client or a replacement engineer to deploy, operate, inspect, troubleshoot, and recover the Pipeline without the Contractor's private infrastructure or account.

Unless expressly added to Annex A, the scope excludes production deployment, production data access, unrestricted administration of the Client's terminal computer, indefinite operations support, and guarantees about performance outside the declared environment and workload.

### 3.1 Technology choice and fee boundary

The Contractor may use OpenHands, another open-source framework, a proprietary framework, custom code, or a combination of technologies. The Client's suggested framework is not mandatory. The mandatory requirement is that the delivered solution autonomously completes the technical code-debugging, migration, testing, evidence, load-testing, and authorized red-team functions stated in this Agreement.

The Contractor may propose changes to the architecture, tools, roles, interfaces, permissions, test method, or acceptance thresholds before the Acceptance Manifest is frozen. Each proposal must state its reason, risks, effect on scope, effect on cost, and effect on acceptance. No proposal becomes part of the project unless the Client approves it in writing. After the Acceptance Manifest is frozen, changes require written approval from both parties.

Any paid software, model, API, runner, hosting, plugin, or other service required by the proposed solution must be disclosed before signature and included in the fixed fee. The Contractor shall not cause the Client to incur additional or recurring expenditure, usage charges, subscription charges, or automatic account enrollment unless the Client has expressly approved that cost in writing. A solution that depends on an undisclosed paid service is not a compliant Delivery Package.

### 3.2 Public hands-on entry before signature and formal delivery after signature

Before quoting, the Contractor may independently inspect and run the Client’s sanitized public hands-on project: the public repository is [vendure-project-briefing](https://github.com/vendure-ai-factory/vendure-project-briefing). The public package includes the small runnable demo, the test images under [`evaluation-demo/assets/nail-patterns/`](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/assets/nail-patterns), and the larger [sanitized migration-input package](https://github.com/vendure-ai-factory/vendure-project-briefing/tree/codex/github-refactor-20260904/evaluation-demo/migration-input), including the public-safe source snapshot and migration task documents. The current public hands-on revision is branch `codex/github-refactor-20260904`; the original image subdirectory structure must be preserved and the images must not be mixed, flattened, or renamed. The Contractor may clone or fork the public repository into the Contractor’s own environment, read the project documentation, run the demo, inspect the migration input, modify the Contractor’s own copy, and submit a pull request or fork link. A pull request or fork is only a way to demonstrate the hands-on result; it does not require the Client to merge the code and does not grant access to the Client’s `main`, private repositories, minipc, or production environment. The public package is a clean-tree publication and does not expose private Git history or formal owner-controlled acceptance data.

After the hands-on run, the Contractor submits a quote, delivery period, scope, assumptions, and risks based on the actual result. The Client chooses one Contractor from the received quotes and signs this Agreement. Only after signature does the Contractor receive controlled access to the formal private inputs and proceed under Section 3.3 through the long-chain capability gate, formal delivery, and post-delivery tuning. The Client pins the candidate revision, starts the Final Acceptance Run remotely, and reviews the evidence. The Contractor may repair issues based on recorded failure evidence; the Client-controlled validator and evidence, not the Contractor’s own declaration, determine whether the result passes.

### 3.3 Pre-delivery capability gate, post-delivery tuning, and final payment

Before formally delivering the Pipeline, the Contractor shall select at least 3 representative long-chain tasks from the end-to-end validation tasks in the Chinese or English project overview, run them automatically with the Contractor’s Pipeline, and submit evidence. In principle, the set should cover at least one task from Batch 1 and one from Batch 2; the Contractor proposes the third and the Client confirms the set. Each long-chain task must start from a plain-language task card and automatically complete the necessary task decomposition, code understanding/modification, environment preparation, real storefront or admin operations, database or other required tool verification, evidence collection, and cleanup/rollback. A successful build, HTTP 200 response, screenshot, or model statement is insufficient. The Contractor may deliver the formal Pipeline only after all 3 long-chain tasks pass; this is a delivery gate, not payment and not final project acceptance.

After formal delivery, the Client shall use the Contractor’s Pipeline to attempt the complete Vendure migration within the current scope of the project overview. Batch 1 and Batch 2 will be run and recorded separately, then combined for the final scope judgment. If there is a failure, omission, false pass, insufficient evidence, rollback failure, or a need for the Client to perform technical steps manually on behalf of the Pipeline, the Client will provide the actual failure evidence. The Contractor shall continue tuning the Pipeline, adapters, tool calls, task decomposition, or recovery logic, submit a new candidate version, and rerun the affected tasks. This tuning and rerun work is part of the fixed-price project and does not trigger staged payment.

Only when the agreed migration scope is complete, the Pipeline runs the agreed environment and acceptance scenarios reliably and automatically without unresolved Pipeline defects, and the Client-controlled validator and evidence pass the Final Acceptance Run, will final handover and payment proceed.

### 3.4 Acceptance environment, migration scope, and tuning boundary

The migration scope of this Agreement is the project overview and Annex A confirmed by both parties at signature, and is explicitly divided into two batches:

- **Batch 1: foundational capabilities.** Country and channel behavior, currency, customer country, product visibility, cart and checkout channel locking, and the dependent frontend pages, database extensions, and surrounding configuration needed to make these capabilities runnable.
- **Batch 2: remaining business capabilities.** The remaining secondary-development functions listed in the project overview, including custom press-on-nail product publication, the directory and archive behavior for effect/design images, standard and custom-product purchase, wallet and payment, order merging, size, inventory, restocking, shipping, and the related end-to-end flows.
- **Explicitly outside this phase.** Accounting-related functionality and WorldFirst-related functionality; coupons and the marketing module marked “to be developed” in the project overview are not treated as completed capabilities under this Agreement.

Batch 1 and Batch 2 must each retain traceable code changes, environment preparation, verification actions, observed results, and evidence. A generic statement that “the migration is complete” is not a substitute for the individual validations. New business features, a new Vendure base version, a new execution environment, a new acceptance scenario, production deployment, or performance requirements outside the declared environment/workload are scope changes and require separate written confirmation by both parties.

The Contractor may complete the 3 pre-delivery long-chain capability validations in the Contractor’s own isolated environment or another temporary environment approved by both parties. Formal acceptance shall not rely on GitHub files, a GitHub Pages page, or the Contractor’s personal computer as the sole runtime. The Client shall start a one-time clean and isolated Linux Acceptance Environment through GitHub Actions `workflow_dispatch`, an equivalent authenticated API, or another interface confirmed in writing. GitHub stores versions, task inputs, workflow interfaces, and evidence; the complete Vendure runtime, database, browser E2E run, and cleanup occur in the temporary Acceptance Environment. If a tool must run on the Client terminal computer, it may be invoked only through a Client-controlled allowlisted adapter; the Contractor receives no root, unrestricted SSH, unrestricted Docker, or unrestricted self-hosted-runner access to the Client minipc.

For Pipeline defects within the agreed scope, there is no fixed upper limit on the number of tuning iterations, and the project is not deemed complete merely because a preset number has been used. The Client will provide reviewable evidence of failure, omission, false pass, insufficient evidence, rollback failure, or manual substitution; the Contractor will submit a repair with a new version identifier and rerun the affected tasks until the agreed migration scope is complete and the Pipeline runs reliably and automatically. New features, versions, environments, or acceptance scenarios are not defect tuning under this paragraph and require written scope-change confirmation.

## 4. Client inputs and responsibilities

The Client shall provide, before the Acceptance Manifest is frozen:

- Access to the specified legacy code and the specified new-base reference;
- The business objective and the critical E2E user-visible result;
- Test accounts, fixtures, or an approved fixture-bootstrap method;
- The declared runtime, database, ports, public entry point, and environment identity;
- The list of permitted surrounding tools and prohibited actions;
- The Acceptance Manifest and the Acceptance Authority configuration;
- Any required credentials through an agreed secret-injection mechanism, never through source code or ordinary logs.

The Client's role during the Acceptance Run is limited to confirming the final end-to-end business result and, if required by the Contra platform, confirming the commercial release. The Client shall not be required to provide intermediate technical instructions for the Pipeline to continue.

The Client shall not place production secrets, customer data, private keys, or unrestricted administrative credentials in the Client Repositories or Acceptance Manifest.

If a required business fact is unknown, the Contractor shall identify it as an assumption in the proposal. The Contractor may not silently convert an unresolved business assumption into a PASS criterion.

## 5. Repository, execution, and access boundaries

### 5.1 Private repositories and source confidentiality

The Contractor may keep the Pipeline source in the Contractor Repository until the Acceptance Run passes and the payment is released. Before payment, the Client receives only the Evaluation Interface, status, redacted evidence, hashes, and the PASS/FAIL record. The Client shall not attempt to access, copy, reverse engineer, or extract the Pipeline source before the contractual handover.

The Contractor shall keep the Client's legacy code private and use it only for this project. The Client shall keep the Contractor's Pipeline source confidential after handover, subject to the ownership and license terms in Section 11.

### 5.2 No direct privileged access to the Client terminal computer

The Contractor shall not receive root access, unrestricted SSH access, unrestricted Docker access, or unrestricted self-hosted-runner access to the Client's terminal computer or production systems.

The Contractor may invoke only the allowlisted Client Terminal Computer Adapter operations. The adapter shall reject arbitrary shell commands, privilege escalation, unapproved file paths, unapproved network destinations, and production targets.

### 5.3 Mandatory GitHub self-hosted-runner warning

The parties expressly acknowledge the following official GitHub warning and agree that it is a material security constraint of this Agreement:

> **GitHub officially warns that running untrusted workflows on a self-hosted runner may allow the workflow code to compromise the runner and expose the machine's secrets and resources.**

Official GitHub security guidance: [Disabling or limiting GitHub Actions](https://docs.github.com/en/organizations/managing-organization-settings/disabling-or-limiting-github-actions-for-your-organization).

Accordingly:

- The Contractor shall not register the Client terminal computer as a self-hosted runner for the Contractor Repository without a separate written authorization.
- The default execution target shall be a GitHub-hosted runner or an ephemeral, clean, isolated runner controlled by the Contractor or an agreed independent verifier.
- A persistent runner containing Client secrets or production access shall not be used for untrusted Pipeline code.
- If a self-hosted runner is expressly authorized, its repository access, network egress, credentials, lifetime, logs, and cleanup procedure must be documented and accepted before use.

GitHub's documentation also describes ephemeral runners as a way to process one job and then de-register and wipe the runner; this Agreement adopts that pattern where a self-hosted runner is necessary: [Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).

### 5.4 AI, third-party service, and data handling

The Contractor may use OpenHands, other coding agents, or third-party model providers only if the Contractor remains responsible for the result and discloses the providers and data handling in the proposal. No Client secrets, personal data, production data, or private repository contents may be sent to an unapproved provider.

### 5.5 GitHub, ephemeral execution, and ephemeral preview

GitHub repositories are versioned carriers for source code, task inputs, workflow interfaces, and acceptance evidence. GitHub Pages is not the execution environment for the complete Vendure storefront. Full Vendure acceptance must run in a Linux environment capable of running the Server, Worker, database, and all other declared dependencies.

The formal Acceptance Run shall create a new Ephemeral Acceptance Environment. In that environment, the Pipeline may obtain the authorized Client repository or archive, verify the pinned revision, install dependencies, start PostgreSQL/Redis/other declared services, start Vendure and the Storefront, and run browser-based E2E tests in the same environment or on a controlled network. The source is obtained inside that temporary execution environment; the Contractor is not required to download it to a personal computer, and a Contractor's personal computer shall not be the sole acceptance environment.

If the Client wants to inspect the pages directly, the Contractor shall provide an Ephemeral Preview Environment and temporary URL. The environment must record its creation time, access control, URL, code revision, maximum lifetime, destruction time, and destruction result. The preview is for auxiliary visual inspection and troubleshooting; “the page opens” or “the page looks normal” alone does not constitute acceptance.

The recommended formal trigger is GitHub Actions `workflow_dispatch` or an equivalent authenticated API. When a run ends, the Ephemeral Acceptance Environment must be stopped and cleaned up; if the preview is separate, it must also be automatically destroyed when its agreed maximum lifetime is reached. Screenshots, videos, traces, logs, machine-readable results, load reports, and red-team reports shall be retained as evidence with the retention period recorded. Any design requiring a human to log in, click a next step, approve routine technical operations, or manually retry a technical failure does not satisfy the full-automation requirement.

If a GitHub-hosted runner cannot carry the full Vendure dependency set, the Contractor may propose a temporary cloud environment or temporary container. Before the Acceptance Manifest is frozen, the proposal must state the environment owner, network boundary, credential handling, cost, maximum lifetime, destruction method, and observable evidence. Without the Client's written approval, the Client terminal computer or a persistent host containing Client secrets shall not be used as the execution environment.

## 6. Operating and monitoring model

Before the Acceptance Manifest is frozen, the Contractor may submit written technical recommendations, including alternative frameworks, tools, roles, interfaces, security boundaries, runner arrangements, and acceptance methods. The Client may accept, reject, or request an alternative. The Contractor shall not unilaterally change the business objective, access scope, cost, or acceptance rules. Once frozen, the Acceptance Manifest is the controlling specification.

The intended control flow is:

Before the final `RUN_START`, complete the 3 long-chain capability validations and the post-delivery migration tuning required by Section 3.3. The Contractor may submit new candidate versions in response to the Client’s recorded failure evidence; each version must have a new commit, container digest, package hash, or equivalent identifier. Only when the Client confirms final acceptance will the candidate version be frozen and the formal run below begin.

1. The Client freezes the Acceptance Manifest, the test harness, and the permitted capability list.
2. The Contractor builds the Candidate Pipeline in the Contractor Repository.
3. The Contractor submits the Candidate Pipeline commit/container hash and the proposed Delivery Package hash.
4. The Client's Codex invokes the fixed workflow through the Evaluation Interface, normally by an authenticated `workflow_dispatch`/API request.
5. The Pipeline creates a clean Ephemeral Acceptance Environment and records its identity, code revision, dependency revisions, and maximum lifetime.
6. The Pipeline obtains and verifies the inputs in that environment, then starts the database, Vendure Server, Worker, Storefront, and declared supporting services.
7. The Pipeline autonomously performs the migration, E2E testing, load testing, and authorized red-team testing; if preview is enabled, it returns a temporary preview URL, which does not replace automated acceptance.
8. The Probe observes the run from outside the Candidate Pipeline and records the run ID, commit hash, environment lifecycle, job events, manual actions, tool calls, artifacts, and evidence.
9. The Pipeline uploads machine-readable results, screenshots, videos, traces, logs, load reports, red-team reports, and cleanup records, then destroys the ephemeral environment.
10. The code-owned validator evaluates the machine-readable results and cleanup evidence and emits `PASS` or `FAIL`.
11. The Acceptance Authority produces the PASS Attestation or a failure record.

The Probe and validator shall not rely solely on a narrative report written by the Pipeline. A zero process exit code or a green GitHub job is not, by itself, acceptance.

## 7. Pre-delivery capability validation, iterative tuning, and one-time final acceptance

### 7.1 At least 3 long-chain capability validations before delivery

Before formally delivering the Pipeline, the Contractor shall select and automatically complete at least 3 long-chain tasks from the project overview’s E2E validation tasks. The selected tasks, their batches, task inputs, run versions, complete evidence, and Client confirmation must be retained. This stage permits tuning and reruns after failure, is not the Final Acceptance Run, and does not trigger payment.

### 7.2 Complete-migration tuning after delivery

After formal delivery, the Client shall use the candidate Pipeline to attempt the complete migration specified by the project overview. Batch 1 and Batch 2 shall be run and recorded separately; the Client will provide failure, omission, false-pass, insufficient-evidence, rollback-failure, or manual-substitution evidence to the Contractor. The Contractor shall repair and submit a new candidate version, and the Client shall rebind the version and rerun affected tasks until the agreed migration scope is complete and the Pipeline runs reliably and automatically.

There is no fixed upper limit on tuning iterations for Pipeline defects within the agreed scope. Each repair must produce an identifiable new candidate version and retain its run result. New features, versions, environments, or acceptance scenarios are outside this paragraph and require separate written confirmation.

### 7.3 Freeze before final acceptance

After the Client confirms final acceptance, the following must be recorded before `RUN_START`:

- Legacy repository and commit;
- New-base repository and commit;
- Acceptance Manifest version/hash;
- Acceptance harness and validator version/hash;
- Codex acceptance profile/version/hash;
- Candidate Pipeline commit/container/package hash;
- Runner identity and environment identity;
- Fixture and account identifiers or hashes;
- Tool and network allowlists;
- Load and red-team thresholds;
- Evidence retention and redaction rules.

### 7.4 Final Acceptance Run rule

After the final candidate and acceptance materials are frozen, one Final Acceptance Run shall be executed. After the final `RUN_START`:

- The Contractor may not modify the Candidate Pipeline, Acceptance Manifest, validator, fixtures, or environment to improve the result.
- The Contractor may not manually repair, approve, rerun, or select a different execution path.
- A rerun is permitted only when the Acceptance Authority records that the verifier or platform itself failed, not when the Candidate Pipeline failed.

The “one final run” rule does not prohibit the pre-final tuning in Section 7.2. That tuning must occur before the final `RUN_START`, and every candidate version and run result must be retained.

### 7.5 PASS requirements

The final Candidate Pipeline passes only if every mandatory criterion in Annex A is satisfied, including:

1. At least 3 long-chain E2E tasks passed automatically before delivery, with complete evidence.
2. The Pipeline accepts the fixed task through the Evaluation Interface.
3. The final Pipeline runs after `RUN_START` without human intervention.
4. The specified legacy code is migrated to the specified new Vendure base, and the current agreed migration scope in the project overview is complete.
5. The resulting application builds and reaches the declared runtime state.
6. The declared E2E scenarios achieve the required user-visible results and have sufficient browser/API/backend evidence.
7. Required surrounding capabilities are actually used or an equivalent capability is proven with a recorded reason.
8. Load testing reaches the pre-agreed concurrency, duration, latency, throughput, and error thresholds.
9. Authorized red-team testing is completed within scope, with findings, severity, remediation status, and retest results.
10. The evidence package is complete, redacted, reproducible, and linked to the correct run, candidate version, and hashes.
11. The final Delivery Package hash matches the hash of the tested Candidate Pipeline.
12. No prohibited access, data exfiltration, privilege escalation, production targeting, or acceptance-harness tampering occurred.

## 8. Payment, Contra escrow, and handover

### 8.1 One-time fixed payment

The Client shall fund the full fixed fee through a Contra one-time fixed-price / escrow project before the Contractor begins the formal build. No milestone payments apply; the 3 pre-delivery long-chain validations and post-delivery tuning reruns do not trigger payment, and the fee is approved only after final acceptance.

The parties shall use a custom written agreement in the Contra project where permitted. Contra describes one-time fixed projects as projects in which funds are held and released when the Client approves the deliverable: [Contra Paid Projects](https://help.contra.com/en/articles/9322763-paid-projects).

### 8.2 Pre-registered delivery identity

Before `RUN_START`, the Contractor shall record the immutable Candidate Pipeline hash and Delivery Package hash. The Contractor shall not substitute a different version after a PASS.

Where the parties use encrypted delivery, the encrypted Delivery Package may be deposited with a mutually agreed escrow location before the Acceptance Run, while the decryption key remains unreleased until the Acceptance Run passes. After a PASS, the Contractor shall release the key or transfer the repository before the Client approves payment. If no independent escrow service is used, the Contractor remains contractually responsible for immediate post-PASS delivery.

### 8.3 PASS handover: delivery before payment release

After a PASS Attestation:

1. The Contractor immediately transfers the Delivery Package to the Client's private GitHub repository or releases the agreed decryption key;
2. The Client and the Acceptance Authority verify receipt, completeness, and the delivered hash against the tested hash;
3. The Client confirms the delivery and acceptance in Contra;
4. Contra releases the fixed fee in accordance with the Contra project and platform terms;
5. Ownership and license rights transfer as specified in Section 11 upon full payment.

The parties acknowledge that Contra's native platform may not implement a cryptographic atomic swap between source delivery and payment release. The delivery-before-payment obligation above is therefore a contractual obligation, supported by Contra escrow and the hash record, not a representation that Contra natively performs source-code escrow.

The Client may inspect the delivered source solely to verify completeness, identity, and the agreed hash before approving payment. The Client shall not use, copy, redistribute, or commercially exploit the delivered source before payment except as necessary for that verification.

The Client must act within Contra's then-current review and dispute window. Contra's published Terms currently state that a Client may be deemed to have approved a deliverable if the Client does not approve, request revisions, or submit a dispute within 120 hours of receipt; see [Contra Terms of Service](https://contra.com/policies/terms). The parties shall follow the then-current platform terms where they differ from this Agreement.

### 8.4 FAIL or non-delivery

If the Final Acceptance Run produces `FAIL`, the Client shall not approve release of the fee, and the Contractor shall not release the Delivery Package; issues found before the final run shall be handled through the tuning and rerun process in Section 7.2. The Client may submit a detailed defect record and use Contra's dispute process within the applicable platform window.

If the Acceptance Run produces `PASS` but the Contractor fails to deliver the matching Delivery Package, this is a material non-delivery and may be raised through Contra and the remedies in this Agreement.

## 9. Evidence and audit requirements

The Evidence Package shall contain, at minimum:

- Acceptance Run ID and timestamps;
- Candidate Pipeline and Delivery Package hashes;
- Environment and runner identity;
- Codex, Probe, validator, and harness versions/hashes;
- Event timeline and manual-intervention record;
- Tool-usage manifest and capability evidence;
- Build and test results;
- Browser screenshots, traces, API/network evidence, and backend/runtime evidence where applicable;
- Load-test parameters and raw summarized metrics;
- Red-team scope, findings, severity, remediation, and retest status;
- Cleanup and retention record;
- PASS Attestation or a precise FAIL code.

Evidence must not include secrets, private keys, database connection strings, customer data, or unnecessary source-code excerpts.

## 10. Security, authorized testing, and prohibited conduct

All load and red-team testing must be limited to the declared non-production environment and approved targets. The Contractor shall not attack, scan, stress, modify, or disrupt production systems or third-party systems.

The Contractor shall not:

- Exfiltrate Client code, credentials, data, or evidence;
- Add hidden network backdoors, time bombs, remote kill switches, or undisclosed telemetry;
- Bypass the Probe or validator;
- Modify the Acceptance Manifest or acceptance harness;
- Claim success from a self-authored status file without independent evidence;
- Use Client resources after the project except as expressly authorized.

The Contractor shall disclose any suspected security incident promptly and preserve relevant evidence.

## 11. Intellectual property and open-source materials

The parties agree that the commercial purpose of this project is not to prevent the Contractor from productizing a reusable pipeline. After full payment, the Contractor retains ownership of pre-existing tools, general know-how, and reusable general-purpose pipelines, components, and general-purpose code developed for this project, and may retain, use, further adapt, license, or commercialize those reusable results for the Contractor's own projects or other clients.

For project-specific configurations, client-specific adaptations, private client interfaces, project-specific documentation, and project-specific acceptance evidence included in the Delivery Package, the Contractor grants the Client a perpetual, worldwide, royalty-free, irrevocable, non-exclusive license to use, reproduce, modify, run, maintain, deploy internally, and engage replacement engineers to maintain the project. Unless the parties separately agree in writing, the Client does not receive exclusive ownership of the general-purpose pipeline or reusable components.

Nothing in this section permits the Contractor to use or disclose the Client's private code, client data, credentials, pre-redaction materials, acceptance materials, or other confidential information. Third-party and open-source materials remain subject to their applicable licenses.

The Contractor shall provide a dependency and license inventory and shall not include code that violates third-party rights or imposes undisclosed copyleft or usage restrictions.

## 12. Confidentiality

Each party shall protect the other party's confidential information with reasonable care and use it only for this project. Confidential information includes private repositories, source code, credentials, architecture, task data, acceptance tests, Probe data, and business information.

The confidentiality obligations survive termination and continue for `[PERIOD / TRADE SECRET STANDARD]`, except for information that becomes public without breach or must be disclosed by law.

## 13. Post-delivery reproducibility warranty

For `[PERIOD]` after handover, the Contractor shall correct defects that prevent the Client from reproducing the accepted Acceptance Run using the delivered Delivery Package, the declared environment, and the frozen Acceptance Manifest.

This warranty does not create a second acceptance stage and does not include new business features, changed environments, changed Vendure bases, or new load requirements unless separately agreed.

## 14. Termination and remedies

Either party may terminate for material breach after written notice and the applicable cure period `[PERIOD]`, except for serious security, confidentiality, fraud, or unauthorized-access breaches, which may justify immediate termination.

If the Contractor abandons the project, materially violates the access boundary, tampers with acceptance, refuses required tuning based on failure evidence, or fails the Final Acceptance Run, the Client may withhold approval of the escrowed fee and seek the remedies available under the Contra agreement and applicable law.

If the Client misuses or redistributes the Contractor's source before the contractual handover, the Contractor may seek the remedies available under applicable law and this Agreement.

## 15. Independent contractor and subcontracting

The Contractor is an independent contractor and is responsible for its personnel, taxes, tools, and subcontractors. Subcontracting or sending Client confidential information to another party requires the Client's prior written approval and does not reduce the Contractor's responsibility.

## 16. Precedence and amendments

This Agreement, the signed Contra project, and the final Acceptance Manifest form the project record. If a platform term is mandatory and conflicts with this Agreement, the mandatory platform term controls for the platform transaction; the parties shall preserve the commercial intent through a lawful amendment where possible.

Any change to the Acceptance Manifest, acceptance thresholds, access scope, or candidate version must be written, versioned, and approved by both parties before the Acceptance Run.

## 17. Signatures

| Client | Contractor |
|---|---|
| Name: `[NAME]` | Name: `[NAME]` |
| Signature: `[SIGNATURE]` | Signature: `[SIGNATURE]` |
| Date: `[DATE]` | Date: `[DATE]` |

# Annex A — Acceptance Manifest template

The following fields must be completed and hashed before `RUN_START`.

The pre-delivery list of at least 3 long-chain capability tasks, their batches, candidate versions, and evidence references must also be recorded in the final project record before the final `RUN_START`.

## A1. Task identity

- Acceptance Run ID: `[RUN ID]`
- Human task statement: `[PLAIN-LANGUAGE OBJECTIVE]`
- Legacy repository/commit: `[VALUE]`
- New Vendure base/commit: `[VALUE]`
- Required migration boundary: `[VALUE]`
- Expected final user-visible result: `[VALUE]`

## A2. Environment identity

- Execution environment type: `[GITHUB-HOSTED RUNNER / TEMPORARY CLOUD / TEMPORARY CONTAINER / CODESPACE / OTHER]`
- Target business environment: `[TEMPORARY VENDURE ENVIRONMENT / STAGING / OTHER]`
- Runtime and build identity: `[VALUE]`
- Database/container identity: `[VALUE]`
- Public entry point and ports: `[VALUE]`
- Test account and fixture identity: `[VALUE]`
- Prohibited targets: `[VALUE]`
- Automated acceptance workflow identifier and trigger: `[WORKFLOW_DISPATCH/API IDENTIFIER]`
- Environment creation time and maximum lifetime: `[VALUE]`
- Environment stop/destruction method: `[VALUE]`
- Ephemeral preview URL and access control, if enabled: `[VALUE]`
- Evidence storage location and retention period: `[VALUE]`

## A3. No-human-intervention rule

After the final `RUN_START`, the following are prohibited: manual code edits, manual approvals, manual tool selection, manual retries, interactive SSH sessions, acceptance-harness changes, and switching to another candidate version. The pre-delivery validations and post-delivery tuning in Sections 7.1 and 7.2 may submit new candidate versions and rerun after failures, but every version and result must be recorded. Pre-provisioned secrets and automatic service startup are permitted if recorded. The ephemeral environment must be created, stopped, and cleaned up by the Pipeline. The Client may open a preview for observation, but preview observation must not replace automated acceptance or provide technical guidance during the run.

## A4. E2E acceptance

- User journey: `[STEP-BY-STEP FLOW]`
- Expected UI result: `[VALUE]`
- Expected browser/network/API result: `[VALUE]`
- Expected backend/runtime result: `[VALUE]`
- Negative assertions: `[VALUE]`
- Cleanup: `[VALUE]`
- Automated browser execution location: `[INSIDE EPHEMERAL ACCEPTANCE ENVIRONMENT / OTHER CONTROLLED LOCATION]`
- Ephemeral preview enabled: `[YES/NO]`
- If enabled, preview URL, access lifetime, and destruction condition: `[VALUE]`

## A5. Load acceptance

- Target: `[VALUE]`
- Concurrency: `[VALUE]`
- Duration: `[VALUE]`
- Request mix: `[VALUE]`
- Maximum error rate: `[VALUE]`
- Latency thresholds: `[P95/P99 VALUE]`
- Throughput threshold: `[VALUE]`
- Stop conditions: `[VALUE]`

## A6. Authorized red-team acceptance

- Authorized target and scope: `[VALUE]`
- Test classes: `[VALUE]`
- Prohibited actions: `[VALUE]`
- Maximum severity allowed at PASS: `[VALUE]`
- Required remediation/retest: `[VALUE]`
- Stop conditions and rollback: `[VALUE]`

## A7. Evidence acceptance

Required outputs: complete evidence and Client confirmation for the at least 3 pre-delivery long-chain tasks, `PASS Attestation`, tool-usage manifest, event timeline, build/test results, E2E evidence, load report, red-team report, ephemeral-environment lifecycle record, cleanup record, and matching hashes. If applicable, the outputs must also include the preview URL, preview access control, and preview destruction record. Empty or unexplained evidence fields are not accepted.

# Annex B — Permission and role matrix

| Role | Allowed | Not allowed |
|---|---|---|
| Client local Codex | Start the fixed run, read status/evidence, invoke the validator | Modify the Candidate Pipeline or acceptance rules during the run |
| Probe | Read workflow/job/artifact metadata and bridge events | Write source code, approve a failed run, or grant permissions |
| Contractor Pipeline | Use declared repositories, tools, fixtures, and bridge operations | Root access, arbitrary shell, production access, hidden telemetry, or acceptance-harness changes |
| Client Terminal Computer Adapter | Execute registered allowlisted adapters | Arbitrary commands, privilege escalation, unrestricted filesystem or network access |
| Contra | Contract, payment escrow, messages, dispute record | Technical certification of the Pipeline |
