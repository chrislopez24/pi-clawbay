import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	MODEL_CACHE_TTL_MS,
	MODEL_CACHE_VERSION,
	MODEL_DISCOVERY_MAX_ATTEMPTS,
	MODEL_DISCOVERY_RETRY_DELAY_MS,
	MODEL_DISCOVERY_TIMEOUT_MS,
	THECLAWBAY_ANTHROPIC_VERSION_HEADER,
	THECLAWBAY_CLAUDE_MODELS_URL,
	THECLAWBAY_OPENAI_MODELS_URL,
} from "./constants.js";
import { buildFallbackOpenAIModels, buildOpenAIModels, isClaudeModelId, normalizeOpenAIModelIds, normalizeOpenAIModelMetadata } from "./models.js";
import { registerProviders } from "./provider.js";
import type { ClaudeModelListResponse, ModelCacheFile, OpenAIModelListResponse, TheClawBayModelMetadata } from "./types.js";

export function getModelCachePath(): string {
	const overrideDir = process.env.PI_CLAWBAY_CACHE_DIR?.trim();
	if (overrideDir) {
		return join(overrideDir, "models.json");
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "cache", "pi-clawbay", "models.json");
}

function debugLog(message: string): void {
	if (process.env.PI_CLAWBAY_DEBUG === "1") {
		console.info(`[theclawbay:debug] ${message}`);
	}
}

export function readCachedModelIds(now = Date.now(), options?: { allowStale?: boolean }): string[] | null {
	const metadata = readCachedModelMetadata(now, options);
	return metadata ? metadata.map((model) => model.id) : null;
}

export function readCachedModelMetadata(now = Date.now(), options?: { allowStale?: boolean }): TheClawBayModelMetadata[] | null {
	try {
		const cachePath = getModelCachePath();
		if (!existsSync(cachePath)) {
			return null;
		}

		return readValidCacheFile(cachePath, now, options);
	} catch (error) {
		debugLog(`Ignoring unreadable model cache: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function readValidCacheFile(cachePath: string, now: number, options?: { allowStale?: boolean }): TheClawBayModelMetadata[] | null {
	const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCacheFile;
	if (!isSupportedCacheVersion(parsed.version) || typeof parsed.fetchedAt !== "string") {
		return null;
	}

	const fetchedAt = Date.parse(parsed.fetchedAt);
	if (!Number.isFinite(fetchedAt)) {
		return null;
	}

	if (!options?.allowStale && now - fetchedAt > MODEL_CACHE_TTL_MS) {
		return null;
	}

	const rawModels = extractCachedModelMetadata(parsed);
	const models = normalizeOpenAIModelMetadata(rawModels, { includePinned: true });
	return models.length > 0 ? models : null;
}

function isSupportedCacheVersion(version: unknown): boolean {
	return version === MODEL_CACHE_VERSION || version === 2 || version === 1;
}

function extractCachedModelMetadata(parsed: ModelCacheFile): TheClawBayModelMetadata[] {
	if (Array.isArray(parsed.models)) {
		return parsed.models
			.map(normalizeCachedModelEntry)
			.filter((model): model is TheClawBayModelMetadata => model !== null);
	}

	const rawIds = Array.isArray(parsed.modelIds) ? parsed.modelIds : [];
	return normalizeOpenAIModelIds(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0), { includePinned: true }).map(
		(id) => ({ id })
	);
}

function normalizeCachedModelEntry(entry: unknown): TheClawBayModelMetadata | null {
	if (!entry || typeof entry !== "object") {
		return null;
	}

	const source = entry as Partial<TheClawBayModelMetadata>;
	if (typeof source.id !== "string" || source.id.trim().length === 0) {
		return null;
	}

	return {
		id: source.id.trim(),
		...(typeof source.name === "string" && source.name.trim().length > 0 ? { name: source.name.trim() } : {}),
		...(isPositiveInteger(source.contextWindow) ? { contextWindow: source.contextWindow } : {}),
		...(typeof source.supportsReasoning === "boolean" ? { supportsReasoning: source.supportsReasoning } : {}),
		...(Array.isArray(source.supportedReasoningEfforts)
			? { supportedReasoningEfforts: source.supportedReasoningEfforts.filter(isNonEmptyString) }
			: {}),
		...(source.defaultReasoningEffort === null || typeof source.defaultReasoningEffort === "string"
			? { defaultReasoningEffort: source.defaultReasoningEffort }
			: {}),
	};
}

export function writeCachedModelIds(ids: string[], now = Date.now()): void {
	writeCachedModelMetadata(ids.map((id) => ({ id })), now);
}

export function writeCachedModelMetadata(models: TheClawBayModelMetadata[], now = Date.now()): void {
	try {
		const cachePath = getModelCachePath();
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, `${JSON.stringify(buildCacheFile(models, now), null, 2)}\n`, "utf8");
	} catch (error) {
		debugLog(`Failed to write model cache: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function buildCacheFile(models: TheClawBayModelMetadata[], now: number): ModelCacheFile {
	const normalized = normalizeOpenAIModelMetadata(models, { includePinned: true });
	return {
		version: MODEL_CACHE_VERSION,
		fetchedAt: new Date(now).toISOString(),
		modelIds: normalized.map((model) => model.id),
		models: normalized,
	};
}

export async function fetchOpenAIModelIds(apiKey: string): Promise<string[] | null> {
	const metadata = await fetchOpenAIModelMetadata(apiKey);
	return metadata ? metadata.map((model) => model.id) : null;
}

export async function fetchOpenAIModelMetadata(apiKey: string): Promise<TheClawBayModelMetadata[] | null> {
	for (let attempt = 1; attempt <= MODEL_DISCOVERY_MAX_ATTEMPTS; attempt += 1) {
		const metadata = await fetchCompleteOpenAIModelMetadata(apiKey);
		if (metadata) {
			return metadata;
		}
		if (attempt < MODEL_DISCOVERY_MAX_ATTEMPTS) {
			await waitForDiscoveryRetry();
		}
	}

	return null;
}

function waitForDiscoveryRetry(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, MODEL_DISCOVERY_RETRY_DELAY_MS));
}

async function fetchCompleteOpenAIModelMetadata(apiKey: string): Promise<TheClawBayModelMetadata[] | null> {
	const [openaiMetadata, claudeMetadata] = await Promise.all([fetchOpenAICompatibleModelMetadata(apiKey), fetchClaudeModelMetadata(apiKey)]);
	if (!openaiMetadata) {
		debugLog("Skipping partial live model registration because /v1/models did not return a usable model list.");
		return null;
	}

	if (!claudeMetadata) {
		debugLog("Skipping partial live model registration because /anthropic/v1/models did not return a usable model list.");
		return null;
	}

	const merged = normalizeOpenAIModelMetadata([...openaiMetadata, ...claudeMetadata], { includePinned: true });
	return merged.length > 0 ? merged : null;
}

async function fetchOpenAICompatibleModelMetadata(apiKey: string): Promise<TheClawBayModelMetadata[] | null> {
	try {
		const response = await fetch(THECLAWBAY_OPENAI_MODELS_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
		});

		if (!response.ok) {
			debugLog(`Model discovery failed with HTTP ${response.status}`);
			return null;
		}

		const payload = (await response.json()) as OpenAIModelListResponse;
		const models = normalizeOpenAIModelMetadata(extractModelMetadata(payload).filter((model) => !isClaudeModelId(model.id)), { includePinned: true });
		return models.length > 0 ? models : null;
	} catch (error) {
		debugLog(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

async function fetchClaudeModelMetadata(apiKey: string): Promise<TheClawBayModelMetadata[] | null> {
	try {
		const response = await fetch(THECLAWBAY_CLAUDE_MODELS_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"anthropic-version": THECLAWBAY_ANTHROPIC_VERSION_HEADER,
			},
			signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
		});

		if (!response.ok) {
			debugLog(`Claude model discovery failed with HTTP ${response.status}`);
			return null;
		}

		const payload = (await response.json()) as ClaudeModelListResponse;
		const models = normalizeOpenAIModelMetadata(extractClaudeModelMetadata(payload), { includePinned: false });
		return models;
	} catch (error) {
		debugLog(`Claude model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function extractModelMetadata(payload: OpenAIModelListResponse): TheClawBayModelMetadata[] {
	return (payload.data ?? [])
		.map((entry) => {
			const id = entry.id?.trim();
			if (!id) {
				return null;
			}

			return {
				id,
				...(typeof entry.display_name === "string" && entry.display_name.trim().length > 0 ? { name: entry.display_name.trim() } : {}),
				...(isPositiveInteger(entry.context_window) ? { contextWindow: entry.context_window } : {}),
				...(typeof entry.supports_reasoning === "boolean" ? { supportsReasoning: entry.supports_reasoning } : {}),
				...(Array.isArray(entry.supported_reasoning_efforts)
					? { supportedReasoningEfforts: entry.supported_reasoning_efforts.filter(isNonEmptyString) }
					: {}),
				...(entry.default_reasoning_effort === null || typeof entry.default_reasoning_effort === "string"
					? { defaultReasoningEffort: entry.default_reasoning_effort }
					: {}),
			};
		})
		.filter((model): model is TheClawBayModelMetadata => model !== null);
}

function extractClaudeModelMetadata(payload: ClaudeModelListResponse): TheClawBayModelMetadata[] {
	return (payload.data ?? [])
		.map((entry) => {
			const id = entry.id?.trim();
			if (!id) {
				return null;
			}

			return {
				id,
				...(typeof entry.display_name === "string" && entry.display_name.trim().length > 0 ? { name: entry.display_name.trim() } : {}),
			};
		})
		.filter((model): model is TheClawBayModelMetadata => model !== null);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export async function refreshProviderModelsNow(pi: ExtensionAPI, apiKey: string): Promise<number | null> {
	const metadata = await fetchOpenAIModelMetadata(apiKey);
	if (!metadata) {
		return null;
	}

	writeCachedModelMetadata(metadata);
	const models = buildOpenAIModels(metadata);
	registerProviders(pi, models);
	return models.length;
}

export function registerModelRefreshCommand(pi: ExtensionAPI, getApiKey: () => string | undefined): void {
	pi.registerCommand("clawbay-refresh-models", {
		description: "Refresh TheClawBay models from live discovery",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const apiKey = getApiKey();
			if (!apiKey) {
				ctx.ui.notify("THECLAWBAY_API_KEY is not set", "error");
				return;
			}

			let count: number | null;
			try {
				count = await refreshProviderModelsNow(pi, apiKey);
			} catch (error) {
				ctx.ui.notify(`Failed to refresh TheClawBay models: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			if (count === null) {
				ctx.ui.notify("Failed to refresh TheClawBay models from live discovery", "error");
				return;
			}

			const noun = count === 1 ? "model" : "models";
			ctx.ui.notify(`Refreshed ${count} TheClawBay ${noun} from live discovery`, "info");
		},
	});
}

export async function resolveStartupProviderModels(apiKey?: string): Promise<{ models: ProviderModelConfig[]; source: "live" | "fallback" | "cache" }> {
	if (apiKey) {
		const liveMetadata = await fetchOpenAIModelMetadata(apiKey);
		if (liveMetadata) {
			writeCachedModelMetadata(liveMetadata);
			return { models: buildOpenAIModels(liveMetadata), source: "live" };
		}
	}

	const cachedModels = readCachedModelMetadata(Date.now(), { allowStale: true });
	if (cachedModels) {
		return { models: buildOpenAIModels(cachedModels), source: "cache" };
	}

	return { models: buildFallbackOpenAIModels(), source: "fallback" };
}
