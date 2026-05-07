import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../dist/index.js';

const cacheDir = mkdtempSync(join(tmpdir(), 'pi-clawbay-test-'));
const originalApiKey = process.env.THECLAWBAY_API_KEY;
const originalCacheDir = process.env.PI_CLAWBAY_CACHE_DIR;
const originalImageGeneration = process.env.PI_CLAWBAY_IMAGE_GENERATION;
const originalGeneratedImagesDir = process.env.PI_CLAWBAY_GENERATED_IMAGES_DIR;
const originalFetch = globalThis.fetch;
process.env.PI_CLAWBAY_CACHE_DIR = cacheDir;
process.env.PI_CLAWBAY_GENERATED_IMAGES_DIR = join(cacheDir, 'generated_images');

function createPi(registrations, commands = {}) {
  return {
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
    registerCommand(name, config) {
      commands[name] = config;
    },
  };
}

async function waitForRefresh() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createStalePi(registrations) {
  return {
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
    registerCommand() {},
  };
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
  const fallbackGpt55 = firstRegistrations[0].config.models.find((model) => model.id === 'gpt-5.5');
  assert.ok(fallbackGpt55, 'fallback models should include gpt-5.5');
  assert.equal(fallbackGpt55.contextWindow, 272000, 'gpt-5.5 should use the default 272k Codex context window');
  assert.equal(fallbackGpt55.thinkingLevelMap?.xhigh, 'xhigh', 'gpt-5.5 should explicitly expose xhigh thinking');
  assert.equal(fallbackGpt55.thinkingLevelMap?.minimal, 'low', 'gpt-5.5 should map minimal thinking to low like Pi 0.73 Codex');
  const fallbackImage15 = firstRegistrations[0].config.models.find((model) => model.id === 'gpt-image-1.5');
  const fallbackImage2 = firstRegistrations[0].config.models.find((model) => model.id === 'gpt-image-2');
  const invalidFallbackImage20 = firstRegistrations[0].config.models.find((model) => model.id === 'gpt-image-2.0');
  assert.equal(fallbackImage15, undefined, 'chat provider model list should not expose gpt-image-1.5 as selectable chat model');
  assert.equal(fallbackImage2, undefined, 'chat provider model list should not expose gpt-image-2 as selectable chat model');
  assert.equal(invalidFallbackImage20, undefined, 'fallback models should not include invalid gpt-image-2.0');
  assert.equal(firstRegistrations[0].config.baseUrl, 'https://api.theclawbay.com/backend-api/codex');
  assert.equal(firstRegistrations[0].config.api, 'theclawbay-codex-responses');
  assert.equal(typeof firstRegistrations[0].config.streamSimple, 'function');

  await waitForRefresh();
  assert.equal(firstRegistrations.length, 2, 'live refresh should re-register after discovery');
  assert.deepEqual(firstRegistrations[1].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']);
  for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']) {
    const model = firstRegistrations[1].config.models.find((entry) => entry.id === id);
    assert.equal(model?.thinkingLevelMap?.xhigh, 'xhigh', `${id} should explicitly expose xhigh thinking`);
    assert.equal(model?.thinkingLevelMap?.minimal, 'low', `${id} should map minimal thinking to low`);
  }

  const cache = JSON.parse(readFileSync(join(cacheDir, 'models.json'), 'utf8'));
  assert.deepEqual(cache.modelIds, ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']);

  const streamPayloads = [];
  const streamHeaders = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      streamHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      streamPayloads.push(JSON.parse(init?.body));
      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-test"}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp-test","output":[],"usage":{"input_tokens":0,"output_tokens":0,"input_tokens_details":{"cached_tokens":0}},"status":"completed"}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const stream = firstRegistrations[1].config.streamSimple(
    {
      ...firstRegistrations[1].config.models.find((model) => model.id === 'gpt-5.4[1m]'),
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    },
    { apiKey: 'test-key', sessionId: 'session-123' }
  );
  await stream.result();
  assert.equal(streamPayloads.length, 1, 'stream transport should issue one HTTP Responses request');
  assert.equal(streamPayloads[0].model, 'gpt-5.4', '1m variant should remap to upstream gpt-5.4');
  assert.equal(streamPayloads[0].instructions, 'system prompt');
  assert.equal(streamPayloads[0].prompt_cache_key, 'session-123');
  assert.equal(streamPayloads[0].store, false);
  assert.equal(streamPayloads[0].input.some((entry) => entry.role === 'system' || entry.role === 'developer'), false);
  assert.ok(streamPayloads[0].include.includes('reasoning.encrypted_content'));
  assert.equal(streamHeaders[0].session_id, 'session-123', 'session id should be sent as a request header');
  assert.equal(streamHeaders[0]['chatgpt-account-id'], 'theclawbay');

  process.env.PI_CLAWBAY_IMAGE_GENERATION = 'hosted';
  const imagePayloads = [];
  const imageResult = Buffer.from('fake-png-bytes').toString('base64');
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      imagePayloads.push(JSON.parse(init?.body));
      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-image"}}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"id":"ig_call/one","type":"image_generation_call","status":"in_progress"}}\n\n',
        'event: response.output_item.done\n',
        `data: {"type":"response.output_item.done","item":{"id":"ig_call/one","type":"image_generation_call","status":"completed","revised_prompt":"revised sailboat","result":"${imageResult}"}}\n\n`,
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp-image","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5,"input_tokens_details":{"cached_tokens":0}},"status":"completed"}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const imageStream = firstRegistrations[1].config.streamSimple(
    {
      ...firstRegistrations[1].config.models.find((model) => model.id === 'gpt-5.5'),
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'draw a sailboat' }] }],
    },
    { apiKey: 'test-key', sessionId: 'session/with spaces' }
  );
  const imageMessage = await imageStream.result();
  assert.equal(imagePayloads.length, 1, 'hosted image transport should issue one HTTP Responses request');
  assert.deepEqual(
    imagePayloads[0].tools.find((tool) => tool.type === 'image_generation'),
    { type: 'image_generation', output_format: 'png' },
    'hosted image_generation tool should be sent Codex-style when enabled'
  );
  const generatedImagePath = join(cacheDir, 'generated_images', 'session_with_spaces', 'ig_call_one.png');
  assert.equal(readFileSync(generatedImagePath, 'utf8'), 'fake-png-bytes', 'image_generation_call result should be decoded to disk');
  const imageText = imageMessage.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.match(imageText, /Generated image saved to:/, 'assistant output should mention the saved image path');
  assert.match(imageText, /revised sailboat/, 'assistant output should include the revised prompt');
  process.env.PI_CLAWBAY_IMAGE_GENERATION = 'off';

  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  const secondRegistrations = [];
  extension(createPi(secondRegistrations));
  assert.deepEqual(secondRegistrations[0].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']);

  globalThis.fetch = async () => ({ ok: true, async json() { return { data: [{ id: 'gpt-5.5' }] }; } });
  const staleRegistrations = [];
  const stalePi = createStalePi(staleRegistrations);
  extension(stalePi);
  stalePi.registerProvider = () => {
    throw new Error('stale pi');
  };
  await waitForRefresh();
  assert.equal(staleRegistrations.length, 1, 'stale extension refresh should not crash after initial registration');

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/quota')) {
      return {
        ok: true,
        async json() {
          return {
            usage: {
              fiveHour: { secondsUntilReset: 3599, requestCount: 2, percentUsed: 10 },
              weekly: { secondsUntilReset: 259260, requestCount: 12, percentUsed: 20 },
            },
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };
  const commands = {};
  extension(createPi([], commands));
  const notifications = [];
  await commands.quota.handler([], {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(notifications, [
    {
      message: '5h: 10% • 2 req • resets 0h 59m | Week: 20% • 12 req • resets 3d 0h 1m',
      level: 'info',
    },
  ]);
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

  if (originalImageGeneration === undefined) {
    delete process.env.PI_CLAWBAY_IMAGE_GENERATION;
  } else {
    process.env.PI_CLAWBAY_IMAGE_GENERATION = originalImageGeneration;
  }

  if (originalGeneratedImagesDir === undefined) {
    delete process.env.PI_CLAWBAY_GENERATED_IMAGES_DIR;
  } else {
    process.env.PI_CLAWBAY_GENERATED_IMAGES_DIR = originalGeneratedImagesDir;
  }

  globalThis.fetch = originalFetch;
  rmSync(cacheDir, { recursive: true, force: true });
}
