'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');
var demoWorkspace = require('./demoWorkspace');
var patchModule = require('../tools/patch');
var verifyRunner = require('./verifyRunner');
var checkpointModule = require('../tools/checkpoint');
var llmModule = require('../llm');

function sleepAsync(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

var TASK_ID = 'CAN-DEMO-01';
var MAX_REPAIR_ATTEMPTS = 3;

function buildClassification(failureClass, reason, evidence, rule) {
  return {
    failureClass: failureClass || 'PIPELINE_OR_ENVIRONMENT',
    reason: reason || 'Unknown',
    evidence: evidence || {},
    rule: rule || null,
    recoverable: false
  };
}

function extractFencedBlock(text) {
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'Empty response' };
  }

  var fencePattern = /^```([^\n]*)\s*\n([\s\S]*?)\n```/m;
  var match = text.match(fencePattern);

  if (!match) {
    return { valid: false, reason: 'No fenced code block found' };
  }

  var infoString = (match[1] || '').trim();
  var content = match[2];

  // Count total fences
  var totalFences = (text.match(/^```/gm) || []).length;
  if (totalFences === 0) {
    return { valid: false, reason: 'No fenced block' };
  }

  if (infoString !== 'js catalog.mjs') {
    return { valid: false, reason: 'Wrong info string: ' + infoString };
  }

  var stripped = content.trim();
  if (!stripped) {
    return { valid: false, reason: 'Empty content' };
  }

  if (stripped.indexOf('export function migrateCatalog') === -1) {
    return { valid: false, reason: 'Missing export function migrateCatalog' };
  }

  var FORBIDDEN = /\b(fetch|eval|XMLHttpRequest|WebSocket|child_process)\b|\brequire\s*\(|from\s+['"]node:(fs|net|http|https|child_process|os|dns)\b/;
  if (FORBIDDEN.test(stripped)) {
    return { valid: false, reason: 'Forbidden pattern detected' };
  }

  return { valid: true, content: stripped };
}

function hashSignature(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function writeEvidence(evRoot, basename, content) {
  try {
    var filePath = basename ? path.join(evRoot, basename) : evRoot;
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (content !== undefined) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  } catch (err) {
    // non-fatal
  }
}

async function runDemoRepair(options) {
  options = options || {};
  var provider = options.provider;
  var providerType = options.providerType || (provider ? 'mock' : 'real');
  var runId = options.runId || ('demo-repair-' + Date.now());
  var scenario = options.scenario || 'fix-on-second';
  var acceptNoSandbox = !!options.acceptNoSandbox;

  var finalResult = {
    result: 'BLOCK',
    class: 'PIPELINE_OR_ENVIRONMENT',
    runId: runId,
    baselineHash: null,
    attempts: 0,
    provider: providerType,
    evidenceRoot: null,
    exitCode: 1
  };

  var wsRoot = null;
  var baselineHash = null;

  try {
    patchModule.setupDemoWorkspaceProtection(null);
  } catch (err) {
    // non-fatal
  }

  try {
    // Reuse an existing workspace for this runId so a pre-created workspace is
    // not clobbered; otherwise create a fresh one.
    var existingHash = demoWorkspace.getBaselineHash(runId);
    var wsResult;
    if (existingHash) {
      var runsRoot = path.resolve(__dirname, '..', '..', 'runs');
      wsResult = {
        success: true,
        workspaceRoot: path.join(runsRoot, runId, 'workspace'),
        baselineHash: existingHash,
        runId: runId
      };
    } else {
      wsResult = demoWorkspace.createWorkspace(runId);
    }
    if (!wsResult.success) {
      finalResult.result = 'BLOCK';
      finalResult.class = 'PIPELINE_OR_ENVIRONMENT';
      return finalResult;
    }

    wsRoot = wsResult.workspaceRoot;
    baselineHash = wsResult.baselineHash;
    finalResult.baselineHash = baselineHash;

    var evidenceRoot = path.join(path.dirname(wsRoot), 'demo-evidence', runId);
    finalResult.evidenceRoot = evidenceRoot;
    try {
      if (!fs.existsSync(evidenceRoot)) {
        fs.mkdirSync(evidenceRoot, { recursive: true });
      }
    } catch (mkdirErr) {
      // non-fatal
    }

    patchModule.setWorkspaceRoot(wsRoot);
    checkpointModule.setRepoRoot(wsRoot);

    var baselineVerify = verifyRunner.runVerify(wsRoot, { timeout: 60000 });

    var waitBaseline = Date.now();
    for (; baselineVerify.exitCode === null && Date.now() - waitBaseline < 15000; ) {
      await sleepAsync(100);
    }

    if (baselineVerify.exitCode === 0) {
      finalResult.result = 'NO_REPAIR_NEEDED';
      finalResult.attempts = 0;
      finalResult.exitCode = 0;
      writeEvidence(path.join(evidenceRoot, 'baseline-failure.txt'), null, '');
      var baselineEvidence = 'baseline verify: exit 0, no repair needed\n';
      writeEvidence(path.join(evidenceRoot, 'verification.txt'), null,
        'command: ' + baselineVerify.command + '\n' +
        'exit code: ' + baselineVerify.exitCode + '\n' +
        'stdout: ' + (baselineVerify.stdout || '').substring(0, 2000) + '\n' +
        'stderr: ' + (baselineVerify.stderr || '').substring(0, 2000) + '\n' +
        'duration: ' + (baselineVerify.duration || 0) + 'ms\n');
      writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, '[]');
      writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
      return finalResult;
    }

    if (baselineVerify.exitCode !== 1) {
      finalResult.result = 'BLOCK';
      finalResult.class = 'PIPELINE_OR_ENVIRONMENT';
      writeEvidence(path.join(evidenceRoot, 'baseline-failure.txt'), null,
        'baseline verify exit: ' + baselineVerify.exitCode + '\n' +
        (baselineVerify.stderr || '') + '\n');
      writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify([], null, 2));
      writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
      return finalResult;
    }

    var baselineFailureText = (baselineVerify.stdout || '').substring(0, 6000);
    writeEvidence(path.join(evidenceRoot, 'baseline-failure.txt'), null, baselineFailureText);

    var llmClient = llmModule.createLLMClient({ provider: provider });
    var allowedModel = llmClient._test.getConfiguredModel();

    var attemptsList = [];
    var permissionModelUsed = verifyRunner.isPermissionModelAvailable();

    for (var attemptNum = 1; attemptNum <= MAX_REPAIR_ATTEMPTS; attemptNum++) {
      var checkpointResult = checkpointModule.createCheckpoint('repair-attempt-' + attemptNum);
      var checkpointHash = checkpointResult.success ? checkpointResult.commitHash : baselineHash;

      var taskPath = path.join(wsRoot, 'evaluation-demo', 'task.md');
      var catalogPath = path.join(wsRoot, 'evaluation-demo', 'app', 'src', 'catalog.mjs');

      var taskContent = '';
      var currentCatalog = '';

      try {
        taskContent = fs.readFileSync(taskPath, 'utf8');
      } catch (e) {
        taskContent = '';
      }
      try {
        currentCatalog = fs.readFileSync(catalogPath, 'utf8');
      } catch (e) {
        currentCatalog = '';
      }

      var promptText = 'Task:\n' + taskContent + '\n\nCurrent catalog.mjs:\n```js\n' + currentCatalog + '\n```\n\nLast failing output:\n' + baselineFailureText + '\n\nRespond with ONLY a single fenced code block (info string exactly "js catalog.mjs") containing the FULL new catalog.mjs content.';

      var llmResponse;
      try {
        llmResponse = await llmClient.complete({
          messages: [{ role: 'user', content: promptText }],
          taskId: TASK_ID,
          purpose: 'repair',
          model: allowedModel,
          runId: runId
        });
      } catch (llmErr) {
        if (llmErr.name === 'BudgetPausedError' || llmErr.name === 'CircuitOpenError') {
          finalResult.result = 'BLOCK';
          finalResult.class = llmErr.name === 'BudgetPausedError' ? 'BUDGET_PAUSED' : 'CIRCUIT_OPEN';
          writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify(attemptsList, null, 2));
          writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
          return finalResult;
        }
        if (llmErr.name === 'ModelLockError' || llmErr.name === 'ModelMismatchError') {
          finalResult.result = 'BLOCK';
          finalResult.class = 'MODEL_LOCK';
          writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify(attemptsList, null, 2));
          writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
          return finalResult;
        }
        finalResult.result = 'BLOCK';
        finalResult.class = 'PIPELINE_OR_ENVIRONMENT';
        writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify(attemptsList, null, 2));
        writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
        return finalResult;
      }

      if (typeof llmResponse === 'object' && llmResponse !== null) {
        llmResponse = llmResponse.text || '';
      } else if (typeof llmResponse === 'string') {
        llmResponse = llmResponse;
      } else {
        llmResponse = '';
      }

      var parseResult = extractFencedBlock(llmResponse);

      if (!parseResult.valid) {
        var rejectSig = hashSignature(TASK_ID + 'validation' + parseResult.reason);
        demoWorkspace.resetWorkspace(baselineHash, runId);
        attemptsList.push({
          n: attemptNum,
          accepted: false,
          reason: 'validation: ' + parseResult.reason,
          signature: rejectSig,
          verifyExitCode: null,
          checkpointHash: checkpointHash,
          permissionModelUsed: permissionModelUsed,
          acceptNoSandbox: acceptNoSandbox,
          provider: finalResult.provider,
          model: allowedModel
        });
        continue;
      }

      try {
        fs.writeFileSync(catalogPath, parseResult.content, 'utf8');
      } catch (writeErr) {
        demoWorkspace.resetWorkspace(baselineHash, runId);
        attemptsList.push({
          n: attemptNum,
          accepted: false,
          reason: 'write error: ' + writeErr.message,
          signature: hashSignature(TASK_ID + 'validation' + 'write error'),
          verifyExitCode: null,
          checkpointHash: checkpointHash,
          permissionModelUsed: permissionModelUsed,
          acceptNoSandbox: acceptNoSandbox,
          provider: finalResult.provider,
          model: allowedModel
        });
        continue;
      }

      var allowResult = demoWorkspace.enforceAllowlist(wsRoot, baselineHash);
      if (!allowResult.success) {
        demoWorkspace.resetWorkspace(baselineHash, runId);
        attemptsList.push({
          n: attemptNum,
          accepted: false,
          reason: 'allowlist violation: ' + (allowResult.error || ''),
          signature: hashSignature(TASK_ID + 'validation' + 'allowlist'),
          verifyExitCode: null,
          checkpointHash: checkpointHash,
          permissionModelUsed: permissionModelUsed,
          acceptNoSandbox: acceptNoSandbox,
          provider: finalResult.provider,
          model: allowedModel
        });
        continue;
      }

      var verifyResult = verifyRunner.runVerify(wsRoot, { timeout: 60000 });
      var waitVerify = Date.now();
      for (; verifyResult.exitCode === null && Date.now() - waitVerify < 15000; ) {
        await sleepAsync(100);
      }

      if (verifyResult.exitCode === 0) {
        finalResult.result = 'PASS_CANDIDATE';
        finalResult.attempts = attemptNum;

        var diffPatch = '';
        try {
          var diffResult = childProcess.execFileSync('git', [
            'diff', baselineHash, '--', 'evaluation-demo/app/src/catalog.mjs'
          ], {
            cwd: wsRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            env: demoWorkspace.buildAllowedEnv()
          });
          diffPatch = diffResult || '';
        } catch (e) {
          diffPatch = '';
        }

        attemptsList.push({
          n: attemptNum,
          accepted: true,
          reason: 'verify passed',
          signature: hashSignature(TASK_ID + 'verify' + verifyResult.exitCode),
          verifyExitCode: verifyResult.exitCode,
          checkpointHash: checkpointHash,
          permissionModelUsed: permissionModelUsed,
          acceptNoSandbox: acceptNoSandbox,
          provider: finalResult.provider,
          model: allowedModel
        });

        writeEvidence(path.join(evidenceRoot, 'final-diff.patch'), null, diffPatch);
        // Verify the patch can be reversed (empty diff = nothing to reverse is OK)
        var patchPath = path.join(evidenceRoot, 'final-diff.patch');
        if (diffPatch.trim().length > 0) {
          try {
            childProcess.execFileSync('git', ['apply', '--check', '-R', patchPath], {
              cwd: wsRoot,
              stdio: ['pipe', 'pipe', 'pipe'],
              env: demoWorkspace.buildAllowedEnv()
            });
          } catch (e) {
            // non-fatal: empty diff or git not available
          }
        }
        writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify(attemptsList, null, 2));
        writeEvidence(path.join(evidenceRoot, 'verification.txt'), null,
          'command: ' + verifyResult.command + '\n' +
          'exit code: ' + verifyResult.exitCode + '\n' +
          'stdout: ' + (verifyResult.stdout || '').substring(0, 2000) + '\n' +
          'stderr: ' + (verifyResult.stderr || '').substring(0, 2000) + '\n' +
          'duration: ' + (verifyResult.duration || 0) + 'ms\n');
        writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
        writeEvidence(path.join(evidenceRoot, 'rollback.txt'), null,
          'git -C ' + wsRoot + ' reset --hard ' + baselineHash + ' && git -C ' + wsRoot + ' clean -fd\n');

        if (!permissionModelUsed) {
          writeEvidence(path.join(evidenceRoot, 'verification.txt'), null,
            '\nNO SANDBOX: validation regex is the only guard against generated code\n');
        }

        return finalResult;
      }

      if (verifyResult.exitCode !== 1) {
        demoWorkspace.resetWorkspace(baselineHash, runId);
        finalResult.result = 'BLOCK';
        finalResult.class = 'PIPELINE_OR_ENVIRONMENT';
        writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify(attemptsList, null, 2));
        writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));
        return finalResult;
      }

      demoWorkspace.resetWorkspace(checkpointHash, runId);
      attemptsList.push({
        n: attemptNum,
        accepted: true,
        reason: 'verify failed',
        signature: hashSignature(TASK_ID + 'verify' + verifyResult.exitCode),
        verifyExitCode: verifyResult.exitCode,
        checkpointHash: checkpointHash,
        permissionModelUsed: permissionModelUsed,
        acceptNoSandbox: acceptNoSandbox,
        provider: finalResult.provider,
        model: allowedModel
      });
    }

    finalResult.result = 'BLOCK';
    finalResult.class = 'APPLICATION_DEFECT';
    finalResult.attempts = attemptsList.length;

  } catch (err) {
    finalResult.result = 'BLOCK';
    finalResult.class = 'PIPELINE_OR_ENVIRONMENT';
  }

  // Always write attempts.json and rollback guidance on exit (even if BLOCK
  // from exhausted attempts) so the evidence set is complete.
  writeEvidence(path.join(evidenceRoot, 'attempts.json'), null, JSON.stringify(attemptsList, null, 2));
  writeEvidence(path.join(evidenceRoot, 'verification.txt'), null,
    'command: (exhausted ' + MAX_REPAIR_ATTEMPTS + ' attempts)\n' +
    'exit code: 1\n' +
    'stdout: (none)\n' +
    'stderr: (none)\n' +
    'duration: 0ms\n');
  if (wsRoot && baselineHash) {
    writeEvidence(path.join(evidenceRoot, 'rollback.txt'), null,
      'git -C ' + wsRoot + ' reset --hard ' + baselineHash + ' && git -C ' + wsRoot + ' clean -fd\n');
  }
  writeEvidence(path.join(evidenceRoot, 'final-diff.patch'), null, '');
  writeEvidence(path.join(evidenceRoot, 'result.json'), null, JSON.stringify(finalResult, null, 2));

  return finalResult;
}

module.exports = { runDemoRepair: runDemoRepair };