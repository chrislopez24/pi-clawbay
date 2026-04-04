# TheClawBay Provider for Pi Coding Agent

A provider extension for [pi coding agent](https://github.com/badlogic/pi-mono) that enables access to GPT-5, Codex, and Claude models through [TheClawBay](https://theclawbay.com) API.

## Features

- **GPT-5 & Codex Models** - Access via Codex Responses API with session-based prompt cache
- **Claude Models** - Access via Anthropic-compatible Messages API
- **High Usage Headroom** - More capacity than standard subscriptions
- **Simple Setup** - Single API key for all models

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

If discovery fails or `THECLAWBAY_API_KEY` is not set yet, the extension falls back to a bundled default list so `/model` still works.

Requests for `theclawbay/*` models are sent through TheClawBay's native Codex route:

- `https://api.theclawbay.com/backend-api/codex`

This extension uses a custom Responses transport for that route. It sends:

- `Authorization: Bearer $THECLAWBAY_API_KEY`
- `chatgpt-account-id: theclawbay`
- `session_id` when Pi provides a session id
- `prompt_cache_key` in the request body

This avoids Pi's built-in `openai-codex-responses` JWT parsing path, which expects a ChatGPT/Codex-style token and can fail with `Failed to extract accountId from token` when given a normal TheClawBay API key.

Last verified against the live APIs on `2026-04-03`:

- OpenAI-compatible: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`
- Anthropic-compatible: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-6`

### Model Limits

- `gpt-5.4` is configured with a `1,050,000` token context window.
- Current GPT-5/Codex variants default to `400,000` context and `128,000` max output tokens.
- Claude models default to `200,000` context in this extension. Anthropic documents `1M` context for Opus 4.6 and Sonnet 4.6 behind a beta header, but this extension does not enable that beta automatically.

### Anthropic Reasoning Behavior In Pi

This extension does not set Anthropic `thinking` or `budget_tokens` itself. It only registers Claude models with `api: "anthropic-messages"` and `reasoning: true`. Pi Coding Agent handles the request mapping at runtime.

With current `pi-mono` releases:

- `claude-sonnet-4-6` and `claude-opus-4-6` use adaptive thinking automatically.
- `claude-haiku-4-5-20251001` uses budget-based thinking automatically.
- Default budget-based thinking levels in Pi map to:
  - `minimal`: `1024`
  - `low`: `2048`
  - `medium`: `8192`
  - `high`: `16384`

Anthropic does not publish canonical token budgets for "low", "medium", and "high" on budget-based models. Their guidance is to start at the minimum `1024` tokens and increase incrementally for your workload.

This means:

- Pi Coding Agent works correctly with this extension as long as your Pi version includes Anthropic adaptive-thinking support for Claude 4.6 models.
- OpenCode must be configured separately; it does not inherit Pi's Anthropic thinking defaults.

## Usage

### Select a Model

Use `/model` command in pi:

```
/model theclawbay/gpt-5.4
/model theclawbay-claude/claude-sonnet-4-6
```

### Programmatic Usage

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // After loading this extension, models are available:
  // - theclawbay/gpt-5.4
  // - theclawbay/gpt-5.4-mini
  // - theclawbay-claude/claude-opus-4-6
  // - theclawbay-claude/claude-haiku-4-5-20251001
  // - theclawbay-claude/claude-sonnet-4-6
}
```

## API Reference

### Endpoints

| Provider | Base URL | API Type |
|----------|----------|----------|
| `theclawbay` | `https://api.theclawbay.com/backend-api/codex` | OpenAI Codex Responses |
| `theclawbay-claude` | `https://api.theclawbay.com/anthropic` | Anthropic Messages |

### Authentication

All requests use Bearer token authentication:

```
Authorization: Bearer THECLAWBAY_API_KEY
```

### Quota Checking

Check your current usage:

```bash
curl "https://theclawbay.com/api/codex-auth/v1/quota" \
  -H "Authorization: Bearer $THECLAWBAY_API_KEY"
```

### Cache Hit Inspection

After a TheClawBay response in Pi, you can inspect the latest prompt-cache hit rate with:

```text
/cachehit
```

It reports:

- `R` = cached prompt tokens read
- `I` = non-cached prompt input tokens
- `cache hit % = R / (R + I)`

## Error Handling

Common error codes:

| Code | Description |
|------|-------------|
| `weekly_cost_limit_reached` | Weekly spend cap hit |
| `5h_cost_limit_reached` | 5-hour spend cap hit |
| `invalid_api_key` | Key missing or malformed |
| `model_not_found` | Requested model unavailable |

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
- [Pi Custom Provider Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

## License

MIT
