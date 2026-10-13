# Security Boundary

## What the public demo allows

- read the sanitized task and source;
- clone or fork the public repository;
- modify and test a personal copy;
- submit a PR or commit link for review;
- run the no-secret demo on a personal computer or isolated runner.

## What it does not allow

- write to or merge the canonical `main` branch;
- read the private Git history, owner-controlled formal acceptance revision, or production-only inputs. The public repository does contain a separately audited sanitized source snapshot for review; it must not be treated as private or production data;
- log in to the minipc, production system, or shared evidence directory;
- obtain passwords, API keys, SSH keys, or production data;
- turn a PR, workflow green check, or model statement into formal PASS.

## Safe execution rule

Untrusted contractor code must run only in the contractor's own environment or an isolated, no-secret public-demo runner. For the three-task capability gate, the contractor may use an isolated environment they control or another agreed isolated runner. For final acceptance, the project owner or an agreed independent verifier creates a clean, temporary Linux environment and binds the candidate commit, frozen input revision, contract revision, environment identity, fixtures, and run ID before execution. The validator owns the final PASS or BLOCK.

GitHub is the versioned control and evidence surface, not the complete Vendure runtime. The normal trigger is an authenticated `workflow_dispatch` or equivalent API. A repository page or GitHub Pages preview cannot replace the actual isolated run. SSH is not the normal control path; any diagnostic SSH channel must be separately approved, limited, temporary, logged, and unable to reach production or unrestricted host resources. If a required tool exists only on the minipc, the project owner must expose it through a narrow allowlisted adapter with fixed inputs and outputs.

The candidate package should normally include a `Dockerfile` and `compose.yaml` or an equivalent reproducible environment definition, pinned dependencies, start/stop/check/cleanup scripts, a no-secret `.env.example`, declared tool permissions, and an identifiable image digest or package hash. Secrets are injected only by the owner-controlled runtime and are never committed to the public repository.

Never use `pull_request_target` to execute untrusted changes while exposing repository secrets. Never commit a secret to this repository.
