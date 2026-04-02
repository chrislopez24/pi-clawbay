# TheClawBay Provider for Pi Coding Agent

A provider extension for [pi coding agent](https://github.com/badlogic/pi-mono) that enables access to GPT-5, Codex, and Claude models through [TheClawBay](https://theclawbay.com) API.

## Features

- **GPT-5 & Codex Models** - Access via OpenAI-compatible Responses API
- **Claude Models** - Access via Anthropic-compatible Messages API
- **High Usage Headroom** - More capacity than standard subscriptions
- **Simple Setup** - Single API key for all models

## Installation

### Option 1: Load extension directly

```bash
pi -e /path/to/pi-clawbay
```

### Option 2: Install as dependency

```bash
cd your-project
npm install /path/to/pi-clawbay
```

Then add to your `.pi/agent/AGENTS.md` or load via extension config.

## Configuration

### Environment Variable

Set your TheClawBay API key:

```bash
export THECLAWBAY_API_KEY=your-api-key-here
```

Get your API key from [TheClawBay Dashboard](https://theclawbay.com).

### Available Models

#### GPT/Codex Models (`theclawbay/*`)

| Model ID | Name | Description |
|----------|------|-------------|
| `gpt-5.4` | GPT-5.4 | Frontier coding model with widest headroom |
| `gpt-5.3-codex` | GPT-5.3 Codex | Strong daily-driver for heavier work |
| `gpt-5.2-codex` | GPT-5.2 Codex | Stable compatibility for older flows |
| `gpt-5.2` | GPT-5.2 | Balanced non-Codex option |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max | Higher-throughput for longer sessions |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini | Lower-cost for quick iterations |

#### Claude Models (`theclawbay-claude/*`)

| Model ID | Name | Description |
|----------|------|-------------|
| `claude-opus-4-6` | Claude Opus 4.6 | Most capable for complex tasks |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | Near-Opus at lower cost |

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
  // - theclawbay/gpt-5.3-codex
  // - theclawbay-claude/claude-opus-4-6
  // - theclawbay-claude/claude-sonnet-4-6
}
```

## API Reference

### Endpoints

| Provider | Base URL | API Type |
|----------|----------|----------|
| `theclawbay` | `https://api.theclawbay.com/v1` | OpenAI Responses |
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
```

## Resources

- [TheClawBay Docs](https://theclawbay.com/docs)
- [TheClawBay Dashboard](https://theclawbay.com)
- [Pi Custom Provider Docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)

## License

MIT
