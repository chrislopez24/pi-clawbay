import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../dist/index.js';
import { readCachedModelIds } from '../dist/model-cache.js';
import { buildOpenAIModels, normalizeOpenAIModelIds } from '../dist/models.js';
import {
  buildTheClawBayHeaders,
  buildTheClawBayPayload,
  createTheClawBayStreamContext,
  createTheClawBayStreamModel,
  restoreTheClawBayEventProvider,
  streamSimpleTheClawBayCodexResponses,
} from '../dist/transport.js';

const cacheDir = mkdtempSync(join(tmpdir(), 'pi-clawbay-test-'));
const imageDir = mkdtempSync(join(tmpdir(), 'pi-clawbay-images-'));
const originalApiKey = process.env.THECLAWBAY_API_KEY;
const originalCacheDir = process.env.PI_CLAWBAY_CACHE_DIR;
const originalImageDir = process.env.PI_CLAWBAY_IMAGE_DIR;
const originalImageMaxRetries = process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES;
const originalAllowPartial = process.env.PI_CLAWBAY_IMAGE_ALLOW_PARTIAL;
const originalFetch = globalThis.fetch;
process.env.PI_CLAWBAY_CACHE_DIR = cacheDir;
process.env.PI_CLAWBAY_IMAGE_DIR = imageDir;

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
          return { data: [{ id: 'gpt-5.5' }, { id: 'gpt-image-2' }, { id: 'gpt-5.4' }] };
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
  assert.ok(firstRegistrations[0].config.models.some((model) => model.id === 'gpt-image-2'), 'fallback models should include supported gpt-image-2');
  assert.equal(firstRegistrations[0].config.models.some((model) => model.id === 'gpt-image-1.5'), false, 'unsupported native image models should stay hidden from fallback model selection');

  await waitForRefresh();
  assert.equal(firstRegistrations.length, 2, 'live refresh should re-register after discovery');
  assert.deepEqual(firstRegistrations[1].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]']);
  for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4[1m]']) {
    const model = firstRegistrations[1].config.models.find((entry) => entry.id === id);
    assert.equal(model?.thinkingLevelMap?.xhigh, 'xhigh', `${id} should explicitly expose xhigh thinking`);
    assert.equal(model?.thinkingLevelMap?.minimal, 'low', `${id} should map minimal thinking to low`);
  }

  const cache = JSON.parse(readFileSync(join(cacheDir, 'models.json'), 'utf8'));
  assert.deepEqual(cache.modelIds, ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]']);

  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  const secondRegistrations = [];
  extension(createPi(secondRegistrations));
  assert.deepEqual(secondRegistrations[0].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]']);

  const staleCacheTime = Date.now() + 7 * 60 * 60 * 1000;
  assert.equal(readCachedModelIds(staleCacheTime), null, 'stale cache should be ignored by default');
  assert.deepEqual(readCachedModelIds(staleCacheTime, { allowStale: true }), ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]'], 'stale cache should be available as a startup fallback');

  assert.deepEqual(
    normalizeOpenAIModelIds(['gpt-5.5', 'gpt-image-2', 'gpt-image-1.5', 'gpt-5.4'], { includePinned: true }),
    ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]'],
    'gpt-image-2 should be exposed while unsupported native image models stay hidden',
  );

  const gptImage2 = buildOpenAIModels(['gpt-image-2'])[0];
  assert.equal(gptImage2.name, 'GPT Image 2');
  assert.deepEqual(gptImage2.cost, { input: 5, output: 30, cacheRead: 2, cacheWrite: 5 });
  assert.equal(gptImage2.contextWindow, 272000);
  assert.equal(gptImage2.maxTokens, 65536);

  globalThis.fetch = async () => ({ ok: true, async json() { return { data: [{ id: 'gpt-5.5' }] }; } });
  const staleRegistrations = [];
  const stalePi = createStalePi(staleRegistrations);
  extension(stalePi);
  stalePi.registerProvider = () => {
    throw new Error('stale pi');
  };
  await waitForRefresh();
  assert.equal(staleRegistrations.length, 1, 'stale extension refresh should not crash after initial registration');

  globalThis.fetch = async () => ({ ok: true, async json() { return { data: [{ id: 'gpt-5.4-mini' }] }; } });
  const refreshCommands = {};
  const refreshRegistrations = [];
  extension(createPi(refreshRegistrations, refreshCommands));
  await waitForRefresh();
  refreshRegistrations.length = 0;
  const refreshNotifications = [];
  assert.ok(refreshCommands['clawbay-refresh-models'], 'model refresh command should be registered');
  await refreshCommands['clawbay-refresh-models'].handler('', {
    ui: {
      notify(message, level) {
        refreshNotifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(refreshRegistrations.map((entry) => entry.config.models.map((model) => model.id)), [['gpt-5.4-mini']]);
  assert.deepEqual(refreshNotifications, [{ message: 'Refreshed 1 TheClawBay model from live discovery', level: 'info' }]);

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/quota')) {
      return {
        ok: true,
        async json() {
          return {
            usageLimitPresentation: 'Weekly usage is high',
            anyLimitReached: true,
            usage: {
              fiveHour: { secondsUntilReset: 3599, requestCount: 2, percentUsed: 10 },
              weekly: { secondsUntilReset: 259260, requestCount: 12, percentUsed: 20, limitReached: true },
            },
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };
  const commands = {};
  extension(createPi([], commands));
  assert.ok(commands.quota, 'quota command should be registered');
  assert.ok(commands['clawbay-quota'], 'namespaced quota command alias should be registered');
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
      message: 'Weekly usage is high | 5h: 10% • 2 req • resets 0h 59m | Week: 20% • 12 req • resets 3d 0h 1m',
      level: 'warning',
    },
  ]);

  const headers = buildTheClawBayHeaders({ headers: { existing: '1' }, sessionId: 'session-123' });
  assert.deepEqual(headers, {
    existing: '1',
    'chatgpt-account-id': 'theclawbay',
    originator: 'pi',
    'OpenAI-Beta': 'responses=experimental',
    session_id: 'session-123',
  });

  const payload = buildTheClawBayPayload(
    {
      input: [
        { role: 'developer', content: 'drop me' },
        { role: 'user', content: 'keep me' },
      ],
      include: ['existing', 'reasoning.encrypted_content'],
      text: { verbosity: 'low' },
      tool_choice: 'none',
      parallel_tool_calls: false,
      store: true,
    },
    { systemPrompt: 'system from pi', messages: [] },
  );
  assert.deepEqual(payload, {
    input: [{ role: 'user', content: 'keep me' }],
    instructions: 'system from pi',
    include: ['existing', 'reasoning.encrypted_content'],
    text: { verbosity: 'low' },
    tool_choice: 'none',
    parallel_tool_calls: false,
    store: true,
  });

  const streamModel = createTheClawBayStreamModel({
    id: 'gpt-5.4[1m]',
    name: 'GPT-5.4 [1M]',
    provider: 'theclawbay',
    api: 'theclawbay-codex-responses',
    baseUrl: 'https://api.theclawbay.com/backend-api/codex',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxTokens: 128000,
  });
  assert.equal(streamModel.id, 'gpt-5.4', '1m display model should be remapped to the upstream id');
  assert.equal(streamModel.provider, 'openai-codex', 'internal stream model should preserve Codex tool-call IDs');
  assert.equal(streamModel.api, 'openai-responses', 'internal stream model should use the Responses serializer');

  const restored = restoreTheClawBayEventProvider(
    { type: 'done', reason: 'stop', message: { provider: 'openai-codex', api: 'openai-responses', model: 'gpt-5.4' } },
    { provider: 'theclawbay', api: 'theclawbay-codex-responses', id: 'gpt-5.4[1m]' },
  );
  assert.equal(restored.message.provider, 'theclawbay');
  assert.equal(restored.message.api, 'theclawbay-codex-responses');
  assert.equal(restored.message.model, 'gpt-5.4[1m]');

  const oneByOnePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  let imageRequest;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      imageRequest = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-image"}}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","item":{"id":"ig-test","type":"image_generation_call","status":"in_progress"}}\n\n',
        'event: response.image_generation_call.partial_image\n',
        `data: {"type":"response.image_generation_call.partial_image","item_id":"ig-test","partial_image_index":0,"partial_image_b64":"${oneByOnePngBase64}"}\n\n`,
        'event: response.output_item.done\n',
        `data: {"type":"response.output_item.done","item":{"id":"ig-test","type":"image_generation_call","status":"completed","result":"${oneByOnePngBase64}","revised_prompt":"A tiny test PNG."}}\n\n`,
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp-image","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected image fetch ${url}`);
  };
  const imageStream = streamSimpleTheClawBayCodexResponses(
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      provider: 'theclawbay',
      api: 'theclawbay-codex-responses',
      baseUrl: 'https://api.theclawbay.com/backend-api/codex',
      reasoning: false,
      input: ['text'],
      cost: { input: 5, output: 30, cacheRead: 2, cacheWrite: 5 },
      contextWindow: 272000,
      maxTokens: 65536,
    },
    { messages: [{ role: 'user', content: 'Draw a tiny test PNG.', timestamp: 0 }] },
    { apiKey: 'test-key' },
  );
  const imageEvents = [];
  for await (const event of imageStream) {
    imageEvents.push(event);
  }
  assert.deepEqual(
    imageEvents.map((event) => event.type),
    ['start', 'text_start', 'text_delta', 'text_end', 'done'],
    'image generation should emit the standard assistant message event sequence',
  );
  const imageDone = imageEvents.find((event) => event.type === 'done');
  assert.equal(imageRequest.url, 'https://api.theclawbay.com/backend-api/codex/responses');
  assert.equal(imageRequest.body.model, 'gpt-5.5');
  assert.equal(imageRequest.body.input[0].content[0].text, 'Draw a tiny test PNG.');
  assert.equal(imageRequest.body.stream, true);
  assert.deepEqual(
    imageRequest.body.tools[0],
    { type: 'image_generation', model: 'gpt-image-2', output_format: 'png', size: '1024x1024', partial_images: 2 },
    'gpt-image-2 should use the hosted Responses image_generation tool to avoid Images API socket timeouts',
  );
  assert.ok(imageDone, 'image generation stream should finish successfully');
  assert.equal(imageDone.message.provider, 'theclawbay');
  assert.equal(imageDone.message.model, 'gpt-image-2');
  const generatedPath = imageDone.message.content[0].text.match(/`([^`]+\.png)`/)?.[1];
  assert.ok(generatedPath, 'image generation response should include the saved PNG path');
  assert.ok(existsSync(generatedPath), 'image generation should save the decoded PNG to disk');

  const partialImageBase64 = Buffer.from('partial-image-bytes').toString('base64');
  const finalImageBase64 = Buffer.from('final-image-bytes').toString('base64');
  let retryImageAttempts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/responses')) {
      retryImageAttempts += 1;
      if (retryImageAttempts === 1) {
        return new Response([
          'event: response.created\n',
          'data: {"type":"response.created","response":{"id":"resp-image-retry-1"}}\n\n',
          'event: response.output_item.added\n',
          'data: {"type":"response.output_item.added","item":{"id":"ig-retry","type":"image_generation_call","status":"in_progress"}}\n\n',
          'event: response.image_generation_call.partial_image\n',
          `data: {"type":"response.image_generation_call.partial_image","item_id":"ig-retry","partial_image_index":1,"partial_image_b64":"${partialImageBase64}"}\n\n`,
          'event: response.failed\n',
          'data: {"type":"response.failed","response":{"id":"resp-image-retry-1","status":"failed","error":{"message":"temporarily unavailable","type":"server_error","code":"service_unavailable"}}}\n\n',
        ].join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-image-retry-2"}}\n\n',
        'event: response.completed\n',
        `data: {"type":"response.completed","response":{"id":"resp-image-retry-2","status":"completed","output":[{"id":"ig-final","type":"image_generation_call","status":"completed","result":"${finalImageBase64}","revised_prompt":"final revised protagonist"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5,"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected retry image fetch ${url}`);
  };
  const retryImageStream = streamSimpleTheClawBayCodexResponses(
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      provider: 'theclawbay',
      api: 'theclawbay-codex-responses',
      baseUrl: 'https://api.theclawbay.com/backend-api/codex',
      reasoning: false,
      input: ['text'],
      cost: { input: 5, output: 30, cacheRead: 2, cacheWrite: 5 },
      contextWindow: 272000,
      maxTokens: 65536,
    },
    { messages: [{ role: 'user', content: 'Draw a final image after retry.', timestamp: 0 }] },
    { apiKey: 'test-key' },
  );
  const retryImageEvents = [];
  for await (const event of retryImageStream) {
    retryImageEvents.push(event);
  }
  const retryImageDone = retryImageEvents.find((event) => event.type === 'done');
  assert.equal(retryImageAttempts, 2, 'hosted image generation should retry transient response.failed events before saving partials');
  assert.ok(retryImageDone, 'retried image generation stream should finish successfully');
  const retryImageText = retryImageDone.message.content[0].text;
  assert.doesNotMatch(retryImageText, /Saved latest partial/, 'successful retry should save the final image instead of the earlier partial');
  assert.match(retryImageText, /final revised protagonist/, 'final image from response.completed output should preserve revised_prompt');
  const retryGeneratedPath = retryImageText.match(/`([^`]+\.png)`/)?.[1];
  assert.ok(retryGeneratedPath, 'retried image generation should include the saved PNG path');
  assert.equal(readFileSync(retryGeneratedPath, 'utf8'), 'final-image-bytes', 'response.completed output result should be saved as the final image');

  process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES = '0';
  delete process.env.PI_CLAWBAY_IMAGE_ALLOW_PARTIAL;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/responses')) {
      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp-image-partial-only"}}\n\n',
        'event: response.image_generation_call.partial_image\n',
        `data: {"type":"response.image_generation_call.partial_image","item_id":"ig-partial","partial_image_index":0,"partial_image_b64":"${partialImageBase64}"}\n\n`,
        'event: response.failed\n',
        'data: {"type":"response.failed","response":{"id":"resp-image-partial-only","status":"failed","error":{"message":"temporarily unavailable","type":"server_error","code":"service_unavailable"}}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected partial-only image fetch ${url}`);
  };
  const partialOnlyStream = streamSimpleTheClawBayCodexResponses(
    {
      id: 'gpt-image-2',
      name: 'GPT Image 2',
      provider: 'theclawbay',
      api: 'theclawbay-codex-responses',
      baseUrl: 'https://api.theclawbay.com/backend-api/codex',
      reasoning: false,
      input: ['text'],
      cost: { input: 5, output: 30, cacheRead: 2, cacheWrite: 5 },
      contextWindow: 272000,
      maxTokens: 65536,
    },
    { messages: [{ role: 'user', content: 'Draw a partial-only image.', timestamp: 0 }] },
    { apiKey: 'test-key' },
  );
  const partialOnlyEvents = [];
  for await (const event of partialOnlyStream) {
    partialOnlyEvents.push(event);
  }
  const partialOnlyError = partialOnlyEvents.find((event) => event.type === 'error');
  assert.ok(partialOnlyError, 'partial-only hosted image failures should not be reported as successful final images by default');
  assert.match(partialOnlyError.error.errorMessage, /temporarily unavailable/);
  delete process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES;

  const streamContext = createTheClawBayStreamContext(
    {
      messages: [
        {
          role: 'assistant',
          provider: 'theclawbay',
          api: 'theclawbay-codex-responses',
          model: 'gpt-5.4[1m]',
          content: [{ type: 'toolCall', id: 'call_abc|fc_123', name: 'ls', arguments: {} }],
        },
        { role: 'toolResult', toolCallId: 'call_abc|fc_123', toolName: 'ls', content: [{ type: 'text', text: 'ok' }], isError: false },
      ],
    },
    { provider: 'theclawbay', api: 'theclawbay-codex-responses', id: 'gpt-5.4[1m]' },
    streamModel,
  );
  assert.deepEqual(streamContext.messages[0], {
    role: 'assistant',
    provider: 'openai-codex',
    api: 'openai-responses',
    model: 'gpt-5.4',
    content: [{ type: 'toolCall', id: 'call_abc|fc_123', name: 'ls', arguments: {} }],
  });
  assert.equal(streamContext.messages[1].toolCallId, 'call_abc|fc_123', 'tool results should keep the original pipe-separated call id');

  const switchedModelContext = createTheClawBayStreamContext(
    {
      messages: [
        {
          role: 'assistant',
          provider: 'theclawbay',
          api: 'theclawbay-codex-responses',
          model: 'gpt-5.5',
          content: [{ type: 'toolCall', id: 'call_previous|fc_previous', name: 'ls', arguments: {} }],
        },
      ],
    },
    { provider: 'theclawbay', api: 'theclawbay-codex-responses', id: 'gpt-5.4[1m]' },
    streamModel,
  );
  assert.equal(switchedModelContext.messages[0].provider, 'openai-codex');
  assert.equal(switchedModelContext.messages[0].api, 'openai-responses');
  assert.equal(
    switchedModelContext.messages[0].model,
    'gpt-5.5',
    'historical assistant messages should keep their original model so Pi handles cross-model Codex history like the official provider',
  );
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

  if (originalImageDir === undefined) {
    delete process.env.PI_CLAWBAY_IMAGE_DIR;
  } else {
    process.env.PI_CLAWBAY_IMAGE_DIR = originalImageDir;
  }

  if (originalImageMaxRetries === undefined) {
    delete process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES;
  } else {
    process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES = originalImageMaxRetries;
  }

  if (originalAllowPartial === undefined) {
    delete process.env.PI_CLAWBAY_IMAGE_ALLOW_PARTIAL;
  } else {
    process.env.PI_CLAWBAY_IMAGE_ALLOW_PARTIAL = originalAllowPartial;
  }

  globalThis.fetch = originalFetch;
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(imageDir, { recursive: true, force: true });
}
