/**
 * TheClawBay Provider Extension for Pi Coding Agent
 *
 * Provides access to GPT-5 and Codex models through TheClawBay API.
 * Uses a single provider endpoint:
 * - `theclawbay`: OpenAI-compatible endpoint for GPT/Codex models
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	parseStreamingJson,
	streamSimpleOpenAIResponses,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ImageContent,
	type SimpleStreamOptions,
	type TextContent,
	type ToolCall,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

const THECLAWBAY_OPENAI_DISCOVERY_BASE_URL = "https://api.theclawbay.com/v1";
const THECLAWBAY_CODEX_BASE_URL = "https://api.theclawbay.com/backend-api/codex";
const THECLAWBAY_IMAGES_GENERATIONS_URL = `${THECLAWBAY_OPENAI_DISCOVERY_BASE_URL}/images/generations`;
const THECLAWBAY_QUOTA_URL = "https://theclawbay.com/api/codex-auth/v1/quota";
const THECLAWBAY_OPENAI_MODELS_URL = `${THECLAWBAY_OPENAI_DISCOVERY_BASE_URL}/models`;
const THECLAWBAY_CODEX_API = "theclawbay-codex-responses";
const THECLAWBAY_CHATGPT_ACCOUNT_ID = "theclawbay";
const IMAGE_GENERATION_ENV = "PI_CLAWBAY_IMAGE_GENERATION";
const GENERATED_IMAGES_DIR_ENV = "PI_CLAWBAY_GENERATED_IMAGES_DIR";
const HOSTED_IMAGE_GENERATION_TOOL = { type: "image_generation", output_format: "png" } as const;
const IMAGE_GENERATION_DISABLED_MODES = new Set(["off", "false", "0", "disabled"]);
const MODEL_CACHE_VERSION = 1;
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const GPT_54_UPSTREAM_MODEL_ID = "gpt-5.4";
const GPT_54_DEFAULT_MODEL_ID = "gpt-5.4";
const GPT_54_1M_MODEL_ID = "gpt-5.4[1m]";

const MODEL_INPUTS = ["text", "image"] as const;
const OPENAI_CODEX_THINKING_LEVEL_MAP = { xhigh: "xhigh", minimal: "low" } as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const OPENAI_KNOWN_COSTS: Record<string, ProviderModelConfig["cost"]> = {
	"gpt-5.5": { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 5.0 },
	[GPT_54_DEFAULT_MODEL_ID]: { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite: 2.5 },
	[GPT_54_1M_MODEL_ID]: { input: 5.0, output: 22.5, cacheRead: 0.5, cacheWrite: 5.0 },
	"gpt-5.4-mini": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-5.3-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.2-codex": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.2": { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
	"gpt-5.1-codex-max": { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
	"gpt-5.1-codex-mini": { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
};
const OPENAI_CODEX_CONTEXT_WINDOW = 272000;
const OPENAI_DEFAULT_CONTEXT_WINDOW = OPENAI_CODEX_CONTEXT_WINDOW;
const OPENAI_FRONTIER_CONTEXT_WINDOW = 1050000;
const OPENAI_DEFAULT_MAX_TOKENS = 128000;

const IMAGE_GENERATION_MODEL_IDS = ["gpt-image-2", "gpt-image-1.5"];
const IMAGE_GENERATION_MODEL_ID_SET = new Set(IMAGE_GENERATION_MODEL_IDS);

const FALLBACK_OPENAI_MODEL_IDS = [
	"gpt-5.5",
	GPT_54_DEFAULT_MODEL_ID,
	GPT_54_1M_MODEL_ID,
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];

interface OpenAIModelListResponse {
	data?: Array<{
		id?: string;
	}>;
}

interface ModelCacheFile {
	version?: number;
	fetchedAt?: string;
	modelIds?: string[];
}

interface QuotaWindow {
	secondsUntilReset?: number;
	requestCount?: number;
	estimatedCostUsdUsed?: number | null;
	costUsdLimit?: number | null;
	percentUsed: number;
	limitReached?: boolean;
}

interface QuotaResponse {
	usageLimitPresentation?: string;
	usage?: {
		fiveHour?: QuotaWindow;
		weekly?: QuotaWindow;
	};
	fiveHourLimitReached?: boolean;
	weeklyLimitReached?: boolean;
	anyLimitReached?: boolean;
}

function dedupeIds(ids: string[]): string[] {
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

	if (id.startsWith("gpt-")) {
		const suffix = id
			.slice(4)
			.split("-")
			.map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : toTitleCase(part)))
			.join(" ");
		return `GPT-${suffix}`;
	}

	return id
		.split("-")
		.map((part) => (/^\d+(\.\d+)?$/.test(part) ? part.toUpperCase() : toTitleCase(part)))
		.join(" ");
}

function isGpt54Or55Model(id: string): boolean {
	return id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5");
}

function isImageGenerationModel(id: string): boolean {
	return IMAGE_GENERATION_MODEL_ID_SET.has(id);
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

	if (isImageGenerationModel(id)) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, 8192, 4096);
	}

	if (id === GPT_54_DEFAULT_MODEL_ID) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_CODEX_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	if (id === GPT_54_1M_MODEL_ID) {
		return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_FRONTIER_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
	}

	return createModelConfig(id, formatOpenAIModelName(id), cost, OPENAI_DEFAULT_CONTEXT_WINDOW, OPENAI_DEFAULT_MAX_TOKENS);
}

function buildOpenAIModels(ids: string[]): ProviderModelConfig[] {
	return dedupeIds([...ids, ...IMAGE_GENERATION_MODEL_IDS]).map((id) => createOpenAIModel(id));
}

function buildFallbackOpenAIModels(): ProviderModelConfig[] {
	return buildOpenAIModels(FALLBACK_OPENAI_MODEL_IDS);
}

function normalizeOpenAIModelIds(ids: string[]): string[] {
	return dedupeIds(
		ids.flatMap((id) => {
			if (id.startsWith("claude-")) {
				return [];
			}

			if (id.startsWith("gpt-image-") && !isImageGenerationModel(id)) {
				return [];
			}

			if (id === GPT_54_UPSTREAM_MODEL_ID) {
				return [GPT_54_DEFAULT_MODEL_ID, GPT_54_1M_MODEL_ID];
			}

			if (id === "gpt-5.4-pro") {
				return [];
			}

			return [id];
		})
	);
}

function resolveUpstreamModelId(id: string): string {
	if (id === GPT_54_1M_MODEL_ID) {
		return GPT_54_UPSTREAM_MODEL_ID;
	}

	return id;
}

function buildTheClawBayHeaders(options?: SimpleStreamOptions): Record<string, string> {
	return {
		...(options?.headers ?? {}),
		"chatgpt-account-id": THECLAWBAY_CHATGPT_ACCOUNT_ID,
		originator: "pi",
		"OpenAI-Beta": "responses=experimental",
		...(options?.sessionId ? { session_id: options.sessionId } : {}),
	};
}

function getHostedImageGenerationMode(): string | undefined {
	return process.env[IMAGE_GENERATION_ENV]?.trim().toLowerCase();
}

function isHostedImageGenerationDisabled(): boolean {
	const mode = getHostedImageGenerationMode();
	return mode !== undefined && IMAGE_GENERATION_DISABLED_MODES.has(mode);
}

function shouldExposeHostedImageGenerationTool(model: Model<"openai-responses">): boolean {
	return !isHostedImageGenerationDisabled() && model.input.includes("image");
}

function appendHostedImageGenerationTool(tools: unknown): unknown[] {
	const existing = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool === "object") : [];
	const hasHostedImageTool = existing.some((tool) => (tool as { type?: unknown }).type === HOSTED_IMAGE_GENERATION_TOOL.type);
	return hasHostedImageTool ? existing : [...existing, { ...HOSTED_IMAGE_GENERATION_TOOL }];
}

function buildTheClawBayPayload(payload: unknown, context: Context, options?: { includeHostedImageGeneration?: boolean }): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}

	const source = payload as Record<string, unknown>;
	const include = Array.isArray(source.include)
		? source.include.filter((item): item is string => typeof item === "string")
		: [];
	const input = Array.isArray(source.input)
		? source.input.filter((item) => {
				if (!item || typeof item !== "object") {
					return true;
				}
				const role = (item as { role?: unknown }).role;
				return role !== "developer" && role !== "system";
			})
		: source.input;

	return {
		...source,
		instructions: context.systemPrompt,
		input,
		...(options?.includeHostedImageGeneration ? { tools: appendHostedImageGenerationTool(source.tools) } : {}),
		include: dedupeIds([...include, "reasoning.encrypted_content"]),
		text: { verbosity: "medium" },
		tool_choice: "auto",
		parallel_tool_calls: true,
		store: false,
	};
}

function sanitizeGeneratedImagePathPart(value: string | undefined, fallback: string): string {
	const sanitized = (value?.trim() || fallback).replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
	return (sanitized || fallback).slice(0, 128);
}

function getGeneratedImagesRoot(): string {
	const overrideDir = process.env[GENERATED_IMAGES_DIR_ENV]?.trim();
	if (overrideDir) {
		return overrideDir;
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "generated_images");
}

function getGeneratedImagePath(sessionId: string | undefined, callId: string): string {
	return join(
		getGeneratedImagesRoot(),
		sanitizeGeneratedImagePathPart(sessionId, "session"),
		`${sanitizeGeneratedImagePathPart(callId, "image_generation_call")}.png`
	);
}

function saveImageGenerationResult(sessionId: string | undefined, callId: string, result: string): string {
	const filePath = getGeneratedImagePath(sessionId, callId);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, Buffer.from(result, "base64"));
	return filePath;
}

function responseInputContent(content: string | (TextContent | ImageContent)[]): unknown {
	if (typeof content === "string") {
		return [{ type: "input_text", text: content }];
	}

	return content.map((item) => {
		if (item.type === "text") {
			return { type: "input_text", text: item.text };
		}

		return {
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		};
	});
}

function convertTheClawBayResponsesMessages(context: Context, model: Model<"openai-responses">): unknown[] {
	const messages: unknown[] = [];

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content = responseInputContent(msg.content);
			if (Array.isArray(content) && content.length > 0) {
				messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "thinking" && block.thinkingSignature) {
					try {
						messages.push(JSON.parse(block.thinkingSignature) as unknown);
					} catch {
						// Ignore malformed opaque reasoning history.
					}
				} else if (block.type === "text") {
					messages.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						status: "completed",
					});
				} else if (block.type === "toolCall") {
					const [callId, itemId] = block.id.split("|");
					messages.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const imageResults = msg.content.filter((item) => item.type === "image");
			const [callId] = msg.toolCallId.split("|");
			const output =
				imageResults.length > 0 && model.input.includes("image")
					? [
							...(textResult ? [{ type: "input_text", text: textResult }] : []),
							...imageResults.map((item) => ({
								type: "input_image",
								detail: "auto",
								image_url: `data:${item.mimeType};base64,${item.data}`,
							})),
						]
					: textResult || "(see attached image)";
			messages.push({ type: "function_call_output", call_id: callId, output });
		}
	}

	return messages;
}

function convertTheClawBayResponsesTools(context: Context): unknown[] | undefined {
	const functionTools = context.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: null,
	}));

	return appendHostedImageGenerationTool(functionTools);
}

function buildHostedImageGenerationPayload(
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: convertTheClawBayResponsesMessages(context, model),
		text: { verbosity: "medium" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
		tools: convertTheClawBayResponsesTools(context),
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}
	if (options?.maxTokens !== undefined) {
		body.max_output_tokens = options.maxTokens;
	}

	if (model.reasoning && options?.reasoning) {
		const clampedReasoning = clampThinkingLevel(model, options.reasoning);
		if (clampedReasoning && clampedReasoning !== "off") {
			body.reasoning = {
				effort: model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning,
				summary: "auto",
			};
		}
	}

	return body;
}

function resolveTheClawBayCodexResponsesUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/responses")) {
		return normalized;
	}
	return `${normalized}/responses`;
}

async function* parseTheClawBaySse(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) {
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n\n");
			while (index !== -1) {
				const chunk = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const data = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n")
					.trim();

				if (data && data !== "[DONE]") {
					yield JSON.parse(data) as Record<string, unknown>;
				}
				index = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Ignore stream cleanup errors.
		}
		try {
			reader.releaseLock();
		} catch {
			// Ignore stream cleanup errors.
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getEventType(event: Record<string, unknown>): string | undefined {
	return typeof event.type === "string" ? event.type : undefined;
}

function getEventItem(event: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(event.item) ? event.item : undefined;
}

function getBlockIndex(output: AssistantMessage): number {
	return output.content.length - 1;
}

function pushGeneratedImageText(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	filePath: string,
	revisedPrompt?: string
): void {
	const lines = [`Generated image saved to: ${pathToFileURL(filePath).href}`, `Path: ${filePath}`];
	if (revisedPrompt) {
		lines.push(`Revised prompt: ${revisedPrompt}`);
	}
	const text = lines.join("\n");
	output.content.push({ type: "text", text });
	const contentIndex = getBlockIndex(output);
	stream.push({ type: "text_start", contentIndex, partial: output });
	stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function readResponseUsage(response: Record<string, unknown>, output: AssistantMessage, model: Model<"openai-responses">): void {
	if (!isRecord(response.usage)) {
		return;
	}

	const usage = response.usage;
	const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens;
	const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
	const cachedTokens = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
	output.usage = {
		input: inputTokens - cachedTokens,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, output.usage);
}

function mapResponseStopReason(status: unknown): AssistantMessage["stopReason"] {
	if (status === "incomplete") {
		return "length";
	}
	if (status === "failed" || status === "cancelled") {
		return "error";
	}
	return "stop";
}

async function processTheClawBayHostedImageStream(
	events: AsyncIterable<Record<string, unknown>>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-responses">,
	options?: SimpleStreamOptions
): Promise<void> {
	let currentItem: Record<string, unknown> | null = null;
	let currentBlock: (ToolCall & { partialJson?: string }) | { type: "text"; text: string; textSignature?: string } | { type: "thinking"; thinking: string; thinkingSignature?: string } | null = null;

	for await (const event of events) {
		const eventType = getEventType(event);

		if (eventType === "response.created" && isRecord(event.response) && typeof event.response.id === "string") {
			output.responseId = event.response.id;
		} else if (eventType === "response.output_item.added") {
			const item = getEventItem(event);
			if (!item || typeof item.type !== "string") {
				continue;
			}
			currentItem = item;
			if (item.type === "reasoning") {
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: getBlockIndex(output), partial: output });
			} else if (item.type === "message") {
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: getBlockIndex(output), partial: output });
			} else if (item.type === "function_call") {
				currentBlock = {
					type: "toolCall",
					id: `${String(item.call_id ?? "call")}|${String(item.id ?? "fc")}`,
					name: String(item.name ?? ""),
					arguments: {},
					partialJson: typeof item.arguments === "string" ? item.arguments : "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: getBlockIndex(output), partial: output });
			}
		} else if (eventType === "response.content_part.added") {
			if (currentItem?.type === "message" && isRecord(event.part)) {
				const content = Array.isArray(currentItem.content) ? currentItem.content : [];
				currentItem.content = [...content, event.part];
			}
		} else if (eventType === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text" && typeof event.delta === "string") {
				currentBlock.text += event.delta;
				stream.push({ type: "text_delta", contentIndex: getBlockIndex(output), delta: event.delta, partial: output });
			}
		} else if (eventType === "response.output_text.done") {
			if (currentItem?.type === "message" && currentBlock?.type === "text" && typeof event.text === "string") {
				const delta = event.text.startsWith(currentBlock.text) ? event.text.slice(currentBlock.text.length) : event.text;
				currentBlock.text = event.text;
				if (delta) {
					stream.push({ type: "text_delta", contentIndex: getBlockIndex(output), delta, partial: output });
				}
			}
		} else if (eventType === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking" && typeof event.delta === "string") {
				currentBlock.thinking += event.delta;
				stream.push({ type: "thinking_delta", contentIndex: getBlockIndex(output), delta: event.delta, partial: output });
			}
		} else if (eventType === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall" && typeof event.delta === "string") {
				currentBlock.partialJson = (currentBlock.partialJson ?? "") + event.delta;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
				stream.push({ type: "toolcall_delta", contentIndex: getBlockIndex(output), delta: event.delta, partial: output });
			}
		} else if (eventType === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall" && typeof event.arguments === "string") {
				const previous = currentBlock.partialJson ?? "";
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(event.arguments || "{}");
				const delta = event.arguments.startsWith(previous) ? event.arguments.slice(previous.length) : event.arguments;
				if (delta) {
					stream.push({ type: "toolcall_delta", contentIndex: getBlockIndex(output), delta, partial: output });
				}
			}
		} else if (eventType === "response.output_item.done") {
			const item = getEventItem(event);
			if (!item || typeof item.type !== "string") {
				continue;
			}

			if (item.type === "message" && currentBlock?.type === "text") {
				if (Array.isArray(item.content)) {
					currentBlock.text = item.content
						.map((contentItem) => (isRecord(contentItem) && typeof contentItem.text === "string" ? contentItem.text : ""))
						.join("");
				}
				stream.push({ type: "text_end", contentIndex: getBlockIndex(output), content: currentBlock.text, partial: output });
				currentBlock = null;
			} else if (item.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinkingSignature = JSON.stringify(item);
				stream.push({ type: "thinking_end", contentIndex: getBlockIndex(output), content: currentBlock.thinking, partial: output });
				currentBlock = null;
			} else if (item.type === "function_call") {
				if (currentBlock?.type === "toolCall") {
					currentBlock.arguments = parseStreamingJson(currentBlock.partialJson || (typeof item.arguments === "string" ? item.arguments : "{}"));
					delete currentBlock.partialJson;
					stream.push({ type: "toolcall_end", contentIndex: getBlockIndex(output), toolCall: currentBlock, partial: output });
				}
				currentBlock = null;
			} else if (item.type === "image_generation_call") {
				if (typeof item.id === "string" && typeof item.result === "string") {
					const filePath = saveImageGenerationResult(options?.sessionId, item.id, item.result);
					pushGeneratedImageText(
						stream,
						output,
						filePath,
						typeof item.revised_prompt === "string" ? item.revised_prompt : undefined
					);
				}
			}
		} else if (eventType === "response.completed" && isRecord(event.response)) {
			if (typeof event.response.id === "string") {
				output.responseId = event.response.id;
			}
			readResponseUsage(event.response, output, model);
			output.stopReason = mapResponseStopReason(event.response.status);
			if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (eventType === "response.failed") {
			const response = isRecord(event.response) ? event.response : undefined;
			const error = isRecord(response?.error) ? response.error : undefined;
			const message = typeof error?.message === "string" ? error.message : "TheClawBay response failed";
			throw new Error(message);
		} else if (eventType === "error") {
			throw new Error(typeof event.message === "string" ? event.message : "TheClawBay stream error");
		}
	}
}

function streamHostedImageGenerationTheClawBayCodexResponses(
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || process.env.THECLAWBAY_API_KEY;
			if (!apiKey) {
				throw new Error("No API key for provider: theclawbay");
			}

			let payload: unknown = buildHostedImageGenerationPayload(model, context, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

			const response = await fetch(resolveTheClawBayCodexResponsesUrl(model.baseUrl), {
				method: "POST",
				headers: {
					...buildTheClawBayHeaders(options),
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: options?.signal,
			});
			await options?.onResponse?.(
				{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
				model
			);

			if (!response.ok) {
				throw new Error(await response.text());
			}

			stream.push({ type: "start", partial: output });
			await processTheClawBayHostedImageStream(parseTheClawBaySse(response), output, stream, model, options);
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "TheClawBay response failed");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { partialJson?: unknown }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function getLatestUserPrompt(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
	}
	return "";
}

async function readResponseBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch (error) {
		return `Unable to read error body: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function describeFetchCause(error: Error): string | undefined {
	const cause = (error as { cause?: unknown }).cause;
	if (!cause) return undefined;
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

function formatDirectImageGenerationError(error: unknown, modelId: string, status?: number, body?: string): string {
	const parts = [`TheClawBay Images API request failed`, `endpoint=${THECLAWBAY_IMAGES_GENERATIONS_URL}`, `model=${modelId}`];
	if (status !== undefined) parts.push(`status=${status}`);
	if (body) parts.push(`body=${body}`);
	if (error instanceof Error) {
		parts.push(`message=${error.message}`);
		const cause = describeFetchCause(error);
		if (cause) parts.push(`cause=${cause}`);
	} else if (error !== undefined) {
		parts.push(`message=${String(error)}`);
	}
	return parts.join("; ");
}

function streamDirectTheClawBayImageGeneration(
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || process.env.THECLAWBAY_API_KEY;
			if (!apiKey) throw new Error("No API key for provider: theclawbay");

			const prompt = getLatestUserPrompt(context);
			if (!prompt) throw new Error("Image generation requires a text prompt");

			let response: Response;
			try {
				response = await fetch(THECLAWBAY_IMAGES_GENERATIONS_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: model.id,
						prompt,
						size: "1024x1024",
						quality: "low",
						output_format: "png",
					}),
					signal: options?.signal,
				});
			} catch (error) {
				throw new Error(formatDirectImageGenerationError(error, model.id));
			}

			await options?.onResponse?.(
				{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
				model
			);
			if (!response.ok) {
				const body = await readResponseBody(response);
				throw new Error(formatDirectImageGenerationError(undefined, model.id, response.status, body));
			}

			const result = (await response.json()) as { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
			const image = result.data?.find((item) => typeof item.b64_json === "string");
			if (!image?.b64_json) throw new Error("TheClawBay image generation response did not include b64_json");

			stream.push({ type: "start", partial: output });
			const filePath = saveImageGenerationResult(options?.sessionId, `${model.id}-${Date.now()}`, image.b64_json);
			pushGeneratedImageText(stream, output, filePath, image.revised_prompt);
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function streamSimpleTheClawBayCodexResponses(
	model: unknown,
	context: unknown,
	options?: unknown
): AssistantMessageEventStream {
	const typedModel = model as Model<"openai-responses">;
	const typedContext = context as Context;
	const typedOptions = options as SimpleStreamOptions | undefined;
	const originalOnPayload = typedOptions?.onPayload;
	const headers = buildTheClawBayHeaders(typedOptions);
	const remappedModel = {
		...typedModel,
		id: resolveUpstreamModelId(typedModel.id),
	} as Model<"openai-responses">;

	if (isImageGenerationModel(remappedModel.id)) {
		return streamDirectTheClawBayImageGeneration(remappedModel, typedContext, typedOptions);
	}

	if (!shouldExposeHostedImageGenerationTool(remappedModel)) {
		return streamSimpleOpenAIResponses(remappedModel, typedContext, {
			...typedOptions,
			headers,
			onPayload: async (payload, streamModel) => {
				const transformedPayload = buildTheClawBayPayload(payload, typedContext);
				const nextPayload = await originalOnPayload?.(transformedPayload, streamModel);
				return nextPayload === undefined ? transformedPayload : nextPayload;
			},
		});
	}

	return streamHostedImageGenerationTheClawBayCodexResponses(remappedModel, typedContext, {
		...typedOptions,
		headers,
		onPayload: async (payload, streamModel) => {
			const transformedPayload = buildTheClawBayPayload(payload, typedContext, { includeHostedImageGeneration: true });
			const nextPayload = await originalOnPayload?.(transformedPayload, streamModel);
			return nextPayload === undefined ? transformedPayload : nextPayload;
		},
	});
}

function registerProviders(pi: ExtensionAPI, openaiModels: ProviderModelConfig[]) {
	pi.registerProvider("theclawbay", {
		baseUrl: THECLAWBAY_CODEX_BASE_URL,
		apiKey: "THECLAWBAY_API_KEY",
		api: THECLAWBAY_CODEX_API,
		streamSimple: streamSimpleTheClawBayCodexResponses,
		models: openaiModels,
	});
}

function getModelCachePath(): string {
	const overrideDir = process.env.PI_CLAWBAY_CACHE_DIR?.trim();
	if (overrideDir) {
		return join(overrideDir, "models.json");
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "cache", "pi-clawbay", "models.json");
}

function readCachedModelIds(now = Date.now()): string[] | null {
	try {
		const cachePath = getModelCachePath();
		if (!existsSync(cachePath)) {
			return null;
		}

		const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCacheFile;
		if (parsed.version !== MODEL_CACHE_VERSION || !Array.isArray(parsed.modelIds) || typeof parsed.fetchedAt !== "string") {
			return null;
		}

		const fetchedAt = Date.parse(parsed.fetchedAt);
		if (!Number.isFinite(fetchedAt) || now - fetchedAt > MODEL_CACHE_TTL_MS) {
			return null;
		}

		const ids = normalizeOpenAIModelIds(parsed.modelIds.filter((id): id is string => typeof id === "string" && id.length > 0));
		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

function writeCachedModelIds(ids: string[], now = Date.now()): void {
	try {
		const cachePath = getModelCachePath();
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(
			cachePath,
			JSON.stringify(
				{
					version: MODEL_CACHE_VERSION,
					fetchedAt: new Date(now).toISOString(),
					modelIds: normalizeOpenAIModelIds(ids),
				},
				null,
				2
			) + "\n",
			"utf8"
		);
	} catch {
		// Cache writes are best-effort; model registration should not fail because the filesystem is unavailable.
	}
}

async function fetchOpenAIModelIds(apiKey: string): Promise<string[] | null> {
	try {
		const response = await fetch(THECLAWBAY_OPENAI_MODELS_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as OpenAIModelListResponse;
		const ids = normalizeOpenAIModelIds(
			(payload.data ?? [])
				.map((entry) => entry.id?.trim())
				.filter((id): id is string => typeof id === "string" && id.length > 0)
		);

		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

function refreshProviderModels(pi: ExtensionAPI, apiKey: string): void {
	void fetchOpenAIModelIds(apiKey).then((ids) => {
		if (!ids) {
			return;
		}

		writeCachedModelIds(ids);
		const models = buildOpenAIModels(ids);
		try {
			registerProviders(pi, models);
		} catch (error) {
			console.warn(`[theclawbay] Skipped live model refresh: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		console.info(`[theclawbay] Registered ${models.length} OpenAI-compatible models from live model discovery.`);
	});
}

function loadProviderModels(): { models: ProviderModelConfig[]; source: "fallback" | "cache" } {
	const cachedIds = readCachedModelIds();
	if (cachedIds) {
		return { models: buildOpenAIModels(cachedIds), source: "cache" };
	}

	return { models: buildFallbackOpenAIModels(), source: "fallback" };
}

async function fetchQuota(apiKey: string): Promise<QuotaResponse | null> {
	try {
		const response = await fetch(THECLAWBAY_QUOTA_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as QuotaResponse;
	} catch {
		return null;
	}
}

function getApiKey(): string | undefined {
	return process.env.THECLAWBAY_API_KEY;
}

function getQuotaWindows(quota: QuotaResponse): { fiveHour?: QuotaWindow; weekly?: QuotaWindow } {
	return {
		fiveHour: quota.usage?.fiveHour,
		weekly: quota.usage?.weekly,
	};
}

function formatPercent(percent: number): { text: string; color: "dim" | "warning" | "error" } {
	const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : percent >= 0.1 ? 2 : 3;

	if (percent >= 90) {
		return { text: `${percent.toFixed(digits)}%`, color: "error" };
	}
	if (percent >= 70) {
		return { text: `${percent.toFixed(digits)}%`, color: "warning" };
	}
	return { text: `${percent.toFixed(digits)}%`, color: "dim" };
}

function formatDuration(seconds?: number): string {
	if (seconds === undefined) {
		return "unknown";
	}

	const totalSeconds = Math.max(0, Math.floor(seconds));
	const totalMinutes = Math.floor(totalSeconds / 60);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const time = `${hours}h ${minutes}m`;

	if (days > 0) {
		return `${days}d ${time}`;
	}
	return time;
}

function formatQuotaDetails(label: string, window?: QuotaWindow): string {
	if (!window) {
		return `${label}: N/A`;
	}

	const percent = formatPercent(window.percentUsed).text;
	const costUsed = window.estimatedCostUsdUsed;
	const costLimit = window.costUsdLimit;
	const hasUsd = typeof costUsed === "number" && typeof costLimit === "number";
	const usage = hasUsd
		? `${percent} ($${costUsed.toFixed(2)}/$${costLimit.toFixed(2)})`
		: percent;

	return `${label}: ${usage} • ${window.requestCount ?? 0} req • resets ${formatDuration(window.secondsUntilReset)}`;
}

export default function (pi: ExtensionAPI) {
	const apiKey = getApiKey();

	if (!apiKey) {
		console.warn(
			"\x1b[33m⚠️  TheClawBay API key not set.\x1b[0m\n" +
				"   Set THECLAWBAY_API_KEY environment variable:\n" +
				"   export THECLAWBAY_API_KEY=your-key-here\n" +
				"   Get your key at: https://theclawbay.com\n"
		);
	}

	const { models } = loadProviderModels();
	registerProviders(pi, models);

	if (apiKey) {
		refreshProviderModels(pi, apiKey);
	}

	pi.registerCommand("quota", {
		description: "Check TheClawBay quota usage",
		handler: async (_args, ctx) => {
			const currentApiKey = getApiKey();
			if (!currentApiKey) {
				ctx.ui.notify("THECLAWBAY_API_KEY is not set", "error");
				return;
			}

			const quota = await fetchQuota(currentApiKey);
			if (!quota) {
				ctx.ui.notify("Failed to fetch quota from TheClawBay", "error");
				return;
			}

			const { fiveHour, weekly } = getQuotaWindows(quota);
			ctx.ui.notify(`${formatQuotaDetails("5h", fiveHour)} | ${formatQuotaDetails("Week", weekly)}`, "info");
		},
	});
}
