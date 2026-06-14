import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { streamSimpleTheClawBayAnthropicMessages } from "./anthropic-transport.js";
import { THECLAWBAY_ANTHROPIC_API, THECLAWBAY_CODEX_API, THECLAWBAY_CODEX_BASE_URL } from "./constants.js";
import { streamSimpleTheClawBayCodexResponses } from "./transport.js";

export function registerProviders(pi: ExtensionAPI, openaiModels: ProviderModelConfig[]): void {
	pi.registerProvider("theclawbay", {
		name: "TheClawBay",
		baseUrl: THECLAWBAY_CODEX_BASE_URL,
		apiKey: "$THECLAWBAY_API_KEY",
		api: THECLAWBAY_CODEX_API,
		streamSimple: streamSimpleTheClawBayCodexResponses,
		models: openaiModels,
	});

	pi.registerProvider("theclawbay-anthropic-transport", {
		api: THECLAWBAY_ANTHROPIC_API,
		streamSimple: streamSimpleTheClawBayAnthropicMessages,
	});
}
