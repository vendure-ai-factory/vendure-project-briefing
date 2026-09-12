import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(scriptDir, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'vendure-public-demo-'));
const tempDemo = join(tempRoot, 'evaluation-demo');
cpSync(demoDir, tempDemo, { recursive: true });
const reference = readFileSync(join(demoDir, 'expected-results', 'reference-catalog.mjs'), 'utf8');
writeFileSync(join(tempDemo, 'app', 'src', 'catalog.mjs'), `${reference}\n`);

const result = spawnSync(process.execPath, ['--test', join(tempDemo, 'app', 'tests', 'acceptance.test.mjs')], {
  cwd: tempDemo,
  encoding: 'utf8'
});
const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-reference`;
const resultDir = join(demoDir, 'results', runId);
const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(resultDir, { recursive: true });
await writeFile(join(resultDir, 'run-manifest.json'), `${JSON.stringify({ run_id: runId, mode: 'reference', source: 'temporary-copy', network_used: false, secrets_used: false }, null, 2)}\n`);
await writeFile(join(resultDir, 'status.json'), `${JSON.stringify({ status: result.status === 0 ? 'PASS' : 'BLOCK', run_id: runId, test_exit_code: result.status }, null, 2)}\n`);
await writeFile(join(resultDir, 'summary.md'), `# Reference Demo Summary\n\n- Status: \`${result.status === 0 ? 'PASS' : 'BLOCK'}\`\n- Run ID: \`${runId}\`\n- The reference was run in a temporary copy.\n- Network used: \`false\`\n- Secrets used: \`false\`\n`);
await writeFile(join(resultDir, 'rollback.md'), 'The reference run changed only a temporary copy, which was removed after the run.\n');
await writeFile(join(resultDir, 'stdout.log'), result.stdout ?? '');
await writeFile(join(resultDir, 'stderr.log'), result.stderr ?? '');
rmSync(tempRoot, { recursive: true, force: true });

console.log(JSON.stringify({ status: result.status === 0 ? 'PASS' : 'BLOCK', run_id: runId, result_dir: resultDir }, null, 2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status === 0 ? 0 : 1;
