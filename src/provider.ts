import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { streamSimpleTheClawBayAnthropicMessages } from "./anthropic-transport.js";
import { THECLAWBAY_ANTHROPIC_API, THECLAWBAY_CODEX_API, THECLAWBAY_CODEX_BASE_URL } from "./constants.js";
import { streamSimpleTheClawBayCodexResponses } from "./transport.js";
import { fetchOpenAIModelMetadata, writeCachedModelMetadata } from "./model-cache.js";
import { buildOpenAIModels } from "./models.js";

function getCredentialKey(context: RefreshModelsContext): string | undefined {
	return context.credential?.type === "api_key" ? context.credential.key : process.env.THECLAWBAY_API_KEY;
}

async function refreshModels(
	context: RefreshModelsContext,
	initialModels: ProviderModelConfig[],
): Promise<ProviderModelConfig[]> {
	const stored = await context.store.read();
	const storedModels = stored?.models.filter((model) => model.id.length > 0) as unknown as ProviderModelConfig[] | undefined;
	const apiKey = getCredentialKey(context);
	if (!apiKey || !context.allowNetwork || context.signal?.aborted) {
		return storedModels?.length ? storedModels : initialModels;
	}

	const metadata = await fetchOpenAIModelMetadata(apiKey, context.signal);
	if (!metadata || context.signal?.aborted) {
		throw new Error("TheClawBay model discovery did not return both complete model catalogs");
	}

	writeCachedModelMetadata(metadata);
	const models = buildOpenAIModels(metadata);
	await context.store.write({
		models: models.map((model) => ({ ...model, provider: "theclawbay", api: model.api ?? THECLAWBAY_CODEX_API })) as never,
		checkedAt: Date.now(),
	});
	return models;
}

export function registerProviders(pi: ExtensionAPI, openaiModels: ProviderModelConfig[]): void {
	pi.registerProvider("theclawbay", {
		name: "TheClawBay",
		baseUrl: THECLAWBAY_CODEX_BASE_URL,
		apiKey: "$THECLAWBAY_API_KEY",
		api: THECLAWBAY_CODEX_API,
		streamSimple: streamSimpleTheClawBayCodexResponses,
		models: openaiModels,
		refreshModels: (context) => refreshModels(context, openaiModels),
	});

	pi.registerProvider("theclawbay-anthropic-transport", {
		api: THECLAWBAY_ANTHROPIC_API,
		streamSimple: streamSimpleTheClawBayAnthropicMessages,
	});
}
