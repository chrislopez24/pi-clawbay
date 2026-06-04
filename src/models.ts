import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	FALLBACK_OPENAI_MODEL_IDS,
	HIDDEN_MODEL_ID_PREFIXES,
	GPT_IMAGE_2_MODEL_ID,
	GPT_54_1M_MODEL_ID,
	GPT_54_DEFAULT_MODEL_ID,
	GPT_54_UPSTREAM_MODEL_ID,
	IMAGE_GENERATION_MODEL_INPUTS,
	MODEL_INPUTS,
	OPENAI_CODEX_CONTEXT_WINDOW,
	OPENAI_DEFAULT_CONTEXT_WINDOW,
	OPENAI_DEFAULT_MAX_TOKENS,
	OPENAI_FRONTIER_CONTEXT_WINDOW,
	OPENAI_IMAGE_MAX_TOKENS,
	OPENAI_KNOWN_COSTS,
	PINNED_MODEL_IDS,
	ZERO_COST,
} from "./constants.js";
import { createDeepSeekModelConfig, formatDeepSeekModelName, isDeepSeekModelId } from "./deepseek-models.js";
import { createGoogleModelConfig, isGoogleModelId, resolveGoogleThinkingLevelMap, supportsGoogleThinking } from "./google-models.js";
import type { TheClawBayModelMetadata } from "./types.js";

export { isGoogleModelId } from "./google-models.js";

type ModelSource = string | TheClawBayModelMetadata;
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

const FALLBACK_REASONING_EFFORTS: Record<string, string[]> = {
	"gpt-5.5": ["low", "medium", "high", "xhigh"],
	[GPT_54_DEFAULT_MODEL_ID]: ["minimal", "low", "medium", "high"],
	[GPT_54_1M_MODEL_ID]: ["minimal", "low", "medium", "high"],
	"gpt-5.4-mini": ["minimal", "low", "medium", "high"],
	"gpt-5.3-codex": ["low", "medium", "high"],
	"codex-auto-review": ["low", "medium", "high"],
	"gpt-5.2-codex": ["low", "medium", "high", "xhigh"],
	"gpt-5.2": ["none", "low", "medium", "high", "xhigh"],
	"gpt-5.1-codex-max": ["none", "medium", "high", "xhigh"],
	"gpt-5.1-codex-mini": ["medium", "high"],
};

export function dedupeIds(ids: string[]): string[] {
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

function dedupeModelMetadata(models: TheClawBayModelMetadata[]): TheClawBayModelMetadata[] {
	const seen = new Set<string>();
	const deduped: TheClawBayModelMetadata[] = [];

	for (const model of models) {
		if (!seen.has(model.id)) {
			seen.add(model.id);
			deduped.push(model);
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
	if (id === GPT_IMAGE_2_MODEL_ID) {
		return "GPT Image 2";
	}

	if (id === GPT_54_DEFAULT_MODEL_ID) {
		return "GPT-5.4";
	}

	if (id === GPT_54_1M_MODEL_ID) {
		return "GPT-5.4 [1M]";
	}

	return formatGenericModelName(id);
}

function formatGenericModelName(id: string): string {
	if (id.startsWith("gpt-")) {
		const suffix = id.slice(4).split("-").map(formatModelNamePart).join(" ");
		return `GPT-${suffix}`;
	}

	if (isDeepSeekModelId(id)) {
		return formatDeepSeekModelName(id, formatModelNamePart);
	}

	return id.split("-").map(formatModelNamePart).join(" ");
}

function formatModelNamePart(part: string): string {
	return /^\d+(\.\d+)?$/.test(part) ? part.toUpperCase() : toTitleCase(part);
}

export function isSupportedImageGenerationModel(id: string): boolean {
	return id === GPT_IMAGE_2_MODEL_ID;
}

function isHiddenImageGenerationModel(id: string): boolean {
	return HIDDEN_MODEL_ID_PREFIXES.some((prefix) => id.startsWith(prefix)) && !isSupportedImageGenerationModel(id);
}

function toModelMetadata(source: ModelSource): TheClawBayModelMetadata {
	return typeof source === "string" ? { id: source } : source;
}

function withFallbackMetadata(id: string): TheClawBayModelMetadata {
	return {
		id,
		...(FALLBACK_REASONING_EFFORTS[id]
			? { supportsReasoning: true, supportedReasoningEfforts: [...FALLBACK_REASONING_EFFORTS[id]] }
			: {}),
	};
}

function createModelConfig(
	id: string,
	name: string,
	cost: ProviderModelConfig["cost"],
	contextWindow: number,
	maxTokens: number,
	options?: {
		api?: ProviderModelConfig["api"];
		baseUrl?: string;
		reasoning?: boolean;
		thinkingLevelMap?: ThinkingLevelMap;
	}
): ProviderModelConfig {
	const isImageModel = isSupportedImageGenerationModel(id);
	const isReasoningModel = options?.reasoning ?? !isImageModel;

	return {
		id,
		name,
		...(options?.api ? { api: options.api } : {}),
		...(options?.baseUrl ? { baseUrl: options.baseUrl } : {}),
		reasoning: isReasoningModel,
		...(isReasoningModel && options?.thinkingLevelMap ? { thinkingLevelMap: { ...options.thinkingLevelMap } } : {}),
		input: isImageModel ? [...IMAGE_GENERATION_MODEL_INPUTS] : [...MODEL_INPUTS],
		cost: { ...cost },
		contextWindow,
		maxTokens,
	};
}

function resolveReasoning(metadata: TheClawBayModelMetadata): boolean {
	if (isSupportedImageGenerationModel(metadata.id)) {
		return false;
	}

	if (isGoogleModelId(metadata.id)) {
		return supportsGoogleThinking(metadata.id);
	}

	if (typeof metadata.supportsReasoning === "boolean") {
		return metadata.supportsReasoning;
	}

	return true;
}

function resolveThinkingLevelMap(metadata: TheClawBayModelMetadata): ThinkingLevelMap | undefined {
	if (!resolveReasoning(metadata)) {
		return undefined;
	}

	if (isGoogleModelId(metadata.id)) {
		return resolveGoogleThinkingLevelMap(metadata.id);
	}

	if (metadata.supportedReasoningEfforts) {
		return buildThinkingLevelMap(metadata.supportedReasoningEfforts);
	}

	const fallbackEfforts = FALLBACK_REASONING_EFFORTS[metadata.id];
	return fallbackEfforts ? buildThinkingLevelMap(fallbackEfforts) : undefined;
}

function buildThinkingLevelMap(efforts: string[]): ThinkingLevelMap {
	const supported = new Set(efforts.filter((effort) => typeof effort === "string" && effort.length > 0));
	return {
		off: supported.has("none") ? "none" : null,
		minimal: supported.has("minimal") ? "minimal" : supported.has("low") ? "low" : null,
		low: supported.has("low") ? "low" : null,
		medium: supported.has("medium") ? "medium" : null,
		high: supported.has("high") ? "high" : null,
		xhigh: supported.has("xhigh") ? "xhigh" : supported.has("max") ? "max" : null,
	};
}

function resolveContextWindow(metadata: TheClawBayModelMetadata, fallback: number): number {
	return metadata.contextWindow ?? fallback;
}

function createOpenAIModel(source: ModelSource): ProviderModelConfig {
	const metadata = toModelMetadata(source);
	const id = metadata.id;
	const cost = OPENAI_KNOWN_COSTS[id] ?? ZERO_COST;
	const name = metadata.name?.trim() || formatOpenAIModelName(id);
	const options = { reasoning: resolveReasoning(metadata), thinkingLevelMap: resolveThinkingLevelMap(metadata) };

	if (id === GPT_54_DEFAULT_MODEL_ID) {
		return createModelConfig(id, name, cost, resolveContextWindow(metadata, OPENAI_CODEX_CONTEXT_WINDOW), OPENAI_DEFAULT_MAX_TOKENS, options);
	}

	if (id === GPT_54_1M_MODEL_ID) {
		return createModelConfig(id, name, cost, OPENAI_FRONTIER_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS, options);
	}

	if (id === GPT_IMAGE_2_MODEL_ID) {
		return createModelConfig(id, name, cost, resolveContextWindow(metadata, OPENAI_DEFAULT_CONTEXT_WINDOW), OPENAI_IMAGE_MAX_TOKENS, options);
	}

	if (isGoogleModelId(id)) {
		return createGoogleModelConfig({ id, name, cost });
	}

	if (isDeepSeekModelId(id)) {
		return createDeepSeekModelConfig(metadata, name, cost);
	}

	return createModelConfig(id, name, cost, resolveContextWindow(metadata, OPENAI_DEFAULT_CONTEXT_WINDOW), OPENAI_DEFAULT_MAX_TOKENS, options);
}

export function buildOpenAIModels(sources: ModelSource[]): ProviderModelConfig[] {
	return dedupeModelMetadata(sources.map(toModelMetadata)).map((model) => createOpenAIModel(model));
}

export function buildFallbackOpenAIModels(): ProviderModelConfig[] {
	return buildOpenAIModels(FALLBACK_OPENAI_MODEL_IDS.map(withFallbackMetadata));
}

export function normalizeOpenAIModelIds(ids: string[], options?: { includePinned?: boolean }): string[] {
	const normalized = dedupeIds(ids.flatMap(normalizeOpenAIModelId));
	return options?.includePinned ? dedupeIds([...normalized, ...PINNED_MODEL_IDS]) : normalized;
}

export function normalizeOpenAIModelMetadata(
	models: TheClawBayModelMetadata[],
	options?: { includePinned?: boolean }
): TheClawBayModelMetadata[] {
	const normalized = dedupeModelMetadata(models.flatMap(normalizeOpenAIModelMetadataEntry));
	if (!options?.includePinned) {
		return normalized;
	}

	const pinned = PINNED_MODEL_IDS.map(withFallbackMetadata);
	return dedupeModelMetadata([...normalized, ...pinned]);
}

function normalizeOpenAIModelId(id: string): string[] {
	if (id.startsWith("claude-") || id === "gpt-5.4-pro" || isHiddenImageGenerationModel(id)) {
		return [];
	}

	if (id === GPT_54_UPSTREAM_MODEL_ID) {
		return [GPT_54_DEFAULT_MODEL_ID, GPT_54_1M_MODEL_ID];
	}

	return [id];
}

function normalizeOpenAIModelMetadataEntry(model: TheClawBayModelMetadata): TheClawBayModelMetadata[] {
	const id = model.id.trim();
	if (normalizeOpenAIModelId(id).length === 0) {
		return [];
	}

	const normalized = { ...model, id };
	if (id === GPT_54_UPSTREAM_MODEL_ID) {
		return [
			{ ...normalized, id: GPT_54_DEFAULT_MODEL_ID, name: model.name || formatOpenAIModelName(GPT_54_DEFAULT_MODEL_ID) },
			{ ...normalized, id: GPT_54_1M_MODEL_ID, name: formatOpenAIModelName(GPT_54_1M_MODEL_ID), contextWindow: OPENAI_FRONTIER_CONTEXT_WINDOW },
		];
	}

	return [normalized];
}

export function resolveUpstreamModelId(id: string): string {
	if (id === GPT_54_1M_MODEL_ID) {
		return GPT_54_UPSTREAM_MODEL_ID;
	}

	return id;
}
