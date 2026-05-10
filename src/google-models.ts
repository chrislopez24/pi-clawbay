import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GOOGLE_GEMINI_CONTEXT_WINDOW, GOOGLE_GEMINI_MAX_TOKENS, MODEL_INPUTS, THECLAWBAY_GEMINI_BASE_URL } from "./constants.js";

interface GoogleModelConfigInput {
	id: string;
	name: string;
	cost: ProviderModelConfig["cost"];
}

export function isGoogleModelId(id: string): boolean {
	return id.startsWith("gemini-");
}

export function createGoogleModelConfig(input: GoogleModelConfigInput): ProviderModelConfig {
	return {
		id: input.id,
		name: input.name,
		api: "google-generative-ai",
		baseUrl: THECLAWBAY_GEMINI_BASE_URL,
		reasoning: false,
		input: [...MODEL_INPUTS],
		cost: { ...input.cost },
		contextWindow: GOOGLE_GEMINI_CONTEXT_WINDOW,
		maxTokens: GOOGLE_GEMINI_MAX_TOKENS,
	};
}
