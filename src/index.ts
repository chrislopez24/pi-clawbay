/**
 * TheClawBay Provider Extension for Pi Coding Agent
 *
 * Provides access to GPT-5, Codex, and Claude models through TheClawBay API.
 * Uses two provider endpoints:
 * - `theclawbay`: OpenAI-compatible endpoint for GPT/Codex models
 * - `theclawbay-claude`: Anthropic-compatible endpoint for Claude models
 *
 * Features:
 * - Shows quota usage in status line (only when using TheClawBay models)
 * - /quota command to check detailed usage
 *
 * Usage:
 *   pi -e ./pi-clawbay
 *   # Then set THECLAWBAY_API_KEY=... or use /model to select a model
 *
 * Get your API key at: https://theclawbay.com
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const THECLAWBAY_OPENAI_BASE_URL = "https://api.theclawbay.com/v1";
const THECLAWBAY_ANTHROPIC_BASE_URL = "https://api.theclawbay.com/anthropic";
const THECLAWBAY_QUOTA_URL = "https://theclawbay.com/api/codex-auth/v1/quota";

const THECLAWBAY_PROVIDERS = ["theclawbay", "theclawbay-claude"];
const THECLAWBAY_QUOTA_STATUS_KEY = "theclawbay-quota";

/**
 * GPT and Codex models available through TheClawBay OpenAI-compatible endpoint
 */
const OPENAI_MODELS = [
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		description: "Frontier coding model with the widest headroom",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		description: "Strong daily-driver Codex model for heavier work",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		description: "Stable compatibility option for older Codex flows",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		description: "Balanced GPT-5 path when you want a non-Codex option",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5.1-codex-max",
		name: "GPT-5.1 Codex Max",
		description: "Higher-throughput option for longer coding sessions",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5.1-codex-mini",
		name: "GPT-5.1 Codex Mini",
		description: "Lower-cost Codex path for quick iterations",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

/**
 * Claude models available through TheClawBay Anthropic-compatible endpoint
 */
const ANTHROPIC_MODELS = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		description: "Anthropic's most capable model for complex tasks",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		description: "Near-Opus intelligence at a fraction of the cost",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
];

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

function isTheClawBayProvider(provider: string | undefined): boolean {
	return provider !== undefined && THECLAWBAY_PROVIDERS.includes(provider);
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

	pi.registerProvider("theclawbay", {
		baseUrl: THECLAWBAY_OPENAI_BASE_URL,
		apiKey: "THECLAWBAY_API_KEY",
		api: "openai-responses",
		authHeader: true,
		models: OPENAI_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: [...m.input],
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	});

	pi.registerProvider("theclawbay-claude", {
		baseUrl: THECLAWBAY_ANTHROPIC_BASE_URL,
		apiKey: "THECLAWBAY_API_KEY",
		api: "anthropic-messages",
		authHeader: true,
		models: ANTHROPIC_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: [...m.input],
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	});

	const setQuotaUnavailableStatus = (ctx: any) => {
		ctx.ui.setStatus(THECLAWBAY_QUOTA_STATUS_KEY, ctx.ui.theme.fg("dim", "Quota: unavailable"));
	};

	const refreshQuotaStatus = async (ctx: any, provider: string | undefined) => {
		if (!isTheClawBayProvider(provider)) {
			ctx.ui.setStatus(THECLAWBAY_QUOTA_STATUS_KEY, undefined);
			return;
		}

		const currentApiKey = getApiKey();
		if (!currentApiKey) {
			setQuotaUnavailableStatus(ctx);
			return;
		}

		const quota = await fetchQuota(currentApiKey);
		if (!quota) {
			setQuotaUnavailableStatus(ctx);
			return;
		}

		updateQuotaStatus(ctx, quota, true);
	};

	pi.on("session_start", async (_event, ctx) => {
		await refreshQuotaStatus(ctx, ctx.model?.provider);
	});

	pi.on("model_select", async (event, ctx) => {
		await refreshQuotaStatus(ctx, event.model.provider);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshQuotaStatus(ctx, ctx.model?.provider);
	});

	const showQuota = async (ctx: any) => {
		const currentApiKey = getApiKey();
		if (!currentApiKey) {
			setQuotaUnavailableStatus(ctx);
			ctx.ui.notify("THECLAWBAY_API_KEY is not set", "error");
			return;
		}

		const quota = await fetchQuota(currentApiKey);
		if (!quota) {
			setQuotaUnavailableStatus(ctx);
			ctx.ui.notify("Failed to fetch quota from TheClawBay", "error");
			return;
		}

		updateQuotaStatus(ctx, quota, true);

		const { fiveHour, weekly } = getQuotaWindows(quota);
		ctx.ui.notify(`${formatQuotaDetails("5h", fiveHour)} | ${formatQuotaDetails("Week", weekly)}`, "info");
	};

	pi.registerCommand("quota", {
		description: "Check TheClawBay quota usage",
		handler: async (_args, ctx) => {
			await showQuota(ctx);
		},
	});

	pi.registerCommand("quotas", {
		description: "Check TheClawBay quota usage",
		handler: async (_args, ctx) => {
			await showQuota(ctx);
		},
	});
}

/**
 * Update quota status in the status line
 */
function updateQuotaStatus(ctx: any, quota: QuotaResponse, force: boolean = false) {
	const theme = ctx.ui.theme;
	const { fiveHour, weekly } = getQuotaWindows(quota);
	const parts: string[] = [];

	if (fiveHour) {
		const five = formatPercent(fiveHour.percentUsed);
		parts.push(theme.fg(five.color, `5h:${five.text}`));
	}

	if (weekly) {
		const week = formatPercent(weekly.percentUsed);
		parts.push(theme.fg(week.color, `w:${week.text}`));
	}

	if (parts.length > 0) {
		ctx.ui.setStatus(THECLAWBAY_QUOTA_STATUS_KEY, parts.join(" "));
	} else if (force) {
		ctx.ui.setStatus(THECLAWBAY_QUOTA_STATUS_KEY, theme.fg("dim", "Quota: N/A"));
	}
}
