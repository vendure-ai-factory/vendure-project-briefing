# Sanitized Migration Input Package

This directory is a public, sanitized snapshot prepared for contractor review and hands-on experiments. It is copied from the current sanitized working tree, not from the private repository's Git history. No private repository history, credentials, production data, or runtime secrets are included.

## Contents

- `legacy/` — the sanitized Vendure secondary-development source tree, including the legacy storefront and related scripts.
- `fixtures/美甲图案/` — the sanitized image fixture tree with its original subdirectories preserved. Do not flatten or rename these directories because some scripts resolve them by relative path.
- `acceptance-inputs/测试任务.docx` — the migration task input.
- `acceptance-inputs/流水线诉求描述.docx` — the pipeline requirement input.
- `PUBLICATION_SANITIZATION_REPORT.md` — the publication audit and environment-variable guidance.
- `SOURCE_LAYOUT.md` — the source-tree and path conventions used by the sanitized package.

## How to use it

Start with the repository-level quickstart and the English project and pipeline documents. Use this package to inspect the larger code and task context, then run experiments only in your own clone, fork, Codespace, or isolated runner. Keep all paths repository-relative or configurable through environment variables; never add local machine paths, credentials, or real service endpoints.

The small deterministic demo under `evaluation-demo/app/` remains the quickest smoke test. This package gives additional context for feasibility and pipeline design; it is not the owner-controlled formal acceptance environment. Formal acceptance still uses a frozen revision and validator controlled by the project owner.
