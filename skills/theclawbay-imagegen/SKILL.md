---
name: theclawbay-imagegen
description: Use TheClawBay image generation through pi-clawbay's Codex-style hosted image_generation support. Use when the user asks to create, generate, draw, render, or save an image while using the theclawbay provider.
---

# TheClawBay Image Generation

Use this skill when the user asks for image generation with the `pi-clawbay` extension.

## Preferred flow

Use the extension's hosted Responses tool support:

```bash
export THECLAWBAY_API_KEY=your-key
export PI_CLAWBAY_IMAGE_GENERATION=hosted
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

When enabled, `pi-clawbay` sends TheClawBay the Codex-style hosted tool definition:

```json
{ "type": "image_generation", "output_format": "png" }
```

The provider decodes `image_generation_call.result` and saves the PNG under:

```text
~/.pi/agent/generated_images/<session_id>/<image_generation_call_id>.png
```

The assistant response includes a `file://` URL, the filesystem path, and the revised prompt when one is returned.

If the generated image is needed in the project, copy it into the workspace. Leave the original generated-images artifact in place unless the user explicitly asks to delete it.

## Model guidance

- The current TheClawBay image model ID is `gpt-image-2`, not `gpt-image-2.0`.
- `gpt-image-2` and `gpt-image-1.5` are image API models and should not be selected with `/model`.
- Hosted image generation should be requested from a text/Codex model such as `gpt-5.5`.

## Transparent backgrounds

Do not claim native transparent output from `gpt-image-2`.

For transparent assets, use one of these approaches:

1. Generate with a flat chroma-key background, then remove the background with image processing.
2. If native transparency is required, ask the user before using the older `gpt-image-1.5` direct Images API path.

## Direct API fallback

If hosted image generation is disabled or unavailable, call TheClawBay's OpenAI-compatible Images API outside the Pi provider loop:

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

Use the direct API only as a fallback or when the user explicitly asks for programmatic image API usage.
