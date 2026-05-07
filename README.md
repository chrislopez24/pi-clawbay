# TheClawBay Provider for Pi Coding Agent

A provider extension for [Pi Coding Agent](https://github.com/earendil-works/pi) that enables access to GPT-5 and Codex models through [TheClawBay](https://theclawbay.com) API.

## Features

- **GPT-5 & Codex Models** - Access via Codex Responses API with session-based prompt cache
- **Single Provider** - Only `theclawbay` is registered
- **GPT-5.4 Split Options** - `gpt-5.4` and `gpt-5.4[1m]` for clearer cost/context choice
- **GPT Image 2** - Generate PNG images through TheClawBay's OpenAI-compatible Images endpoint
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

If discovery fails or `THECLAWBAY_API_KEY` is not set yet, the extension falls back to the last successful discovery cache, even if it is stale, then to a bundled default list so `/model` still works on startup. Live discovery refreshes the cache in the background after the provider has been registered.

Requests for `theclawbay/*` text and coding models are sent through TheClawBay's native Codex route:

- `https://api.theclawbay.com/backend-api/codex`

Requests for `theclawbay/gpt-image-2` are sent through TheClawBay's Codex Responses route with the hosted `image_generation` tool:

- `https://api.theclawbay.com/backend-api/codex/responses`

This extension uses a custom Responses transport for that route. It sends:

- `Authorization: Bearer $THECLAWBAY_API_KEY`
- `chatgpt-account-id: theclawbay`
- `session_id` when Pi provides a session id
- `prompt_cache_key` in the request body
- `tools: [{ type: "image_generation", model: "gpt-image-2", output_format: "png", size: "1024x1024", partial_images: 2 }]`

This avoids Pi's built-in `openai-codex-responses` JWT parsing path, which expects a ChatGPT/Codex-style token and can fail with `Failed to extract accountId from token` when given a normal TheClawBay API key.

Based on the live docs at `https://theclawbay.com/docs`:

- OpenAI-compatible apps use `https://api.theclawbay.com/v1`
- Native Codex config uses `https://api.theclawbay.com/backend-api/codex`
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
- Current non-5.4 GPT-5/Codex variants default to `272,000` context and `128,000` max output tokens.
- `gpt-image-2` uses the Images API path with `1024x1024` PNG output, `272,000` context metadata, and `65,536` max output metadata.

### Example Model List

Current fallback list in this package:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4[1m]`
- `gpt-5.4-mini`
- `gpt-image-2`
- `gpt-5.3-codex`
- `gpt-5.2-codex`
- `gpt-5.2`
- `gpt-5.1-codex-max`
- `gpt-5.1-codex-mini`

`gpt-image-2` is exposed because TheClawBay's latest npm setup marks it as an image generation model backed by `codex-lb`. The extension uses the hosted Responses image tool instead of the synchronous Images API because realistic 1024x1024 prompts can exceed the Images route socket window and fail as `fetch failed`. Other native image-generation models returned by discovery, such as `gpt-image-1.5`, remain hidden until this extension has a dedicated, tested flow for them.

## Usage

### Select a Model

Use `/model` command in pi:

```text
/model theclawbay/gpt-5.5
/model theclawbay/gpt-5.4
/model theclawbay/gpt-5.4[1m]
/model theclawbay/gpt-image-2
```

When `gpt-image-2` is selected, Pi receives a normal assistant message event sequence and the generated PNG is saved locally. Set `PI_CLAWBAY_IMAGE_DIR` to override the output directory; otherwise images are saved under Pi's generated-files directory. If TheClawBay sends partial images and the final image is unavailable, the latest partial PNG is saved instead of returning a socket-level failure.

### Commands

This extension currently registers:

```text
/quota
/clawbay-quota
/clawbay-refresh-models
```

`/quota` and `/clawbay-quota` show current usage. `/clawbay-refresh-models` refreshes live model discovery, updates the local cache, and re-registers the provider without needing `/reload`.

`/cachehit` was removed.

### Programmatic Usage

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // After loading this extension, models are available:
  // - theclawbay/gpt-5.5
  // - theclawbay/gpt-5.4
  // - theclawbay/gpt-5.4[1m]
  // - theclawbay/gpt-5.4-mini
  // - theclawbay/gpt-image-2
  // - theclawbay/gpt-5.3-codex
}
```

## API Reference

### Endpoints

| Provider | Base URL | API Type |
|----------|----------|----------|
| `theclawbay` | `https://api.theclawbay.com/backend-api/codex` | OpenAI Codex Responses |
| `theclawbay/gpt-image-2` | `https://api.theclawbay.com/backend-api/codex/responses` | Hosted Responses `image_generation` |

### Authentication

All requests use Bearer token authentication:

```text
Authorization: Bearer THECLAWBAY_API_KEY
```

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

# Basic reasoning/cache path
PI_CLAWBAY_DEBUG=1 pi --no-extensions -e /path/to/pi-clawbay --model theclawbay/gpt-5.4 --thinking low --no-session -p "Say OK and nothing else."

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
