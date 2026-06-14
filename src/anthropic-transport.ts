import Anthropic from "@anthropic-ai/sdk";
import {
	streamAnthropic,
	type AnthropicEffort,
	type AnthropicOptions,
} from "@earendil-works/pi-ai/anthropic";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

type Fetch = typeof fetch;
type AnthropicCompat = {
	forceAdaptiveThinking?: boolean;
	sendSessionAffinityHeaders?: boolean;
	supportsEagerToolInputStreaming?: boolean;
};

function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
	return Object.assign({}, ...sources.filter(Boolean));
}

function shouldNormalizeAnthropicSse(response: Response): boolean {
	const contentType = response.headers.get("content-type") ?? "";
	return !!response.body && contentType.toLowerCase().includes("text/event-stream");
}

function createNormalizedSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	let inEvent = false;

	function normalizeLine(line: string): string {
		if (line === "") {
			inEvent = false;
			return "\n";
		}

		const prefix = line.startsWith("event:") && inEvent ? "\n" : "";
		if (line.startsWith("event:")) {
			inEvent = true;
		}

		return `${prefix}${line}\n`;
	}

	function drainLines(flush = false): string {
		let output = "";
		for (;;) {
			const match = buffer.match(/\r\n|\n|\r/);
			if (!match?.index && match?.index !== 0) break;
			const line = buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			output += normalizeLine(line);
		}
		if (flush && buffer.length > 0) {
			output += normalizeLine(buffer);
			buffer = "";
		}
		return output;
	}

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { value, done } = await reader.read();
			if (done) {
				const output = drainLines(true);
				if (output) controller.enqueue(encoder.encode(output));
				controller.close();
				reader.releaseLock();
				return;
			}

			buffer += decoder.decode(value, { stream: true });
			const output = drainLines();
			if (output) controller.enqueue(encoder.encode(output));
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

export function normalizeAnthropicSseResponse(response: Response): Response {
	const body = response.body;
	if (!body || !shouldNormalizeAnthropicSse(response)) {
		return response;
	}

	return new Response(createNormalizedSseStream(body), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function getAnthropicCompat(model: Model<Api>): AnthropicCompat {
	return (model.compat ?? {}) as AnthropicCompat;
}

function createNormalizingFetch(sourceFetch: Fetch = globalThis.fetch): Fetch {
	return async (input, init) => normalizeAnthropicSseResponse(await sourceFetch(input, init));
}

function resolveAnthropicEffort(model: Model<Api>, level: SimpleStreamOptions["reasoning"]): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		default:
			return "high";
	}
}

function adjustMaxTokensForThinking(
	requestedMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoning: NonNullable<SimpleStreamOptions["reasoning"]>,
	customBudgets?: SimpleStreamOptions["thinkingBudgets"]
): { maxTokens: number; thinkingBudgetTokens: number } {
	const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...customBudgets };
	const level = reasoning === "xhigh" ? "high" : reasoning;
	let thinkingBudgetTokens = budgets[level] ?? budgets.high;
	const maxTokens = requestedMaxTokens === undefined ? modelMaxTokens : Math.min(requestedMaxTokens + thinkingBudgetTokens, modelMaxTokens);

	if (maxTokens <= thinkingBudgetTokens) {
		thinkingBudgetTokens = Math.max(0, maxTokens - 1024);
	}

	return { maxTokens, thinkingBudgetTokens };
}

function buildAnthropicClient(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Anthropic {
	const apiKey = options?.apiKey ?? process.env.THECLAWBAY_API_KEY;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const betaFeatures = [
		...(contextNeedsFineGrainedToolStreaming(model, context) ? [FINE_GRAINED_TOOL_STREAMING_BETA] : []),
		...(getAnthropicCompat(model).forceAdaptiveThinking === true ? [] : [INTERLEAVED_THINKING_BETA]),
	];
	const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
	const compat = getAnthropicCompat(model);
	const sessionHeaders =
		cacheSessionId && compat.sendSessionAffinityHeaders ? { "x-session-affinity": cacheSessionId } : undefined;

	return new Anthropic({
		apiKey,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch: createNormalizingFetch(),
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			sessionHeaders,
			model.headers,
			options?.headers
		),
	});
}

function contextNeedsFineGrainedToolStreaming(model: Model<Api>, context: Context): boolean {
	return !!context?.tools?.length && getAnthropicCompat(model).supportsEagerToolInputStreaming === false;
}

function buildAnthropicOptions(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AnthropicOptions {
	const client = buildAnthropicClient(model, context, options);
	const shared = {
		...options,
		apiKey: options?.apiKey ?? process.env.THECLAWBAY_API_KEY,
		client,
	};

	if (!model.reasoning || !options?.reasoning) {
		return { ...shared, thinkingEnabled: false };
	}

	if (getAnthropicCompat(model).forceAdaptiveThinking === true) {
		return {
			...shared,
			thinkingEnabled: true,
			effort: resolveAnthropicEffort(model, options.reasoning),
		};
	}

	return {
		...shared,
		thinkingEnabled: true,
		...adjustMaxTokensForThinking(options.maxTokens, model.maxTokens, options.reasoning, options.thinkingBudgets),
	};
}

export function streamSimpleTheClawBayAnthropicMessages(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	return streamAnthropic(model as Model<"anthropic-messages">, context, buildAnthropicOptions(model, context, options));
}
