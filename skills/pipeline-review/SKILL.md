# pipeline-review

- Version: 1.0.0
- Owner: pipeline-contract review step
- Entry point: `review.js`

## Purpose

`pipeline-review` independently verifies that the acceptance evidence for a
run is complete, consistent and untampered, and derives a single overall
verdict. It is the gate between "the pipeline says the run is done" and
"the evidence actually supports that claim".

The review **never trusts the compliance report**. It re-runs hash
verification over the real evidence files and re-derives each task verdict
from the evidence itself. A report that claims a passing run does not count
for anything unless the evidence holds up.

## Inputs

- `evidence/<runId>/` - the evidence tree produced during the run (index.json,
  one folder per canonical task, record.json per task).
- `reports/<runId>/compliance-report.json` - the generateReport output
  persisted by the runner. Optional: if it is missing the review still
  derives its verdict from the evidence.
- `reports/<runId>/chain-<id>.json` - chain-level summaries written by the
  chain runner (chunk 16). The review reads them and re-derives each chain's
  verdict from the evidence, never trusting the summary's claimed result.

## Exact commands

```bash
# From the repo root: review a specific run
node skills/pipeline-review/review.js <runId>

# Override the evidence/reports base directories (used by tests and CI)
PIPELINE_REVIEW_EVIDENCE_DIR=<dir> node skills/pipeline-review/review.js <runId>
```

The script reads `<runId>` from argv, defaults the evidence base to
`evidence/` and the reports base to `reports/` under the current working
directory, re-runs `verifyEvidence(runId)` and prints the review.

## Verdict rules (plain language)

Every task is judged only from its evidence. A task is never a passing
outcome unless **all** of the following hold at once:

- the task exists and its record is present;
- the record has a `result` field;
- its result equals the granted pass constant (`RESULT_PASS` from
  `src/terminalState.js`);
- every evidence file exists and its sha256 matches the index;
- `expectedResult` equals `actualResult`;
- no manual intervention is required;
- cleanup is verified (`cleanupResetResult` present and not null);
- the protected-path hashes start/end match, and the end hash matches the
  pinned hash in `index.json` when a pin is present;
- the task does not depend on a pending client value or an unconfirmed
  assumption.

The non-passing verdicts:

- **BLOCK with a failure class** - any task that is not a passing outcome.
  The following stay *unmet*: `PIPELINE_DEFECT`, `APPLICATION_DEFECT`,
  `SAFETY_AUTHORIZATION`, exhausted repair. The following are reported
  *pending*: `CLIENT_INPUT_SCOPE`, `DEPENDENCY_ENVIRONMENT`.
- **MISSING_EVIDENCE** - any required file, field or hash is absent or
  mismatched (including a tampered file, a missing `result` field, or
  protected-hash mismatch). A `MISSING_EVIDENCE` task can never resolve to a
  passing outcome.
- **UNRESOLVED_ASSUMPTION** - a task depends on a value marked
  `PENDING_CLIENT` or on an unconfirmed assumption, including a missing
  protected-hashes pin. Never resolves to a passing outcome.

Overall verdict precedence (highest wins):

1. `MISSING_EVIDENCE`
2. `BLOCK` (any *unmet* task)
3. `UNRESOLVED_ASSUMPTION`
4. `BLOCK` (pending tasks only, no unmet and no missing evidence)
5. passing outcome

A passing overall verdict additionally requires all 24 acceptance tasks to
be present (`CAN-B1-01` ... `CAN-B2-16`; `CAN-DEMO-01` is not an acceptance
task).

## Output format

One line per task:

```
CAN-B1-01 BLOCK CLIENT_INPUT_SCOPE pending
CAN-B2-08 PASS
```

Then a reasoned paragraph per non-passing group, then the overall line:

```
MISSING_EVIDENCE: CAN-B1-05
  CAN-B1-05: evidence integrity failure (missing, tampered or field-short file)
CHAIN A PASS (summary declared PASS, consistent)
OVERALL: MISSING_EVIDENCE
```

Exit code: `0` only for a passing overall verdict; any other verdict exits
non-zero.

## Never do

- **Never infer a passing verdict from a narrative.** Only a verdict re-derived
  from real evidence (hashes, fields, expected vs actual) counts.
- **Never skip hash verification.** Every evidence file is re-hashed against
  `index.json` on every review.
- **Never edit evidence.** The review is read-only; any tampering shows up as
  `MISSING_EVIDENCE`.
- **Never trust the compliance report's claims.** The report is read only to
  be compared against the re-derived verdict.
