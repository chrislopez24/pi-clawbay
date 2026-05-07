import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
          return { data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }, { id: 'gpt-image-2.0' }] };
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
  assert.ok(fallbackImage15, 'provider model list should expose gpt-image-1.5 through the direct Images API transport');
  assert.ok(fallbackImage2, 'provider model list should expose gpt-image-2 through the direct Images API transport');
  assert.equal(fallbackImage15.reasoning, false, 'image API models should not be treated as reasoning chat models');
  assert.equal(fallbackImage2.reasoning, false, 'image API models should not be treated as reasoning chat models');
  assert.equal(invalidFallbackImage20, undefined, 'fallback models should not include invalid gpt-image-2.0');
  assert.equal(firstRegistrations[0].config.baseUrl, 'https://api.theclawbay.com/backend-api/codex');
  assert.equal(firstRegistrations[0].config.api, 'theclawbay-codex-responses');
  assert.equal(typeof firstRegistrations[0].config.streamSimple, 'function');

  await waitForRefresh();
  assert.equal(firstRegistrations.length, 2, 'live refresh should re-register after discovery');
  assert.deepEqual(firstRegistrations[1].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]', 'gpt-image-2', 'gpt-image-1.5']);
  assert.equal(
    firstRegistrations[1].config.models.find((model) => model.id === 'gpt-image-2.0'),
    undefined,
    'live discovery should not expose invalid gpt-image-2.0 as an image model'
  );
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
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"id":"msg-test","type":"message","status":"in_progress","content":[]}}\n\n',
        'event: response.content_part.added\n',
        'data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","delta":"Normal text response"}\n\n',
        'event: response.output_text.done\n',
        'data: {"type":"response.output_text.done","text":"Normal text response"}\n\n',
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","item":{"id":"msg-test","type":"message","status":"completed","content":[{"type":"output_text","text":"Normal text response"}]}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp-test","output":[],"usage":{"input_tokens":1,"output_tokens":3,"total_tokens":4,"input_tokens_details":{"cached_tokens":0}},"status":"completed"}}\n\n',
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
  const normalTextMessage = await stream.result();
  assert.equal(streamPayloads.length, 1, 'stream transport should issue one HTTP Responses request');
  assert.equal(streamPayloads[0].model, 'gpt-5.4', '1m variant should remap to upstream gpt-5.4');
  assert.equal(streamPayloads[0].instructions, 'system prompt');
  assert.equal(streamPayloads[0].prompt_cache_key, 'session-123');
  assert.equal(streamPayloads[0].store, false);
  assert.equal(streamPayloads[0].input.some((entry) => entry.role === 'system' || entry.role === 'developer'), false);
  assert.ok(streamPayloads[0].include.includes('reasoning.encrypted_content'));
  assert.deepEqual(
    streamPayloads[0].tools.find((tool) => tool.type === 'image_generation'),
    { type: 'image_generation', output_format: 'png' },
    'Codex-style transport should expose hosted image_generation as a model tool even for ordinary text requests'
  );
  assert.equal(streamHeaders[0].session_id, 'session-123', 'session id should be sent as a request header');
  assert.equal(streamHeaders[0]['chatgpt-account-id'], 'theclawbay');
  assert.equal(normalTextMessage.stopReason, 'stop', 'ordinary text requests should complete normally');
  assert.equal(
    normalTextMessage.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
    'Normal text response',
    'ordinary text requests on text models should return assistant text, not direct image output'
  );

  const toolCallPayloads = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      toolCallPayloads.push(JSON.parse(init?.body));
      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-tool"}}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"id":"fc-one","type":"function_call","call_id":"call-one","name":"read_file","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\n',
        'data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"README.md\\"}"}\n\n',
        'event: response.function_call_arguments.done\n',
        'data: {"type":"response.function_call_arguments.done","arguments":"{\\"path\\":\\"README.md\\"}"}\n\n',
        'event: response.output_item.done\n',
        'data: {"type":"response.output_item.done","item":{"id":"fc-one","type":"function_call","call_id":"call-one","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp-tool","output":[],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6,"input_tokens_details":{"cached_tokens":0}},"status":"completed"}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`text model tool-call flow should not use ${url}`);
  };
  const toolCallStream = firstRegistrations[1].config.streamSimple(
    {
      ...firstRegistrations[1].config.models.find((model) => model.id === 'gpt-5.5'),
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read README.md' }] }],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    },
    { apiKey: 'test-key', sessionId: 'session-tool-call' }
  );
  const toolCallMessage = await toolCallStream.result();
  assert.equal(toolCallPayloads.length, 1, 'text model tool-call flow should issue one Responses request');
  assert.equal(toolCallPayloads[0].model, 'gpt-5.5', 'text model tool-call flow should keep the selected text model');
  assert.equal(toolCallMessage.stopReason, 'toolUse', 'text model function calls should still surface as Pi tool use');
  assert.deepEqual(
    toolCallMessage.content.find((block) => block.type === 'toolCall'),
    { type: 'toolCall', id: 'call-one|fc-one', name: 'read_file', arguments: { path: 'README.md' } },
    'text model function calls should be parsed from Codex Responses SSE'
  );

  delete process.env.PI_CLAWBAY_IMAGE_GENERATION;
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
      reasoning: true,
      thinkingLevelMap: { off: 'none', minimal: 'low', xhigh: 'xhigh' },
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'genérame una imagen de un velero' }] }],
    },
    { apiKey: 'test-key', sessionId: 'session/with spaces' }
  );
  const imageMessage = await imageStream.result();
  assert.equal(imagePayloads.length, 1, 'hosted image transport should issue one HTTP Responses request');
  assert.deepEqual(
    imagePayloads[0].tools.find((tool) => tool.type === 'image_generation'),
    { type: 'image_generation', output_format: 'png' },
    'hosted image_generation tool should be sent Codex-style for explicit image-generation requests'
  );
  assert.equal(
    Object.hasOwn(imagePayloads[0], 'reasoning'),
    false,
    'hosted image generation payload should omit default reasoning=none because TheClawBay image service rejects it'
  );
  const generatedImagePath = join(cacheDir, 'generated_images', 'session_with_spaces', 'ig_call_one.png');
  assert.equal(readFileSync(generatedImagePath, 'utf8'), 'fake-png-bytes', 'image_generation_call result should be decoded to disk');
  const imageText = imageMessage.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.match(imageText, /Generated image saved to:/, 'assistant output should mention the saved image path');
  assert.match(imageText, /revised sailboat/, 'assistant output should include the revised prompt');

  process.env.PI_CLAWBAY_IMAGE_GENERATION = 'off';
  const disabledImagePayloads = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      disabledImagePayloads.push(JSON.parse(init?.body));
      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-opt-out"}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp-opt-out","output":[],"usage":{"input_tokens":0,"output_tokens":0,"input_tokens_details":{"cached_tokens":0}},"status":"completed"}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const disabledImageStream = firstRegistrations[1].config.streamSimple(
    {
      ...firstRegistrations[1].config.models.find((model) => model.id === 'gpt-5.5'),
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'generate an image of a red kite' }] }],
    },
    { apiKey: 'test-key', sessionId: 'session-disabled-image' }
  );
  await disabledImageStream.result();
  assert.equal(disabledImagePayloads.length, 1, 'disabled image-generation transport should still issue one HTTP Responses request');
  assert.equal(
    Boolean(disabledImagePayloads[0].tools?.some((tool) => tool.type === 'image_generation')),
    false,
    'PI_CLAWBAY_IMAGE_GENERATION=off should disable automatic hosted image generation'
  );

  const directImagePayloads = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/images/generations')) {
      directImagePayloads.push(JSON.parse(init?.body));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async json() {
          return { data: [{ b64_json: Buffer.from('direct-image-bytes').toString('base64'), revised_prompt: 'direct revised apple' }] };
        },
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const directImageStream = firstRegistrations[1].config.streamSimple(
    {
      ...firstRegistrations[1].config.models.find((model) => model.id === 'gpt-image-2'),
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'A simple red apple on a white background' }] }],
    },
    { apiKey: 'test-key', sessionId: 'session-direct-image' }
  );
  const directImageMessage = await directImageStream.result();
  assert.deepEqual(
    directImagePayloads[0],
    {
      model: 'gpt-image-2',
      prompt: 'A simple red apple on a white background',
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
    },
    'selected gpt-image-* models should use TheClawBay direct Images API payload'
  );
  const directGeneratedImagePath = join(cacheDir, 'generated_images', 'session-direct-image');
  const directImageText = directImageMessage.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.match(
    directImageText,
    new RegExp(directGeneratedImagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'direct image generation response should include the saved image path'
  );
  assert.match(directImageText, /file:\/\//, 'direct image generation response should include a file:// URL');
  assert.match(directImageText, /direct revised apple/, 'direct image generation response should include revised_prompt when present');
  const directFiles = readdirSync(directGeneratedImagePath);
  assert.equal(directFiles.length, 1, 'direct image generation should save one decoded PNG file');
  assert.equal(
    readFileSync(join(directGeneratedImagePath, directFiles[0]), 'utf8'),
    'direct-image-bytes',
    'direct image generation should decode b64_json to disk'
  );

  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause: new Error('socket closed') });
  };
  const directErrorStream = firstRegistrations[1].config.streamSimple(
    {
      ...firstRegistrations[1].config.models.find((model) => model.id === 'gpt-image-1.5'),
      provider: 'theclawbay',
      api: firstRegistrations[1].config.api,
      baseUrl: firstRegistrations[1].config.baseUrl,
    },
    {
      systemPrompt: 'system prompt',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'A simple blue square' }] }],
    },
    { apiKey: 'test-key', sessionId: 'session-direct-image-error' }
  );
  const directErrorMessage = await directErrorStream.result();
  assert.equal(directErrorMessage.stopReason, 'error', 'direct image fetch failures should return an error assistant message');
  assert.match(directErrorMessage.errorMessage, /endpoint=https:\/\/api\.theclawbay\.com\/v1\/images\/generations/);
  assert.match(directErrorMessage.errorMessage, /model=gpt-image-1\.5/);
  assert.match(directErrorMessage.errorMessage, /message=fetch failed/);
  assert.match(directErrorMessage.errorMessage, /cause=socket closed/);

  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  const secondRegistrations = [];
  extension(createPi(secondRegistrations));
  assert.deepEqual(secondRegistrations[0].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]', 'gpt-image-2', 'gpt-image-1.5']);

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
