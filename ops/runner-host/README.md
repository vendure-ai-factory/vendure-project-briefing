# Runner staging operations

This directory documents the root-owned, allowlisted host wrapper used by the GitHub self-hosted Runner. It exposes only two entry points through sudo:

- Read bounded, best-effort-redacted logs:
  - `sudo /usr/local/sbin/pipeline-staging-ops logs vendure`
  - `sudo /usr/local/sbin/pipeline-staging-ops logs worker`
  - `sudo /usr/local/sbin/pipeline-staging-ops logs postgres`
- Deploy one immutable image from the approved GHCR repository:
  - `sudo /usr/local/sbin/pipeline-staging-ops deploy ghcr.io/vendure-ai-factory/nail-patterns-vendure@sha256:<64-lowercase-hex>`

The deploy command verifies the fixed image repository and digest, image source/revision labels, and the two approved staging Compose services. It updates only the staging Vendure API/worker services, then checks container status, the staging health endpoint, and a Shop API smoke response. It stores a root-only copy of the previous `deploy.env` and a root-only operation evidence record. It does not automatically roll back application or database state; failed health checks return BLOCK for investigation.

The log reader is limited to the Vendure API, Vendure worker, and staging Postgres, and to the last 100 lines from the last two hours. It redacts common credential patterns and email addresses before printing. Redaction is best effort, not a guarantee: do not add secrets or real customer data to logs, and review output before sharing it.

Image provenance labels identify the claimed source repository and commit; they do not prove CI or acceptance-pipeline success. Deploy only after the required build/check/pipeline gates pass and the digest is selected from their evidence. Installing the wrapper does not trigger a deployment.
