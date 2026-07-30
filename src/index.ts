/**
 * TheClawBay Provider Extension for Pi Coding Agent
 *
 * Provides access to GPT-5, Codex, Gemini, and image models through TheClawBay API.
 * Uses a single `theclawbay` provider with per-model routing:
 * - GPT/Codex: custom native Codex transport for prompt-cache hits
 * - Gemini: Pi's native google-generative-ai transport against TheClawBay /v1beta
 * - gpt-image-2: direct OpenAI-compatible Images API
 *
 * Features:
 * - /quota command to check detailed usage
 * - custom Codex-style transport without JWT account-id extraction
 * - GPT-5.4 exposed as two user-selectable variants: standard and [1m]
 *
 * Usage:
 *   pi -e ./pi-clawbay
 *   # Then set THECLAWBAY_API_KEY=... or use /model to select a model
 *
 * Get your API key at: https://theclawbay.com
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFallbackOpenAIModels, buildOpenAIModels } from "./models.js";
import { readCachedModelCatalog, registerModelRefreshCommand, resolveStartupProviderModels } from "./model-cache.js";
import { registerOverflowNormalization } from "./overflow.js";
import { registerProviders } from "./provider.js";
import { getApiKey, registerQuotaCommand } from "./quota.js";

function debugLog(message: string): void {
	if (process.env.PI_CLAWBAY_DEBUG === "1") {
		console.info(`[theclawbay:debug] ${message}`);
	}
}

function warnMissingApiKey(): void {
	console.warn(
		"\x1b[33m⚠️  TheClawBay API key not set.\x1b[0m\n" +
			"   Set THECLAWBAY_API_KEY environment variable:\n" +
			"   export THECLAWBAY_API_KEY=your-key-here\n" +
			"   Get your key at: https://theclawbay.com\n"
	);
}

export default function (pi: ExtensionAPI): void {
	const apiKey = getApiKey();

	if (!apiKey) {
		warnMissingApiKey();
	}

	// Keep remote model discovery off the startup critical path. Use the last
	// catalog immediately and refresh it in the background; the same refresh
	// remains available manually through /clawbay-refresh-models.
	const freshCache = readCachedModelCatalog();
	const cachedCatalog = freshCache ?? readCachedModelCatalog(Date.now(), { allowStale: true });
	const models = cachedCatalog ? buildOpenAIModels(cachedCatalog.models) : buildFallbackOpenAIModels();
	const source = cachedCatalog ? "cache" : "fallback";
	debugLog(`Registering ${models.length} model(s) from ${source}.`);
	registerProviders(pi, models);

	if (apiKey && !freshCache) {
		void resolveStartupProviderModels(apiKey, models)
			.then((result) => {
				if (result.source !== "live") return;
				debugLog(`Registering ${result.models.length} model(s) from live discovery.`);
				registerProviders(pi, result.models);
			})
			.catch((error: unknown) => {
				debugLog(`Background model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			});
	}

	registerOverflowNormalization(pi);
	registerQuotaCommand(pi);
	registerModelRefreshCommand(pi, getApiKey);
}
