---
name: theclawbay-imagegen
description: Use TheClawBay image generation through pi-clawbay's Codex-style hosted image_generation support or manual direct gpt-image-* Images API transport. Use when the user asks to create, generate, draw, render, or save an image while using the theclawbay provider.
---

# TheClawBay Image Generation

Use this skill when the user asks for image generation with the `pi-clawbay` extension. TheClawBay's image API documentation is at <https://theclawbay.com/docs#image-generation>.

## Preferred flow

Use the extension's hosted Responses tool support. The provider follows Codex CLI's hosted-tool pattern: it exposes `image_generation` to image-capable TheClawBay models, and the model decides when to call it with `tool_choice: auto`.

```bash
export THECLAWBAY_API_KEY=your-key
pi -e /path/to/pi-clawbay
```

Select a text/Codex model, for example:

```text
/model theclawbay/gpt-5.5
```

Then ask for an image naturally:

```text
Generate a minimalist black sailboat icon on a white background. No text.
```

`pi-clawbay` sends TheClawBay the Codex-style hosted tool definition:

```json
{ "type": "image_generation", "output_format": "png" }
```

The provider decodes `image_generation_call.result` and saves the PNG under:

```text
~/.pi/agent/generated_images/<session_id>/<image_generation_call_id>.png
```

The assistant response includes a `file://` URL, the filesystem path, and the revised prompt when one is returned.

If the generated image is needed in the project, copy it into the workspace. Leave the original generated-images artifact in place unless the user explicitly asks to delete it.

## Environment controls

- `PI_CLAWBAY_IMAGE_GENERATION=off` disables hosted image generation entirely.
- `PI_CLAWBAY_GENERATED_IMAGES_DIR=/absolute/output/dir` overrides where decoded PNG files are saved.

## Manual Direct Images API flow

If the user explicitly wants to select an image model, use one of the manual direct models:

```text
/model theclawbay/gpt-image-2
/model theclawbay/gpt-image-1.5
```

When one of these models is selected, `pi-clawbay` does not use the Codex chat endpoint. It calls TheClawBay's direct Images API:

```http
POST https://api.theclawbay.com/v1/images/generations
Authorization: Bearer $THECLAWBAY_API_KEY
Content-Type: application/json
```

with payload shape:

```json
{
  "model": "gpt-image-2",
  "prompt": "A minimalist black sailboat icon on a white background. No text.",
  "size": "1024x1024",
  "quality": "low",
  "output_format": "png"
}
```

The provider decodes `data[0].b64_json`, saves a PNG under `~/.pi/agent/generated_images/<session_id>/`, and responds with the `file://` URL, local path, and `revised_prompt` when returned.

## Model guidance

- Prefer hosted image generation from a text/Codex model such as `gpt-5.5`.
- Use `gpt-image-2` or `gpt-image-1.5` only for the manual direct Images API flow.
- The valid model is `gpt-image-2`, not `gpt-image-2.0`.

## Transparent backgrounds

Do not claim native transparent output from `gpt-image-2`.

For transparent assets, use one of these approaches:

1. Generate with a flat chroma-key background, then remove the background with image processing.
2. If native transparency is required, ask the user before using the older `gpt-image-1.5` direct Images API path.

## Direct API outside Pi

If hosted image generation is disabled or unavailable and you are operating outside the Pi provider loop, call TheClawBay's OpenAI-compatible Images API directly:

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

Inside Pi, selecting `theclawbay/gpt-image-2` or `theclawbay/gpt-image-1.5` uses this endpoint automatically. Outside Pi, use the direct API only as a fallback or when the user explicitly asks for programmatic image API usage.
