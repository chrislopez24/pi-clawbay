import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	CLAUDE_CONTEXT_WINDOW,
	CLAUDE_DEFAULT_MAX_TOKENS,
	CLAUDE_HAIKU_MAX_TOKENS,
	CLAUDE_OPUS_MAX_TOKENS,
	CLAUDE_SONNET_MAX_TOKENS,
	MODEL_INPUTS,
	THECLAWBAY_CLAUDE_BASE_URL,
	ZERO_COST,
} from "./constants.js";
import type { TheClawBayModelMetadata } from "./types.js";

type ClaudeCompat = NonNullable<ProviderModelConfig["compat"]> & {
	forceAdaptiveThinking?: boolean;
	supportsTemperature?: boolean;
};

const CLAUDE_KNOWN_COSTS: Record<string, ProviderModelConfig["cost"]> = {
	"claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

export function isClaudeModelId(id: string): boolean {
	return id.startsWith("claude-");
}

export function formatClaudeModelName(id: string, formatPart: (part: string) => string): string {
	const parts = id.split("-");
	if (parts.length >= 4 && parts[0] === "claude") {
		const family = formatPart(parts[1]);
		const version = `${parts[2]}.${parts[3]}`;
		const suffix = parts.slice(4).map(formatPart).join(" ");
		return suffix ? `Claude ${family} ${version} ${suffix}` : `Claude ${family} ${version}`;
	}

	return id.split("-").map(formatPart).join(" ");
}

function resolveClaudeContextWindow(metadata: TheClawBayModelMetadata): number {
	return metadata.contextWindow ?? CLAUDE_CONTEXT_WINDOW;
}

function resolveClaudeMaxTokens(id: string): number {
	if (id.includes("opus-4-")) {
		return CLAUDE_OPUS_MAX_TOKENS;
	}

	if (id.includes("sonnet-4-")) {
		return CLAUDE_SONNET_MAX_TOKENS;
	}

	if (id.includes("haiku-4-")) {
		return CLAUDE_HAIKU_MAX_TOKENS;
	}

	return CLAUDE_DEFAULT_MAX_TOKENS;
}

function resolveClaudeCompat(id: string): ClaudeCompat | undefined {
	if (id === "claude-opus-4-7" || id === "claude-opus-4-8") {
		return { forceAdaptiveThinking: true, supportsTemperature: false };
	}

	if (id === "claude-opus-4-6" || id === "claude-sonnet-4-6") {
		return { forceAdaptiveThinking: true };
	}

	return undefined;
}

function resolveClaudeThinkingLevelMap(id: string): ProviderModelConfig["thinkingLevelMap"] | undefined {
	if (id === "claude-opus-4-7" || id === "claude-opus-4-8") {
		return { xhigh: "xhigh" };
	}

	if (id === "claude-opus-4-6") {
		return { xhigh: "max" };
	}

	return undefined;
}

export function createClaudeModelConfig(metadata: TheClawBayModelMetadata, name: string): ProviderModelConfig {
	const thinkingLevelMap = resolveClaudeThinkingLevelMap(metadata.id);
	const compat = resolveClaudeCompat(metadata.id);

	return {
		id: metadata.id,
		name,
		api: "anthropic-messages",
		baseUrl: THECLAWBAY_CLAUDE_BASE_URL,
		reasoning: true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: [...MODEL_INPUTS],
		cost: { ...(CLAUDE_KNOWN_COSTS[metadata.id] ?? ZERO_COST) },
		contextWindow: resolveClaudeContextWindow(metadata),
		maxTokens: resolveClaudeMaxTokens(metadata.id),
		...(compat ? { compat } : {}),
	};
}
