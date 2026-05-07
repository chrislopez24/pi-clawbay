# TheClawBay Provider for Pi Coding Agent

`pi-clawbay` is a Pi Coding Agent provider extension for [TheClawBay](https://theclawbay.com). It exposes TheClawBay GPT/Codex models through Pi and includes image generation support through both Codex-style hosted tools and the direct Images API.

## Features

- **Single Pi provider:** registers `theclawbay`.
- **Codex Responses transport:** sends requests to TheClawBay's native Codex route over HTTP streaming.
- **Dynamic model discovery:** loads model IDs from TheClawBay's `/v1/models` endpoint and caches successful discovery results.
- **GPT-5.4 variants:** exposes `gpt-5.4` and `gpt-5.4[1m]` as separate Pi selections while remapping both to the upstream `gpt-5.4` model ID.
- **Hosted image generation:** Codex-style `image_generation` hosted tool support exposed as a model tool; the model decides when to call it with `tool_choice: auto`.
- **Direct Images API transport:** manual `gpt-image-2` and `gpt-image-1.5` selections call TheClawBay's documented `/v1/images/generations` endpoint and save returned PNGs locally.
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

Selectable Pi models include GPT/Codex text models plus two explicit image-only entries, `gpt-image-2` and `gpt-image-1.5`. The image entries are selectable manually, but they do not use the chat/Codex transport; they route directly to TheClawBay's Images API.

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
- `gpt-image-2`
- `gpt-image-1.5`

### GPT-5.4 variants

The upstream TheClawBay model ID is `gpt-5.4`. This extension exposes two Pi entries for clearer cost/context selection:

| Pi model | Upstream model | Context configured in Pi |
|----------|----------------|--------------------------|
| `theclawbay/gpt-5.4` | `gpt-5.4` | `272,000` tokens |
| `theclawbay/gpt-5.4[1m]` | `gpt-5.4` | `1,050,000` tokens |

Other GPT/Codex fallback models use a `272,000` token context window and `128,000` max output tokens.

## Image generation

`pi-clawbay` supports two image-generation flows. Prefer the Codex-style hosted tool from a text/Codex model; select a `gpt-image-*` model only when you explicitly want the direct Images API transport documented at <https://theclawbay.com/docs#image-generation>.

The provider follows Codex CLI's hosted-tool pattern: for image-capable TheClawBay models, it exposes the hosted `image_generation` tool in the Responses payload and lets the model decide when to call it with `tool_choice: auto`. Normal coding and text requests still return regular assistant text; they do not produce an `image_generation_call` unless the model intentionally uses the hosted tool.

Select a text/Codex model, for example:

```text
/model theclawbay/gpt-5.5
```

Ask for an image naturally:

```text
Generate a minimalist black sailboat icon on a white background. No text.
```

The hosted Responses tool definition is:

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

### Environment controls

To disable hosted image generation entirely, use:

```bash
export PI_CLAWBAY_IMAGE_GENERATION=off
```

Override the output root when needed:

```bash
export PI_CLAWBAY_GENERATED_IMAGES_DIR=/absolute/output/dir
```

### Manual Direct Images API flow

For explicit direct Images API usage, select one of the image models:

```text
/model theclawbay/gpt-image-2
/model theclawbay/gpt-image-1.5
```

These models are not sent through the Codex chat endpoint. `streamSimple` calls:

```text
POST https://api.theclawbay.com/v1/images/generations
```

with the documented payload shape:

```json
{
  "model": "gpt-image-2",
  "prompt": "A minimalist black sailboat icon on a white background. No text.",
  "size": "1024x1024",
  "quality": "low",
  "output_format": "png"
}
```

The provider decodes `data[0].b64_json`, saves a PNG under `~/.pi/agent/generated_images/<session_id>/`, and returns the `file://` URL, path, and `revised_prompt` when present.

The valid TheClawBay image model IDs exposed here are `gpt-image-2` and `gpt-image-1.5`. `gpt-image-2.0` is not a valid model ID.

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

### Direct Images API outside Pi

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

Use the direct API outside Pi only when you need your own programmatic integration or when hosted generation is unavailable. Inside Pi, selecting `theclawbay/gpt-image-2` or `theclawbay/gpt-image-1.5` uses this same endpoint automatically.

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
