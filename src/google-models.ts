import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GOOGLE_GEMINI_CONTEXT_WINDOW, GOOGLE_GEMINI_MAX_TOKENS, MODEL_INPUTS, THECLAWBAY_GEMINI_BASE_URL } from "./constants.js";

interface GoogleModelConfigInput {
	id: string;
	name: string;
	cost: ProviderModelConfig["cost"];
}

type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

const GEMINI_3_FLASH_THINKING_LEVEL_MAP: ThinkingLevelMap = { off: null };
const GEMINI_3_PRO_THINKING_LEVEL_MAP: ThinkingLevelMap = { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" };

export function isGoogleModelId(id: string): boolean {
	return id.startsWith("gemini-");
}

function isGemini25ThinkingModel(id: string): boolean {
	return /^gemini-(?:live-)?2\.5-/.test(id);
}

function isGeminiLatestThinkingModel(id: string): boolean {
	return /^gemini-flash(?:-lite)?-latest$/.test(id);
}

function isGemini3FlashThinkingModel(id: string): boolean {
	return /^gemini-3(?:\.\d+)?-flash/.test(id);
}

function isGemini3ProThinkingModel(id: string): boolean {
	return /^gemini-3(?:\.\d+)?-pro/.test(id);
}

export function supportsGoogleThinking(id: string): boolean {
	return (
		isGemini25ThinkingModel(id) ||
		isGeminiLatestThinkingModel(id) ||
		isGemini3FlashThinkingModel(id) ||
		isGemini3ProThinkingModel(id)
	);
}

export function resolveGoogleThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
	if (isGemini3ProThinkingModel(id)) {
		return { ...GEMINI_3_PRO_THINKING_LEVEL_MAP };
	}

	if (isGemini3FlashThinkingModel(id)) {
		return { ...GEMINI_3_FLASH_THINKING_LEVEL_MAP };
	}

	return undefined;
}

export function createGoogleModelConfig(input: GoogleModelConfigInput): ProviderModelConfig {
	const reasoning = supportsGoogleThinking(input.id);
	const thinkingLevelMap = resolveGoogleThinkingLevelMap(input.id);
	return {
		id: input.id,
		name: input.name,
		api: "google-generative-ai",
		baseUrl: THECLAWBAY_GEMINI_BASE_URL,
		reasoning,
		...(reasoning && thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: [...MODEL_INPUTS],
		cost: { ...input.cost },
		contextWindow: GOOGLE_GEMINI_CONTEXT_WINDOW,
		maxTokens: GOOGLE_GEMINI_MAX_TOKENS,
	};
}
