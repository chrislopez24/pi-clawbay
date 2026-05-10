/**
 * TheClawBay Provider Extension for Pi Coding Agent
 *
 * Provides access to GPT-5, Codex, Gemini, and image models through TheClawBay API.
 * Uses a single `theclawbay` provider with per-model routing:
 * - GPT/Codex: custom native Codex transport for prompt-cache hits
 * - Gemini: Pi's native google-generative-ai transport against TheClawBay /v1beta
 * - gpt-image-2: hosted Codex Responses image_generation tool
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
import { loadProviderModels, refreshProviderModels, registerModelRefreshCommand } from "./model-cache.js";
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

	const { models, source } = loadProviderModels();
	debugLog(`Registering ${models.length} model(s) from ${source}.`);
	registerProviders(pi, models);

	if (apiKey) {
		refreshProviderModels(pi, apiKey);
	}

	registerQuotaCommand(pi);
	registerModelRefreshCommand(pi, getApiKey);
}
