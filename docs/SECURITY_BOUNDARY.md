# Security Boundary

## What the public demo allows

- read the sanitized task and source;
- clone or fork the public repository;
- modify and test a personal copy;
- submit a PR or commit link for review;
- run the no-secret demo on a personal computer or isolated runner.

## What it does not allow

- write to or merge the canonical `main` branch;
- read the private legacy source or formal acceptance inputs;
- log in to the minipc, production system, or shared evidence directory;
- obtain passwords, API keys, SSH keys, or production data;
- turn a PR, workflow green check, or model statement into formal PASS.

## Safe execution rule

Untrusted contractor code must run only in the contractor's own environment or an isolated, no-secret public-demo runner. A maintainer-controlled formal run must bind the candidate commit, frozen input revision, contract revision, environment identity, and run ID before execution. The validator owns the final PASS or BLOCK.

Never use `pull_request_target` to execute untrusted changes while exposing repository secrets. Never commit a secret to this repository.
