import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { MODEL_CACHE_TTL_MS, MODEL_CACHE_VERSION, MODEL_DISCOVERY_TIMEOUT_MS, THECLAWBAY_OPENAI_MODELS_URL } from "./constants.js";
import { buildFallbackOpenAIModels, buildOpenAIModels, normalizeOpenAIModelIds } from "./models.js";
import { registerProviders } from "./provider.js";
import type { ModelCacheFile, OpenAIModelListResponse } from "./types.js";

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

function readValidCacheFile(cachePath: string, now: number, options?: { allowStale?: boolean }): string[] | null {
	const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCacheFile;
	if (parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.modelIds) || typeof parsed.fetchedAt !== "string") {
		return null;
	}

	const fetchedAt = Date.parse(parsed.fetchedAt);
	if (!Number.isFinite(fetchedAt)) {
		return null;
	}

	if (!options?.allowStale && now - fetchedAt > MODEL_CACHE_TTL_MS) {
		return null;
	}

	const rawIds = parsed.modelIds.filter((id): id is string => typeof id === "string" && id.length > 0);
	const ids = normalizeOpenAIModelIds(rawIds, { includePinned: true });
	return ids.length > 0 ? ids : null;
}

export function writeCachedModelIds(ids: string[], now = Date.now()): void {
	try {
		const cachePath = getModelCachePath();
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, `${JSON.stringify(buildCacheFile(ids, now), null, 2)}\n`, "utf8");
	} catch (error) {
		// Cache writes are best-effort; provider registration should not fail if the cache is unavailable.
		debugLog(`Failed to write model cache: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function buildCacheFile(ids: string[], now: number): ModelCacheFile {
	return {
		version: MODEL_CACHE_VERSION,
		fetchedAt: new Date(now).toISOString(),
		modelIds: normalizeOpenAIModelIds(ids, { includePinned: true }),
	};
}

export async function fetchOpenAIModelIds(apiKey: string): Promise<string[] | null> {
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
		const ids = normalizeOpenAIModelIds(extractModelIds(payload), { includePinned: true });
		return ids.length > 0 ? ids : null;
	} catch (error) {
		debugLog(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function extractModelIds(payload: OpenAIModelListResponse): string[] {
	return (payload.data ?? [])
		.map((entry) => entry.id?.trim())
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function refreshProviderModelsNow(pi: ExtensionAPI, apiKey: string): Promise<number | null> {
	const ids = await fetchOpenAIModelIds(apiKey);
	if (!ids) {
		return null;
	}

	writeCachedModelIds(ids);
	const models = buildOpenAIModels(ids);
	registerProviders(pi, models);
	return models.length;
}

export function refreshProviderModels(pi: ExtensionAPI, apiKey: string): void {
	void refreshProviderModelsNow(pi, apiKey)
		.then((count) => {
			if (count === null) {
				return;
			}
			console.info(`[theclawbay] Registered ${count} OpenAI-compatible models from live model discovery.`);
		})
		.catch((error) => {
			console.warn(`[theclawbay] Skipped live model refresh: ${error instanceof Error ? error.message : String(error)}`);
		});
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

export function loadProviderModels(): { models: ProviderModelConfig[]; source: "fallback" | "cache" } {
	const cachedIds = readCachedModelIds(Date.now(), { allowStale: true });
	if (cachedIds) {
		return { models: buildOpenAIModels(cachedIds), source: "cache" };
	}

	return { models: buildFallbackOpenAIModels(), source: "fallback" };
}
