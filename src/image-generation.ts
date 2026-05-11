import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	THECLAWBAY_CHATGPT_ACCOUNT_ID,
	THECLAWBAY_CODEX_RESPONSES_URL,
	MODEL_INPUTS,
	OPENAI_CODEX_THINKING_LEVEL_MAP,
	OPENAI_KNOWN_COSTS,
} from "./constants.js";

interface HostedImageGenerationResult {
	base64: string;
	revisedPrompt?: string;
	usedPartial: boolean;
}

interface HostedImageCandidate {
	base64: string;
	revisedPrompt?: string;
	partialIndex?: number;
}

type ImageProgressCallback = (message: string) => void;

const DEFAULT_IMAGE_RESPONSES_MODEL_ID = "gpt-5.5";
const HOSTED_IMAGE_PARTIAL_COUNT = 2;
const DEFAULT_HOSTED_IMAGE_MAX_RETRIES = 5;
const ALLOW_PARTIAL_ENV = "PI_CLAWBAY_IMAGE_ALLOW_PARTIAL";

class HostedImageGenerationStreamError extends Error {
	readonly partial?: HostedImageCandidate;
	readonly retryable: boolean;

	constructor(message: string, options?: { partial?: HostedImageCandidate; retryable?: boolean }) {
		super(message);
		this.name = "HostedImageGenerationStreamError";
		this.partial = options?.partial;
		this.retryable = options?.retryable ?? false;
	}
}

export function getImageOutputDir(): string {
	const overrideDir = process.env.PI_CLAWBAY_IMAGE_DIR?.trim();
	if (overrideDir) {
		return overrideDir;
	}

	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "generated", "pi-clawbay");
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
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
}

function extractPrompt(context: Context): string {
	const userMessages = context.messages.filter((message) => message.role === "user");
	const latest = userMessages.at(-1);
	if (!latest) {
		throw new Error("gpt-image-2 requires a user prompt");
	}

	if (typeof latest.content === "string") {
		return latest.content.trim();
	}

	return latest.content
		.filter((item) => item.type === "text")
		.map((item) => item.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(Array.from(headers.entries()));
}

function saveGeneratedPng(base64: string): { path: string; bytes: number } {
	const image = Buffer.from(base64, "base64");
	const outputDir = getImageOutputDir();
	mkdirSync(outputDir, { recursive: true });
	const path = join(outputDir, `gpt-image-2-${Date.now()}-${randomUUID()}.png`);
	writeFileSync(path, image, "binary");
	return { path, bytes: image.byteLength };
}

function formatSuccessMessage(path: string, bytes: number, revisedPrompt?: string, usedPartial = false): string {
	const lines = [`Generated image saved to \`${path}\` (${bytes.toLocaleString()} bytes).`];
	if (usedPartial) {
		lines.push("Saved latest partial image because the final image was unavailable.");
	}
	if (revisedPrompt) {
		lines.push(`Revised prompt: ${revisedPrompt}`);
	}
	return lines.join("\n");
}

async function requestImageGeneration(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	onProgress?: ImageProgressCallback
): Promise<{ path: string; bytes: number; revisedPrompt?: string; usedPartial: boolean }> {
	const apiKey = options?.apiKey ?? process.env.THECLAWBAY_API_KEY;
	if (!apiKey) {
		throw new Error("No API key for provider: theclawbay");
	}

	onProgress?.("🎨 Preparing image request…\n");
	const body = await buildHostedImageRequestBody(model, context, options);
	const payload = await fetchHostedImageGeneration(model, apiKey, body, options, onProgress);
	onProgress?.("💾 Saving final image…\n");
	const saved = saveGeneratedPng(payload.base64);
	return { ...saved, revisedPrompt: payload.revisedPrompt, usedPartial: payload.usedPartial };
}

async function buildHostedImageRequestBody(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<unknown> {
	const prompt = extractPrompt(context);
	if (!prompt) {
		throw new Error("gpt-image-2 requires a non-empty user prompt");
	}

	const body = {
		model: getImageResponsesModelId(),
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
		tools: [
			{
				type: "image_generation",
				model: model.id,
				output_format: "png",
				size: "1024x1024",
				partial_images: HOSTED_IMAGE_PARTIAL_COUNT,
			},
		],
		tool_choice: "auto",
		parallel_tool_calls: true,
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
		...(options?.sessionId ? { prompt_cache_key: options.sessionId } : {}),
	};
	return (await options?.onPayload?.(body, model)) ?? body;
}

function buildHostedRequestHeaders(apiKey: string, options?: SimpleStreamOptions): Record<string, string> {
	return {
		...(options?.headers ?? {}),
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"chatgpt-account-id": THECLAWBAY_CHATGPT_ACCOUNT_ID,
		originator: "pi",
		"OpenAI-Beta": "responses=experimental",
		...(options?.sessionId ? { session_id: options.sessionId } : {}),
	};
}

function createHostedRequestModel(model: Model<Api>): Model<Api> {
	const requestModelId = getImageResponsesModelId();
	return {
		...model,
		id: requestModelId,
		name: requestModelId,
		reasoning: true,
		input: [...MODEL_INPUTS],
		cost: OPENAI_KNOWN_COSTS[requestModelId] ?? model.cost,
		thinkingLevelMap: { ...OPENAI_CODEX_THINKING_LEVEL_MAP },
	};
}

function getImageResponsesModelId(): string {
	return process.env.PI_CLAWBAY_IMAGE_RESPONSES_MODEL?.trim() || DEFAULT_IMAGE_RESPONSES_MODEL_ID;
}

async function fetchHostedImageGeneration(
	model: Model<Api>,
	apiKey: string,
	body: unknown,
	options?: SimpleStreamOptions,
	onProgress?: ImageProgressCallback
): Promise<HostedImageGenerationResult> {
	let latestPartial: HostedImageCandidate | undefined;
	let lastError: unknown;
	const maxRetries = getHostedImageMaxRetries();

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		onProgress?.("🖌️ Generating image…\n");
		const response = await fetch(THECLAWBAY_CODEX_RESPONSES_URL, {
			method: "POST",
			headers: buildHostedRequestHeaders(apiKey, options),
			body: JSON.stringify(body),
			signal: options?.signal,
		});
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, createHostedRequestModel(model));
		if (!response.ok) {
			const message = await response.text();
			if (attempt < maxRetries && isRetryableHttpStatus(response.status)) {
				lastError = new Error(message);
				onProgress?.("⚠️ Image service was temporarily busy. Retrying…\n");
				continue;
			}
			throw new Error(message);
		}

		try {
			return await readHostedImageGenerationStream(response, onProgress);
		} catch (error) {
			lastError = error;
			if (error instanceof HostedImageGenerationStreamError && error.partial) {
				latestPartial = error.partial;
			}
			if (error instanceof HostedImageGenerationStreamError && error.retryable && attempt < maxRetries && !options?.signal?.aborted) {
				onProgress?.("⚠️ Image service was temporarily busy. Retrying…\n");
				continue;
			}
			break;
		}
	}

	if (latestPartial && isPartialImageFallbackEnabled()) {
		return { ...latestPartial, usedPartial: true };
	}
	throw lastError instanceof Error ? lastError : new Error("TheClawBay hosted image generation failed");
}

async function readHostedImageGenerationStream(
	response: Response,
	onProgress?: ImageProgressCallback
): Promise<HostedImageGenerationResult> {
	let finalImage: HostedImageCandidate | undefined;
	let latestPartial: HostedImageCandidate | undefined;
	let completed = false;

	for await (const event of parseTheClawBaySse(response)) {
		const eventType = typeof event.type === "string" ? event.type : undefined;
		if (eventType === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string") {
			latestPartial = {
				base64: event.partial_image_b64,
				partialIndex: typeof event.partial_image_index === "number" ? event.partial_image_index : undefined,
			};
			onProgress?.("✨ Refining image…\n");
			continue;
		}

		if (eventType === "response.output_item.done" && isRecord(event.item) && event.item.type === "image_generation_call") {
			if (typeof event.item.result === "string" && event.item.result.length > 0) {
				finalImage = {
					base64: event.item.result,
					revisedPrompt: typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : undefined,
				};
			}
			continue;
		}

		if (eventType === "response.completed") {
			if (isRecord(event.response)) {
				const completedImage = extractFinalImageFromResponse(event.response);
				if (completedImage) {
					finalImage = completedImage;
				}
			}
			completed = true;
			continue;
		}

		if (eventType === "response.failed") {
			throw new HostedImageGenerationStreamError(readResponseFailureMessage(event, "TheClawBay hosted image generation failed"), {
				partial: latestPartial,
				retryable: isRetryableResponseFailure(event),
			});
		}

		if (eventType === "error") {
			throw new HostedImageGenerationStreamError(readResponseFailureMessage(event, "TheClawBay hosted image generation stream error"), {
				partial: latestPartial,
				retryable: true,
			});
		}
	}

	if (finalImage) {
		return { ...finalImage, usedPartial: false };
	}
	if (latestPartial) {
		throw new HostedImageGenerationStreamError("TheClawBay hosted image generation completed without a final image", {
			partial: latestPartial,
			retryable: true,
		});
	}
	if (!completed) {
		throw new Error("TheClawBay hosted image generation stream ended before completion");
	}
	throw new Error("TheClawBay hosted image generation response did not include an image");
}

function extractFinalImageFromResponse(response: Record<string, unknown>): HostedImageCandidate | undefined {
	const output = Array.isArray(response.output) ? response.output : [];
	for (const item of output) {
		if (!isRecord(item) || item.type !== "image_generation_call" || typeof item.result !== "string" || item.result.length === 0) {
			continue;
		}

		return {
			base64: item.result,
			revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
		};
	}
	return undefined;
}

function getHostedImageMaxRetries(): number {
	const value = process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES?.trim();
	if (!value) {
		return DEFAULT_HOSTED_IMAGE_MAX_RETRIES;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 5)) : DEFAULT_HOSTED_IMAGE_MAX_RETRIES;
}

function isPartialImageFallbackEnabled(): boolean {
	const value = process.env[ALLOW_PARTIAL_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function isRetryableHttpStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableResponseFailure(event: Record<string, unknown>): boolean {
	const response = isRecord(event.response) ? event.response : undefined;
	const error = isRecord(response?.error) ? response.error : undefined;
	const code = typeof error?.code === "string" ? error.code : "";
	const type = typeof error?.type === "string" ? error.type : "";
	return code === "service_unavailable" || code === "proxy_request_failed" || type === "server_error";
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

function readResponseFailureMessage(event: Record<string, unknown>, fallback: string): string {
	const response = isRecord(event.response) ? event.response : undefined;
	const error = isRecord(response?.error) ? response.error : undefined;
	if (typeof error?.message === "string" && error.message.trim()) {
		return error.message;
	}
	if (typeof event.message === "string" && event.message.trim()) {
		return event.message;
	}
	return fallback;
}

export function streamSimpleTheClawBayImageGeneration(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = createEmptyAssistantMessage(model);
		output.content.push({ type: "text", text: "" });

		const appendTextDelta = (delta: string): void => {
			const block = output.content[0];
			if (block?.type !== "text") {
				return;
			}
			block.text += delta;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
		};

		try {
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			const result = await requestImageGeneration(model, context, options, appendTextDelta);
			const text = formatSuccessMessage(result.path, result.bytes, result.revisedPrompt, result.usedPartial);
			appendTextDelta(text);
			const block = output.content[0];
			const content = block?.type === "text" ? block.text : text;
			stream.push({ type: "text_end", contentIndex: 0, content, partial: output });
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
