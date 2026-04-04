# TheClawBay Provider Extension for Pi Coding Agent

## Overview

This extension registers [TheClawBay](https://theclawbay.com) as a custom provider for pi coding agent, enabling access to GPT-5, Codex, and Claude models with high usage headroom at competitive pricing.

## Project Status

**IMPLEMENTED** - Two providers registered:
- `theclawbay` - OpenAI-compatible endpoint for GPT/Codex models
- `theclawbay-claude` - Anthropic-compatible endpoint for Claude models

## TheClawBay API Reference

### Base URLs

| Protocol | Base URL |
|----------|----------|
| OpenAI-compatible | `https://api.theclawbay.com/v1` |
| Anthropic-compatible | `https://api.theclawbay.com/anthropic` |
| Codex native | `https://api.theclawbay.com/backend-api/codex` |

### Authentication

- **Environment Variable**: `THECLAWBAY_API_KEY`
- **Header**: `Authorization: Bearer <key>`

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | List available models (call first) |
| POST | `/responses` | Responses API (recommended) |
| POST | `/chat/completions` | OpenAI chat completions |
| GET | `/quota` | Current usage stats |
| POST | `/anthropic/v1/messages` | Claude messages |
| GET | `/anthropic/v1/models` | Claude model list |

### Available Models

#### OpenAI/Codex Models
- `gpt-5.4` - Frontier coding model with widest headroom
- `gpt-5.3-codex` - Strong daily-driver Codex model
- `gpt-5.2-codex` - Stable compatibility for older Codex flows
- `gpt-5.2` - Balanced non-Codex option
- `gpt-5.1-codex-max` - Higher-throughput for longer sessions
- `gpt-5.1-codex-mini` - Lower-cost for quick iterations

#### Claude Models (via Anthropic-compatible)
- `claude-sonnet-4-6`
- `claude-opus-4-6`

### Streaming

Set `stream: true` for SSE. Event type: `response.output_text.delta` carries text chunks.

### Quota & Rate Limits

Check quota:
```bash
curl "https://theclawbay.com/api/codex-auth/v1/quota" \
  -H "Authorization: Bearer $THECLAWBAY_API_KEY"
```

Error codes:
- `weekly_cost_limit_reached` - Weekly spend cap hit
- `5h_cost_limit_reached` - 5-hour spend cap hit
- `invalid_api_key` - Key missing or malformed
- `model_not_found` - Requested model unavailable

---

## Pi Coding Agent Provider Registration

### Quick Reference

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("theclawbay", {
    baseUrl: "https://api.theclawbay.com/backend-api/codex",  // Pi appends /responses for the native Codex route
    apiKey: "THECLAWBAY_API_KEY",
    api: "openai-codex-responses",       // Enables session_id header caching like Codex CLI
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384
      }
    ]
  });
}
```

### API Types

The `api` field determines streaming implementation:

| API | Use for |
|-----|---------|
| `openai-codex-responses` | **TheClawBay OpenAI endpoint** - sends `session_id` header for prompt caching |
| `openai-responses` | OpenAI Responses API (no session_id header) |
| `openai-completions` | OpenAI Chat Completions |
| `anthropic-messages` | Anthropic Claude API |

**Why `openai-codex-responses` for TheClawBay?**

The `openai-codex-responses` API type enables prompt caching via the `session_id` header,
which is the same mechanism used by Codex CLI. This significantly reduces token usage
by allowing the backend to cache the system prompt and conversation context.

- **Endpoint**: `https://api.theclawbay.com/backend-api/codex/responses` (provider appends `/responses`)
- **Headers**: `session_id: <uuid>` for cache key
- **Body**: `prompt_cache_key: <sessionId>` for cache lookup

### Model Definition Reference

```typescript
interface ProviderModelConfig {
  id: string;           // Model ID (e.g., "gpt-5.4")
  name: string;         // Display name
  api?: Api;            // API type override
  reasoning: boolean;   // Supports extended thinking
  input: ("text" | "image")[];
  cost: {
    input: number;      // $/million tokens
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: {            // OpenAI compatibility settings
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    reasoningEffortMap?: Partial<Record<"minimal" | "low" | "medium" | "high" | "xhigh", string>>;
  };
}
```

### Config Reference

```typescript
interface ProviderConfig {
  baseUrl?: string;              // API endpoint URL
  apiKey?: string;               // API key or env var name
  api?: Api;                     // API type for streaming
  streamSimple?: Function;       // Custom streaming implementation
  headers?: Record<string, string>; // Custom headers
  authHeader?: boolean;          // Add Authorization: Bearer header
  models?: ProviderModelConfig[];
  oauth?: OAuthConfig;           // OAuth provider for /login
}
```

---

## Extension Implementation

**Completed:**
- [x] Create extension entry point (`src/index.ts`)
- [x] Register TheClawBay provider with OpenAI-compatible config (`theclawbay`)
- [x] Register Claude models via Anthropic-compatible endpoint (`theclawbay-claude`)
- [x] Document configuration options
- [x] **Use `openai-codex-responses` API for prompt caching** (sends `session_id` header)

**Future improvements:**
- [ ] Dynamic model discovery from `/models` endpoint
- [ ] Quota checking utilities
- [ ] OAuth support for TheClawBay login

## Project Structure

```
pi-clawbay/
├── AGENTS.md              # This file (project context)
├── README.md               # User documentation
├── package.json            # Extension package
├── tsconfig.json           # TypeScript config
└── src/
    └── index.ts            # Extension entry point
```

## Usage

```bash
# Load the extension
pi -e /path/to/pi-clawbay

# Set API key
export THECLAWBAY_API_KEY=your-key-here

# Select a model
/model theclawbay/gpt-5.4
/model theclawbay-claude/claude-sonnet-4-6
```

## Resources

- [TheClawBay Docs](https://theclawbay.com/docs)
- [TheClawBay Dashboard](https://theclawbay.com)
- [Pi Custom Provider Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
