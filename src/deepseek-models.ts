import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_DEFAULT_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS, THECLAWBAY_OPENAI_DISCOVERY_BASE_URL } from "./constants.js";
import type { TheClawBayModelMetadata } from "./types.js";

type ModelCompat = NonNullable<ProviderModelConfig["compat"]>;
type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

const DEEPSEEK_COMPAT: ModelCompat = {
	supportsDeveloperRole: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
};

export function isDeepSeekModelId(id: string): boolean {
	return /^deepseek[-.]/i.test(id);
}

export function formatDeepSeekModelName(id: string, formatPart: (part: string) => string): string {
	const suffix = id.replace(/^deepseek[-.]?/i, "").split("-").map(formatPart).join(" ");
	return suffix ? `DeepSeek ${suffix}` : "DeepSeek";
}

export function createDeepSeekModelConfig(
	metadata: TheClawBayModelMetadata,
	name: string,
	cost: ProviderModelConfig["cost"],
	thinkingLevelMap?: ThinkingLevelMap
): ProviderModelConfig {
	return {
		id: metadata.id,
		name,
		api: "openai-completions",
		baseUrl: THECLAWBAY_OPENAI_DISCOVERY_BASE_URL,
		reasoning: metadata.supportsReasoning ?? true,
		...(thinkingLevelMap ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
		input: ["text", "image"],
		cost: { ...cost },
		contextWindow: metadata.contextWindow ?? OPENAI_DEFAULT_CONTEXT_WINDOW,
		maxTokens: OPENAI_DEFAULT_MAX_TOKENS,
		compat: { ...DEEPSEEK_COMPAT },
	};
}
