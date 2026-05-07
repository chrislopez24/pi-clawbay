import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const THECLAWBAY_OPENAI_DISCOVERY_BASE_URL = "https://api.theclawbay.com/v1";
export const THECLAWBAY_CODEX_BASE_URL = "https://api.theclawbay.com/backend-api/codex";
export const THECLAWBAY_QUOTA_URL = "https://theclawbay.com/api/codex-auth/v1/quota";
export const THECLAWBAY_OPENAI_MODELS_URL = `${THECLAWBAY_OPENAI_DISCOVERY_BASE_URL}/models`;
export const THECLAWBAY_CODEX_API = "theclawbay-codex-responses";
export const THECLAWBAY_CHATGPT_ACCOUNT_ID = "theclawbay";

export const MODEL_CACHE_VERSION = 1;
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

export const GPT_54_UPSTREAM_MODEL_ID = "gpt-5.4";
export const GPT_54_DEFAULT_MODEL_ID = "gpt-5.4";
export const GPT_54_1M_MODEL_ID = "gpt-5.4[1m]";

export const MODEL_INPUTS = ["text", "image"] as const;
export const OPENAI_CODEX_THINKING_LEVEL_MAP = { xhigh: "xhigh", minimal: "low" } as const;
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const OPENAI_KNOWN_COSTS: Record<string, ProviderModelConfig["cost"]> = {
	"gpt-5.5": { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 5.0 },
	[GPT_54_DEFAULT_MODEL_ID]: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 2.5 },
	[GPT_54_1M_MODEL_ID]: { input: 5.0, output: 22.5, cacheRead: 0.5, cacheWrite: 5.0 },
	"gpt-5.4-mini": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-5.3-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.2-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.2": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.1-codex-max": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-5.1-codex-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
};
export const OPENAI_CODEX_CONTEXT_WINDOW = 272000;
export const OPENAI_DEFAULT_CONTEXT_WINDOW = OPENAI_CODEX_CONTEXT_WINDOW;
export const OPENAI_FRONTIER_CONTEXT_WINDOW = 1050000;
export const OPENAI_DEFAULT_MAX_TOKENS = 128000;

export const HIDDEN_MODEL_ID_PREFIXES = ["gpt-image-"] as const;
export const PINNED_MODEL_IDS: string[] = [];
export const FALLBACK_OPENAI_MODEL_IDS = [
	"gpt-5.5",
	GPT_54_DEFAULT_MODEL_ID,
	GPT_54_1M_MODEL_ID,
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];
