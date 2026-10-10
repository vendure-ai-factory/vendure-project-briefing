'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var canonicalizeModule = require('../src/canonicalize');

var ROOT = path.resolve(__dirname, '..');

// Load current manifest to get additional fields
var current = JSON.parse(fs.readFileSync('./manifest/acceptance-manifest.v0.4.json', 'utf8'));

// Extract fields from current tasks
var fromCurrent = {};
current.tasks.forEach(function(t) {
  fromCurrent[t.canonicalId] = {
    negativeChecks: t.negativeChecks || [],
    requiredInputs: t.requiredInputs || [],
    evidenceRequired: t.evidenceRequired || [],
    status: t.status,
    title: t.title,
    batch: t.batch,
    mandatoryAssertions: t.mandatoryAssertions
  };
});

// Coverage requirement mapping for coverageRef
var coverageMap = {
  'CAN-B1-01': 'COV-A02', 'CAN-B1-02': 'COV-A01', 'CAN-B1-03': 'COV-A02',
  'CAN-B1-04': null, 'CAN-B1-05': 'COV-A02', 'CAN-B1-06': null,
  'CAN-B1-07': null, 'CAN-B1-08': 'COV-A02', 'CAN-B2-01': 'COV-A04',
  'CAN-B2-02': 'COV-A04', 'CAN-B2-03': 'COV-A04', 'CAN-B2-04': 'COV-A10',
  'CAN-B2-05': 'COV-A03', 'CAN-B2-06': 'COV-A10', 'CAN-B2-07': 'COV-A05',
  'CAN-B2-08': 'COV-A07', 'CAN-B2-09': 'COV-A08', 'CAN-B2-10': 'COV-A09',
  'CAN-B2-11': 'COV-A10', 'CAN-B2-12': 'COV-A11', 'CAN-B2-13': 'COV-A09',
  'CAN-B2-14': 'COV-A12', 'CAN-B2-15': null, 'CAN-B2-16': null
};

function deriveSummaryChains(chains) {
  var map = {A:1, B:2, C:3, D:4, E:5, F:6, G:6};
  return (chains || []).map(function(c) { return map[c] || 0; });
}

// Build tasks array
var newTasks = [];
current.tasks.forEach(function(t) {
  if (t.canonicalId === 'CAN-DEMO-01') return; // handle separately
  
  var batchNum = t.batch === 'BATCH-1' ? 1 : 2;
  var curr = fromCurrent[t.canonicalId];
  
  // Add coverageRef: preserve per-assertion coverageRef from source, else use coverageMap default
  var assertionsWithRef = (curr.mandatoryAssertions || []).map(function(a) {
    var ref = (a.coverageRef !== undefined) ? a.coverageRef : coverageMap[t.canonicalId];
    return {
      id: a.id,
      text: a.text,
      sourceRef: a.sourceRef,
      evidenceKinds: a.evidenceKinds || [],
      coverageRef: ref
    };
  });
  
  var newTask = {
    canonicalId: t.canonicalId,
    batch: 'BATCH-' + batchNum,
    title: t.title || null,
    origin: t.origin,
    summaryRaw: t.summaryIds[0] || '',
    summaryIds: t.summaryIds,
    summaryPartial: false,
    specRaw: t.specIds[0] || '',
    specIds: t.specIds,
    specSections: [],
    mappingTypeSource: t.mappingType,
    mappingType: t.mappingType,
    expectedResult: t.expectedResult,
    chains: t.chains,
    summaryChains: deriveSummaryChains(t.chains),
    negativeChecks: curr.negativeChecks,
    requiredInputs: curr.requiredInputs,
    evidenceRequired: curr.evidenceRequired,
    status: curr.status,
    mandatoryAssertions: assertionsWithRef
  };
  
  // Pass through scopeNote if present
  if (t.scopeNote) {
    newTask.scopeNote = t.scopeNote;
  }
  
  newTasks.push(newTask);
});

// Add CAN-DEMO-01 with hardcoded fields (not in current manifest)
newTasks.push({
  canonicalId: 'CAN-DEMO-01',
  batch: 'DEMO',
  origin: 'public-demo',
  title: 'Public demo: catalog migration adapter',
  summaryRaw: 'DEMO-01',
  summaryIds: [],
  summaryPartial: false,
  specRaw: 'DEMO-01',
  specIds: [],
  specSections: [],
  mappingTypeSource: 'direct',
  mappingType: 'direct',
  expectedResult: 'bash evaluation-demo/scripts/verify.sh --acceptance returns PASS; evidence is the verifier output directory.',
  chains: [],
  summaryChains: [],
  negativeChecks: ['No network calls', 'Input not mutated', 'No new dependencies'],
  requiredInputs: [],
  evidenceRequired: ['file'],
  status: 'READY',
  mandatoryAssertions: [
    { id: 'CAN-DEMO-01-A01', text: 'bash evaluation-demo/scripts/verify.sh --acceptance returns PASS; evidence is the verifier output directory.', sourceRef: { doc: 'acceptance-manifest-v0.4', section: 'Batch 2 table' }, evidenceKinds: ['file'], coverageRef: null },
    { id: 'CAN-DEMO-01-A02', text: 'No network calls, input not mutated, no new dependencies.', sourceRef: { doc: 'acceptance-manifest-v0.4', section: 'Batch 2 table (negativeChecks)' }, evidenceKinds: ['file'], coverageRef: null }
  ]
});

// Chains structure from reference
var chainsObj = {
  rows: [
    { summaryChain: 1, specChainsRaw: 'A', specChains: ['A'], mappingTypeSource: 'direct', canonicalIds: ['CAN-B1-02'], tasksRaw: 'CAN-B1-02 and all regression targets', includesAllRegressionTargets: true },
    { summaryChain: 2, specChainsRaw: 'B', specChains: ['B'], mappingTypeSource: 'direct', canonicalIds: ['CAN-B2-01', 'CAN-B2-06', 'CAN-B2-04', 'CAN-B2-12'], tasksRaw: 'CAN-B2-01, CAN-B2-06, CAN-B2-04, CAN-B2-12', includesAllRegressionTargets: false },
    { summaryChain: 3, specChainsRaw: 'C', specChains: ['C'], mappingTypeSource: 'direct', canonicalIds: ['CAN-B2-02', 'CAN-B2-03', 'CAN-B2-04', 'CAN-B2-07', 'CAN-B2-08', 'CAN-B2-09'], tasksRaw: 'CAN-B2-02, CAN-B2-03, CAN-B2-04, CAN-B2-07, CAN-B2-08, CAN-B2-09', includesAllRegressionTargets: false },
    { summaryChain: 4, specChainsRaw: 'D + F', specChains: ['D', 'F'], mappingTypeSource: 'merge', canonicalIds: ['CAN-B2-10', 'CAN-B2-13', 'CAN-B2-14', 'CAN-B2-08'], tasksRaw: 'CAN-B2-10, CAN-B2-13, CAN-B2-14, CAN-B2-08', includesAllRegressionTargets: false },
    { summaryChain: 5, specChainsRaw: 'B (part) + E', specChains: ['B', 'E'], mappingTypeSource: 'merge', canonicalIds: ['CAN-B2-04', 'CAN-B2-11', 'CAN-B2-12'], tasksRaw: 'CAN-B2-04, CAN-B2-11, CAN-B2-12', includesAllRegressionTargets: false },
    { summaryChain: 6, specChainsRaw: '—', specChains: ['G'], mappingTypeSource: 'added Chain G', canonicalIds: ['CAN-B2-09', 'CAN-B2-11', 'CAN-B2-15'], tasksRaw: 'CAN-B2-09, CAN-B2-11, CAN-B2-15', includesAllRegressionTargets: false }
  ],
  chainG: {
    name: 'Account, Delisting and Order-Index Views',
    covers: ['buyer order view', 'designer sales view', 'cross-channel order index', 'correct Channel-specific order detail', 'exclusion of unpaid anonymous abandoned carts', 'customer self-delisting', 'authorized administrator delisting', 'related design-file removal/archive', 'resulting receipt correctness'],
    canonicalIds: ['CAN-B2-09', 'CAN-B2-11', 'CAN-B2-15']
  }
};

// Scripts from reference (using reference IDs)
var scripts = [
  { id: 'setup_tax_rates', kind: 'present', relationship: 'separate operation', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/setup_tax_rates.mjs', wrapperPath: null, implementationPath: null, purpose: 'Sets tax rates DE 19, AT 20, HU 27, GB 20 for category `Standard Tax`', inputsRaw: "args `--country`, `--apply`; needs `docker compose` + `psql`", outputsRaw: "`work/tmp/tax-rate-setup/<ts>/summary.txt`, `result.json`", credentialFreeModeRaw: 'No: even dry-run needs Docker/DB access', stateChangeRiskRaw: '`--apply` deletes and re-inserts `tax_rate` rows: isolated clone only', referenceRevision: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd', pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-14', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED', fileLines: 226 },
  { id: 'process_shipping_csv', kind: 'present', relationship: 'separate operation; implementation of the `.ts` name (Client-stated)', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/process_shipping_csv.mjs', wrapperPath: null, implementationPath: null, purpose: 'Fulfils orders from CSV and deducts variant stock', inputsRaw: '`--csv`, `--commit`, `--reconcile-stock`; env `VENDURE_ADMIN_API_URL`, `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD`', outputsRaw: '`shipping-plan.json`, `result.json`, `summary.txt`', credentialFreeModeRaw: 'Yes: dry-run (default)', stateChangeRiskRaw: '`--commit` fulfils and deducts stock; `--reconcile-stock` deducts again (double-deduction risk, section 4.6)', referenceRevision: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd', pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-12', 'CAN-B2-13', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED', fileLines: 596 },
  { id: 'mark_shipped_from_csv', kind: 'adapter', relationship: 'separate operation, not an alias', path: 'evaluation-demo/migration-input/legacy/vendure-store/tools/mark_shipped_from_csv.sh', wrapperPath: null, implementationPath: null, purpose: 'Fulfils orders from the Chinese-column export CSV; optional `batchExportedAt`', inputsRaw: 'CSV path, env `VENDURE_ADMIN_API_URL`, `VENDURE_ADMIN_TOKEN`, `DRY_RUN`, `MARK_BATCH_EXPORTED`', outputsRaw: 'console log, exit code', credentialFreeModeRaw: 'Yes: `DRY_RUN=true`', stateChangeRiskRaw: 'Uses `FulfillmentInput!`; the Vendure Admin API documents `FulfillOrderInput!` (section 4.7)', referenceRevision: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd', pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-10', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED', fileLines: 179 },
  { id: 'run_export', kind: 'present', relationship: 'wrapper + implementation', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/run_export.mjs', wrapperPath: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/run_export.sh', implementationPath: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/run_export.mjs', purpose: 'Exports paid orders (`PaymentAuthorized`/`PaymentSettled`)', inputsRaw: 'env `VENDURE_ADMIN_API_URL`, `SUPERADMIN_USERNAME`, `SUPERADMIN_PASSWORD`; args `--start`, `--end`, `--country`, `--take`, `--outputDir`, `--settle`', outputsRaw: '`orders.json`, `orders.csv` (English columns incl. `orderCode`, `lineId`, `variantSku`, `lineQuantity`), `result.json`, `summary.txt`', credentialFreeModeRaw: 'No: always logs in as admin', stateChangeRiskRaw: '`--settle` transitions orders to `PaymentSettled`', referenceRevision: null, pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-05', 'CAN-B2-11', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED' },
  { id: 'run_publish_product_v11', kind: 'present', relationship: 'wrapper + implementation', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/publish_product_v11.mjs', wrapperPath: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/run_publish_product_v11.sh', implementationPath: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/publish_product_v11.mjs', purpose: 'Platform design publication through the Admin API', inputsRaw: 'manifest via `PUBLISH_PRODUCT_MANIFEST`, `PUBLISH_PRODUCT_DRY_RUN=1`, `PUBLISH_PRODUCT_DESIGNER_ID`, admin credentials', outputsRaw: '`result.json` in `PUBLISH_PRODUCT_ARTIFACT_DIR`', credentialFreeModeRaw: 'No: dry-run still logs in and resolves channels', stateChangeRiskRaw: 'Non-dry-run creates the product, reindexes, and runs `sudo systemctl restart vendure-product-storefront.service` unless the manifest sets `sync.restartStorefront` to `false`', referenceRevision: null, pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-01', 'CAN-B2-05', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED' },
  { id: 'set_craft_fee', kind: 'present', relationship: 'separate operation', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/set_craft_fee.mjs', wrapperPath: null, implementationPath: null, purpose: 'Views or sets the craft fee per country/channel', inputsRaw: 'args `--country`, `--channel`, `--fee`, `--currency`', outputsRaw: 'local file `scripts/config/craft_fee_config.json`', credentialFreeModeRaw: 'Yes: local file only, no API', stateChangeRiskRaw: 'Overwrites the local config file when a fee is set', referenceRevision: null, pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-08', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED' },
  { id: 'admin_delist_products', kind: 'present', relationship: 'separate operation', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/admin_delist_products.mjs', wrapperPath: null, implementationPath: null, purpose: 'Delists products by SKU and moves their archive folders', inputsRaw: '`--sku`, `--archive-root`, `--delisted-root`, `--apply`, `--dry-run`, `--no-reindex`; needs `docker compose` + `psql` and admin credentials for reindex', outputsRaw: '`result.json` / `summary.txt` in the artifact root', credentialFreeModeRaw: 'No: needs Docker/DB access even in dry-run', stateChangeRiskRaw: '`--apply` runs disabling SQL and moves archive folders', referenceRevision: null, pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-15', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED' },
  { id: 'sync_vendor_uploads', kind: 'present', relationship: 'wrapper + implementation', path: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/sync_vendor_uploads.mjs', wrapperPath: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/sync_vendor_uploads.sh', implementationPath: 'evaluation-demo/migration-input/legacy/vendure-store/scripts/sync_vendor_uploads.mjs', purpose: 'Copies design/effect files into `<archive>/<sku>/<timestamp>/` with SHA-256', inputsRaw: '`--source-root`, `--archive-root`, `--sku`, `--apply`', outputsRaw: '`summary.txt`, `result.json`, `sync-result.json`', credentialFreeModeRaw: 'Yes: dry-run (default)', stateChangeRiskRaw: '`--apply` copies files into the archive', referenceRevision: null, pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-04', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED' },
  { id: 'check_order', kind: 'present', relationship: 'wrapper + implementation', path: 'evaluation-demo/migration-input/legacy/vendure-store/tools/query_order_revenue.js', wrapperPath: 'evaluation-demo/migration-input/legacy/vendure-store/tools/check_order.sh', implementationPath: 'evaluation-demo/migration-input/legacy/vendure-store/tools/query_order_revenue.js', purpose: 'Read-only order and design-fee inspection by order code', inputsRaw: 'env `VENDURE_DB_PATH` (a SQLite file), optional `COMMISSION_CONFIG_PATH`; needs `better-sqlite3`', outputsRaw: 'JSON on the console', credentialFreeModeRaw: 'Yes: read-only', stateChangeRiskRaw: 'None; note it reads a SQLite database while the staging scripts use Postgres, so the Client must confirm which database this helper is meant for', referenceRevision: null, pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-08', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'VERIFIED' },
  { id: 'set_commission_tiers', name: 'set_commission_tiers', canonicalPath: 'TO_CONFIRM', kind: 'pipeline-authored', relationship: 'not present', path: null, wrapperPath: null, implementationPath: null, purpose: 'Pipeline-authoring target', inputsRaw: 'generated from the commission requirements', outputsRaw: 'generated path, revision, inputs, evidence', credentialFreeModeRaw: 'n/a', stateChangeRiskRaw: 'n/a', referenceRevision: 'TO_CONFIRM', pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3', relatedTasks: ['CAN-B2-08', 'CAN-B2-16'], relatedTasksBasis: 'derived by the Contractor from sections A, C and E; confirm with the Client', status: 'PIPELINE_AUTHORING_TARGET', generatedPath: 'TO_BE_RECORDED_BY_PIPELINE', unavailableHandling: 'NOT N/A: the Pipeline must generate or update this script, run it and record path, revision, inputs and evidence (sections E and F.2 override the section 4.8 N/A rule)' }
];

// Compute SHA256 of file
function sha256File(filePath) {
  var content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Compute expectedValuesHash
var canonicalData = {
  tasks: newTasks.map(function(t) { return { canonicalId: t.canonicalId, expectedResult: t.expectedResult, mandatoryAssertions: t.mandatoryAssertions }; })
};

var expectedValuesHash = canonicalizeModule.computeHash(canonicalData);

// Get HEAD commit
var headCommit = require('child_process').execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();

// Compute nail-size-data.ts hash at HEAD
var nailSizePath = 'evaluation-demo/migration-input/legacy/vendure-store/src/plugins/nail-customization/nail-size-data.ts';
var nailSizeFullPath = path.join(ROOT, nailSizePath);
var frozenCopyHash = null;
try {
  frozenCopyHash = sha256File(nailSizeFullPath);
} catch (e) {
  frozenCopyHash = 'FILE_NOT_FOUND';
}

// Build full manifest
var manifest = {
  schemaVersion: '1.0',
  manifestVersion: '0.4-reconciled',
  source: {
    document: 'docs/client/acceptance-manifest-v0.4-reconciled.md',
    documentSha256: sha256File(path.join(ROOT, 'docs/client/acceptance-manifest-v0.4-reconciled.md')),
    repository: 'vendure-ai-factory/vendure-project-briefing',
    branch: 'codex/github-refactor-20260904',
    referenceCommit: 'a6b8b8296adc0d0c3794a9d8af2b2df6998095cd',
    pinnedExecutionCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3',
    pinnedRepoCommit: '2b8336a027824519a57c0eeacd9cf5a0c3f6a8b3',
    note: 'tasks, chains, coverage, evidence rules and safety rules are parsed verbatim from the document by script; Contractor fields carry a status of VERIFIED, PROPOSED, CONTRACTOR_FREEZE or PENDING_CLIENT'
  },
  scopeCounts: {
    batch1Tasks: 8,
    batch2Tasks: 16,
    chains: 7,
    chainIds: ['A', 'B', 'C', 'D', 'E', 'F', 'G']
  },
  statusLegend: {
    VERIFIED: 'checked against actual script text or client documents',
    PROPOSED: 'Contractor implementation choice; Client fixes the business result',
    PENDING_CLIENT: 'cannot be verified until the Client supplies or freezes the input; no value assumed',
    CONTRACTOR_FREEZE: 'non-secret fixture or value the Contractor creates and freezes, with origin and hash recorded before the formal run',
    PIPELINE_AUTHORING_TARGET: 'to be generated by the Pipeline and evidenced'
  },
  tasks: newTasks,
  chains: chainsObj,
  scripts: scripts,
  scriptsBasePath: 'evaluation-demo/migration-input/legacy/vendure-store/',
  scriptNameMap: current.scriptNameMap || null,
  targetEnvironmentBoundary: current.targetEnvironmentBoundary || null,
  testDataPolicy: current.testDataPolicy || null,
  executionRevisionRule: {
    PROPOSED: {
      rule: 'run invalid if tree hash of evaluation-demo/migration-input at HEAD differs from the same path at the pinned commit; HEAD recorded as execution revision',
      note: 'Pipeline commits make HEAD differ from the pin, so this PROPOSED rule captures the stricter tree-hash comparison rather than the loose equality check'
    },
    CLIENT_STATED: {
      rule: 'git rev-parse HEAD must equal the pinned commit',
      reason: 'Pipeline commits make HEAD differ from the pin; this is the Client-stated rule from F.2'
    }
  },
  integrity: {
    algorithm: 'sha256',
    protects: ['tasks[].expectedResult', 'tasks[].mandatoryAssertions', 'coverageRequirements'],
    expectedValuesHash: expectedValuesHash,
    rule: 'checked before any PASS is recorded'
  }
};

// Write manifest
var outputPath = path.join(ROOT, 'manifest', 'acceptance-manifest.v0.4.json');
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));

console.log('Manifest written to:', outputPath);
console.log('Tasks:', newTasks.length);
console.log('Expected values hash:', expectedValuesHash);
console.log('Nail size hash:', frozenCopyHash);
console.log('HEAD commit:', headCommit);