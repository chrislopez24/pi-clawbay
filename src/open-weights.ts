import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_DEFAULT_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS, THECLAWBAY_OPENAI_DISCOVERY_BASE_URL } from "./constants.js";
import type { TheClawBayModelMetadata } from "./types.js";

type ModelCompat = NonNullable<ProviderModelConfig["compat"]>;
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

const OPEN_WEIGHT_MODEL_ID_PATTERNS = [/^gemma[-.]/i, /^glm[-.]/i, /^kimi[-.]/i, /^mimo[-.]/i, /^minimax[-.]/i, /^qwen/i] as const;
const CACHE_VERIFIED_OPEN_WEIGHT_MODEL_IDS = new Set(["glm-5.2", "glm-5.1", "kimi-k2.6", "kimi-k2.7-code", "mimo-v2.5-pro"]);
const REASONING_OPEN_WEIGHT_MODEL_IDS = new Set(["glm-5.2"]);

const OPEN_WEIGHT_COMPAT: ModelCompat = {
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: true,
};

const GLM_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "max",
};

export function isOpenWeightModelId(id: string): boolean {
	return OPEN_WEIGHT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(id));
}

export function isCacheVerifiedOpenWeightModelId(id: string): boolean {
	return CACHE_VERIFIED_OPEN_WEIGHT_MODEL_IDS.has(id);
}

function isReasoningOpenWeightModelId(id: string): boolean {
	return REASONING_OPEN_WEIGHT_MODEL_IDS.has(id);
}

export function formatOpenWeightModelName(id: string, formatPart: (part: string) => string): string {
	if (/^glm[-.]/i.test(id)) {
		return `GLM ${id.replace(/^glm[-.]?/i, "").split("-").map(formatPart).join(" ")}`;
	}

	if (/^kimi[-.]/i.test(id)) {
		return `Kimi ${id.replace(/^kimi[-.]?/i, "").split("-").map(formatPart).join(" ")}`;
	}

	if (/^mimo[-.]/i.test(id)) {
		return `Mimo ${id.replace(/^mimo[-.]?/i, "").split("-").map(formatPart).join(" ")}`;
	}

	if (/^minimax[-.]/i.test(id)) {
		return `MiniMax ${id.replace(/^minimax[-.]?/i, "").split("-").map(formatPart).join(" ")}`;
	}

	if (/^qwen/i.test(id)) {
		return `Qwen ${id.replace(/^qwen[-.]?/i, "").split("-").map(formatPart).join(" ")}`;
	}

	return id.split("-").map(formatPart).join(" ");
}

export function createOpenWeightModelConfig(
	metadata: TheClawBayModelMetadata,
	name: string,
	cost: ProviderModelConfig["cost"]
): ProviderModelConfig {
	const reasoning = isReasoningOpenWeightModelId(metadata.id);

	return {
		id: metadata.id,
		name,
		api: "openai-completions",
		baseUrl: THECLAWBAY_OPENAI_DISCOVERY_BASE_URL,
		reasoning,
		...(reasoning ? { thinkingLevelMap: { ...GLM_THINKING_LEVEL_MAP } } : {}),
		input: ["text"],
		cost: { ...cost },
		contextWindow: metadata.contextWindow ?? OPENAI_DEFAULT_CONTEXT_WINDOW,
		maxTokens: OPENAI_DEFAULT_MAX_TOKENS,
		compat: { ...OPEN_WEIGHT_COMPAT },
	};
}
