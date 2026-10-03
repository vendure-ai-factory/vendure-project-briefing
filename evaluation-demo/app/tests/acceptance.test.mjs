import test from 'node:test';
import assert from 'node:assert/strict';
import legacyCatalog from '../fixtures/legacy-catalog.json' with { type: 'json' };
import { migrateCatalog } from '../src/catalog.mjs';

test('migrates the public catalog contract without leaking internal fields', () => {
  const inputSnapshot = structuredClone(legacyCatalog);
  const result = migrateCatalog(legacyCatalog);

  assert.deepEqual(legacyCatalog, inputSnapshot, 'the legacy input must not be mutated');
  assert.deepEqual(result, [
    {
      sku: 'NAIL-001',
      name: 'Soft Pink Almond',
      slug: 'soft-pink-almond',
      price_cents: 1600,
      image_count: 1
    },
    {
      sku: 'NAIL-002',
      name: 'Rose Gold French',
      slug: 'rose-gold-french',
      price_cents: 1850,
      image_count: 2
    }
  ]);

  assert.equal(JSON.stringify(result).includes('internalNote'), false);
});
