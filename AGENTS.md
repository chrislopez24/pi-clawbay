# TheClawBay Provider Extension for Pi Coding Agent

## Overview

This extension registers [TheClawBay](https://theclawbay.com) as a custom provider for Pi Coding Agent. It exposes TheClawBay models under one Pi provider, `theclawbay`, and routes each model family through the transport that matches its upstream API.

## Project Status

Implemented:

- `theclawbay` provider registered from `src/provider.ts`
- Dynamic model discovery from TheClawBay OpenAI-compatible and Anthropic-compatible model endpoints
- Local cached fallback model list when live discovery is unavailable
- GPT/Codex routing through TheClawBay Codex Responses route
- Claude routing through Anthropic Messages compatibility
- Gemini routing through Pi's `google-generative-ai` transport
- DeepSeek routing through Pi's `openai-completions` transport with DeepSeek thinking compatibility
- `gpt-image-2` routing through the direct Images API
- `/quota`, `/clawbay-quota`, and `/clawbay-refresh-models` commands
- Context-overflow error normalization for Pi auto-compaction

There is no separate `theclawbay-claude` provider in the current implementation. Claude models are selected as `theclawbay/claude-*`.

## TheClawBay API Reference

### Base URLs

| Protocol | Base URL |
| --- | --- |
| OpenAI-compatible discovery/chat/images | `https://api.theclawbay.com/v1` |
| Anthropic-compatible | `https://api.theclawbay.com/anthropic` |
| Gemini-compatible | `https://api.theclawbay.com/v1beta` |
| Codex native | `https://api.theclawbay.com/backend-api/codex` |

### Authentication

- Environment variable: `THECLAWBAY_API_KEY`
- Bearer header for direct TheClawBay requests: `Authorization: Bearer <key>`

### Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/v1/models` | OpenAI-compatible model discovery |
| POST | `/backend-api/codex/responses` | GPT/Codex Responses route |
| POST | `/v1/chat/completions` | OpenAI chat completions compatibility |
| POST | `/v1/images/generations` | Image generation |
| GET | `/anthropic/v1/models` | Claude model discovery |
| POST | `/anthropic/v1/messages` | Claude messages |
| GET | `https://theclawbay.com/api/codex-auth/v1/quota` | Current usage stats |

## Pi Provider Registration Notes

The extension registers one provider:

```typescript
pi.registerProvider("theclawbay", {
  name: "TheClawBay",
  baseUrl: "https://api.theclawbay.com/backend-api/codex",
  apiKey: "$THECLAWBAY_API_KEY",
  api: "theclawbay-codex-responses",
  streamSimple: streamSimpleTheClawBayCodexResponses,
  models
});
```

The custom `theclawbay-codex-responses` stream wrapper delegates to Pi's OpenAI Responses serializer for GPT/Codex requests, preserves `prompt_cache_key`, and sends both the current Pi Codex cache-affinity header, `session-id`, and the legacy TheClawBay/Codex `session_id` header when Pi provides a session id.

Model-level overrides select other Pi transports:

- `claude-*`: `api: "anthropic-messages"`, `baseUrl: "https://api.theclawbay.com/anthropic"`
- `gemini-*`: `api: "google-generative-ai"`, `baseUrl: "https://api.theclawbay.com/v1beta"`
- `deepseek-*`: `api: "openai-completions"`, `baseUrl: "https://api.theclawbay.com/v1"`
- `gpt-image-2`: handled by the custom image-generation path

## Usage

```bash
pi install npm:pi-clawbay@latest
export THECLAWBAY_API_KEY=your-key-here
pi
```

Example model selections:

```text
/model theclawbay/gpt-5.4
/model theclawbay/gpt-5.4[1m]
/model theclawbay/gpt-5.5
/model theclawbay/claude-sonnet-4-6
/model theclawbay/claude-opus-4-8
/model theclawbay/gemini-3-flash-preview
/model theclawbay/deepseek-v4-flash
/model theclawbay/gpt-image-2
```

## Maintenance Notes

- Keep `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` aligned with Pi latest.
- If Pi changes Codex cache-affinity behavior again, update `src/transport.ts`, tests, README, and this file together.
- If TheClawBay introduces provider-specific context-limit wording, update `src/overflow.ts` so Pi can auto-compact and retry.
- Run `npm run check` and `npm test` before publishing.

## Resources

- [TheClawBay Docs](https://theclawbay.com/docs)
- [TheClawBay Dashboard](https://theclawbay.com)
- [Pi Custom Provider Docs](https://pi.dev/docs/latest/custom-provider)
- [Pi Providers Docs](https://pi.dev/docs/latest/providers)
