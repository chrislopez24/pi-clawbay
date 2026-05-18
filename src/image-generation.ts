import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
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

interface DirectImageGenerationRequest {
	model: string;
	prompt: string;
	size: string;
	n: number;
}

interface DirectImageGenerationResult {
	base64: string;
	revisedPrompt?: string;
}

type ImageProgressCallback = (message: string) => void;

const DEFAULT_DIRECT_IMAGE_MAX_RETRIES = 5;
const DIRECT_IMAGE_SIZE = "1024x1024";
const RETRY_PROGRESS_MESSAGE = "⚠️ Image service was temporarily busy. Retrying…\n";

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
	const fileName = basename(path);
	const fileUrl = pathToFileURL(path).href;
	const lines = [
		`Generated image saved: [${fileName}](${fileUrl}) (${bytes.toLocaleString()} bytes).`,
		`Path: \`${path}\``,
	];
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
): Promise<{ path: string; bytes: number; revisedPrompt?: string }> {
	const apiKey = options?.apiKey ?? process.env.THECLAWBAY_API_KEY;
	if (!apiKey) {
		throw new Error("No API key for provider: theclawbay");
	}

	onProgress?.("🎨 Preparing image request…\n");
	const body = await buildDirectImageRequestBody(model, context, options);
	const payload = await fetchDirectImageGeneration(model, apiKey, body, options, onProgress);
	onProgress?.("💾 Saving final image…\n");
	const saved = saveGeneratedPng(payload.base64);
	return { ...saved, revisedPrompt: payload.revisedPrompt };
}

async function buildDirectImageRequestBody(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<unknown> {
	const prompt = extractPrompt(context);
	if (!prompt) {
		throw new Error("gpt-image-2 requires a non-empty user prompt");
	}

	const body: DirectImageGenerationRequest = {
		model: model.id,
		prompt,
		size: DIRECT_IMAGE_SIZE,
		n: 1,
	};
	return (await options?.onPayload?.(body, model)) ?? body;
}

function buildDirectRequestHeaders(apiKey: string, options?: SimpleStreamOptions): Record<string, string> {
	return {
		...(options?.headers ?? {}),
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
}

async function fetchDirectImageGeneration(
	model: Model<Api>,
	apiKey: string,
	body: unknown,
	options?: SimpleStreamOptions,
	onProgress?: ImageProgressCallback
): Promise<DirectImageGenerationResult> {
	let lastError: unknown;
	const maxRetries = getDirectImageMaxRetries();

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		onProgress?.("🖌️ Generating image…\n");
		const response = await trySendDirectImageRequest(apiKey, body, options);
		if (response instanceof Error) {
			lastError = response;
			if (!shouldRetryDirectImageRequest(attempt, maxRetries, undefined, options)) {
				throw response;
			}
			onProgress?.(RETRY_PROGRESS_MESSAGE);
			continue;
		}

		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		if (response.ok) {
			return readDirectImageGenerationResponse(await response.json());
		}

		lastError = new Error(await readImageErrorMessage(response));
		if (!shouldRetryDirectImageRequest(attempt, maxRetries, response.status, options)) {
			throw lastError;
		}
		onProgress?.(RETRY_PROGRESS_MESSAGE);
	}

	throw lastError instanceof Error ? lastError : new Error("TheClawBay direct image generation failed");
}

async function trySendDirectImageRequest(
	apiKey: string,
	body: unknown,
	options?: SimpleStreamOptions
): Promise<Response | Error> {
	try {
		return await fetch(THECLAWBAY_IMAGES_GENERATIONS_URL, {
			method: "POST",
			headers: buildDirectRequestHeaders(apiKey, options),
			body: JSON.stringify(body),
			signal: options?.signal,
		});
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function readDirectImageGenerationResponse(response: unknown): DirectImageGenerationResult {
	if (!isRecord(response) || !Array.isArray(response.data)) {
		throw new Error("TheClawBay direct image generation response did not include an image");
	}

	for (const item of response.data) {
		if (!isRecord(item) || typeof item.b64_json !== "string" || item.b64_json.length === 0) {
			continue;
		}

		return {
			base64: item.b64_json,
			revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
		};
	}

	throw new Error("TheClawBay direct image generation response did not include an image");
}

async function readImageErrorMessage(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const parsed = JSON.parse(text) as unknown;
		const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
		if (typeof error?.message === "string" && error.message.trim()) {
			return error.message;
		}
	} catch {
		// Fall through to raw response text.
	}
	return text.trim() || `TheClawBay image generation failed with HTTP ${response.status}`;
}

function getDirectImageMaxRetries(): number {
	const value = process.env.PI_CLAWBAY_IMAGE_MAX_RETRIES?.trim();
	if (!value) {
		return DEFAULT_DIRECT_IMAGE_MAX_RETRIES;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 5)) : DEFAULT_DIRECT_IMAGE_MAX_RETRIES;
}

function shouldRetryDirectImageRequest(
	attempt: number,
	maxRetries: number,
	status?: number,
	options?: SimpleStreamOptions
): boolean {
	if (attempt >= maxRetries || options?.signal?.aborted) {
		return false;
	}
	return status === undefined || isRetryableHttpStatus(status);
}

function isRetryableHttpStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
			const text = formatSuccessMessage(result.path, result.bytes, result.revisedPrompt);
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
