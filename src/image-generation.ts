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
import { THECLAWBAY_IMAGES_GENERATIONS_URL } from "./constants.js";

interface ImageGenerationResponse {
	data?: Array<{
		b64_json?: string;
		revised_prompt?: string;
	}>;
	error?: {
		message?: string;
		code?: string;
	};
}

const IMAGE_GENERATION_MAX_RETRIES = 3;
const IMAGE_GENERATION_RETRY_DELAY_MS = 1000;

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

function formatSuccessMessage(path: string, bytes: number, revisedPrompt?: string): string {
	const lines = [`Generated image saved to \`${path}\` (${bytes.toLocaleString()} bytes).`];
	if (revisedPrompt) {
		lines.push(`Revised prompt: ${revisedPrompt}`);
	}
	return lines.join("\n");
}

async function requestImageGeneration(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions
): Promise<{ path: string; bytes: number; revisedPrompt?: string }> {
	const apiKey = options?.apiKey ?? process.env.THECLAWBAY_API_KEY;
	if (!apiKey) {
		throw new Error("No API key for provider: theclawbay");
	}

	const body = await buildImageRequestBody(model, context, options);
	const payload = await fetchImageGenerationPayload(model, apiKey, body, options);
	const first = payload.data?.[0];
	if (!first?.b64_json) {
		throw new Error("Image generation response did not include b64_json");
	}

	return { ...saveGeneratedPng(first.b64_json), revisedPrompt: first.revised_prompt };
}

function isRetryableImageError(status: number, payload: ImageGenerationResponse): boolean {
	const code = payload.error?.code ?? "";
	return status === 429 || status >= 500 || code === "service_unavailable" || code === "proxy_request_failed";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

async function fetchImageGenerationPayload(
	model: Model<Api>,
	apiKey: string,
	body: unknown,
	options?: SimpleStreamOptions
): Promise<ImageGenerationResponse> {
	let lastError = new Error("Image generation failed");
	for (let attempt = 0; attempt <= IMAGE_GENERATION_MAX_RETRIES; attempt++) {
		const response = await fetchImageGenerationResponse(apiKey, body, options);
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		const payload = (await response.json()) as ImageGenerationResponse;
		if (response.ok && !payload.error) {
			return payload;
		}
		lastError = new Error(payload.error?.message ?? `Image generation failed with HTTP ${response.status}`);
		if (attempt < IMAGE_GENERATION_MAX_RETRIES && isRetryableImageError(response.status, payload)) {
			await sleep(IMAGE_GENERATION_RETRY_DELAY_MS * 2 ** attempt, options?.signal);
			continue;
		}
		break;
	}
	throw lastError;
}

function fetchImageGenerationResponse(apiKey: string, body: unknown, options?: SimpleStreamOptions): Promise<Response> {
	return fetch(THECLAWBAY_IMAGES_GENERATIONS_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: options?.signal,
	});
}

async function buildImageRequestBody(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<unknown> {
	const prompt = extractPrompt(context);
	if (!prompt) {
		throw new Error("gpt-image-2 requires a non-empty user prompt");
	}

	const body = { model: model.id, prompt, n: 1, size: "1024x1024" };
	return (await options?.onPayload?.(body, model)) ?? body;
}

export function streamSimpleTheClawBayImageGeneration(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = createEmptyAssistantMessage(model);
		try {
			const result = await requestImageGeneration(model, context, options);
			const text = formatSuccessMessage(result.path, result.bytes, result.revisedPrompt);
			output.content.push({ type: "text", text });
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
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
