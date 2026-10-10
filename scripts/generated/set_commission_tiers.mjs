#!/usr/bin/env node
// Pipeline-authored target for CAN-B2-08.
//
// Reads a commission-tier definition JSON (--config=<path>) and validates it
// against the declared schema:
//
//   {
//     "schemaVersion": "1.0",
//     "countries": {
//       "DE": {
//         "currency": "EUR",
//         "origin": "documented",
//         "bands": [
//           { "from": 0,  "to": 3,  "platformSharePct": 0  },
//           { "from": 3,  "to": 7,  "platformSharePct": 20 },
//           { "from": 7,  "to": 20, "platformSharePct": 60 },
//           { "from": 20, "to": 50, "platformSharePct": 80 },
//           { "from": 50, "to": null, "platformSharePct": 90 }
//         ]
//       }
//     }
//   }
//
// Schema rules: one entry per country; each entry carries a currency and a
// non-empty bands array. Bands start at 0, are contiguous (band[i].from is
// exactly band[i-1].to), have no gaps or overlaps, and each platformSharePct
// is 0-100. At most the last band may be open ended (to === null).
//
// Default is dry-run: the resulting tier table is printed and the validated
// config plus boundary checks are written as result.json and summary.txt
// under work/tmp/commission-tiers/<timestamp>/. With --apply the validated
// config is written to scripts/config/commission_tiers.json (a local file;
// no API call). The split computation (computeSplit) is the exact function
// the executor uses to verify every tier boundary.
//
// Output roots respect env overrides so integration tests stay hermetic:
//   COMMISSION_TIERS_ARTIFACT_ROOT  (default <repo>/work/tmp/commission-tiers)
//   COMMISSION_TIERS_CONFIG_PATH    (default <repo>/scripts/config/commission_tiers.json)

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const ARTIFACT_ROOT = process.env.COMMISSION_TIERS_ARTIFACT_ROOT
  ? path.resolve(process.env.COMMISSION_TIERS_ARTIFACT_ROOT)
  : path.join(REPO_ROOT, 'work/tmp/commission-tiers');
const CONFIG_PATH = process.env.COMMISSION_TIERS_CONFIG_PATH
  ? path.resolve(process.env.COMMISSION_TIERS_CONFIG_PATH)
  : path.join(REPO_ROOT, 'scripts/config/commission_tiers.json');

// Boundary epsilon used when deriving "just below / at / just above" amounts.
const BOUNDARY_EPS = 0.01;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a parsed config object against the tier schema.
 * Returns { valid, errors, config } where config is the validated copy.
 */
export function validateConfig(input) {
  const errors = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['config must be an object'], config: null };
  }

  if (input.schemaVersion !== undefined && input.schemaVersion !== '1.0') {
    errors.push('schemaVersion must be "1.0" when present');
  }

  const countries = input.countries;
  if (!countries || typeof countries !== 'object' || Array.isArray(countries)) {
    return { valid: false, errors: ['config.countries must be an object keyed by country code'], config: null };
  }

  const countryCodes = Object.keys(countries);
  if (countryCodes.length === 0) {
    return { valid: false, errors: ['config.countries must not be empty'], config: null };
  }

  const validatedCountries = {};
  const splitAt = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.round(value * 100) / 100;
  };

  for (const code of countryCodes.sort()) {
    const entry = countries[code];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${code}: entry must be an object`);
      continue;
    }

    if (typeof entry.currency !== 'string' || entry.currency.trim().length === 0) {
      errors.push(`${code}: currency is required`);
    }

    const bands = entry.bands;
    if (!Array.isArray(bands) || bands.length === 0) {
      errors.push(`${code}: bands must be a non-empty array`);
      continue;
    }

    let prevTo = null;
    const validatedBands = [];
    let openCount = 0;

    for (let i = 0; i < bands.length; i += 1) {
      const bandIndex = `${code}.bands[${i}]`;
      const band = bands[i];
      if (!band || typeof band !== 'object' || Array.isArray(band)) {
        errors.push(`${bandIndex} must be an object`);
        continue;
      }

      const fromNum = splitAt(band.from);
      const toNum = band.to === null ? null : splitAt(band.to);
      const pctNum = splitAt(band.platformSharePct);

      if (fromNum === null || fromNum < 0) {
        errors.push(`${bandIndex}.from must be a number >= 0`);
      }
      if (band.to !== null && toNum === null) {
        errors.push(`${bandIndex}.to must be a number or null`);
      }
      if (pctNum === null || pctNum < 0 || pctNum > 100) {
        errors.push(`${bandIndex}.platformSharePct must be a number between 0 and 100`);
      }

      if (fromNum !== null && toNum !== null && toNum <= fromNum) {
        errors.push(`${bandIndex}.to must be greater than its from`);
      }

      if (i === 0 && fromNum !== 0) {
        errors.push(`${bandIndex}.from must be 0 in the first band (bands start at 0)`);
      }

      if (i > 0) {
        if (prevTo === null) {
          errors.push(`${bandIndex}: cannot follow an open-ended band`);
        } else if (fromNum !== prevTo) {
          errors.push(`${bandIndex}.from (${fromNum}) is not contiguous with the previous band's to (${prevTo})`);
        }
      }

      if (toNum === null) {
        openCount += 1;
        if (openCount > 1 || i !== bands.length - 1) {
          errors.push(`${bandIndex}: only the final band may be open ended (to === null)`);
        }
      }

      validatedBands.push({
        from: fromNum,
        to: toNum,
        platformSharePct: pctNum
      });
      prevTo = toNum;
    }

    if (errors.length === 0 || true) {
      validatedCountries[code] = {
        currency: typeof entry.currency === 'string' ? entry.currency.trim() : entry.currency,
        origin: typeof entry.origin === 'string' && entry.origin.length > 0 ? entry.origin : null,
        bands: validatedBands
      };
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, config: null };
  }

  const validatedConfig = {
    schemaVersion: input.schemaVersion !== undefined ? input.schemaVersion : '1.0',
    countries: validatedCountries
  };
  return { valid: true, errors: [], config: validatedConfig };
}

// ---------------------------------------------------------------------------
// Split computation (tax already excluded; the platform + designer split)
// ---------------------------------------------------------------------------

/**
 * Resolve the tier that applies to a given amount using half-open ranges:
 * band applies when from <= amount and (to === null or amount < to).
 * Returns the band or null when no band matches.
 */
export function resolveTier(bands, amount) {
  if (!Array.isArray(bands)) return null;
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return null;
  for (const band of bands) {
    if (band.from === null) continue;
    if (value >= band.from && (band.to === null || value < band.to)) {
      return band;
    }
    if (band.to === null) return band;
  }
  return null;
}

/**
 * Round a money value half-up to 2 decimal places (deterministic).
 */
export function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Compute the platform/designer split for an amount, tax already excluded.
 *
 * Returns:
 *   {
 *     amount,          // the input amount
 *     platformSharePct,// the platform percentage of the matched tier
 *     designerSharePct,// 100 - platformSharePct
 *     platform,        // amount * platformSharePct / 100 (rounded)
 *     designer         // amount - platform (rounded)
 *   }
 * Throws when no tier matches the amount (validation error upstream).
 */
export function computeSplit(bands, amount) {
  const tier = resolveTier(bands, amount);
  if (!tier) {
    throw new Error('no tier matches amount ' + amount);
  }
  const platform = roundMoney(amount * tier.platformSharePct / 100);
  const designer = roundMoney(amount - platform);
  return {
    amount,
    platformSharePct: tier.platformSharePct,
    designerSharePct: roundMoney(100 - tier.platformSharePct),
    platform,
    designer
  };
}

// ---------------------------------------------------------------------------
// Boundary checks (just below / at / just above every band limit)
// ---------------------------------------------------------------------------

/**
 * Build the deterministic set of boundary amounts for one country's bands.
 * For every limit (each band's from value, and each non-null to value) the
 * amounts [limit - eps, limit, limit + eps] are produced, dropping the
 * negative amount when a limit is 0. Limits derived from the same numeric
 * point are de-duplicated. Returns a sorted array of amounts.
 */
export function boundaryAmounts(bands) {
  const limits = [];
  for (const band of bands) {
    if (band.from !== null) limits.push(band.from);
    if (band.to !== null) limits.push(band.to);
  }
  const unique = [...new Set(limits)].sort((a, b) => a - b);
  const amounts = new Set();
  for (const limit of unique) {
    for (const delta of [-BOUNDARY_EPS, 0, BOUNDARY_EPS]) {
      const amount = roundMoney(limit + delta);
      if (amount < 0) continue;
      amounts.add(amount);
    }
  }
  return [...amounts].sort((a, b) => a - b);
}

/**
 * For every country, resolve each boundary amount to its split via
 * computeSplit. Returns { [country]: [ { amount, platformSharePct,
 * designerSharePct, platform, designer, from, to }, ... ] }.
 */
export function buildBoundaryChecks(config) {
  const checks = {};
  const countries = config.countries;
  for (const code of Object.keys(countries).sort()) {
    const bands = countries[code].bands;
    const amounts = boundaryAmounts(bands);
    checks[code] = amounts.map((amount) => {
      const tier = resolveTier(bands, amount);
      const split = computeSplit(bands, amount);
      return {
        amount,
        from: tier.from,
        to: tier.to,
        platformSharePct: tier.platformSharePct,
        platform: split.platform,
        designer: split.designer
      };
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderTable(config) {
  const lines = ['Commission tier configuration (dry-run)', ''];
  const codes = Object.keys(config.countries).sort();
  for (const code of codes) {
    const entry = config.countries[code];
    const origin = entry.origin ? ' [' + entry.origin + ']' : '';
    lines.push(`${code} (${entry.currency})${origin}:`);
    for (const band of entry.bands) {
      const upper = band.to === null ? '+' : band.to;
      const range = `${band.from} <= x < ${upper}`;
      lines.push(`  ${range.padEnd(16)} platform ${band.platformSharePct}%`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderSummary(config, artifactDir, mode) {
  const lines = [];
  lines.push('set_commission_tiers');
  lines.push('Mode: ' + (mode || 'dry-run'));
  lines.push('Result: ' + (mode === 'apply' ? 'config written' : 'boundary checks computed'));
  lines.push('Countries: ' + Object.keys(config.countries).length);
  lines.push('Artifact dir: ' + artifactDir);
  lines.push('');
  const codes = Object.keys(config.countries).sort();
  for (const code of codes) {
    const entry = config.countries[code];
    lines.push(`${code} (${entry.currency})${entry.origin ? ' [' + entry.origin + ']' : ''}:`);
    for (const band of entry.bands) {
      const upper = band.to === null ? '+' : band.to;
      lines.push(`  ${band.from} - ${upper} -> platform ${band.platformSharePct}%`);
    }
  }
  return lines.join('\n') + '\n';
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const parsed = { apply: false, config: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.apply = false;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match && match[1] === 'config') {
      parsed.config = match[2];
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.config) {
    throw new Error('Missing required --config=<path> (JSON tier definitions).');
  }

  let rawText;
  try {
    rawText = await readFile(args.config, 'utf8');
  } catch (e) {
    throw new Error('Cannot read config file ' + args.config + ': ' + (e && e.message ? e.message : e));
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error('Config file is not valid JSON: ' + (e && e.message ? e.message : e));
  }

  const result = validateConfig(parsed);
  if (!result.valid) {
    throw new Error('commission tier config invalid:\n  ' + result.errors.join('\n  '));
  }
  const config = result.config;

  if (!args.apply) {
    // Dry-run: print the table and write deterministically-named artifacts.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const artifactDir = path.join(ARTIFACT_ROOT, timestamp);
    await mkdir(artifactDir, { recursive: true });

    const boundaryChecks = buildBoundaryChecks(config);
    const resultJson = {
      schemaVersion: '1.0',
      mode: 'dry-run',
      timestamp,
      outputDir: artifactDir,
      configSha256: sha256Text(JSON.stringify(config, null, 2) + '\n'),
      config,
      boundaryChecks
    };
    const summary = renderSummary(config, artifactDir, 'dry-run');

    await writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(resultJson, null, 2) + '\n', 'utf8');
    await writeFile(path.join(artifactDir, 'summary.txt'), summary, 'utf8');

    process.stdout.write(renderTable(config) + '\n');
    process.stdout.write('\nArtifacts written to ' + artifactDir + '\n');
    return;
  }

  // --apply: write ONLY the validated config file (local file, no API).
  const configText = JSON.stringify(config, null, 2) + '\n';
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, configText, 'utf8');
  process.stdout.write(renderTable(config) + '\n');
  process.stdout.write('\nCommission tier config written to ' + CONFIG_PATH + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write('set_commission_tiers failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(1);
  });
}
