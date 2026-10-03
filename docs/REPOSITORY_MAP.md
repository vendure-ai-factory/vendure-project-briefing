# Repository Map

| Repository | Visibility | Purpose | Contractor path |
| --- | --- | --- | --- |
| `vendure-project-briefing` | Public | Sanitized project briefing, runnable demo, approved test-image tree, and clean-tree sanitized migration-input package | Anonymous read, clone, fork, local changes, optional PR; no private history or production access |
| `vendure-evaluation-input` | Private | Owner-controlled formal revisions, private history, fixtures, task documents, and acceptance inputs | Only the approved private access needed after contract and manifest freeze |
| `pipeline-contract` | Private | Full pipeline interface, evidence schema, runtime constraints, and acceptance contract | Contracted delivery, version pinning, and maintainer review only |

The repositories are connected by explicit versions, revisions, and case identifiers, not by exposing private Git history or hidden submodules. The public migration-input package is a reviewed, sanitized clean-tree publication; it is useful for inspection and experiments but must not be treated as the owner-controlled formal revision.

GitHub carries source revisions, task inputs, workflow interfaces, status, and redacted evidence. It does not itself run the full Vendure stack: the Pipeline creates or enters a clean isolated Linux environment. The contractor may use their own isolated runner for development and the three-task capability gate; final acceptance uses a project-controlled temporary environment or an agreed independent verifier. An authenticated `workflow_dispatch` or equivalent API is the preferred control path, while SSH is only a separately approved diagnostic fallback.

The handoff chain is: public repository and demo -> contractor quote -> signed agreement -> approved private input and candidate Pipeline revision -> three long-chain capability gate -> owner-controlled complete migration run -> evidence-based tuning of in-scope defects -> final validator PASS -> handover and payment under the applicable agreement. A PR or fork is a review/submission surface only; it never grants merge rights or access to private repositories, the minipc, or production.
