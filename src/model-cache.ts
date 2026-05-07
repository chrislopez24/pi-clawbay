import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { MODEL_CACHE_TTL_MS, MODEL_CACHE_VERSION, THECLAWBAY_OPENAI_MODELS_URL } from "./constants.js";
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

export function readCachedModelIds(now = Date.now()): string[] | null {
	try {
		const cachePath = getModelCachePath();
		if (!existsSync(cachePath)) {
			return null;
		}

		return readValidCacheFile(cachePath, now);
	} catch {
		return null;
	}
}

function readValidCacheFile(cachePath: string, now: number): string[] | null {
	const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCacheFile;
	if (parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.modelIds) || typeof parsed.fetchedAt !== "string") {
		return null;
	}

	const fetchedAt = Date.parse(parsed.fetchedAt);
	if (!Number.isFinite(fetchedAt) || now - fetchedAt > MODEL_CACHE_TTL_MS) {
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
	} catch {
		// Cache writes are best-effort; provider registration should not fail if the cache is unavailable.
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
		});

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as OpenAIModelListResponse;
		const ids = normalizeOpenAIModelIds(extractModelIds(payload), { includePinned: true });
		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

function extractModelIds(payload: OpenAIModelListResponse): string[] {
	return (payload.data ?? [])
		.map((entry) => entry.id?.trim())
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function refreshProviderModels(pi: ExtensionAPI, apiKey: string): void {
	void fetchOpenAIModelIds(apiKey).then((ids) => {
		if (!ids) {
			return;
		}

		writeCachedModelIds(ids);
		const models = buildOpenAIModels(ids);
		try {
			registerProviders(pi, models);
		} catch (error) {
			console.warn(`[theclawbay] Skipped live model refresh: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		console.info(`[theclawbay] Registered ${models.length} OpenAI-compatible models from live model discovery.`);
	});
}

export function loadProviderModels(): { models: ProviderModelConfig[]; source: "fallback" | "cache" } {
	const cachedIds = readCachedModelIds();
	if (cachedIds) {
		return { models: buildOpenAIModels(cachedIds), source: "cache" };
	}

	return { models: buildFallbackOpenAIModels(), source: "fallback" };
}
