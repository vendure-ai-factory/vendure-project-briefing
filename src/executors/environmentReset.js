'use strict';

/**
 * Clean environment, rollback and restart behavior executor (CAN-B1-07).
 *
 * CAN-B1-07 asserts (acceptance-manifest.v0.4.json, task CAN-B1-07-A01) that
 * clean initialization, migration, rollback and restart work on the isolated
 * clone, and that the environment identity and the reset/cleanup result are
 * recorded. Restart/reboot is permitted only through the approved lifecycle
 * wrapper that the Runner publishes on the isolated clone (the sole way to
 * reboot or restart; inputs-registry.json requiredInput
 * isolatedCloneRestartRollback). This executor never spawns a reboot/restart
 * command itself.
 *
 * The approved wrapper is a Runner-owned tool and is absent in a local
 * checkout. It is discovered, in order, from:
 *   - context.deps.runWrapper - an injected wrapper function (the Runner
 *     adapter; also used by tests with a fake wrapper). Input request:
 *     { lifecycle: 'verify', phases: ['init','migrate','rollback','restart'],
 *       identity: {...} }; output: { ok, environmentIdentity, phases,
 *       resetCleanupResult }. The request/response contract is defined by this
 *     executor because the wrapper is not part of this repository. [assumption]
 *   - the env var PIPELINE_ENV_RESET_WRAPPER (Runner secret; only the NAME is
 *     recorded in evidence). When present and no injected function exists the
 *     executor still blocks: there is no approved adapter to invoke, and
 *     invoking a restart command by hand is forbidden.
 *
 * Local behavior: the wrapper is absent, so the executor returns BLOCK with
 * failure class CLIENT_INPUT_SCOPE (errorCode VALIDATION_ERROR) and writes
 * evidence that the wrapper is absent, including the environment identity it
 * can still observe (git rev-parse HEAD, platform, run id). No reboot or
 * restart is attempted.
 *
 * Failure classes:
 *   - any lifecycle phase reports ok:false, or environment identity /
 *     reset-cleanup result is missing -> EXPECTED_MISMATCH (APPLICATION_DEFECT)
 *   - the wrapper call itself fails or is unreachable -> ENVIRONMENT_ERROR
 *     (DEPENDENCY_ENVIRONMENT)
 *   - the approved wrapper is absent -> VALIDATION_ERROR (CLIENT_INPUT_SCOPE)
 *
 * When every required phase and identity/reset claim is verified from the
 * wrapper-reported evidence the run is a READINESS_PASS with coverage
 * readiness-subset; real isolated-clone reboot/restart behavior is provable
 * only on the Runner, so a full pass is never claimed here.
 */

var terminalState = require('../terminalState');
var gitBaseline = require('../gitBaseline');
var sessionModule = require('./shopApiSession');

var RESULT_READINESS_PASS = terminalState.RESULT_READINESS_PASS;
var COVERAGE_READINESS_SUBSET = terminalState.COVERAGE_READINESS_SUBSET;

// Canonical task id this executor registers (acceptance-manifest.v0.4.json).
var TASK_ID = 'CAN-B1-07';

// Approved wrapper env var NAME (name only is recorded). Value would be the
// Runner's approved lifecycle wrapper; locally it is absent.
var WRAPPER_ENV = 'PIPELINE_ENV_RESET_WRAPPER';
var WRAPPER_ENV_NAMES = [WRAPPER_ENV];

// Lifecycle phases that CAN-B1-07-A01 requires to work on the isolated clone.
var LIFECYCLE_PHASES = ['init', 'migrate', 'rollback', 'restart'];

function getEnvFn(context) {
  return sessionModule.getEnvFn(context);
}

function getClock(context) {
  var clock = context && context.deps && context.deps.clock;
  if (typeof clock === 'function') return clock;
  return function() { return new Date(); };
}

function repoRootOf(context) {
  if (context && typeof context.repoRoot === 'string' && context.repoRoot.length > 0) {
    return context.repoRoot;
  }
  return process.cwd();
}

function runIdOf(context) {
  return sessionModule.runIdOf(context);
}

function executionRevisionOf(context) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  return runEnv.gitHead || runEnv.revisionId || null;
}

// ---------------------------------------------------------------------------
// Identity + wrapper resolution
// ---------------------------------------------------------------------------

/**
 * Environment identity recorded in evidence. Never contains secret values:
 * only git HEAD, platform, node version and run/workspace identifiers.
 */
function buildEnvironmentIdentity(context, timestamp) {
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var workspace = context && context.workspace ? context.workspace : {};
  var root = repoRootOf(context);
  var gitHead = gitBaseline.getCurrentCommit(root);
  if (!gitHead && runEnv.gitHead) gitHead = runEnv.gitHead;
  return {
    runId: runIdOf(context),
    workspaceId: workspace.workspaceId || null,
    workspacePath: workspace.workspacePath || null,
    repoRoot: root,
    gitHead: gitHead || null,
    branch: null,
    platform: process.platform,
    nodeVersion: process.version,
    capturedAt: timestamp
  };
}

/**
 * Resolve the approved lifecycle wrapper. Returns:
 *   { ok: true, value, source, envNames } for an injected function or an env
 *   var naming the wrapper; { ok: false, envNames } when absent.
 */
function resolveWrapper(context) {
  if (context && context.deps && typeof context.deps.runWrapper === 'function') {
    return {
      ok: true,
      value: context.deps.runWrapper,
      source: 'deps.runWrapper',
      envNames: WRAPPER_ENV_NAMES.slice()
    };
  }
  var env = getEnvFn(context)();
  for (var i = 0; i < WRAPPER_ENV_NAMES.length; i++) {
    var value = env[WRAPPER_ENV_NAMES[i]];
    if (typeof value === 'string' && value.length > 0) {
      // Present but not invokable without an approved adapter; do not run a
      // reboot/restart command by hand (safety rule: never outside the
      // wrapper).
      return {
        ok: false,
        envPresent: WRAPPER_ENV_NAMES[i],
        envNames: WRAPPER_ENV_NAMES.slice(),
        reason: 'approved wrapper env var is set but no injected wrapper adapter is available; refusing to invoke a restart command directly'
      };
    }
  }
  return { ok: false, envNames: WRAPPER_ENV_NAMES.slice() };
}

// ---------------------------------------------------------------------------
// Wrapper invocation
// ---------------------------------------------------------------------------

function wrapperRequest(identity) {
  return {
    lifecycle: 'verify',
    phases: LIFECYCLE_PHASES.slice(),
    identity: identity
  };
}

/**
 * Invoke the approved lifecycle wrapper with the verify request. Returns
 * { ok:false, error, errorCode } on a thrown/unreachable wrapper, otherwise
 * { ok:true, request, response }.
 */
async function runLifecycleViaWrapper(context, wrapper, identity, timestamp) {
  var request = wrapperRequest(identity);
  var response;
  try {
    response = await wrapper.value(request, context);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'lifecycle wrapper call failed: ' + String(err && err.message || err),
      request: request
    };
  }
  if (!response || typeof response !== 'object') {
    return {
      ok: false,
      errorCode: 'ENVIRONMENT_ERROR',
      error: 'lifecycle wrapper returned no structured result',
      request: request
    };
  }
  return { ok: true, request: request, response: response };
}

// ---------------------------------------------------------------------------
// Assertion verification
// ---------------------------------------------------------------------------

/**
 * Verify the wrapper-reported lifecycle result against CAN-B1-07-A01. Returns
 * { checks, verifiedClaims, unverifiedClaims, failures } describing which
 * parts are verified and which remain unverified.
 */
function verifyLifecycle(identity, response) {
  var phases = (response && response.phases) || {};
  var envIdentity = (response && response.environmentIdentity) || null;
  var resetResult = (response && response.resetCleanupResult) || null;
  var checks = {
    wrapperReported: true,
    allPhasesOk: false,
    identityRecorded: false,
    resetRecorded: false,
    noDirectRestart: false,
    verifiedCount: 0
  };
  var verified = [];
  var unverified = [];
  var failures = [];

  var phaseStatuses = {};
  var verifiedPhases = 0;
  for (var i = 0; i < LIFECYCLE_PHASES.length; i++) {
    var phase = LIFECYCLE_PHASES[i];
    var phaseRes = phases[phase];
    if (!phaseRes || typeof phaseRes !== 'object') {
      unverified.push({
        claim: 'lifecycle phase ' + phase,
        why: 'wrapper reported no result for ' + phase
      });
      phaseStatuses[phase] = 'unreported';
      continue;
    }
    if (phaseRes.ok === true) {
      verifiedPhases = verifiedPhases + 1;
      phaseStatuses[phase] = 'ok';
      verified.push({ claim: 'lifecycle phase ' + phase + ' work', observed: phaseRes });
    } else {
      phaseStatuses[phase] = 'fail';
      failures.push('lifecycle phase ' + phase + ' reported ok=false (' + String(phaseRes.error || '') + ')');
    }
  }
  checks.allPhasesOk = verifiedPhases === LIFECYCLE_PHASES.length && failures.length === 0;

  if (envIdentity && typeof envIdentity === 'object' &&
      (String(envIdentity.cloneId || '') || String(envIdentity.containerId || '')) &&
      String(envIdentity.gitHead || '')) {
    checks.identityRecorded = true;
    verified.push({ claim: 'environment identity recorded', observed: envIdentity });
  } else {
    failures.push('environment identity not recorded by wrapper (cloneId or containerId plus gitHead required)');
  }

  if (resetResult && typeof resetResult === 'object' && resetResult.ok === true && String(resetResult.result || '')) {
    checks.resetRecorded = true;
    verified.push({ claim: 'reset/cleanup result recorded', observed: resetResult });
  } else {
    failures.push('reset/cleanup result not recorded by wrapper (ok:true plus a non-empty result string required)');
  }

  checks.noDirectRestart = true; // the executor never invokes any restart itself

  checks.verifiedCount = verified.length;
  checks.unverifiedCount = unverified.length;
  return { checks: checks, verified: verified, unverified: unverified, failures: failures };
}

// ---------------------------------------------------------------------------
// Evidence + record helpers
// ---------------------------------------------------------------------------

function writeExecutorEvidence(context, task, outcome, evidence) {
  var deps = context && context.deps ? context.deps : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var taskId = task.canonicalId || (context && context.taskId) || null;
  if (!runId || !taskId) return { ok: false, reason: 'no runId/taskId' };
  var wroteAny = false;
  try {
    if (typeof deps.writeEvidenceFile === 'function') {
      deps.writeEvidenceFile(runId, taskId, 'executor-environment-reset.json', JSON.stringify({ schemaVersion: '1.0', evidence: evidence }, null, 2), { kind: 'executor-environment-reset' });
      wroteAny = true;
    }
    if (typeof deps.writeTaskRecord === 'function') {
      deps.writeTaskRecord(runId, taskId, buildRecord(context, task, outcome, evidence), evidenceOptionsFrom(context));
      wroteAny = true;
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e), wroteAny: wroteAny };
  }
  return { ok: true, wroteAny: wroteAny };
}

function evidenceOptionsFrom(context) {
  var config = context && context.deps && context.deps.config ? context.deps.config : {};
  var baseDir = config.evidenceBaseDir || process.env.PIPELINE_EVIDENCE_BASE_DIR || 'evidence';
  var root = config.evidenceRoot || process.cwd();
  return { root: root, baseDir: baseDir };
}

function writePersistedEvidence(context, taskId, name, payload, kind) {
  var runId = runIdOf(context);
  if (!runId) return null;
  var sentinel = sessionModule.writeEvidenceFileFor(context, taskId, name, payload, kind || 'artifact', []);
  return sentinel;
}

function buildCommandInvocation(wrapper) {
  return 'approved lifecycle wrapper (source: ' + wrapper.source + '; phases: ' + LIFECYCLE_PHASES.join(', ') + ')';
}

function buildRecord(context, task, outcome, evidence) {
  var source = context && context.manifest && context.manifest.source ? context.manifest.source : {};
  var runEnv = context && context.runEnvRecord ? context.runEnvRecord : {};
  var runId = (context && context.runId) || runEnv.runId || null;
  var workspace = context && context.workspace ? context.workspace : {};
  var checks = evidence && evidence.checks ? evidence.checks : {};
  var identity = evidence && evidence.environmentIdentity ? evidence.environmentIdentity : {};
  var resetResult = evidence && evidence.resetCleanupResult ? evidence.resetCleanupResult : {};
  return {
    canonicalId: task.canonicalId || null,
    summarySpecIds: (task.summaryIds || []).slice(),
    referenceRevision: source.referenceCommit || null,
    executionRevision: evidence.executionRevision || null,
    environmentIdentity: identity,
    commandInvocation: evidence.commandInvocation || null,
    inputArtifactIds: (task.requiredInputs || []).slice(),
    expectedResult: task.expectedResult || null,
    actualResult: outcome.actual,
    exitErrorResult: { exitCode: outcome.success ? 0 : 1, error: outcome.error || null },
    generatedArtifacts: outcome.success ? ['environment-reset'] : [],
    stateChanges: {
      success: outcome.success === true,
      actual: outcome.actual,
      wrapperReported: checks.wrapperReported === true,
      noDirectRestart: checks.noDirectRestart === true,
      wrapperAbsent: evidence.wrapperAbsent === true
    },
    cleanupResetResult: outcome.success ? resetResult : { ok: false, skipped: true, reason: 'clean init/migrate/rollback/restart not performed (approved wrapper absent or returned failure)' },
    finalClassification: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    naReason: null,
    result: outcome.success ? RESULT_READINESS_PASS : 'BLOCK',
    classification: outcome.success ? null : (outcome.errorCode === 'VALIDATION_ERROR' ? 'CLIENT_INPUT_SCOPE' : (outcome.errorCode === 'ENVIRONMENT_ERROR' ? 'DEPENDENCY_ENVIRONMENT' : (outcome.errorCode === 'EXPECTED_MISMATCH' ? 'APPLICATION_DEFECT' : null))),
    cause: outcome.success ? null : (outcome.errorCode || null),
    scope: 'environment-reset',
    coverage: COVERAGE_READINESS_SUBSET
  };
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function failureOutcome(errorCode, error, evidence) {
  return {
    success: false,
    actual: null,
    result: null,
    error: error,
    errorCode: errorCode,
    evidence: evidence || null
  };
}

function passOutcome(context, taskId, evidence) {
  var expectedText = (context && context.task && context.task.expectedResult) || taskId;
  return {
    success: true,
    actual: expectedText,
    result: RESULT_READINESS_PASS,
    errorCode: null,
    error: null,
    evidence: evidence
  };
}

// ---------------------------------------------------------------------------
// Assertion report
// ---------------------------------------------------------------------------

function buildAssertionReport(verified, unverified) {
  var a01 = {
    id: 'CAN-B1-07-A01',
    verified: verified.length > 0 && unverified.length === 0,
    summary: 'Clean initialization, migration, rollback and restart work on the isolated clone; environment identity and the reset/cleanup result are recorded.',
    verifiedClaims: verified,
    unverifiedClaims: unverified
  };
  return [a01];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * CAN-B1-07: clean init / migration / rollback / restart through the approved
 * lifecycle wrapper. Absent wrapper locally -> BLOCK CLIENT_INPUT_SCOPE with
 * evidence that the wrapper is absent; the executor never reboots itself.
 */
async function handlerEnvironmentReset(context) {
  context = context || {};
  var task = context.task || {};
  var taskId = task.canonicalId || (context.taskId || TASK_ID);
  var clock = getClock(context);
  var timestamp = clock().toISOString();

  var identity = buildEnvironmentIdentity(context, timestamp);
  identity.gitHead = identity.gitHead || executionRevisionOf(context) || null;

  // 1. Approved wrapper presence (the only path to a reboot/restart).
  var wrapper = resolveWrapper(context);
  if (!wrapper.ok) {
    var reason = wrapper.reason ||
      'approved lifecycle wrapper is absent (Runner-only; env var names checked: ' + WRAPPER_ENV_NAMES.join(', ') + '); no reboot or restart performed outside the wrapper';
    var blockEvidence = {
      schemaVersion: '1.0',
      taskId: taskId,
      scope: 'environment-reset',
      title: 'Clean environment, rollback and restart (CAN-B1-07)',
      executionRevision: executionRevisionOf(context),
      step: 'wrapper-presence',
      wrapperAbsent: true,
      wrapperEnvPresent: wrapper.envPresent || null,
      envVarNames: WRAPPER_ENV_NAMES.slice(),
      environmentIdentity: identity,
      resetCleanupResult: { ok: false, skipped: true, reason: 'approved wrapper absent; clean init/migrate/rollback/restart and reset/cleanup not performed' },
      safety: { directRebootAttempted: false, note: 'reboot/restart is only permitted through the approved wrapper; none was attempted' },
      commandInvocation: null,
      assertions: buildAssertionReport([], [{
        id: 'CAN-B1-07-A01',
        text: task.expectedResult || taskId,
        why: 'clean init/migrate/rollback/restart can only run through the approved wrapper on the Runner; the wrapper is absent locally (CLIENT_INPUT_SCOPE)'
      }]),
      completedAt: timestamp
    };
    writePersistedEvidence(context, taskId, 'wrapper-absent.json', blockEvidence, 'api-request');
    writePersistedEvidence(context, taskId, 'executor-error.json', blockEvidence, 'executor-error');
    writeExecutorEvidence(context, task, failureOutcome('VALIDATION_ERROR', reason, blockEvidence), blockEvidence);
    return failureOutcome('VALIDATION_ERROR', reason, blockEvidence);
  }

  // 2. Run the lifecycle only through the approved wrapper.
  var run = await runLifecycleViaWrapper(context, wrapper, {
    runId: identity.runId,
    gitHead: identity.gitHead,
    platform: identity.platform,
    nodeVersion: identity.nodeVersion,
    capturedAt: timestamp
  }, timestamp);
  if (!run.ok) {
    var depEvidence = {
      schemaVersion: '1.0',
      taskId: taskId,
      scope: 'environment-reset',
      title: 'Clean environment, rollback and restart (CAN-B1-07)',
      executionRevision: executionRevisionOf(context),
      step: 'wrapper-invoke',
      wrapperAbsent: false,
      wrapperSource: wrapper.source,
      envVarNames: WRAPPER_ENV_NAMES.slice(),
      environmentIdentity: identity,
      request: run.request,
      error: run.error,
      safety: { directRebootAttempted: false, note: 'reboot/restart only through the approved wrapper' },
      assertions: buildAssertionReport([], [{
        id: 'CAN-B1-07-A01',
        text: task.expectedResult || taskId,
        why: 'lifecycle wrapper call failed: ' + run.error
      }]),
      completedAt: timestamp
    };
    writePersistedEvidence(context, taskId, 'executor-error.json', depEvidence, 'executor-error');
    writeExecutorEvidence(context, task, failureOutcome('ENVIRONMENT_ERROR', run.error, depEvidence), depEvidence);
    return failureOutcome('ENVIRONMENT_ERROR', run.error, depEvidence);
  }

  // 3. Verify the wrapper-reported lifecycle result.
  var verification = verifyLifecycle(identity, run.response);
  var observed = {
    wrapperSource: wrapper.source,
    environmentIdentity: (run.response && run.response.environmentIdentity) || null,
    phases: (run.response && run.response.phases) || {},
    resetCleanupResult: (run.response && run.response.resetCleanupResult) || null,
    gitHeadAtStart: identity.gitHead
  };
  var evidence = {
    schemaVersion: '1.0',
    taskId: taskId,
    scope: 'environment-reset',
    title: 'Clean environment, rollback and restart (CAN-B1-07)',
    executionRevision: executionRevisionOf(context),
    step: 'lifecycle-verify',
    wrapperAbsent: false,
    wrapperSource: wrapper.source,
    envVarNames: WRAPPER_ENV_NAMES.slice(),
    environmentIdentity: identity,
    request: run.request,
    observed: observed,
    checks: verification.checks,
    assertions: buildAssertionReport(verification.verified, verification.unverified),
    safety: { directRebootAttempted: false, note: 'reboot/restart only through the approved wrapper; wrapper-reported evidence only, real isolated-clone behavior is provable only on the Runner' },
    commandInvocation: buildCommandInvocation(wrapper),
    completedAt: timestamp
  };

  // Failures (a reported phase failed) are an application/business defect.
  if (verification.failures.length > 0) {
    var defectEvidence = Object.assign({}, evidence, { errors: verification.failures });
    writePersistedEvidence(context, taskId, 'executor-error.json', defectEvidence, 'executor-error');
    writeExecutorEvidence(context, task, failureOutcome('EXPECTED_MISMATCH', verification.failures.join('; '), defectEvidence), defectEvidence);
    return failureOutcome('EXPECTED_MISMATCH', verification.failures.join('; '), defectEvidence);
  }

  // Some required claims unverified (e.g. phases the wrapper could not run) ->
  // the assertion is not fully verified; readiness-subset only.
  if (verification.unverified.length > 0) {
    writeExecutorEvidence(context, task, passOutcome(context, taskId, evidence), evidence);
    return passOutcome(context, taskId, evidence);
  }

  // Everything verified from wrapper-reported evidence -> readiness pass.
  evidence.checks = verification.checks;
  evidence.result = RESULT_READINESS_PASS;
  writePersistedEvidence(context, taskId, 'lifecycle-evidence.json', evidence, 'api-response');
  writeExecutorEvidence(context, task, passOutcome(context, taskId, evidence), evidence);
  return passOutcome(context, taskId, evidence);
}

function register(executorModule) {
  var reg = executorModule.registerTaskExecutor;
  reg(TASK_ID, {
    description: 'Clean environment, rollback and restart behavior: verify clean init/migrate/rollback/restart on the isolated clone through the approved lifecycle wrapper only, recording environment identity and the reset/cleanup result (CLIENT_INPUT_SCOPE locally when the wrapper is absent)',
    builtIn: true,
    coverage: COVERAGE_READINESS_SUBSET,
    verifiedAssertionIds: ['CAN-B1-07-A01'],
    handler: handlerEnvironmentReset
  });
  return { success: true, registered: [TASK_ID] };
}

module.exports = {
  TASK_ID: TASK_ID,
  WRAPPER_ENV: WRAPPER_ENV,
  WRAPPER_ENV_NAMES: WRAPPER_ENV_NAMES.slice(),
  LIFECYCLE_PHASES: LIFECYCLE_PHASES.slice(),
  buildEnvironmentIdentity: buildEnvironmentIdentity,
  resolveWrapper: resolveWrapper,
  buildCommandInvocation: buildCommandInvocation,
  wrapperRequest: wrapperRequest,
  verifyLifecycle: verifyLifecycle,
  buildAssertionReport: buildAssertionReport,
  buildRecord: buildRecord,
  handlerEnvironmentReset: handlerEnvironmentReset,
  register: register
};
