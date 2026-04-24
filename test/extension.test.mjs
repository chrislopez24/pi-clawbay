import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../dist/index.js';

const cacheDir = mkdtempSync(join(tmpdir(), 'pi-clawbay-test-'));
const originalApiKey = process.env.THECLAWBAY_API_KEY;
const originalCacheDir = process.env.PI_CLAWBAY_CACHE_DIR;
const originalFetch = globalThis.fetch;
process.env.PI_CLAWBAY_CACHE_DIR = cacheDir;

function createPi(registrations) {
  return {
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
    registerCommand() {},
  };
}

async function waitForRefresh() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

try {
  process.env.THECLAWBAY_API_KEY = 'test-key';
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return {
        ok: true,
        async json() {
          return { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }] };
        },
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const firstRegistrations = [];
  const firstResult = extension(createPi(firstRegistrations));
  assert.equal(firstResult, undefined, 'extension factory should register synchronously');
  assert.equal(firstRegistrations.length, 1, 'provider should register immediately before live discovery resolves');
  assert.ok(firstRegistrations[0].config.models.map((model) => model.id).includes('gpt-5.5'));

  await waitForRefresh();
  assert.equal(firstRegistrations.length, 2, 'live refresh should re-register after discovery');
  assert.deepEqual(firstRegistrations[1].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']);

  const cache = JSON.parse(readFileSync(join(cacheDir, 'models.json'), 'utf8'));
  assert.deepEqual(cache.modelIds, ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']);

  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  const secondRegistrations = [];
  extension(createPi(secondRegistrations));
  assert.deepEqual(secondRegistrations[0].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']);
} finally {
  if (originalApiKey === undefined) {
    delete process.env.THECLAWBAY_API_KEY;
  } else {
    process.env.THECLAWBAY_API_KEY = originalApiKey;
  }

  if (originalCacheDir === undefined) {
    delete process.env.PI_CLAWBAY_CACHE_DIR;
  } else {
    process.env.PI_CLAWBAY_CACHE_DIR = originalCacheDir;
  }

  globalThis.fetch = originalFetch;
  rmSync(cacheDir, { recursive: true, force: true });
}
