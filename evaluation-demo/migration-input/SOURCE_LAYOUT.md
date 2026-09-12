# Evaluation input layout

- `legacy/vendure-store`: sanitized old Vendure secondary-development source from `projects_backup_full.tar`; its Vendure core is 3.5.3.
- `legacy/storefront`: sanitized old storefront source and relevant tests.
- `fixtures/美甲图案`: test effect/design assets for the end-to-end evaluation.
- `acceptance-inputs/测试任务.docx`: the detailed migration task and its two-step end-to-end verification requirements.
- `acceptance-inputs/流水线诉求描述.docx`: the required autonomous pipeline behavior and acceptance expectations.
- The target plugin-enabled base is kept in the separate private repository `vendure-base-reference`.
- The original archive, Git history, environment files, databases, dependencies, build output, runtime evidence, and secrets are intentionally not uploaded.
- Scripts use repository-relative defaults and documented environment-variable overrides; credentials must be supplied only at run time.
- The legal contract and negotiation documents are not part of the technical evaluation inputs; they remain in the private contract repository and the Contra engagement.
