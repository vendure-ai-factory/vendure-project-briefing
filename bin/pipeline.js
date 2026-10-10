'use strict';

var cli = require('../src/cli');

// Run ids injected by pipeline/run-staging.mjs have the shape
// run-<base36>-<base36>. Validating here prevents a malformed id from
// silently falling back to a random one (which would break the
// evidence/reports runId matching run-staging depends on).
var RUN_ID_RE = /^run-[a-z0-9]+-[a-z0-9]+$/;

// Validate an injected run id. Errors name only the variable, never its
// value. An unset id is allowed (direct pipeline runs keep their default);
// a present-but-invalid id is rejected.
function validateRunId(runId) {
  if (runId === undefined) {
    return { ok: true, runId: undefined };
  }
  if (!RUN_ID_RE.test(runId)) {
    return { ok: false, runId: null, error: 'Error: PIPELINE_RUN_ID is invalid.' };
  }
  return { ok: true, runId: runId };
}

function main() {
  var validated = validateRunId(process.env.PIPELINE_RUN_ID);
  if (!validated.ok) {
    console.error(validated.error);
    process.exitCode = 2;
    return;
  }
  var deps = {
    console: console,
    fs: require('fs'),
    mkdirSync: function(p) {
      if (!require('fs').existsSync(p)) require('fs').mkdirSync(p, { recursive: true });
    },
    writeFileSync: require('fs').writeFileSync.bind(require('fs')),
    now: function() { return new Date(); },
    getEnv: function() { return process.env; },
    config: require('../src/config').getConfig()
  };
  // cli.js honours deps.runId; a CLI flag is not used because cli.js
  // parseArgs rejects unknown flags.
  if (validated.runId !== undefined) {
    deps.runId = validated.runId;
  }
  cli.runAsync(process.argv, deps).then(function(result) {
    if (result && result.exitCode !== undefined) {
      process.exitCode = result.exitCode;
    } else {
      process.exitCode = 1;
    }
  }).catch(function(err) {
    console.error('Unexpected error:', err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  RUN_ID_RE: RUN_ID_RE,
  validateRunId: validateRunId
};
