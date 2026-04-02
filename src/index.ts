/**
 * TheClawBay Provider Extension for Pi Coding Agent
 *
 * Provides access to GPT-5, Codex, and Claude models through TheClawBay API.
 * Uses two provider endpoints:
 * - `theclawbay`: OpenAI-compatible endpoint for GPT/Codex models
 * - `theclawbay-claude`: Anthropic-compatible endpoint for Claude models
 *
 * Features:
 * - /quota command to check detailed usage
 *
 * Usage:
 *   pi -e ./pi-clawbay
 *   # Then set THECLAWBAY_API_KEY=... or use /model to select a model
 *
 * Get your API key at: https://theclawbay.com
 */

import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const THECLAWBAY_OPENAI_BASE_URL = "https://api.theclawbay.com/v1";
const THECLAWBAY_ANTHROPIC_BASE_URL = "https://api.theclawbay.com/anthropic";
const THECLAWBAY_QUOTA_URL = "https://theclawbay.com/api/codex-auth/v1/quota";
const THECLAWBAY_OPENAI_MODELS_URL = `${THECLAWBAY_OPENAI_BASE_URL}/models`;
const THECLAWBAY_ANTHROPIC_MODELS_URL = `${THECLAWBAY_ANTHROPIC_BASE_URL}/v1/models`;
const ANTHROPIC_VERSION_HEADER = "2023-06-01";

const MODEL_INPUTS = ["text", "image"] as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const OPENAI_KNOWN_COSTS: Record<string, ProviderModelConfig["cost"]> = {
	"gpt-5.4": { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 2.5 },
	"gpt-5.4-mini": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-5.3-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.2-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.2": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.1-codex-max": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-5.1-codex-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
};
const OPENAI_DEFAULT_CONTEXT_WINDOW = 400000;
const OPENAI_FRONTIER_CONTEXT_WINDOW = 1050000;
const OPENAI_DEFAULT_MAX_TOKENS = 128000;
const ANTHROPIC_DEFAULT_CONTEXT_WINDOW = 200000;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 64000;

const FALLBACK_OPENAI_MODEL_IDS = [
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];

const FALLBACK_ANTHROPIC_MODEL_IDS = [
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5-20251001",
];

interface OpenAIModelListResponse {
	data?: Array<{
		id?: string;
	}>;
}

interface AnthropicModelListResponse {
	data?: Array<{
		id?: string;
		display_name?: string;
	}>;
}

function dedupeIds(ids: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];

	for (const id of ids) {
		if (!seen.has(id)) {
			seen.add(id);
			deduped.push(id);
		}
	}

	return deduped;
}

function toTitleCase(value: string): string {
	if (value.length === 0) {
		return value;
	}

	return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatOpenAIModelName(id: string): string {
	if (id.startsWith("gpt-")) {
		const suffix = id
			.slice(4)
			.split("-")
			.map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : toTitleCase(part)))
			.join(" ");
		return `GPT-${suffix}`;
	}

	return id
		.split("-")
		.map((part) => (/^\d+(\.\d+)?$/.test(part) ? part.toUpperCase() : toTitleCase(part)))
		.join(" ");
}

function formatClaudeModelName(id: string): string {
	const parts = id.split("-");
	if (parts.length < 4 || parts[0] !== "claude") {
		return id
			.split("-")
			.map((part) => toTitleCase(part))
			.join(" ");
	}

	const version = `${parts[2]}.${parts[3]}`;
	const suffix = parts.slice(4).join(" ");
	return suffix.length > 0
		? `Claude ${toTitleCase(parts[1])} ${version} ${suffix}`
		: `Claude ${toTitleCase(parts[1])} ${version}`;
}

function createModelConfig(
	id: string,
	name: string,
	cost: ProviderModelConfig["cost"],
	contextWindow: number,
	maxTokens: number
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: true,
		input: [...MODEL_INPUTS],
		cost: { ...cost },
		contextWindow,
		maxTokens,
	};
}

function createOpenAIModel(id: string): ProviderModelConfig {
	const cost = OPENAI_KNOWN_COSTS[id] ?? ZERO_COST;

	if (id === "gpt-5.4") {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_FRONTIER_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	if (id === "gpt-5.4-pro") {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_FRONTIER_CONTEXT_WINDOW, 272000);
	}

	return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_DEFAULT_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
}

function createAnthropicModel(id: string, displayName?: string): ProviderModelConfig {
	const name = displayName?.trim() || formatClaudeModelName(id);

	switch (id) {
		case "claude-opus-4-6":
			return createModelConfig(id, name, { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 }, 200000, 128000);
		case "claude-sonnet-4-6":
			return createModelConfig(id, name, { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }, 200000, 64000);
		case "claude-haiku-4-5":
		case "claude-haiku-4-5-20251001":
			return createModelConfig(id, name, { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 }, 200000, 64000);
		default:
			return createModelConfig(id, name, ZERO_COST, ANTHROPIC_DEFAULT_CONTEXT_WINDOW, ANTHROPIC_DEFAULT_MAX_TOKENS);
	}
}

function buildFallbackOpenAIModels(): ProviderModelConfig[] {
	return dedupeIds(FALLBACK_OPENAI_MODEL_IDS).map((id) => createOpenAIModel(id));
}

function buildFallbackAnthropicModels(): ProviderModelConfig[] {
	return dedupeIds(FALLBACK_ANTHROPIC_MODEL_IDS).map((id) => createAnthropicModel(id));
}

function registerProviders(
	pi: ExtensionAPI,
	openaiModels: ProviderModelConfig[],
	anthropicModels: ProviderModelConfig[]
) {
	pi.registerProvider("theclawbay", {
		baseUrl: THECLAWBAY_OPENAI_BASE_URL,
		apiKey: "THECLAWBAY_API_KEY",
		api: "openai-responses",
		authHeader: true,
		models: openaiModels,
	});

	pi.registerProvider("theclawbay-claude", {
		baseUrl: THECLAWBAY_ANTHROPIC_BASE_URL,
		apiKey: "THECLAWBAY_API_KEY",
		api: "anthropic-messages",
		authHeader: true,
		models: anthropicModels,
	});
}

async function fetchOpenAIModels(apiKey: string): Promise<ProviderModelConfig[] | null> {
	try {
		const response = await fetch(THECLAWBAY_OPENAI_MODELS_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as OpenAIModelListResponse;
		const ids = dedupeIds(
			(payload.data ?? [])
				.map((entry) => entry.id?.trim())
				.filter((id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("claude-"))
		);

		return ids.length > 0 ? ids.map((id) => createOpenAIModel(id)) : null;
	} catch {
		return null;
	}
}

async function fetchAnthropicModels(apiKey: string): Promise<ProviderModelConfig[] | null> {
	try {
		const response = await fetch(THECLAWBAY_ANTHROPIC_MODELS_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"anthropic-version": ANTHROPIC_VERSION_HEADER,
			},
		});

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as AnthropicModelListResponse;
		const models = dedupeIds(
			(payload.data ?? [])
				.map((entry) => entry.id?.trim())
				.filter((id): id is string => Boolean(id))
		).map((id) => {
			const match = (payload.data ?? []).find((entry) => entry.id?.trim() === id);
			return createAnthropicModel(id, match?.display_name);
		});

		return models.length > 0 ? models : null;
	} catch {
		return null;
	}
}

async function refreshProviderModels(pi: ExtensionAPI): Promise<void> {
	const apiKey = getApiKey();
	if (!apiKey) {
		return;
	}

	const [openaiResult, anthropicResult] = await Promise.all([
		fetchOpenAIModels(apiKey),
		fetchAnthropicModels(apiKey),
	]);

	const openaiModels = openaiResult ?? buildFallbackOpenAIModels();
	const anthropicModels = anthropicResult ?? buildFallbackAnthropicModels();

	registerProviders(pi, openaiModels, anthropicModels);

	if (openaiResult || anthropicResult) {
		console.info(
			`[theclawbay] Registered ${openaiModels.length} OpenAI-compatible models and ${anthropicModels.length} Anthropic-compatible models from live model discovery.`
		);
	}
}

interface QuotaWindow {
	secondsUntilReset?: number;
	requestCount?: number;
	estimatedCostUsdUsed?: number | null;
	costUsdLimit?: number | null;
	percentUsed: number;
	limitReached?: boolean;
}

/**
 * Quota response from TheClawBay API
 */
interface QuotaResponse {
	usageLimitPresentation?: string;
	usage?: {
		fiveHour?: QuotaWindow;
		weekly?: QuotaWindow;
	};
	fiveHourLimitReached?: boolean;
	weeklyLimitReached?: boolean;
	anyLimitReached?: boolean;
}

/**
 * Fetch quota information from TheClawBay API
 */
async function fetchQuota(apiKey: string): Promise<QuotaResponse | null> {
	try {
		const response = await fetch(THECLAWBAY_QUOTA_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as QuotaResponse;
	} catch {
		return null;
	}
}

function getApiKey(): string | undefined {
	return process.env.THECLAWBAY_API_KEY;
}

function getQuotaWindows(quota: QuotaResponse): { fiveHour?: QuotaWindow; weekly?: QuotaWindow } {
	return {
		fiveHour: quota.usage?.fiveHour,
		weekly: quota.usage?.weekly,
	};
}

/**
 * Format percentage with color based on usage level
 */
function formatPercent(percent: number): { text: string; color: "dim" | "warning" | "error" } {
	const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : percent >= 0.1 ? 2 : 3;

	if (percent >= 90) {
		return { text: `${percent.toFixed(digits)}%`, color: "error" };
	}
	if (percent >= 70) {
		return { text: `${percent.toFixed(digits)}%`, color: "warning" };
	}
	return { text: `${percent.toFixed(digits)}%`, color: "dim" };
}

function formatDuration(seconds?: number): string {
	if (seconds === undefined) {
		return "unknown";
	}

	const totalSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${secs}s`;
	}
	return `${secs}s`;
}

function formatQuotaDetails(label: string, window?: QuotaWindow): string {
	if (!window) {
		return `${label}: N/A`;
	}

	const percent = formatPercent(window.percentUsed).text;
	const costUsed = window.estimatedCostUsdUsed;
	const costLimit = window.costUsdLimit;
	const hasUsd = typeof costUsed === "number" && typeof costLimit === "number";
	const usage = hasUsd
		? `${percent} ($${costUsed.toFixed(2)}/$${costLimit.toFixed(2)})`
		: percent;

	return `${label}: ${usage} • ${window.requestCount ?? 0} req • resets ${formatDuration(window.secondsUntilReset)}`;
}

/**
 * Register TheClawBay providers with pi coding agent
 */
export default function (pi: ExtensionAPI) {
	const apiKey = getApiKey();

	if (!apiKey) {
		console.warn(
			"\x1b[33m⚠️  TheClawBay API key not set.\x1b[0m\n" +
				"   Set THECLAWBAY_API_KEY environment variable:\n" +
				"   export THECLAWBAY_API_KEY=your-key-here\n" +
				"   Get your key at: https://theclawbay.com\n"
		);
	}

	registerProviders(pi, buildFallbackOpenAIModels(), buildFallbackAnthropicModels());
	void refreshProviderModels(pi);

	// Register single quota command
	pi.registerCommand("quota", {
		description: "Check TheClawBay quota usage",
		handler: async (_args, ctx) => {
			const currentApiKey = getApiKey();
			if (!currentApiKey) {
				ctx.ui.notify("THECLAWBAY_API_KEY is not set", "error");
				return;
			}

			const quota = await fetchQuota(currentApiKey);
			if (!quota) {
				ctx.ui.notify("Failed to fetch quota from TheClawBay", "error");
				return;
			}

			const { fiveHour, weekly } = getQuotaWindows(quota);
			ctx.ui.notify(`${formatQuotaDetails("5h", fiveHour)} | ${formatQuotaDetails("Week", weekly)}`, "info");
		},
	});
}
