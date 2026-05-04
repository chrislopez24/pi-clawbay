/**
 * TheClawBay Provider Extension for Pi Coding Agent
 *
 * Provides access to GPT-5 and Codex models through TheClawBay API.
 * Uses a single provider endpoint:
 * - `theclawbay`: OpenAI-compatible endpoint for GPT/Codex models
 *
 * Features:
 * - /quota command to check detailed usage
 * - custom Codex-style transport without JWT account-id extraction
 * - GPT-5.4 exposed as two user-selectable variants: standard and [1m]
 *
 * Usage:
 *   pi -e ./pi-clawbay
 *   # Then set THECLAWBAY_API_KEY=... or use /model to select a model
 *
 * Get your API key at: https://theclawbay.com
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	streamSimpleOpenAIResponses,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const THECLAWBAY_OPENAI_DISCOVERY_BASE_URL = "https://api.theclawbay.com/v1";
const THECLAWBAY_CODEX_BASE_URL = "https://api.theclawbay.com/backend-api/codex";
const THECLAWBAY_QUOTA_URL = "https://theclawbay.com/api/codex-auth/v1/quota";
const THECLAWBAY_OPENAI_MODELS_URL = `${THECLAWBAY_OPENAI_DISCOVERY_BASE_URL}/models`;
const THECLAWBAY_CODEX_API = "theclawbay-codex-responses";
const THECLAWBAY_CHATGPT_ACCOUNT_ID = "theclawbay";
const MODEL_CACHE_VERSION = 1;
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const GPT_54_UPSTREAM_MODEL_ID = "gpt-5.4";
const GPT_54_DEFAULT_MODEL_ID = "gpt-5.4";
const GPT_54_1M_MODEL_ID = "gpt-5.4[1m]";

const MODEL_INPUTS = ["text", "image"] as const;
const GPT_54_AND_55_THINKING_LEVEL_MAP = { xhigh: "xhigh" } as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const OPENAI_KNOWN_COSTS: Record<string, ProviderModelConfig["cost"]> = {
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
const OPENAI_DEFAULT_CONTEXT_WINDOW = 258000;
const OPENAI_272K_CONTEXT_WINDOW = 272000;
const OPENAI_FRONTIER_CONTEXT_WINDOW = 1050000;
const OPENAI_DEFAULT_MAX_TOKENS = 128000;

const FALLBACK_OPENAI_MODEL_IDS = [
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

interface OpenAIModelListResponse {
	data?: Array<{
		id?: string;
	}>;
}

interface ModelCacheFile {
	version?: number;
	fetchedAt?: string;
	modelIds?: string[];
}

interface QuotaWindow {
	secondsUntilReset?: number;
	requestCount?: number;
	estimatedCostUsdUsed?: number | null;
	costUsdLimit?: number | null;
	percentUsed: number;
	limitReached?: boolean;
}

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
	if (id === GPT_54_DEFAULT_MODEL_ID) {
		return "GPT-5.4";
	}

	if (id === GPT_54_1M_MODEL_ID) {
		return "GPT-5.4 [1M]";
	}

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

function isGpt54Or55Model(id: string): boolean {
	return id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5");
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
		...(isGpt54Or55Model(id) ? { thinkingLevelMap: { ...GPT_54_AND_55_THINKING_LEVEL_MAP } } : {}),
		input: [...MODEL_INPUTS],
		cost: { ...cost },
		contextWindow,
		maxTokens,
	};
}

function createOpenAIModel(id: string): ProviderModelConfig {
	const cost = OPENAI_KNOWN_COSTS[id] ?? ZERO_COST;

	if (id === GPT_54_DEFAULT_MODEL_ID) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_272K_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	if (id === GPT_54_1M_MODEL_ID) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_FRONTIER_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_DEFAULT_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
}

function buildOpenAIModels(ids: string[]): ProviderModelConfig[] {
	return dedupeIds(ids).map((id) => createOpenAIModel(id));
}

function buildFallbackOpenAIModels(): ProviderModelConfig[] {
	return buildOpenAIModels(FALLBACK_OPENAI_MODEL_IDS);
}

function normalizeOpenAIModelIds(ids: string[]): string[] {
	return dedupeIds(
		ids.flatMap((id) => {
			if (id.startsWith("claude-")) {
				return [];
			}

			if (id === GPT_54_UPSTREAM_MODEL_ID) {
				return [GPT_54_DEFAULT_MODEL_ID, GPT_54_1M_MODEL_ID];
			}

			if (id === "gpt-5.4-pro") {
				return [];
			}

			return [id];
		})
	);
}

function resolveUpstreamModelId(id: string): string {
	if (id === GPT_54_1M_MODEL_ID) {
		return GPT_54_UPSTREAM_MODEL_ID;
	}

	return id;
}

function buildTheClawBayHeaders(options?: SimpleStreamOptions): Record<string, string> {
	return {
		...(options?.headers ?? {}),
		"chatgpt-account-id": THECLAWBAY_CHATGPT_ACCOUNT_ID,
		originator: "pi",
		"OpenAI-Beta": "responses=experimental",
		...(options?.sessionId ? { session_id: options.sessionId } : {}),
	};
}

function buildTheClawBayPayload(payload: unknown, context: Context): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}

	const source = payload as Record<string, unknown>;
	const include = Array.isArray(source.include)
		? source.include.filter((item): item is string => typeof item === "string")
		: [];
	const input = Array.isArray(source.input)
		? source.input.filter((item) => {
				if (!item || typeof item !== "object") {
					return true;
				}
				const role = (item as { role?: unknown }).role;
				return role !== "developer" && role !== "system";
			})
		: source.input;

	return {
		...source,
		instructions: context.systemPrompt,
		input,
		include: dedupeIds([...include, "reasoning.encrypted_content"]),
		text: { verbosity: "medium" },
		tool_choice: "auto",
		parallel_tool_calls: true,
		store: false,
	};
}

function streamSimpleTheClawBayCodexResponses(
	model: unknown,
	context: unknown,
	options?: unknown
): AssistantMessageEventStream {
	const typedModel = model as Model<"openai-responses">;
	const typedContext = context as Context;
	const typedOptions = options as SimpleStreamOptions | undefined;
	const originalOnPayload = typedOptions?.onPayload;
	const headers = buildTheClawBayHeaders(typedOptions);
	const remappedModel = {
		...typedModel,
		id: resolveUpstreamModelId(typedModel.id),
	} as Model<"openai-responses">;

	return streamSimpleOpenAIResponses(remappedModel, typedContext, {
		...typedOptions,
		headers,
		onPayload: async (payload, streamModel) => {
			const transformedPayload = buildTheClawBayPayload(payload, typedContext);
			const nextPayload = await originalOnPayload?.(transformedPayload, streamModel);
			return nextPayload === undefined ? transformedPayload : nextPayload;
		},
	});
}

function registerProviders(pi: ExtensionAPI, openaiModels: ProviderModelConfig[]) {
	pi.registerProvider("theclawbay", {
		baseUrl: THECLAWBAY_CODEX_BASE_URL,
		apiKey: "THECLAWBAY_API_KEY",
		api: THECLAWBAY_CODEX_API,
		streamSimple: streamSimpleTheClawBayCodexResponses,
		models: openaiModels,
	});
}

function getModelCachePath(): string {
	const overrideDir = process.env.PI_CLAWBAY_CACHE_DIR?.trim();
	if (overrideDir) {
		return join(overrideDir, "models.json");
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "cache", "pi-clawbay", "models.json");
}

function readCachedModelIds(now = Date.now()): string[] | null {
	try {
		const cachePath = getModelCachePath();
		if (!existsSync(cachePath)) {
			return null;
		}

		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCacheFile;
		if (parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.modelIds) || typeof parsed.fetchedAt !== "string") {
			return null;
		}

		const fetchedAt = Date.parse(parsed.fetchedAt);
		if (!Number.isFinite(fetchedAt) || now - fetchedAt > MODEL_CACHE_TTL_MS) {
			return null;
		}

		const ids = normalizeOpenAIModelIds(parsed.modelIds.filter((id): id is string => typeof id === "string" && id.length > 0));
		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

function writeCachedModelIds(ids: string[], now = Date.now()): void {
	try {
		const cachePath = getModelCachePath();
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(
			cachePath,
			JSON.stringify(
				{
					version: MODEL_CACHE_VERSION,
					fetchedAt: new Date(now).toISOString(),
					modelIds: normalizeOpenAIModelIds(ids),
				},
				null,
				2
			) + "\n",
			"utf8"
		);
	} catch {
		// Cache writes are best-effort; model registration should not fail because the filesystem is unavailable.
	}
}

async function fetchOpenAIModelIds(apiKey: string): Promise<string[] | null> {
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
		const ids = normalizeOpenAIModelIds(
			(payload.data ?? [])
				.map((entry) => entry.id?.trim())
				.filter((id): id is string => typeof id === "string" && id.length > 0)
		);

		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

function refreshProviderModels(pi: ExtensionAPI, apiKey: string): void {
	void fetchOpenAIModelIds(apiKey).then((ids) => {
		if (!ids) {
			return;
		}

		writeCachedModelIds(ids);
		const models = buildOpenAIModels(ids);
		registerProviders(pi, models);
		console.info(`[theclawbay] Registered ${models.length} OpenAI-compatible models from live model discovery.`);
	});
}

function loadProviderModels(): { models: ProviderModelConfig[]; source: "fallback" | "cache" } {
	const cachedIds = readCachedModelIds();
	if (cachedIds) {
		return { models: buildOpenAIModels(cachedIds), source: "cache" };
	}

	return { models: buildFallbackOpenAIModels(), source: "fallback" };
}

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

	const { models } = loadProviderModels();
	registerProviders(pi, models);

	if (apiKey) {
		refreshProviderModels(pi, apiKey);
	}

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
