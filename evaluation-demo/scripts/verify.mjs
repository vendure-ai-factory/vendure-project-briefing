import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(scriptDir, '..');
const appDir = join(demoDir, 'app');
const repoDir = resolve(demoDir, '..');
const mode = process.argv[2] === '--baseline' ? 'baseline' : 'acceptance';
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${mode}`;
const resultDir = join(demoDir, 'results', runId);
mkdirSync(resultDir, { recursive: true });

const run = spawnSync(process.execPath, ['--test', join(appDir, 'tests', 'acceptance.test.mjs')], {
  cwd: appDir,
  encoding: 'utf8'
});
const passed = run.status === 0;
const expectedBaselineBlock = mode === 'baseline' && !passed;
const accepted = mode === 'acceptance' && passed;
const status = accepted ? 'PASS' : expectedBaselineBlock ? 'BASELINE_BLOCKED_EXPECTED' : 'BLOCK';
const exitCode = accepted || expectedBaselineBlock ? 0 : 1;

let diff = '';
try {
  diff = execFileSync('git', ['diff', '--', 'evaluation-demo'], { cwd: repoDir, encoding: 'utf8' });
} catch (error) {
  diff = `git diff unavailable: ${error.message}`;
}

const manifest = {
  run_id: runId,
  mode,
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  source: 'public-evaluation-demo',
  input: 'evaluation-demo/app/fixtures/legacy-catalog.json',
  task: 'evaluation-demo/task.md',
  command: `${process.execPath} --test evaluation-demo/app/tests/acceptance.test.mjs`,
  exit_code: run.status,
  network_used: false,
  secrets_used: false
};

writeFileSync(join(resultDir, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(resultDir, 'status.json'), `${JSON.stringify({ status, run_id: runId, test_exit_code: run.status }, null, 2)}\n`);
writeFileSync(join(resultDir, 'stdout.log'), run.stdout ?? '');
writeFileSync(join(resultDir, 'stderr.log'), run.stderr ?? '');
writeFileSync(join(resultDir, 'diff.patch'), diff);
writeFileSync(join(resultDir, 'change-summary.md'), 'Inspect the Git diff for the changed-file summary. The public verifier does not modify the source tree.\n');
writeFileSync(join(resultDir, 'rollback.md'), 'Rollback: remove or revert the changes in your own clone or fork. The canonical public main branch is not modified by this run.\n');
writeFileSync(join(resultDir, 'summary.md'), `# Run Summary\n\n- Status: \`${status}\`\n- Run ID: \`${runId}\`\n- Mode: \`${mode}\`\n- Test exit code: \`${run.status}\`\n- Network used: \`false\`\n- Secrets used: \`false\`\n\n${expectedBaselineBlock ? 'The incomplete starter was correctly recognized as an expected block. Implement the task and rerun with `--acceptance`.' : accepted ? 'All public acceptance assertions passed.' : 'The acceptance assertions did not pass. Read `stderr.log`, fix the task in your own copy, and rerun.'}\n`);

console.log(JSON.stringify({ status, run_id: runId, result_dir: resultDir }, null, 2));
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exitCode = exitCode;
