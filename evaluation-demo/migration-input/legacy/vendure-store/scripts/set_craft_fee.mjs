#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(SCRIPT_DIR, 'config/craft_fee_config.json');
const DEFAULT_CONFIG = {
  'de-token': { currency: 'EUR', craftFee: 1 },
  'at-token': { currency: 'EUR', craftFee: 1 },
  'hu-token': { currency: 'HUF', craftFee: 5000 },
  'gb-token': { currency: 'GBP', craftFee: 1 },
};

const COUNTRY_TO_CHANNEL = {
  DE: 'de-token',
  AT: 'at-token',
  HU: 'hu-token',
  GB: 'gb-token',
};

const LEGACY_CHANNEL_TO_COUNTRY = {
  'germany-channel': 'DE',
  'austria-channel': 'AT',
  'hungary-channel': 'HU',
};

const COUNTRY_FLAGS = {
  DE: '🇩🇪',
  AT: '🇦🇹',
  HU: '🇭🇺',
  GB: '🇬🇧',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  if (!args.country && !args.channel) {
    printConfig(config);
    printUsage();
    return;
  }

  const target = resolveTarget(args.country || args.channel);
  if (!target) {
    throw new Error(`Unknown country or channel: ${args.country || args.channel}`);
  }

  const current = config[target.channel] || null;
  if (args.fee === undefined) {
    printEntry(target, current);
    return;
  }

  const craftFee = Number(args.fee);
  if (!Number.isFinite(craftFee) || craftFee < 0) {
    throw new Error(`Invalid craft fee: ${args.fee}`);
  }

  const currency = (args.currency || resolveCurrency(target.country)).toUpperCase();
  const nextEntry = { currency, craftFee };
  config[target.channel] = nextEntry;

  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const previous = current ? `${current.craftFee} ${current.currency}` : '<unset>';
  console.log(`Updated ${target.country} (${target.channel}) craft fee: ${previous} -> ${craftFee} ${currency}`);
  printConfig(config);
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    parsed[key] = value;
  }
  return parsed;
}

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  return { ...DEFAULT_CONFIG };
}

function resolveTarget(identifier) {
  if (!identifier) {
    return null;
  }

  const normalizedCountry = String(identifier).toUpperCase();
  if (COUNTRY_TO_CHANNEL[normalizedCountry]) {
    return {
      country: normalizedCountry,
      channel: COUNTRY_TO_CHANNEL[normalizedCountry],
    };
  }

  const normalizedChannel = String(identifier).toLowerCase();
  if (DEFAULT_CONFIG[normalizedChannel]) {
    return {
      country: resolveCountryFromChannel(normalizedChannel),
      channel: normalizedChannel,
    };
  }

  if (LEGACY_CHANNEL_TO_COUNTRY[normalizedChannel]) {
    const country = LEGACY_CHANNEL_TO_COUNTRY[normalizedChannel];
    return {
      country,
      channel: COUNTRY_TO_CHANNEL[country],
    };
  }

  return null;
}

function resolveCountryFromChannel(channel) {
  return Object.entries(COUNTRY_TO_CHANNEL).find(([, mapped]) => mapped === channel)?.[0] || channel.toUpperCase();
}

function resolveCurrency(country) {
  switch (country) {
    case 'HU':
      return 'HUF';
    case 'GB':
      return 'GBP';
    default:
      return 'EUR';
  }
}

function printEntry(target, entry) {
  if (!entry) {
    console.log(`⚠️  ${target.country} (${target.channel}): 未配置`);
    return;
  }
  const flag = COUNTRY_FLAGS[target.country] || '🌍';
  console.log(`${flag} ${target.country} [${target.channel}]: ${entry.craftFee} ${entry.currency}`);
}

function printConfig(config) {
  console.log('\n📋 当前各国制作费配置：');
  console.log('═'.repeat(54));
  const sortedEntries = Object.entries(config).sort(([left], [right]) => left.localeCompare(right));
  for (const [channel, entry] of sortedEntries) {
    const country = resolveCountryFromChannel(channel);
    const flag = COUNTRY_FLAGS[country] || '🌍';
    console.log(`  ${flag} ${country} [${channel}]: ${entry.craftFee} ${entry.currency}`);
  }
  console.log('═'.repeat(54));
}

function printUsage() {
  console.log('\n用法:');
  console.log('  npm run craft-fee');
  console.log('  npm run craft-fee -- --country=DE');
  console.log('  npm run craft-fee -- --country=DE --fee=1');
  console.log('  npm run craft-fee -- --channel=de-token --fee=1.2 --currency=EUR');
  console.log('  国家代码支持 DE / AT / HU / GB，渠道 token 支持 de-token / at-token / hu-token / gb-token');
}

main().catch((error) => {
  console.error(`❌ 执行失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
