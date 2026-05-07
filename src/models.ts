import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	FALLBACK_OPENAI_MODEL_IDS,
	HIDDEN_MODEL_ID_PREFIXES,
	GPT_54_1M_MODEL_ID,
	GPT_54_DEFAULT_MODEL_ID,
	GPT_54_UPSTREAM_MODEL_ID,
	MODEL_INPUTS,
	OPENAI_CODEX_CONTEXT_WINDOW,
	OPENAI_CODEX_THINKING_LEVEL_MAP,
	OPENAI_DEFAULT_CONTEXT_WINDOW,
	OPENAI_DEFAULT_MAX_TOKENS,
	OPENAI_FRONTIER_CONTEXT_WINDOW,
	OPENAI_KNOWN_COSTS,
	PINNED_MODEL_IDS,
	ZERO_COST,
} from "./constants.js";

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

	return formatGenericModelName(id);
}

function formatGenericModelName(id: string): string {
	if (id.startsWith("gpt-")) {
		const suffix = id.slice(4).split("-").map(formatModelNamePart).join(" ");
		return `GPT-${suffix}`;
	}

	return id.split("-").map(formatModelNamePart).join(" ");
}

function formatModelNamePart(part: string): string {
	return /^\d+(\.\d+)?$/.test(part) ? part.toUpperCase() : toTitleCase(part);
}

function isGpt54Or55Model(id: string): boolean {
	return id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5");
}

function isImageGenerationModel(id: string): boolean {
	return HIDDEN_MODEL_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function createModelConfig(
	id: string,
	name: string,
	cost: ProviderModelConfig["cost"],
	contextWindow: number,
	maxTokens: number
): ProviderModelConfig {
	const isReasoningModel = !isImageGenerationModel(id);

	return {
		id,
		name,
		reasoning: isReasoningModel,
		...(isReasoningModel && isGpt54Or55Model(id) ? { thinkingLevelMap: { ...OPENAI_CODEX_THINKING_LEVEL_MAP } } : {}),
		input: [...MODEL_INPUTS],
		cost: { ...cost },
		contextWindow,
		maxTokens,
	};
}

function createOpenAIModel(id: string): ProviderModelConfig {
	const cost = OPENAI_KNOWN_COSTS[id] ?? ZERO_COST;

	if (id === GPT_54_DEFAULT_MODEL_ID) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_CODEX_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	if (id === GPT_54_1M_MODEL_ID) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_FRONTIER_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_DEFAULT_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
}

export function buildOpenAIModels(ids: string[]): ProviderModelConfig[] {
	return dedupeIds(ids).map((id) => createOpenAIModel(id));
}

export function buildFallbackOpenAIModels(): ProviderModelConfig[] {
	return buildOpenAIModels(FALLBACK_OPENAI_MODEL_IDS);
}

export function normalizeOpenAIModelIds(ids: string[], options?: { includePinned?: boolean }): string[] {
	const normalized = dedupeIds(ids.flatMap(normalizeOpenAIModelId));
	return options?.includePinned ? dedupeIds([...normalized, ...PINNED_MODEL_IDS]) : normalized;
}

function normalizeOpenAIModelId(id: string): string[] {
	if (id.startsWith("claude-") || id === "gpt-5.4-pro" || isImageGenerationModel(id)) {
		return [];
	}

	if (id === GPT_54_UPSTREAM_MODEL_ID) {
		return [GPT_54_DEFAULT_MODEL_ID, GPT_54_1M_MODEL_ID];
	}

	return [id];
}

export function resolveUpstreamModelId(id: string): string {
	if (id === GPT_54_1M_MODEL_ID) {
		return GPT_54_UPSTREAM_MODEL_ID;
	}

	return id;
}
