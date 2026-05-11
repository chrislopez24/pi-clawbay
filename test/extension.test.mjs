import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamSimpleGoogle } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
import { createGoogleModelConfig, isGoogleModelId } from '../dist/google-models.js';
import { readCachedModelIds, readCachedModelMetadata } from '../dist/model-cache.js';
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
          return {
            data: [
              {
                id: 'gpt-5.5',
                display_name: 'GPT-5.5',
                supports_reasoning: true,
                supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
                default_reasoning_effort: 'xhigh',
              },
              { id: 'gpt-image-2', display_name: 'GPT Image 2', supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
              {
                id: 'gpt-5.4',
                display_name: 'GPT-5.4',
                supports_reasoning: true,
                supported_reasoning_efforts: ['minimal', 'low', 'medium', 'high'],
                default_reasoning_effort: 'medium',
              },
              {
                id: 'gemini-3-pro-preview',
                display_name: 'Gemini 3 Pro Preview',
                supports_reasoning: false,
                supported_reasoning_efforts: [],
                default_reasoning_effort: null,
              },
            ],
          };
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
  assert.deepEqual(firstRegistrations[1].config.models.map((model) => model.id), [
    'gpt-5.5',
    'gpt-image-2',
    'gpt-5.4',
    'gpt-5.4[1m]',
    'gemini-3-pro-preview',
  ]);
  const liveGpt55 = firstRegistrations[1].config.models.find((entry) => entry.id === 'gpt-5.5');
  assert.equal(liveGpt55?.thinkingLevelMap?.xhigh, 'xhigh', 'gpt-5.5 should expose xhigh from live metadata');
  assert.equal(liveGpt55?.thinkingLevelMap?.minimal, 'low', 'gpt-5.5 should map minimal to low when only low is supported upstream');
  for (const id of ['gpt-5.4', 'gpt-5.4[1m]']) {
    const model = firstRegistrations[1].config.models.find((entry) => entry.id === id);
    assert.equal(model?.thinkingLevelMap?.xhigh, null, `${id} should not expose unsupported xhigh thinking`);
    assert.equal(model?.thinkingLevelMap?.minimal, 'minimal', `${id} should preserve upstream minimal thinking`);
  }
  const liveGemini = firstRegistrations[1].config.models.find((entry) => entry.id === 'gemini-3-pro-preview');
  assert.equal(liveGemini?.api, 'google-generative-ai', 'Gemini models should use Pi\'s native Google transport');
  assert.equal(liveGemini?.baseUrl, 'https://api.theclawbay.com/v1beta', 'Gemini models should use TheClawBay\'s Gemini-compatible base URL');
  assert.equal(liveGemini?.reasoning, true, 'Gemini models should enable Pi native Google thinking when Pi marks the model as compatible');
  assert.deepEqual(
    liveGemini?.thinkingLevelMap,
    { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' },
    'Gemini 3 Pro should expose the same thinking levels as Pi official Google models',
  );
  assert.equal(liveGemini?.contextWindow, 1048576, 'Gemini models should use the native Gemini context window');
  assert.equal(liveGemini?.maxTokens, 65536, 'Gemini models should use the native Gemini output limit');

  const cache = JSON.parse(readFileSync(join(cacheDir, 'models.json'), 'utf8'));
  assert.deepEqual(cache.modelIds, ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]', 'gemini-3-pro-preview']);
  assert.equal(cache.models.find((model) => model.id === 'gemini-3-pro-preview')?.supportsReasoning, false, 'cache should preserve live reasoning metadata');

  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  const secondRegistrations = [];
  extension(createPi(secondRegistrations));
  assert.deepEqual(secondRegistrations[0].config.models.map((model) => model.id), ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]', 'gemini-3-pro-preview']);
  assert.equal(secondRegistrations[0].config.models.find((model) => model.id === 'gemini-3-pro-preview')?.reasoning, true);

  const staleCacheTime = Date.now() + 7 * 60 * 60 * 1000;
  assert.equal(readCachedModelIds(staleCacheTime), null, 'stale cache should be ignored by default');
  assert.deepEqual(
    readCachedModelIds(staleCacheTime, { allowStale: true }),
    ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]', 'gemini-3-pro-preview'],
    'stale cache should be available as a startup fallback',
  );
  assert.equal(
    readCachedModelMetadata(staleCacheTime, { allowStale: true }).find((model) => model.id === 'gemini-3-pro-preview')?.supportsReasoning,
    false,
    'stale startup cache should preserve Gemini metadata',
  );

  writeFileSync(
    join(cacheDir, 'models.json'),
    `${JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), modelIds: ['gemini-3-pro-preview'] })}\n`,
    'utf8',
  );
  assert.deepEqual(readCachedModelIds(Date.now()), ['gemini-3-pro-preview'], 'legacy v1 id-only caches should remain readable');
  const legacyGemini = buildOpenAIModels(readCachedModelIds(Date.now()))[0];
  assert.equal(legacyGemini.reasoning, true, 'legacy cached Gemini ids should still enable Pi native Google thinking for compatible Gemini models');
  assert.deepEqual(
    legacyGemini.thinkingLevelMap,
    { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' },
    'legacy cached Gemini ids should still expose Pi official Gemini 3 Pro thinking levels',
  );
  assert.equal(legacyGemini.api, 'google-generative-ai', 'legacy cached Gemini ids should still use Pi\'s native Google transport');
  assert.equal(legacyGemini.baseUrl, 'https://api.theclawbay.com/v1beta', 'legacy cached Gemini ids should still use the Gemini-compatible base URL');

  assert.deepEqual(
    normalizeOpenAIModelIds(['gpt-5.5', 'gpt-image-2', 'gpt-image-1.5', 'gpt-5.4', 'gemini-3-pro-preview'], { includePinned: true }),
    ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]', 'gemini-3-pro-preview'],
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
      prompt_cache_key: 'session-123',
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
    prompt_cache_key: 'session-123',
  });

  const codexCachePayload = buildTheClawBayPayload(
    { input: [], stream: true, store: false, prompt_cache_key: 'session-456' },
    { messages: [] },
  );
  assert.deepEqual(
    codexCachePayload,
    {
      input: [],
      instructions: undefined,
      include: ['reasoning.encrypted_content'],
      stream: true,
      text: { verbosity: 'medium' },
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      prompt_cache_key: 'session-456',
    },
    'Codex payload transformation should preserve Pi prompt_cache_key and store=false for cache hits/non-storage',
  );

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

  let googleRequest;
  globalThis.fetch = async (url, init) => {
    googleRequest = {
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    if (!String(url).includes('/v1beta/models/gemini-3-pro-preview:streamGenerateContent')) {
      throw new Error(`google models must use native Gemini streaming, got ${url}`);
    }

    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"OK."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };
  assert.equal(isGoogleModelId('gemini-3-pro-preview'), true, 'Gemini ids should be recognized as Google-native models');
  assert.equal(isGoogleModelId('gpt-5.4-mini'), false, 'GPT ids should not be recognized as Google-native models');
  const directGoogleModelConfig = createGoogleModelConfig({
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro Preview',
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(directGoogleModelConfig.api, 'google-generative-ai', 'Google model config should use Pi\'s native Google transport');
  assert.equal(directGoogleModelConfig.baseUrl, 'https://api.theclawbay.com/v1beta', 'Google model config should use TheClawBay /v1beta');
  assert.equal(directGoogleModelConfig.reasoning, true, 'Google model config should enable reasoning for Pi-compatible Gemini models');
  assert.deepEqual(
    directGoogleModelConfig.thinkingLevelMap,
    { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' },
    'Google model config should follow Pi official Gemini 3 Pro thinking levels',
  );
  const gemini25Config = createGoogleModelConfig({
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(gemini25Config.reasoning, true, 'Gemini 2.5 models should use Pi thinkingBudget support');
  assert.equal(gemini25Config.thinkingLevelMap, undefined, 'Gemini 2.5 models should use Pi default thinking levels');
  const gemini3FlashConfig = createGoogleModelConfig({
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash Preview',
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(gemini3FlashConfig.reasoning, true, 'Gemini 3 Flash models should use Pi thinkingLevel support');
  assert.deepEqual(gemini3FlashConfig.thinkingLevelMap, { off: null }, 'Gemini 3 Flash should hide the unsupported off level');
  const gemini15Config = createGoogleModelConfig({
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(gemini15Config.reasoning, false, 'Gemini 1.5 models should remain non-reasoning like Pi official');
  assert.equal(gemini15Config.thinkingLevelMap, undefined, 'non-reasoning Gemini models should not expose thinking levels');
  assert.equal(directGoogleModelConfig.contextWindow, 1048576, 'Google model config should use the Gemini context window');
  assert.equal(directGoogleModelConfig.maxTokens, 65536, 'Google model config should use the Gemini output limit');

  const googleModelConfig = buildOpenAIModels([
    {
      id: 'gemini-3-pro-preview',
      name: 'Gemini 3 Pro Preview',
      supportsReasoning: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    },
  ])[0];
  assert.deepEqual(googleModelConfig, directGoogleModelConfig, 'Generic model builder should delegate Gemini config to the Google module');
  const googleStream = streamSimpleGoogle(
    {
      ...googleModelConfig,
      provider: 'theclawbay',
      api: googleModelConfig.api,
      baseUrl: googleModelConfig.baseUrl,
    },
    { messages: [{ role: 'user', content: 'Respond only OK.', timestamp: 0 }] },
    { apiKey: 'test-key', maxTokens: 16 },
  );
  const googleEvents = [];
  for await (const event of googleStream) {
    googleEvents.push(event);
  }
  const googleDone = googleEvents.find((event) => event.type === 'done');
  assert.equal(googleRequest.url, 'https://api.theclawbay.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse');
  assert.equal(googleRequest.headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(googleRequest.body.contents, [{ parts: [{ text: 'Respond only OK.' }], role: 'user' }]);
  assert.equal(googleRequest.body.generationConfig.maxOutputTokens, 16);
  assert.deepEqual(
    googleRequest.body.generationConfig.thinkingConfig,
    { thinkingLevel: 'LOW' },
    'Gemini 3 Pro without explicit reasoning should still send Pi\'s hidden lowest supported thinking config',
  );
  assert.ok(googleDone, 'Gemini models discovered from /v1/models should stream successfully through the native Gemini route');
  assert.equal(googleDone.message.provider, 'theclawbay');
  assert.equal(googleDone.message.api, 'google-generative-ai');
  assert.equal(googleDone.message.model, 'gemini-3-pro-preview');
  assert.deepEqual(
    googleDone.message.content.map((block) => ({ type: block.type, text: block.text })),
    [{ type: 'text', text: 'OK.' }],
  );
  assert.deepEqual(googleDone.message.usage, {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  let googleReasoningRequest;
  globalThis.fetch = async (url, init) => {
    googleReasoningRequest = {
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    if (!String(url).includes('/v1beta/models/gemini-3-pro-preview:streamGenerateContent')) {
      throw new Error(`google reasoning models must use native Gemini streaming, got ${url}`);
    }

    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"OK."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };
  const googleReasoningStream = streamSimpleGoogle(
    {
      ...googleModelConfig,
      provider: 'theclawbay',
      api: googleModelConfig.api,
      baseUrl: googleModelConfig.baseUrl,
    },
    { messages: [{ role: 'user', content: 'Respond only OK.', timestamp: 0 }] },
    { apiKey: 'test-key', maxTokens: 16, reasoning: 'high' },
  );
  for await (const _event of googleReasoningStream) {}
  assert.deepEqual(
    googleReasoningRequest.body.generationConfig.thinkingConfig,
    { includeThoughts: true, thinkingLevel: 'HIGH' },
    'Gemini 3 Pro with high reasoning should send Pi\'s Google thinkingLevel config',
  );

  let googleBudgetRequest;
  globalThis.fetch = async (url, init) => {
    googleBudgetRequest = {
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    if (!String(url).includes('/v1beta/models/gemini-2.5-flash:streamGenerateContent')) {
      throw new Error(`Gemini 2.5 models must use native Gemini streaming, got ${url}`);
    }

    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"OK."}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };
  const googleBudgetStream = streamSimpleGoogle(
    {
      ...gemini25Config,
      provider: 'theclawbay',
      api: gemini25Config.api,
      baseUrl: gemini25Config.baseUrl,
    },
    { messages: [{ role: 'user', content: 'Respond only OK.', timestamp: 0 }] },
    { apiKey: 'test-key', maxTokens: 16, reasoning: 'medium' },
  );
  for await (const _event of googleBudgetStream) {}
  assert.deepEqual(
    googleBudgetRequest.body.generationConfig.thinkingConfig,
    { includeThoughts: true, thinkingBudget: 8192 },
    'Gemini 2.5 with medium reasoning should send Pi\'s Google thinkingBudget config',
  );

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
