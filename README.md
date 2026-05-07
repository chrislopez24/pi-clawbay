# TheClawBay Provider for Pi Coding Agent

`pi-clawbay` is a Pi Coding Agent provider extension for [TheClawBay](https://theclawbay.com). It exposes TheClawBay GPT/Codex models through Pi and includes experimental Codex-style hosted image generation support.

## Features

- **Single Pi provider:** registers `theclawbay`.
- **Codex Responses transport:** sends requests to TheClawBay's native Codex route over HTTP streaming.
- **Dynamic model discovery:** loads model IDs from TheClawBay's `/v1/models` endpoint and caches successful discovery results.
- **GPT-5.4 variants:** exposes `gpt-5.4` and `gpt-5.4[1m]` as separate Pi selections while remapping both to the upstream `gpt-5.4` model ID.
- **Hosted image generation:** optional Codex-style `image_generation` hosted tool support behind an explicit feature flag.
- **Quota command:** adds `/quota` for current TheClawBay usage information.

## Installation

### Recommended: npm

```bash
pi install npm:pi-clawbay@latest
```

Use the npm package form above. Do not install `npm:chrislopez24/pi-clawbay`; npm treats that as a GitHub-style dependency and it can leave broken global symlinks.

### Local development

```bash
pi -e /path/to/pi-clawbay
```

Use local loading only while developing or testing this extension.

## Configuration

Set your TheClawBay API key:

```bash
export THECLAWBAY_API_KEY=your-api-key-here
```

Get an API key from the [TheClawBay Dashboard](https://theclawbay.com).

## Provider transport

The provider sends `theclawbay/*` requests to TheClawBay's native Codex route:

```text
https://api.theclawbay.com/backend-api/codex
```

The extension uses a custom HTTP streaming Responses transport. It sends:

- `Authorization: Bearer $THECLAWBAY_API_KEY`
- `chatgpt-account-id: theclawbay`
- `originator: pi`
- `OpenAI-Beta: responses=experimental`
- `session_id` when Pi provides a session ID
- `prompt_cache_key` in the request body

It intentionally does not use Pi's built-in Codex WebSocket transport. That path expects ChatGPT/Codex JWT-style credentials and can fail with normal TheClawBay API keys.

## Model discovery and filtering

At startup, the extension calls:

```text
GET https://api.theclawbay.com/v1/models
```

If live discovery fails, it falls back to the last successful cache and then to the bundled default list.

Selectable Pi chat models are filtered to GPT/Codex-compatible models. Image API models such as `gpt-image-2` and `gpt-image-1.5` are intentionally not exposed in `/model`; they are image-generation API models, not chat/Codex models.

### Default fallback models

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4[1m]`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.2-codex`
- `gpt-5.2`
- `gpt-5.1-codex-max`
- `gpt-5.1-codex-mini`

### GPT-5.4 variants

The upstream TheClawBay model ID is `gpt-5.4`. This extension exposes two Pi entries for clearer cost/context selection:

| Pi model | Upstream model | Context configured in Pi |
|----------|----------------|--------------------------|
| `theclawbay/gpt-5.4` | `gpt-5.4` | `272,000` tokens |
| `theclawbay/gpt-5.4[1m]` | `gpt-5.4` | `1,050,000` tokens |

Other GPT/Codex fallback models use a `272,000` token context window and `128,000` max output tokens.

## Image generation

`pi-clawbay` supports experimental hosted image generation in the Codex style used by OpenAI Codex CLI.

Enable it explicitly:

```bash
export PI_CLAWBAY_IMAGE_GENERATION=hosted
```

Then select a text/Codex model, for example:

```text
/model theclawbay/gpt-5.5
```

Ask for an image naturally:

```text
Generate a minimalist black sailboat icon on a white background. No text.
```

When the feature flag is enabled, the provider adds the hosted Responses tool:

```json
{ "type": "image_generation", "output_format": "png" }
```

The stream parser handles `image_generation_call` items, decodes the returned base64 PNG, and saves it to:

```text
~/.pi/agent/generated_images/<session_id>/<image_generation_call_id>.png
```

The assistant response includes:

- a `file://` URL
- the filesystem path
- the revised prompt, when returned by TheClawBay

For tests or automation, override the output root:

```bash
export PI_CLAWBAY_GENERATED_IMAGES_DIR=/absolute/output/dir
```

### Image model IDs

The current TheClawBay image model ID is:

```text
gpt-image-2
```

It is not `gpt-image-2.0`. The extension keeps `gpt-image-*` out of the Pi chat model list. Hosted image generation is invoked from a text/Codex model through the `image_generation` hosted tool.

### Skill guidance

This package includes a Pi skill:

```text
theclawbay-imagegen
```

The skill documents the recommended image-generation workflow and fallback behavior. It is helpful guidance for the agent, but it is not a separate runtime requirement. The provider stream implements the actual hosted image generation support.

If needed, load it explicitly inside Pi:

```text
/skill:theclawbay-imagegen
```

### Direct Images API fallback

For programmatic image generation outside the Pi provider loop, call TheClawBay's OpenAI-compatible Images API directly:

```http
POST https://api.theclawbay.com/v1/images/generations
Authorization: Bearer $THECLAWBAY_API_KEY
Content-Type: application/json
```

Example payload:

```json
{
  "model": "gpt-image-2",
  "prompt": "A minimalist black sailboat icon on a white background. No text.",
  "size": "1024x1024",
  "quality": "low",
  "output_format": "png"
}
```

Use the direct API only when you need programmatic image generation outside Pi or when hosted generation is unavailable.

## Usage

### Select a model

```text
/model theclawbay/gpt-5.5
/model theclawbay/gpt-5.4
/model theclawbay/gpt-5.4[1m]
```

### Commands

```text
/quota
```

`/quota` shows current TheClawBay usage windows and reset times.

## API reference

| Provider | Base URL | API type |
|----------|----------|----------|
| `theclawbay` | `https://api.theclawbay.com/backend-api/codex` | Responses over HTTP streaming |

All provider requests use Bearer token authentication:

```text
Authorization: Bearer $THECLAWBAY_API_KEY
```

Quota endpoint:

```bash
curl "https://theclawbay.com/api/codex-auth/v1/quota" \
  -H "Authorization: Bearer $THECLAWBAY_API_KEY"
```

## Build and test

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

## Publishing

Publishing is handled by the GitHub Actions workflow in `.github/workflows/publish.yml`.

Manual local publishing is not recommended. Use the workflow so npm provenance is attached:

```bash
gh workflow run publish.yml --ref main
```

## Resources

- [TheClawBay Docs](https://theclawbay.com/docs)
- [TheClawBay Dashboard](https://theclawbay.com)
- [Pi Custom Provider Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

## License

MIT
