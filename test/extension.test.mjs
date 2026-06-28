import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { streamSimpleGoogle } from '@earendil-works/pi-ai';
import { streamSimpleOpenAICompletions } from '@earendil-works/pi-ai/openai-completions';
import {
  normalizeTheClawBayAnthropicSystemPrompt,
  streamSimpleTheClawBayAnthropicMessages,
} from '../dist/anthropic-transport.js';
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
import { normalizeTheClawBayContextOverflow } from '../dist/overflow.js';

const cacheDir = mkdtempSync(join(tmpdir(), 'pi-clawbay-test-'));
const imageDir = mkdtempSync(join(tmpdir(), 'pi-clawbay-images-'));
const originalApiKey = process.env.THECLAWBAY_API_KEY;
const originalCacheDir = process.env.PI_CLAWBAY_CACHE_DIR;
const originalImageDir = process.env.PI_CLAWBAY_IMAGE_DIR;
const originalImageMaxRetries = process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES;
const originalAnthropicTimeout = process.env.PI_CLAWBAY_ANTHROPIC_TIMEOUT_MS;
const originalFetch = globalThis.fetch;
process.env.PI_CLAWBAY_CACHE_DIR = cacheDir;
process.env.PI_CLAWBAY_IMAGE_DIR = imageDir;
delete process.env.PI_CLAWBAY_ANTHROPIC_TIMEOUT_MS;
const THECLAWBAY_ANTHROPIC_API = 'theclawbay-anthropic-messages';
const PI_DOCS_HEADER =
  'Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):';
const PI_DOCS_LOOKUP_LINE =
  '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)';

const LIVE_MODEL_IDS = [
  'gpt-5.5',
  'gpt-image-2',
  'gpt-5.4',
  'gpt-5.4[1m]',
  'deepseek-v4-flash',
  'gemini-3-pro-preview',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'glm-5.2',
  'glm-5.1',
  'mimo-v2.5-pro',
  'claude-haiku-4-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
];

const LIVE_OPENAI_MODEL_DATA = [
  {
    id: 'gpt-5.5',
    display_name: 'GPT-5.5',
    context_window: 384000,
    supports_reasoning: true,
    supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    default_reasoning_effort: 'xhigh',
  },
  { id: 'gpt-image-2', display_name: 'GPT Image 2', supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  {
    id: 'gpt-5.4',
    display_name: 'GPT-5.4',
    context_window: 272000,
    supports_reasoning: true,
    supported_reasoning_efforts: ['minimal', 'low', 'medium', 'high'],
    default_reasoning_effort: 'medium',
  },
  {
    id: 'deepseek-v4-flash',
    display_name: 'DeepSeek V4 Flash',
    context_window: 164000,
    supports_reasoning: false,
    supported_reasoning_efforts: [],
    default_reasoning_effort: null,
  },
  {
    id: 'gemini-3-pro-preview',
    display_name: 'Gemini 3 Pro Preview',
    supports_reasoning: false,
    supported_reasoning_efforts: [],
    default_reasoning_effort: null,
  },
  { id: 'kimi-k2.7-code', display_name: 'Kimi K2.7 Code', context_window: 262144, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  { id: 'kimi-k2.6', display_name: 'Kimi K2.6', context_window: 262144, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  { id: 'glm-5.2', display_name: 'GLM 5.2', context_window: 202752, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  { id: 'glm-5.1', display_name: 'GLM 5.1', context_window: 202752, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  { id: 'gemma-4-31b-it', display_name: 'Gemma 4 31B IT', context_window: 262144, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  { id: 'mimo-v2.5-pro', display_name: 'Mimo V2.5 Pro', context_window: 1000000, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  { id: 'qwen3.5-397b-a17b', display_name: 'Qwen 3.5 397B A17B', context_window: 262144, supports_reasoning: false, supported_reasoning_efforts: [], default_reasoning_effort: null },
  {
    id: 'claude-opus-4-8',
    display_name: 'claude-opus-4-8',
    supports_reasoning: false,
    supported_reasoning_efforts: [],
    default_reasoning_effort: null,
  },
];

const LIVE_CLAUDE_MODEL_DATA = [
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4 5' },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4 8' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4 6' },
];

const MINI_OPENAI_MODEL_DATA = [{ id: 'gpt-5.4-mini', context_window: 512000 }];
const MINI_MODEL_IDS = ['gpt-5.4-mini'];
const OPUS_CLAUDE_MODEL_DATA = [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4 8' }];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createPi(registrations, commands = {}, handlers = {}) {
  return {
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
    registerCommand(name, config) {
      commands[name] = config;
    },
    on(name, handler) {
      handlers[name] = handler;
    },
  };
}

function registrationModelIds(registrations, index = 0) {
  return registrations[index].config.models.map((model) => model.id);
}

function discoveryEndpointResponse(value) {
  const resolved = typeof value === 'function' ? value() : value;
  if (resolved instanceof Error) {
    throw resolved;
  }
  if (resolved === false) {
    return { ok: false, async json() { return {}; } };
  }
  return { ok: true, async json() { return { data: resolved }; } };
}

function createDiscoveryFetch({ openai = LIVE_OPENAI_MODEL_DATA, claude = LIVE_CLAUDE_MODEL_DATA } = {}) {
  return async (url) => {
    if (String(url).endsWith('/anthropic/v1/models')) {
      return discoveryEndpointResponse(claude);
    }
    if (String(url).endsWith('/v1/models')) {
      return discoveryEndpointResponse(openai);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function createStalePi(registrations) {
  return {
    registerProvider(name, config) {
      registrations.push({ name, config });
    },
    registerCommand() {},
    on() {},
  };
}

function textDeltas(events) {
  return events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('');
}

try {
  process.env.THECLAWBAY_API_KEY = 'test-key';
  globalThis.fetch = createDiscoveryFetch();

  const firstRegistrations = [];
  const firstHandlers = {};
  const firstResult = await extension(createPi(firstRegistrations, {}, firstHandlers));
  assert.equal(firstResult, undefined, 'extension factory should resolve after startup discovery');
  assert.equal(firstRegistrations.length, 2, 'provider should register the visible provider and internal Anthropic transport');
  assert.equal(typeof firstHandlers.message_end, 'function', 'context overflow normalization should be registered');
  assert.deepEqual(registrationModelIds(firstRegistrations), LIVE_MODEL_IDS);
  assert.equal(
    registrationModelIds(firstRegistrations).includes('qwen3.5-397b-a17b'),
    false,
    'open-weight models that do not return prompt-cache hits should not be registered yet',
  );
  const liveGpt55 = firstRegistrations[0].config.models.find((entry) => entry.id === 'gpt-5.5');
  assert.equal(liveGpt55?.contextWindow, 384000, 'live context_window should override the default Codex context window');
  assert.equal(liveGpt55?.thinkingLevelMap?.xhigh, 'xhigh', 'gpt-5.5 should expose xhigh from live metadata');
  assert.equal(liveGpt55?.thinkingLevelMap?.minimal, 'low', 'gpt-5.5 should map minimal to low when only low is supported upstream');
  for (const id of ['gpt-5.4', 'gpt-5.4[1m]']) {
    const model = firstRegistrations[0].config.models.find((entry) => entry.id === id);
    assert.equal(model?.contextWindow, id === 'gpt-5.4[1m]' ? 1050000 : 272000, `${id} should use its expected context window`);
    assert.equal(model?.thinkingLevelMap?.xhigh, null, `${id} should not expose unsupported xhigh thinking`);
    assert.equal(model?.thinkingLevelMap?.minimal, 'minimal', `${id} should preserve upstream minimal thinking`);
  }
  const liveGemini = firstRegistrations[0].config.models.find((entry) => entry.id === 'gemini-3-pro-preview');
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
  const liveOpenWeight = firstRegistrations[0].config.models.find((entry) => entry.id === 'kimi-k2.7-code');
  assert.equal(liveOpenWeight?.api, 'openai-completions', 'open-weight models should use Pi OpenAI chat completions compatibility');
  assert.equal(liveOpenWeight?.baseUrl, 'https://api.theclawbay.com/v1', 'open-weight models should use TheClawBay OpenAI-compatible base URL');
  assert.equal(liveOpenWeight?.reasoning, false, 'open-weight models should not expose Pi reasoning controls without live reasoning metadata');
  assert.equal(liveOpenWeight?.contextWindow, 262144, 'open-weight models should preserve live context metadata');
  assert.deepEqual(
    liveOpenWeight?.compat,
    { cacheControlFormat: 'anthropic', sendSessionAffinityHeaders: true },
    'open-weight models should request cache-control markers and session-affinity headers for prompt-cache hits',
  );
  const liveGlm52 = firstRegistrations[0].config.models.find((entry) => entry.id === 'glm-5.2');
  assert.equal(liveGlm52?.api, 'openai-completions', 'GLM 5.2 should use Pi OpenAI chat completions compatibility');
  assert.equal(liveGlm52?.reasoning, true, 'GLM 5.2 should expose Pi reasoning controls despite incomplete discovery metadata');
  assert.deepEqual(
    liveGlm52?.thinkingLevelMap,
    { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
    'GLM 5.2 should expose the reasoning efforts accepted by TheClawBay',
  );
  const liveDeepSeek = firstRegistrations[0].config.models.find((entry) => entry.id === 'deepseek-v4-flash');
  assert.equal(liveDeepSeek?.api, 'openai-completions', 'DeepSeek models should use Pi OpenAI chat completions compatibility');
  assert.equal(liveDeepSeek?.baseUrl, 'https://api.theclawbay.com/v1', 'DeepSeek models should use TheClawBay OpenAI-compatible base URL');
  assert.equal(liveDeepSeek?.reasoning, true, 'DeepSeek models should force reasoning support even when live metadata says otherwise');
  assert.deepEqual(
    liveDeepSeek?.compat,
    {
      supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    'DeepSeek models should request Pi DeepSeek thinking/reasoning_content replay compatibility',
  );
  assert.deepEqual(
    liveDeepSeek?.thinkingLevelMap,
    { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
    'DeepSeek models should expose only the upstream-recommended high/max thinking efforts',
  );

  const liveClaude = firstRegistrations[0].config.models.find((entry) => entry.id === 'claude-opus-4-8');
  assert.equal(liveClaude?.api, THECLAWBAY_ANTHROPIC_API, 'Claude models should use TheClawBay Anthropic transport wrapper');
  assert.equal(liveClaude?.baseUrl, 'https://api.theclawbay.com/anthropic', 'Claude models should use TheClawBay\'s Anthropic-compatible base URL');
  assert.equal(liveClaude?.reasoning, true, 'Claude models should expose Pi Anthropic extended/adaptive thinking');
  assert.deepEqual(
    liveClaude?.compat,
    {
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      sendSessionAffinityHeaders: true,
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    },
    'new Opus models should use Pi adaptive thinking compatibility and conservative Anthropic proxy settings',
  );
  assert.deepEqual(liveClaude?.thinkingLevelMap, { xhigh: 'xhigh' }, 'Opus 4.8 should expose native xhigh effort');
  assert.equal(liveClaude?.contextWindow, 1000000, 'new Claude 4.6+ models should use 1M context in Pi metadata');
  assert.equal(liveClaude?.maxTokens, 128000, 'Claude Opus should use the current upstream output limit for xhigh/max efforts');
  const liveSonnet = firstRegistrations[0].config.models.find((entry) => entry.id === 'claude-sonnet-4-6');
  assert.deepEqual(liveSonnet?.thinkingLevelMap, { xhigh: 'max' }, 'Sonnet 4.6 should map Pi xhigh to Anthropic max effort');
  assert.equal(liveSonnet?.maxTokens, 64000, 'Claude Sonnet should use the current upstream output limit for max effort');
  const liveHaiku = firstRegistrations[0].config.models.find((entry) => entry.id === 'claude-haiku-4-5');
  assert.equal(liveHaiku?.reasoning, false, 'TheClawBay Claude Haiku should not expose thinking controls that upstream rejects');
  assert.equal(liveHaiku?.maxTokens, 64000, 'Claude Haiku should use the current upstream output limit');

  const cache = JSON.parse(readFileSync(join(cacheDir, 'models.json'), 'utf8'));
  assert.deepEqual(cache.modelIds, LIVE_MODEL_IDS);
  assert.equal(cache.models.find((model) => model.id === 'gpt-5.5')?.contextWindow, 384000, 'cache should preserve live context metadata');
  assert.equal(cache.models.find((model) => model.id === 'gpt-5.4[1m]')?.contextWindow, 1050000, 'cache should preserve the local 1m context override');
  assert.equal(cache.models.find((model) => model.id === 'deepseek-v4-flash')?.contextWindow, 164000, 'cache should preserve DeepSeek context metadata');
  assert.equal(cache.models.find((model) => model.id === 'kimi-k2.7-code')?.contextWindow, 262144, 'cache should preserve open-weight context metadata');
  assert.equal(cache.models.find((model) => model.id === 'gemini-3-pro-preview')?.supportsReasoning, false, 'cache should preserve live reasoning metadata');

  const fullLiveCacheSnapshot = readFileSync(join(cacheDir, 'models.json'), 'utf8');
  let transientOpenAIRequests = 0;
  globalThis.fetch = createDiscoveryFetch({
    claude: [],
    openai: () => {
      transientOpenAIRequests += 1;
      return transientOpenAIRequests === 1 ? false : MINI_OPENAI_MODEL_DATA;
    },
  });
  const transientStartupRegistrations = [];
  await extension(createPi(transientStartupRegistrations));
  assert.deepEqual(
    registrationModelIds(transientStartupRegistrations),
    MINI_MODEL_IDS,
    'startup should retry complete live discovery before falling back to cache',
  );
  assert.equal(transientStartupRegistrations[0].config.models[0].contextWindow, 512000);
  writeFileSync(join(cacheDir, 'models.json'), fullLiveCacheSnapshot, 'utf8');

  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  const secondRegistrations = [];
  await extension(createPi(secondRegistrations));
  assert.deepEqual(registrationModelIds(secondRegistrations), LIVE_MODEL_IDS);
  assert.equal(secondRegistrations[0].config.models.find((model) => model.id === 'gpt-5.5')?.contextWindow, 384000);
  assert.equal(secondRegistrations[0].config.models.find((model) => model.id === 'deepseek-v4-flash')?.api, 'openai-completions');
  assert.equal(secondRegistrations[0].config.models.find((model) => model.id === 'kimi-k2.7-code')?.compat?.cacheControlFormat, 'anthropic');
  assert.equal(secondRegistrations[0].config.models.find((model) => model.id === 'gemini-3-pro-preview')?.reasoning, true);

  globalThis.fetch = createDiscoveryFetch({ openai: false, claude: OPUS_CLAUDE_MODEL_DATA });
  const partialStartupRegistrations = [];
  await extension(createPi(partialStartupRegistrations));
  assert.deepEqual(
    registrationModelIds(partialStartupRegistrations),
    LIVE_MODEL_IDS,
    'startup should ignore Claude-only partial discovery and keep the cached full model list',
  );

  globalThis.fetch = createDiscoveryFetch({ openai: MINI_OPENAI_MODEL_DATA, claude: false });
  const missingClaudeStartupRegistrations = [];
  await extension(createPi(missingClaudeStartupRegistrations));
  assert.deepEqual(
    registrationModelIds(missingClaudeStartupRegistrations),
    LIVE_MODEL_IDS,
    'startup should ignore OpenAI-only partial discovery and keep the cached full model list',
  );

  delete process.env.THECLAWBAY_API_KEY;
  globalThis.fetch = async () => {
    throw new Error('startup discovery should not fetch without an API key');
  };
  const cachedNoKeyRegistrations = [];
  await extension(createPi(cachedNoKeyRegistrations));
  assert.deepEqual(
    registrationModelIds(cachedNoKeyRegistrations),
    LIVE_MODEL_IDS,
    'startup without an API key should fall back to the stale cache',
  );
  const liveCacheSnapshot = readFileSync(join(cacheDir, 'models.json'), 'utf8');
  rmSync(join(cacheDir, 'models.json'));
  const bundledFallbackRegistrations = [];
  await extension(createPi(bundledFallbackRegistrations));
  const bundledFallbackModelIds = bundledFallbackRegistrations[0].config.models.map((model) => model.id);
  assert.ok(bundledFallbackModelIds.includes('gpt-5.5'), 'startup without API key or cache should fall back to bundled GPT models');
  assert.ok(bundledFallbackModelIds.includes('claude-opus-4-8'), 'startup without API key or cache should fall back to bundled Claude models');
  assert.equal(bundledFallbackModelIds.includes('gpt-image-1.5'), false, 'bundled fallback should keep unsupported native image models hidden');
  writeFileSync(join(cacheDir, 'models.json'), liveCacheSnapshot, 'utf8');
  process.env.THECLAWBAY_API_KEY = 'test-key';

  const staleCacheTime = Date.now() + 7 * 60 * 60 * 1000;
  assert.equal(readCachedModelIds(staleCacheTime), null, 'stale cache should be ignored by default');
  assert.deepEqual(
    readCachedModelIds(staleCacheTime, { allowStale: true }),
    LIVE_MODEL_IDS,
    'stale cache should be available as a startup fallback',
  );
  assert.equal(
    readCachedModelMetadata(staleCacheTime, { allowStale: true }).find((model) => model.id === 'gemini-3-pro-preview')?.supportsReasoning,
    false,
    'stale startup cache should preserve Gemini metadata',
  );
  assert.equal(
    readCachedModelMetadata(staleCacheTime, { allowStale: true }).find((model) => model.id === 'gpt-5.5')?.contextWindow,
    384000,
    'stale startup cache should preserve context metadata',
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
    normalizeOpenAIModelIds(['gpt-5.5', 'gpt-image-2', 'gpt-image-1.5', 'gpt-5.4', 'deepseek-v4-flash', 'gemini-3-pro-preview', 'kimi-k2.7-code', 'qwen3.5-397b-a17b', 'claude-opus-4-8'], { includePinned: true }),
    ['gpt-5.5', 'gpt-image-2', 'gpt-5.4', 'gpt-5.4[1m]', 'deepseek-v4-flash', 'gemini-3-pro-preview', 'kimi-k2.7-code', 'claude-opus-4-8'],
    'unsupported native image and non-cache-hit open-weight models should stay hidden',
  );

  const deepseekModel = buildOpenAIModels([{ id: 'deepseek-v4-flash', supportsReasoning: false, supportedReasoningEfforts: [] }])[0];
  assert.equal(deepseekModel.name, 'DeepSeek V4 Flash');
  assert.equal(deepseekModel.api, 'openai-completions');
  assert.equal(deepseekModel.baseUrl, 'https://api.theclawbay.com/v1');
  assert.equal(deepseekModel.reasoning, true);
  assert.equal(deepseekModel.compat?.thinkingFormat, 'deepseek');
  assert.equal(deepseekModel.compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.deepEqual(deepseekModel.thinkingLevelMap, { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' });

  const openWeightModel = buildOpenAIModels([{ id: 'kimi-k2.7-code', contextWindow: 262144, supportsReasoning: false }])[0];
  assert.equal(openWeightModel.name, 'Kimi K2.7 Code');
  assert.equal(openWeightModel.api, 'openai-completions');
  assert.equal(openWeightModel.baseUrl, 'https://api.theclawbay.com/v1');
  assert.equal(openWeightModel.reasoning, false);
  assert.equal(openWeightModel.contextWindow, 262144);
  assert.equal(openWeightModel.maxTokens, 128000);
  assert.deepEqual(openWeightModel.compat, { cacheControlFormat: 'anthropic', sendSessionAffinityHeaders: true });

  const glm52Model = buildOpenAIModels([{ id: 'glm-5.2', contextWindow: 1000000, supportsReasoning: false }])[0];
  assert.equal(glm52Model.name, 'GLM 5.2');
  assert.equal(glm52Model.api, 'openai-completions');
  assert.equal(glm52Model.reasoning, true);
  assert.equal(glm52Model.contextWindow, 1000000);
  assert.deepEqual(glm52Model.thinkingLevelMap, { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' });
  assert.deepEqual(glm52Model.compat, { cacheControlFormat: 'anthropic', sendSessionAffinityHeaders: true });

  let openWeightRequest;
  globalThis.fetch = async (url, init) => {
    openWeightRequest = {
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };

    return new Response(
      [
        'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":0,"model":"kimi-k2.7-code","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":0,"model":"kimi-k2.7-code","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":1,"total_tokens":101,"prompt_tokens_details":{"cached_tokens":64}}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const openWeightStream = streamSimpleOpenAICompletions(
    {
      ...openWeightModel,
      provider: 'theclawbay',
      api: 'openai-completions',
      baseUrl: 'https://api.theclawbay.com/v1',
    },
    {
      systemPrompt: 'Cacheable system prompt.',
      messages: [
        { role: 'user', content: 'Reply exactly OK.', timestamp: 0 },
      ],
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    },
    { apiKey: 'test-key', sessionId: 'session-open-weight-cache', cacheRetention: 'short', maxTokens: 16 },
  );
  const openWeightEvents = [];
  for await (const event of openWeightStream) {
    openWeightEvents.push(event);
  }
  const openWeightDone = openWeightEvents.find((event) => event.type === 'done');
  assert.equal(openWeightRequest.url, 'https://api.theclawbay.com/v1/chat/completions');
  assert.equal(openWeightRequest.headers.session_id, 'session-open-weight-cache');
  assert.equal(openWeightRequest.headers['x-client-request-id'], 'session-open-weight-cache');
  assert.equal(openWeightRequest.headers['x-session-affinity'], 'session-open-weight-cache');
  assert.equal(openWeightRequest.body.model, 'kimi-k2.7-code');
  assert.equal(openWeightRequest.body.store, false);
  assert.equal(openWeightRequest.body.max_completion_tokens, 16);
  assert.equal(openWeightRequest.body.messages[0].content[0].cache_control.type, 'ephemeral');
  assert.equal(openWeightRequest.body.messages[1].content[0].cache_control.type, 'ephemeral');
  assert.equal(openWeightRequest.body.tools[0].cache_control.type, 'ephemeral');
  assert.ok(openWeightDone, 'open-weight models should stream through Pi openai-completions');
  assert.equal(openWeightDone.message.provider, 'theclawbay');
  assert.equal(openWeightDone.message.api, 'openai-completions');
  assert.equal(openWeightDone.message.model, 'kimi-k2.7-code');
  assert.equal(openWeightDone.message.usage.cacheRead, 64, 'open-weight cached_tokens usage should be reported as cacheRead');

  let glm52ReasoningRequest;
  globalThis.fetch = async (url, init) => {
    glm52ReasoningRequest = {
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };

    return new Response(
      [
        'data: {"id":"chatcmpl_glm52","object":"chat.completion.chunk","created":0,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Thinking."},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl_glm52","object":"chat.completion.chunk","created":0,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl_glm52","object":"chat.completion.chunk","created":0,"model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"reasoning_tokens":1}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const glm52ReasoningEvents = [];
  for await (const event of streamSimpleOpenAICompletions(
    {
      ...glm52Model,
      provider: 'theclawbay',
      api: 'openai-completions',
      baseUrl: 'https://api.theclawbay.com/v1',
    },
    { messages: [{ role: 'user', content: 'Reply exactly OK.', timestamp: 0 }] },
    { apiKey: 'test-key', reasoning: 'xhigh', maxTokens: 16 },
  )) {
    glm52ReasoningEvents.push(event);
  }
  const glm52ReasoningDone = glm52ReasoningEvents.find((event) => event.type === 'done');
  assert.equal(glm52ReasoningRequest.url, 'https://api.theclawbay.com/v1/chat/completions');
  assert.equal(glm52ReasoningRequest.body.model, 'glm-5.2');
  assert.equal(glm52ReasoningRequest.body.reasoning_effort, 'max');
  assert.ok(glm52ReasoningDone, 'GLM 5.2 should stream through Pi openai-completions with reasoning enabled');
  assert.equal(glm52ReasoningDone.message.model, 'glm-5.2');

  const gptImage2 = buildOpenAIModels(['gpt-image-2'])[0];
  assert.equal(gptImage2.name, 'GPT Image 2');
  assert.deepEqual(gptImage2.cost, { input: 5, output: 30, cacheRead: 2, cacheWrite: 5 });
  assert.equal(gptImage2.contextWindow, 272000);
  assert.equal(gptImage2.maxTokens, 65536);

  const opus48 = buildOpenAIModels(['claude-opus-4-8'])[0];
  assert.equal(opus48.name, 'Claude Opus 4.8');
  assert.equal(opus48.api, THECLAWBAY_ANTHROPIC_API);
  assert.equal(opus48.baseUrl, 'https://api.theclawbay.com/anthropic');
  assert.deepEqual(opus48.compat, {
    supportsEagerToolInputStreaming: false,
    supportsCacheControlOnTools: false,
    sendSessionAffinityHeaders: true,
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  });
  assert.deepEqual(opus48.thinkingLevelMap, { xhigh: 'xhigh' });
  assert.equal(opus48.maxTokens, 128000);

  const sonnet46 = buildOpenAIModels(['claude-sonnet-4-6'])[0];
  assert.deepEqual(sonnet46.thinkingLevelMap, { xhigh: 'max' });
  assert.equal(sonnet46.maxTokens, 64000);

  let anthropicRequest;
  globalThis.fetch = async (url, init) => {
    anthropicRequest = {
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };

    return new Response(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":6,"cache_creation_input_tokens":4}}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK."}}',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1,"cache_read_input_tokens":6,"cache_creation_input_tokens":4}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const anthropicStream = streamSimpleTheClawBayAnthropicMessages(
    {
      ...opus48,
      provider: 'theclawbay',
      api: THECLAWBAY_ANTHROPIC_API,
      baseUrl: 'https://api.theclawbay.com/anthropic',
    },
    {
      systemPrompt: `${PI_DOCS_HEADER}\n${PI_DOCS_LOOKUP_LINE}`,
      messages: [{ role: 'user', content: 'Respond only OK.', timestamp: 0 }],
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    },
    {
      apiKey: 'test-key',
      reasoning: 'high',
      sessionId: 'session-claude-cache',
      cacheRetention: 'short',
      toolChoice: { type: 'tool', name: 'read' },
    },
  );
  const anthropicEvents = [];
  for await (const event of anthropicStream) {
    anthropicEvents.push(event);
  }
  assert.equal(anthropicRequest.url, 'https://api.theclawbay.com/anthropic/v1/messages');
  assert.equal(anthropicRequest.headers['x-stainless-timeout'], '180', 'Claude requests should not hang indefinitely when Pi does not pass timeoutMs');
  assert.equal(anthropicRequest.body.max_tokens, 128000, 'Claude requests should allow the current Opus output limit for xhigh/max-capable turns');
  assert.equal(anthropicRequest.headers['x-session-affinity'], 'session-claude-cache', 'Claude requests should send session affinity for prompt-cache routing');
  assert.equal(anthropicRequest.body.thinking?.type, 'adaptive', 'Claude 4.8 should use adaptive thinking through Pi Anthropic compat');
  assert.equal(anthropicRequest.body.thinking?.display, 'omitted', 'Claude adaptive thinking should skip unused summaries to reduce stuck-looking thinking latency');
  assert.deepEqual(anthropicRequest.body.output_config, { effort: 'high' });
  assert.equal('tool_choice' in anthropicRequest.body, false, 'TheClawBay Claude proxy should not receive forced tool_choice');
  assert.equal(
    anthropicRequest.body.system[0].text.includes(PI_DOCS_LOOKUP_LINE),
    false,
    'TheClawBay Claude requests should avoid the upstream-rejected single-line Pi docs lookup list',
  );
  assert.equal(
    anthropicRequest.body.system[0].text.includes(PI_DOCS_HEADER),
    false,
    'TheClawBay Claude requests should avoid the upstream-sensitive Pi docs header wording',
  );
  assert.match(anthropicRequest.body.system[0].text, /Pi documentation paths and routing:/);
  assert.match(anthropicRequest.body.system[0].text, /\n  - extensions: docs\/extensions\.md/);
  assert.match(
    normalizeTheClawBayAnthropicSystemPrompt(PI_DOCS_LOOKUP_LINE),
    /\n  - pi packages: docs\/packages\.md/,
  );
  assert.equal('budget_tokens' in (anthropicRequest.body.thinking ?? {}), false, 'Claude 4.8 should not send legacy budget-based thinking');
  assert.equal('eager_input_streaming' in anthropicRequest.body.tools[0], false, 'Claude tools should avoid proxy-hostile eager_input_streaming');
  assert.equal('cache_control' in anthropicRequest.body.tools[0], false, 'Claude tools should avoid proxy-hostile tool cache_control');
  assert.equal(anthropicRequest.body.messages[0].content[0].cache_control.type, 'ephemeral', 'Claude conversation cache markers should be preserved');
  const anthropicDone = anthropicEvents.find((event) => event.type === 'done');
  assert.ok(anthropicDone, 'Claude should stream through Pi Anthropic transport after TheClawBay SSE normalization');
  assert.equal(anthropicDone.message.api, THECLAWBAY_ANTHROPIC_API);
  assert.equal(anthropicDone.message.usage.cacheRead, 6, 'Claude cache_read_input_tokens should be reported as cacheRead');

  let cappedAnthropicRequest;
  globalThis.fetch = async (url, init) => {
    cappedAnthropicRequest = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };

    return new Response(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_timeout_cap","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const cappedAnthropicStream = streamSimpleTheClawBayAnthropicMessages(
    {
      ...opus48,
      provider: 'theclawbay',
      api: THECLAWBAY_ANTHROPIC_API,
      baseUrl: 'https://api.theclawbay.com/anthropic',
    },
    { messages: [{ role: 'user', content: 'Respond only OK.', timestamp: 0 }] },
    { apiKey: 'test-key', reasoning: 'high', timeoutMs: 300000 },
  );
  for await (const _event of cappedAnthropicStream) {
    // Drain the stream so the request is made and normalized.
  }
  assert.equal(cappedAnthropicRequest.url, 'https://api.theclawbay.com/anthropic/v1/messages');
  assert.equal(
    cappedAnthropicRequest.headers['x-stainless-timeout'],
    '180',
    'Claude requests should cap Pi default 300s timeout to TheClawBay Anthropic idle timeout',
  );

  globalThis.fetch = async () =>
    new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  const idleAnthropicStream = streamSimpleTheClawBayAnthropicMessages(
    {
      ...opus48,
      provider: 'theclawbay',
      api: THECLAWBAY_ANTHROPIC_API,
      baseUrl: 'https://api.theclawbay.com/anthropic',
    },
    { messages: [{ role: 'user', content: 'Respond only OK.', timestamp: 0 }] },
    { apiKey: 'test-key', reasoning: 'high', timeoutMs: 5 },
  );
  const idleAnthropicEvents = [];
  for await (const event of idleAnthropicStream) {
    idleAnthropicEvents.push(event);
  }
  const idleAnthropicError = idleAnthropicEvents.find((event) => event.type === 'error');
  assert.match(
    idleAnthropicError?.error?.errorMessage,
    /TheClawBay Anthropic stream timed out after 5ms without data/,
    'Claude streams should fail visibly when an SSE response goes idle',
  );

  globalThis.fetch = createDiscoveryFetch({ openai: [{ id: 'gpt-5.5' }], claude: [] });
  const staleRegistrations = [];
  const stalePi = createStalePi(staleRegistrations);
  await extension(stalePi);
  stalePi.registerProvider = () => {
    throw new Error('stale pi');
  };
  assert.equal(staleRegistrations.length, 2, 'stale extension refresh should not crash after initial registration');

  globalThis.fetch = createDiscoveryFetch({ openai: MINI_OPENAI_MODEL_DATA, claude: [] });
  const refreshCommands = {};
  const refreshRegistrations = [];
  await extension(createPi(refreshRegistrations, refreshCommands));
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
  assert.deepEqual(registrationModelIds(refreshRegistrations), MINI_MODEL_IDS);
  assert.equal(refreshRegistrations[0].config.models[0].contextWindow, 512000, 'manual refresh should apply live context metadata');
  assert.deepEqual(refreshNotifications, [{ message: 'Refreshed 1 TheClawBay model from live discovery', level: 'info' }]);

  globalThis.fetch = createDiscoveryFetch({ openai: false, claude: OPUS_CLAUDE_MODEL_DATA });
  refreshRegistrations.length = 0;
  refreshNotifications.length = 0;
  await refreshCommands['clawbay-refresh-models'].handler('', {
    ui: {
      notify(message, level) {
        refreshNotifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(refreshRegistrations, [], 'manual refresh should not re-register a Claude-only partial discovery result');
  assert.deepEqual(refreshNotifications, [{ message: 'Failed to refresh TheClawBay models from live discovery', level: 'error' }]);

  globalThis.fetch = createDiscoveryFetch({ openai: MINI_OPENAI_MODEL_DATA, claude: false });
  refreshRegistrations.length = 0;
  refreshNotifications.length = 0;
  await refreshCommands['clawbay-refresh-models'].handler('', {
    ui: {
      notify(message, level) {
        refreshNotifications.push({ message, level });
      },
    },
  });
  assert.deepEqual(refreshRegistrations, [], 'manual refresh should not re-register an OpenAI-only partial discovery result');
  assert.deepEqual(refreshNotifications, [{ message: 'Failed to refresh TheClawBay models from live discovery', level: 'error' }]);

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
  await extension(createPi([], commands));
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
  assert.match(headers['User-Agent'], /^pi \(/, 'Codex requests should use a Pi-style User-Agent for TheClawBay compression compatibility');
  assert.deepEqual({ ...headers, 'User-Agent': '<normalized>' }, {
    existing: '1',
    'OpenAI-Beta': 'responses=experimental',
    'User-Agent': '<normalized>',
    'session-id': 'session-123',
    session_id: 'session-123',
  });

  const overflowResult = normalizeTheClawBayContextOverflow(
    {
      message: {
        role: 'assistant',
        provider: 'theclawbay',
        stopReason: 'error',
        errorMessage: 'input exceeds maximum context window',
      },
    },
    {},
  );
  assert.equal(
    overflowResult?.message.errorMessage,
    'context_length_exceeded: input exceeds maximum context window',
    'TheClawBay context overflow errors should be normalized for Pi auto-compaction',
  );
  assert.equal(
    normalizeTheClawBayContextOverflow(
      {
        message: {
          role: 'assistant',
          provider: 'theclawbay',
          stopReason: 'error',
          errorMessage: 'rate limit reached',
        },
      },
      {},
    ),
    undefined,
    'rate-limit errors must not be normalized as context overflow',
  );
  assert.equal(
    normalizeTheClawBayContextOverflow(
      {
        message: {
          role: 'assistant',
          provider: 'other-provider',
          stopReason: 'error',
          errorMessage: 'input exceeds maximum context window',
        },
      },
      {},
    ),
    undefined,
    'overflow normalization must be scoped to TheClawBay',
  );

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
  assert.equal(streamModel.baseUrl, 'https://api.theclawbay.com/v1', 'GPT/Codex text should use TheClawBay direct OpenAI-compatible route');
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
    if (String(url).endsWith('/images/generations')) {
      imageRequest = { url: String(url), body: JSON.parse(String(init.body)), headers: Object.fromEntries(new Headers(init.headers).entries()) };
      return new Response(JSON.stringify({
        created: 123,
        data: [{ b64_json: oneByOnePngBase64, revised_prompt: 'A tiny test PNG.' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
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
    ['start', 'text_start', 'text_delta', 'text_delta', 'text_delta', 'text_delta', 'text_end', 'done'],
    'image generation should emit visible progress deltas before the final assistant message',
  );
  assert.match(textDeltas(imageEvents), /🎨 Preparing image request/, 'image generation should announce request preparation');
  assert.match(textDeltas(imageEvents), /🖌️ Generating image/, 'image generation should announce generation start');
  assert.match(textDeltas(imageEvents), /💾 Saving final image/, 'image generation should announce final save');
  const imageDone = imageEvents.find((event) => event.type === 'done');
  assert.equal(imageRequest.url, 'https://api.theclawbay.com/v1/images/generations');
  assert.equal(imageRequest.headers.authorization, 'Bearer test-key');
  assert.equal(imageRequest.body.model, 'gpt-image-2');
  assert.equal(imageRequest.body.prompt, 'Draw a tiny test PNG.');
  assert.equal(imageRequest.body.size, '1024x1024');
  assert.equal(imageRequest.body.n, 1);
  assert.ok(!('stream' in imageRequest.body), 'direct Images API requests should not use Responses streaming fields');
  assert.ok(!('tools' in imageRequest.body), 'direct Images API requests should not use the hosted image_generation tool');
  assert.ok(imageDone, 'image generation stream should finish successfully');
  assert.equal(imageDone.message.provider, 'theclawbay');
  assert.equal(imageDone.message.model, 'gpt-image-2');
  const imageText = imageDone.message.content[0].text;
  const generatedPath = imageText.match(/`([^`]+\.png)`/)?.[1];
  assert.ok(generatedPath, 'image generation response should include the saved PNG path');
  const markdownLinkPattern = new RegExp(
    `\\[${escapeRegExp(basename(generatedPath))}\\]\\(${escapeRegExp(pathToFileURL(generatedPath).href)}\\)`,
  );
  assert.match(imageText, markdownLinkPattern, 'image generation response should include a clickable file:// markdown link');
  assert.ok(existsSync(generatedPath), 'image generation should save the decoded PNG to disk');

  const finalImageBase64 = Buffer.from('final-image-bytes').toString('base64');
  let retryImageAttempts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/images/generations')) {
      retryImageAttempts += 1;
      if (retryImageAttempts === 1) {
        return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        created: 456,
        data: [{ b64_json: finalImageBase64, revised_prompt: 'final revised protagonist' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
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
  assert.equal(retryImageAttempts, 2, 'direct image generation should retry transient HTTP failures');
  assert.match(textDeltas(retryImageEvents), /⚠️ Image service was temporarily busy\. Retrying/, 'retrying image generation should show a user-friendly retry progress message');
  assert.ok(retryImageDone, 'retried image generation stream should finish successfully');
  const retryImageText = retryImageDone.message.content[0].text;
  assert.match(retryImageText, /final revised protagonist/, 'direct image response should preserve revised_prompt');
  const retryGeneratedPath = retryImageText.match(/`([^`]+\.png)`/)?.[1];
  assert.ok(retryGeneratedPath, 'retried image generation should include the saved PNG path');
  assert.equal(readFileSync(retryGeneratedPath, 'utf8'), 'final-image-bytes', 'direct image response b64_json should be saved as the final image');

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/images/generations')) {
      return new Response(JSON.stringify({ created: 789, data: [{}] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected malformed image fetch ${url}`);
  };
  const malformedImageStream = streamSimpleTheClawBayCodexResponses(
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
    { messages: [{ role: 'user', content: 'Draw a malformed image.', timestamp: 0 }] },
    { apiKey: 'test-key' },
  );
  const malformedImageEvents = [];
  for await (const event of malformedImageStream) {
    malformedImageEvents.push(event);
  }
  const malformedImageError = malformedImageEvents.find((event) => event.type === 'error');
  assert.ok(malformedImageError, 'malformed direct image responses should not be reported as successful images');
  assert.match(malformedImageError.error.errorMessage, /did not include an image/);

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

  if (originalAnthropicTimeout === undefined) {
    delete process.env.PI_CLAWBAY_ANTHROPIC_TIMEOUT_MS;
  } else {
    process.env.PI_CLAWBAY_ANTHROPIC_TIMEOUT_MS = originalAnthropicTimeout;
  }

  globalThis.fetch = originalFetch;
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(imageDir, { recursive: true, force: true });
}
