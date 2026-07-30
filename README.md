# TheClawBay Provider for Pi Coding Agent

A provider extension for [Pi Coding Agent](https://github.com/earendil-works/pi) that enables access to GPT-5, Codex, Claude, supported Gemini, DeepSeek, open-weight, and image-generation models through [TheClawBay](https://theclawbay.com) API.

## Features

- **GPT-5 & Codex Models** - Access via TheClawBay's native Codex Responses route with session-based prompt-cache hits
- **Claude Models** - Dynamically discovered `claude-*` models use Pi's native Anthropic Messages transport through a TheClawBay SSE-normalizing wrapper, including adaptive thinking support and prompt-cache affinity for current Opus/Sonnet models
- **Gemini Models** - Dynamically discovered `gemini-*` models use Pi's native Google transport against TheClawBay's `/v1beta` route, including Pi-compatible thinking support by default
- **DeepSeek Models** - Dynamically discovered `deepseek-*` models use Pi's OpenAI-compatible chat-completions transport with DeepSeek thinking replay compatibility
- **Open-Weight Models** - Cache-verified discovered open-weight models use Pi's OpenAI-compatible chat-completions transport with prompt-cache markers and session-affinity headers
- **Single Provider** - Only `theclawbay` is registered; routing is selected per model
- **GPT-5.6 Models** - `gpt-5.6`, `gpt-5.6-sol`, and `gpt-5.6-terra` with Pi `xhigh`/`max` thinking and a 272K context cap
- **GPT Image 2** - Generate PNG images through TheClawBay's direct OpenAI-compatible Images API
- **High Usage Headroom** - More capacity than standard subscriptions
- **Simple Setup** - Single API key

## Installation

### Recommended: Install from npm

```bash
pi install npm:pi-clawbay@latest
```

This uses the published npm package and avoids npm's GitHub dependency path.

Do not use:

```bash
pi install npm:chrislopez24/pi-clawbay
```

That form is treated as a GitHub install, not a registry package install, and it can leave broken global symlinks behind.

### Local Development

```bash
pi -e /path/to/pi-clawbay
```

Use this only while actively developing the extension locally.

## Configuration

### Environment Variable

Set your TheClawBay API key:

```bash
export THECLAWBAY_API_KEY=your-api-key-here
```

Get your API key from [TheClawBay Dashboard](https://theclawbay.com).

### Available Models

Model IDs are discovered dynamically at extension load from:

- `GET https://api.theclawbay.com/v1/models`
- `GET https://api.theclawbay.com/anthropic/v1/models`

When `THECLAWBAY_API_KEY` is set, the extension registers the last cached catalog (or the bundled fallback) immediately so startup does not wait on the network. If the cache is stale or unavailable, complete live discovery runs in the background and replaces the catalog only when both endpoints succeed. A successful Anthropic response with no models is valid, but a failed or timed-out endpoint is not. Fresh caches avoid an unnecessary startup discovery request; `/clawbay-refresh-models` remains available for a forced refresh. If complete discovery fails after a short retry, startup keeps the cached catalog, even if it is stale, or falls back to the bundled list so `/model` still works. Successful live discovery updates the local cache and Pi's provider-scoped model store.

### Routing and Cache Behavior

The extension keeps one Pi provider, `theclawbay`, and routes by model family:

- **GPT/Codex text models** (`gpt-*`, `*codex*`) use TheClawBay's OpenAI-compatible Responses route:
  - `https://api.theclawbay.com/v1`
  - The custom `streamSimpleTheClawBayCodexResponses` transport is preserved for model remapping and event provider restoration.
  - This is the cache-critical path: Pi's OpenAI Responses serializer emits `prompt_cache_key` from the session id, and the transport keeps both `session-id` and legacy `session_id` affinity headers so repeated requests can hit TheClawBay/OpenAI prompt cache.
- **DeepSeek models** (`deepseek-*`) use TheClawBay's OpenAI-compatible chat-completions route:
  - `https://api.theclawbay.com/v1`
  - Pi's `openai-completions` transport is used because it supports DeepSeek thinking controls and replays assistant `reasoning_content` fields on follow-up turns.
  - This avoids intermittent thinking-mode failures such as `400 "The \`reasoning_content\` in the thinking mode must be passed back to the API."`
- **Cache-verified open-weight models** currently include `glm-5.2`, `glm-5.1`, `kimi-k2.6`, `kimi-k2.7-code`, and `mimo-v2.5-pro`; they use TheClawBay's OpenAI-compatible chat-completions route:
  - `https://api.theclawbay.com/v1`
  - Pi's `openai-completions` transport sends `stream_options.include_usage`, `store: false`, and `max_completion_tokens`.
  - The model compat enables Anthropic-style `cache_control` markers plus `session_id`, `x-client-request-id`, and `x-session-affinity` headers. Live smoke testing confirmed cache hits through `prompt_tokens_details.cached_tokens` on repeated `kimi-k2.7-code` requests.
  - `glm-5.2` exposes Pi reasoning controls with `high -> high` and `xhigh -> max`, matching the efforts accepted by TheClawBay's chat-completions route.
  - Discovered open-weight IDs that respond without cache hits, or are temporarily unavailable upstream, remain hidden until they can be verified with real `cached_tokens` usage.
- **Claude models** (`claude-*`) are registered per model with:
  - `api: "theclawbay-anthropic-messages"`
  - `baseUrl: "https://api.theclawbay.com/anthropic"`
  - A small TheClawBay wrapper builds the official Anthropic SDK client, normalizes non-standard SSE streams that omit blank-line event delimiters, then delegates to Pi's native Anthropic transport for `/v1/messages`, tool use, prompt-cache markers, usage parsing, and Claude thinking replay.
  - Claude requests require Pi `0.80.10+` so the extension can register its custom Anthropic API wrapper and use the current Anthropic compatibility flags.
  - TheClawBay Claude tool payloads intentionally omit `tools[].eager_input_streaming` and tool-level `cache_control`; system and conversation cache markers plus `x-session-affinity` are preserved for prompt-cache hits.
  - `claude-haiku-4-5` does not expose Pi thinking controls because TheClawBay/upstream rejects thinking parameters for that model.
  - Current discovered Claude models include `claude-haiku-4-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, and `claude-sonnet-4-6`; Fable 5 exposes adaptive `xhigh`/`max` thinking.
- **Gemini models** (`gemini-*`) are registered per model with:
  - `api: "google-generative-ai"`
  - `baseUrl: "https://api.theclawbay.com/v1beta"`
  - `reasoning: true` for the Gemini IDs that Pi's official Google provider marks as thinking-capable (`gemini-2.5-*`, `gemini-live-2.5-*`, `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-3*-flash*`, and `gemini-3*-pro*`)
  - Pi then uses its native Google SDK transport (`/v1beta/models/{model}:streamGenerateContent?alt=sse`) instead of the Codex transport. This is required because sending Gemini models to `https://api.theclawbay.com/backend-api/codex/responses` returns `404 upstream returned HTTP 404`.
- **Image generation** (`gpt-image-2`) uses TheClawBay's direct OpenAI-compatible Images route:
  - `https://api.theclawbay.com/v1/images/generations`

For GPT/Codex text requests, the extension keeps the OpenAI Responses semantics that are needed for existing behavior:

- `Authorization: Bearer $THECLAWBAY_API_KEY`
- `OpenAI-Beta: responses=experimental`
- `session-id` and legacy `session_id` when Pi provides a session id
- `prompt_cache_key` in the request body for GPT/Codex cache affinity
- `include: ["reasoning.encrypted_content"]`
- `store: false`

For `gpt-image-2`, the request follows the current TheClawBay docs and sends a direct Images API payload:

- `model: "gpt-image-2"`
- `prompt: <latest user prompt>`
- `size: "1024x1024"`
- `n: 1`

### Gemini Thinking

Gemini thinking is enabled by default for the same Google-native model families that Pi official marks as compatible; there is no feature flag or environment variable. Pi's Google transport maps Pi reasoning options to Google `thinkingConfig`:

- Gemini 2.5 models use `thinkingBudget`.
- Gemini 3 Flash / Flash-Lite models use `thinkingLevel` and hide the unsupported `off` level.
- Gemini 3 Pro / 3.1 Pro models expose only the supported visible levels: `low -> LOW` and `high -> HIGH`; unsupported `off`, `minimal`, and `medium` levels are hidden/skipped by Pi's thinking-level clamp.

If no explicit Pi reasoning level is selected, Pi still sends the official hidden lowest supported Google config for reasoning-capable Gemini 3 models so the request remains valid while not surfacing hidden thoughts.

### Gemini Cache Limitation

Gemini now uses the correct Pi Google transport. If TheClawBay's `/v1beta` response includes `usageMetadata.cachedContentTokenCount`, Pi will count that as `cacheRead` usage. However, explicit Gemini cached-content creation is not available through TheClawBay at the moment: `v1beta/cachedContents` is blocked by the proxy (`proxy path not allowed: v1beta/cachedContents`). Do not expect or promise Gemini cache hits equivalent to the Codex path until TheClawBay allows that endpoint.

The Codex cache behavior must not be degraded: GPT/Codex models should continue sending `prompt_cache_key`, `session-id`, and legacy `session_id` on the `/v1` Responses route.

### Open-Weight Cache Verification

As of 2026-06-13, live testing against `POST https://api.theclawbay.com/v1/chat/completions` with repeated large prompts, `cache_control`, and session-affinity headers showed:

- Cache hits confirmed through `prompt_tokens_details.cached_tokens`: `glm-5.2`, `glm-5.1`, `kimi-k2.6`, `kimi-k2.7-code`, `mimo-v2.5-pro`.
- Reasoning confirmed for `glm-5.2`: TheClawBay accepts `reasoning_effort` values `high` and `max` and returns `reasoning_content` plus `reasoning_tokens`, even though current discovery metadata reports `supports_reasoning: false`.
- Responded but did not report cache hits after repeated attempts, even with `prompt_cache_key` and long-retention fields: `gemma-4-31b-it`, `qwen3.5-397b-a17b`, `qwen3.6-27b`.
- Temporarily unavailable upstream during verification: `glm-4.7`, `glm-4.7-flash`, `glm-5`, `kimi-k2.5`, `kimi-k2.5-lightning`, `minimax-m2.5`, `qwen3.5-9b`.

Only the cache-hit-confirmed open-weight models are registered by this extension for now. Revisit the filtered models when TheClawBay starts returning `cached_tokens` for them or their upstream availability changes.

Based on the live docs at `https://theclawbay.com/docs`:

- OpenAI-compatible apps use `https://api.theclawbay.com/v1`
- Claude-compatible apps use `https://api.theclawbay.com/anthropic`
- Native Codex config uses `https://api.theclawbay.com/backend-api/codex`
- Gemini-compatible apps use `https://api.theclawbay.com/v1beta`
- The docs recommend calling `/models` first and selecting an available model dynamically

### GPT-5.4 Variants In This Extension

The live TheClawBay docs expose `gpt-5.4` as the upstream model. This extension presents it in Pi as two selectable entries:

- `theclawbay/gpt-5.4` → standard variant, capped to `272k` context in Pi
- `theclawbay/gpt-5.4[1m]` → long-context variant, configured to `1,050,000`

Internally:

- `gpt-5.4` stays as-is
- `gpt-5.4[1m]` is remapped to upstream `gpt-5.4` before the request is sent

Why split it?

- `gpt-5.4` is the cheaper/default option
- `gpt-5.4[1m]` gives explicit access to long context
- both end up using the same official upstream model id from TheClawBay

### Model Limits

- `gpt-5.4` is configured with a `272,000` token context window.
- `gpt-5.4[1m]` is configured with a `1,050,000` token context window.
- GPT-5.6, GPT-5.6 Sol, and GPT-5.6 Terra use a deliberate `272,000` context cap in this extension, despite TheClawBay advertising a 372K route limit; they support `xhigh` and `max` thinking. Other non-5.4 GPT-5/Codex variants default to `272,000` context and `128,000` max output tokens.
- Current Claude 4.6+ variants default to `1,000,000` context in Pi metadata. Opus uses `128,000` max output tokens, while Sonnet and Haiku use `64,000`, matching the current Claude output ceilings needed by adaptive `xhigh`/`max` efforts.
- Gemini variants discovered from `/v1/models` use Pi's Google transport with `1,048,576` context and `65,536` max output tokens.
- Open-weight variants preserve `context_window` from live discovery and default to `128,000` max output metadata.
- `gpt-image-2` uses the direct `/v1/images/generations` path with `1024x1024` PNG output, `272,000` context metadata, and `65,536` max output metadata.

### Example Model List

Current fallback list in this package, used only when live discovery and cache are unavailable:

- `gpt-5.6`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4[1m]`
- `gpt-5.4-mini`
- `gpt-image-2`
- `claude-haiku-4-5`
- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `gpt-5.3-codex`
- `gpt-5.2-codex`
- `gpt-5.2`
- `gpt-5.1-codex-max`
- `gpt-5.1-codex-mini`

Live discovery may add newer GPT/Codex, Claude, Gemini, DeepSeek, and cache-verified open-weight models such as `gemini-2.5-pro`, `gemini-3.1-pro-preview`, `kimi-k2.7-code`, `kimi-k2.6`, `glm-5.2`, `glm-5.1`, or `mimo-v2.5-pro` when TheClawBay exposes them for your account.

`gpt-image-2` is exposed because TheClawBay's latest docs list it as the direct image-generation model for `POST /v1/images/generations`. Other native image-generation models returned by discovery, such as `gpt-image-1.5`, remain hidden until this extension has a dedicated, tested flow for them.

## Usage

### Select a Model

Use `/model` command in pi:

```text
/model theclawbay/gpt-5.6
/model theclawbay/gpt-5.6-sol
/model theclawbay/gpt-5.6-terra
/model theclawbay/gpt-5.5
/model theclawbay/gpt-5.4
/model theclawbay/gpt-5.4[1m]
/model theclawbay/claude-opus-4-8
/model theclawbay/claude-sonnet-4-6
/model theclawbay/gemini-3-flash-preview
/model theclawbay/kimi-k2.7-code
/model theclawbay/glm-5.2
/model theclawbay/glm-5.1
/model theclawbay/gpt-image-2
```

Gemini model IDs appear only when TheClawBay returns them from live discovery or the local discovery cache. When `gpt-image-2` is selected, Pi receives a normal assistant message event sequence and the generated PNG is saved locally. Set `PI_CLAWBAY_IMAGE_DIR` to override the output directory; otherwise images are saved under Pi's generated-files directory. Transient direct image failures are retried up to 5 times by default.

### Commands

This extension currently registers:

```text
/quota
/clawbay-quota
/clawbay-refresh-models
```

`/quota` and `/clawbay-quota` show current usage. `/clawbay-refresh-models` refreshes live model discovery on demand, updates both the local cache and Pi's provider-scoped model store, and re-registers the provider without needing `/reload`. Pi 0.80 offline/cache-only refreshes restore the existing catalog and never replace it with an empty list.

`/cachehit` was removed.

### Programmatic Usage

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  // After loading this extension, models are available:
  // - theclawbay/gpt-5.5
  // - theclawbay/gpt-5.4
  // - theclawbay/gpt-5.4[1m]
  // - theclawbay/gpt-5.4-mini
  // - theclawbay/gpt-image-2
  // - theclawbay/claude-opus-4-8
  // - theclawbay/claude-sonnet-4-6
  // - theclawbay/gpt-5.3-codex
  // - theclawbay/gemini-3-flash-preview (when live discovery exposes it)
}
```

## API Reference

### Endpoints

| Model family | Base URL / Route | API Type |
|--------------|------------------|----------|
| `theclawbay/gpt-*`, `theclawbay/*codex*` | `https://api.theclawbay.com/v1` | Custom Responses transport wrapper (`theclawbay-codex-responses`) |
| `theclawbay/deepseek-*` | `https://api.theclawbay.com/v1/chat/completions` | Pi `openai-completions` transport with DeepSeek compat |
| `theclawbay/glm-5.2`, `theclawbay/glm-5.1`, `theclawbay/kimi-k2.6`, `theclawbay/kimi-k2.7-code`, `theclawbay/mimo-v2.5-pro` | `https://api.theclawbay.com/v1/chat/completions` | Pi `openai-completions` transport with cache-control compat |
| `theclawbay/claude-*` | `https://api.theclawbay.com/anthropic/v1/messages` | TheClawBay SSE normalizer over Pi `anthropic-messages` |
| `theclawbay/gemini-*` | `https://api.theclawbay.com/v1beta` | Pi `google-generative-ai` transport |
| `theclawbay/gpt-image-2` | `https://api.theclawbay.com/v1/images/generations` | Direct OpenAI-compatible Images API |

### Authentication

All model families use the same `THECLAWBAY_API_KEY` value. GPT/Codex, Claude discovery, and direct image requests use Bearer token authentication:

```text
Authorization: Bearer THECLAWBAY_API_KEY
```

Gemini requests are sent by Pi's Google transport, which passes the same key using the Google SDK's API-key header (`x-goog-api-key`). Claude message requests are sent by Pi's Anthropic transport, which passes the same key as the Anthropic SDK API-key header accepted by TheClawBay.

### Quota Checking

Check your current usage:

```bash
curl "https://theclawbay.com/api/codex-auth/v1/quota" \
  -H "Authorization: Bearer $THECLAWBAY_API_KEY"
```

## Error Handling

Common error codes:

| Code | Description |
|------|-------------|
| `weekly_cost_limit_reached` | Weekly spend cap hit |
| `5h_cost_limit_reached` | 5-hour spend cap hit |
| `invalid_api_key` | Key missing or malformed |
| `model_not_found` | Requested model unavailable |

## Debugging and Verification

Enable extension debug logs with:

```bash
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gpt-5.4 --thinking low -p "Respond with OK only."
```

Useful smoke checks:

```bash
# Model registration and hidden image models
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --list-models theclawbay

# Basic GPT/Codex reasoning path
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gpt-5.6-sol --thinking max --no-session -p "Say OK and nothing else."

# Gemini native /v1beta path (choose a gemini-* id shown by --list-models)
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gemini-3-flash-preview --thinking off --no-session -p "Say OK and nothing else."

# Open-weight chat-completions path
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/kimi-k2.7-code --no-session -p "Say OK and nothing else."

# Open-weight prompt-cache path: reuse the same session id so Pi emits cache_control and session-affinity headers
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/kimi-k2.7-code --session-id clawbay-openweights-cache-smoke -p "Remember this cache smoke token: clawbay-openweights-cache-smoke."
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/kimi-k2.7-code --session-id clawbay-openweights-cache-smoke -p "Reply with only the cache smoke token."

# Claude native /anthropic path (choose a claude-* id shown by --list-models)
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/claude-opus-4-8 --thinking off --no-session -p "Say OK and nothing else."
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/claude-opus-4-8 --thinking high --no-session -p "Say OK and nothing else."
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/claude-haiku-4-5 --thinking off --no-session -p "Say OK and nothing else."

# Claude prompt-cache path: reuse the same session id so Pi can send cache markers on follow-up turns
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/claude-opus-4-8 --thinking high --session-id clawbay-claude-cache-smoke -p "Remember this cache smoke token: clawbay-cache-smoke."
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/claude-opus-4-8 --thinking high --session-id clawbay-claude-cache-smoke -p "Reply with only the cache smoke token."

# Codex prompt-cache path: keep the same session so Pi emits prompt_cache_key/session-id/session_id
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gpt-5.4-mini -p "Summarize package.json in one sentence."

# Tool-call path
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gpt-5.4 --thinking low --tools ls -p "Use the ls tool on the current directory, then summarize whether package.json exists."

# Image generation path
PI_CLAWBAY_IMAGE_DIR=/tmp/pi-clawbay-images pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gpt-image-2 -p "Generate a simple square icon of a red crab claw on a white background. No text."
```

## Troubleshooting

- `THECLAWBAY_API_KEY is not set`: export a valid key before selecting `theclawbay/*` models.
- `401` or `invalid_api_key`: verify the key in the TheClawBay dashboard and in your shell environment.
- `429`, `weekly_cost_limit_reached`, or `5h_cost_limit_reached`: run `/quota` or `/clawbay-quota` and wait for the reset window.
- Model missing from `/model`: run `/clawbay-refresh-models`; if discovery still omits it, TheClawBay may not expose it for your account.
- DeepSeek intermittently returns `400 "The \`reasoning_content\` in the thinking mode must be passed back to the API."`: upgrade/reload this extension and refresh models. `deepseek-*` models must use Pi's `openai-completions` DeepSeek compatibility path, not the Codex Responses serializer.
- Claude model returns an OpenAI/Codex-route error: upgrade/reload this extension and refresh models. `claude-*` models must use the extension's `theclawbay-anthropic-messages` wrapper and TheClawBay `/anthropic`, not `backend-api/codex/responses`.
- Claude stream parsing fails around `message_stop` or contains concatenated `event:`/`data:` lines: upgrade/reload this extension. The TheClawBay Anthropic wrapper normalizes those SSE chunks before Pi's official parser consumes them.
- Claude model returns `400 upstream_rejected` with binary-looking escaped content: first confirm the registered Claude model is using Pi `0.80.10+`, the extension's TheClawBay Anthropic wrapper, and current Claude output ceilings. Opus/Sonnet aliases need adaptive thinking, while Haiku must not receive thinking parameters.
- Claude tool requests fail but no-tool prompts work: verify the registered model compat still has `supportsEagerToolInputStreaming: false` and `supportsCacheControlOnTools: false`; the wrapper also strips forced `tool_choice` because TheClawBay's Claude proxy rejects it.
- Gemini model returns `404 upstream returned HTTP 404` on a Codex route: upgrade/reload this extension. `gemini-*` models must use Pi's `google-generative-ai` transport and TheClawBay `/v1beta`, not `backend-api/codex/responses`.
- Gemini cache is not showing Codex-style cache hits: expected for now. TheClawBay currently blocks `v1beta/cachedContents`; Pi will still report `cachedContentTokenCount` as `cacheRead` if the upstream route returns it.
- GPT/Codex cache behavior regresses: verify the request still uses `/v1/responses`, includes `prompt_cache_key`, and sends `session-id` plus legacy `session_id` when Pi has a session id.
- `gpt-image-2` missing: run `/clawbay-refresh-models`; if discovery still omits it, TheClawBay may not expose it for your account.
- `gpt-image-1.5` missing: native image output models are intentionally hidden until this extension has a dedicated tested image flow for them.

## Building

```bash
npm install
npm run build
npm pack --dry-run
```

## Publishing

```bash
npm version patch
npm publish
```

## Resources

- [TheClawBay Docs](https://theclawbay.com/docs)
- [TheClawBay Dashboard](https://theclawbay.com)
- [Pi Custom Provider Docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)

## License

MIT
