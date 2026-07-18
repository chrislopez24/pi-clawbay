import Anthropic from "@anthropic-ai/sdk";
import {
	stream as streamAnthropic,
	type AnthropicEffort,
	type AnthropicOptions,
} from "@earendil-works/pi-ai/api/anthropic-messages";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const ADAPTIVE_THINKING_DISPLAY = "omitted";
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 180_000;
const PI_DISABLED_TIMEOUT_MS = 2_147_483_647;
const PI_DOCS_HEADER =
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const PI_DOCS_SAFE_HEADER = "Pi documentation paths and routing:";
const PI_DOCS_LOOKUP_LINE =
	"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)";
const PI_DOCS_LOOKUP_LIST = `- When asked about:
  - extensions: docs/extensions.md, examples/extensions/
  - themes: docs/themes.md
  - skills: docs/skills.md
  - prompt templates: docs/prompt-templates.md
  - TUI components: docs/tui.md
  - keybindings: docs/keybindings.md
  - SDK integrations: docs/sdk.md
  - custom providers: docs/custom-provider.md
  - adding models: docs/models.md
  - pi packages: docs/packages.md`;

type Fetch = typeof fetch;
type AnthropicCompat = {
	forceAdaptiveThinking?: boolean;
	supportsTemperature?: boolean;
	supportsCacheControlOnTools?: boolean;
	sendSessionAffinityHeaders?: boolean;
	supportsEagerToolInputStreaming?: boolean;
};
type TheClawBayAnthropicOptions = SimpleStreamOptions & { toolChoice?: AnthropicOptions["toolChoice"] };

function mergeHeaders(...sources: Array<Record<string, string | null> | undefined>): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) delete headers[name];
			else headers[name] = value;
		}
	}
	return headers;
}

function shouldNormalizeAnthropicSse(response: Response): boolean {
	const contentType = response.headers.get("content-type") ?? "";
	return !!response.body && contentType.toLowerCase().includes("text/event-stream");
}

async function readWithIdleTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number | undefined
) {
	if (!timeoutMs) return reader.read();

	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					const error = new Error(`TheClawBay Anthropic stream timed out after ${timeoutMs}ms without data`);
					reject(error);
					void reader.cancel(error);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function createNormalizedSseStream(body: ReadableStream<Uint8Array>, idleTimeoutMs?: number): ReadableStream<Uint8Array> {
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
			const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs);
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

export function normalizeAnthropicSseResponse(response: Response, idleTimeoutMs?: number): Response {
	const body = response.body;
	if (!body || !shouldNormalizeAnthropicSse(response)) {
		return response;
	}

	return new Response(createNormalizedSseStream(body, idleTimeoutMs), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function getAnthropicCompat(model: Model<Api>): AnthropicCompat {
	return (model.compat ?? {}) as AnthropicCompat;
}

function createNormalizingFetch(sourceFetch: Fetch = globalThis.fetch, idleTimeoutMs?: number): Fetch {
	return async (input, init) => normalizeAnthropicSseResponse(await sourceFetch(input, init), idleTimeoutMs);
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

function resolveAnthropicTimeoutCapMs(): number {
	const raw = process.env.PI_CLAWBAY_ANTHROPIC_TIMEOUT_MS;
	if (!raw) return DEFAULT_ANTHROPIC_TIMEOUT_MS;

	const timeout = Number.parseInt(raw, 10);
	return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_ANTHROPIC_TIMEOUT_MS;
}

function resolveAnthropicTimeoutMs(requestedTimeoutMs: number | undefined): number {
	const timeoutCapMs = resolveAnthropicTimeoutCapMs();
	if (!requestedTimeoutMs || !Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs >= PI_DISABLED_TIMEOUT_MS) {
		return timeoutCapMs;
	}

	return Math.min(requestedTimeoutMs, timeoutCapMs);
}

function adjustMaxTokensForThinking(
	requestedMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoning: NonNullable<SimpleStreamOptions["reasoning"]>,
	customBudgets?: SimpleStreamOptions["thinkingBudgets"]
): { maxTokens: number; thinkingBudgetTokens: number } {
	const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...customBudgets };
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
		fetch: createNormalizingFetch(globalThis.fetch, options?.timeoutMs),
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

export function normalizeTheClawBayAnthropicSystemPrompt(systemPrompt: string | undefined): string | undefined {
	return systemPrompt?.replace(PI_DOCS_HEADER, PI_DOCS_SAFE_HEADER).replace(PI_DOCS_LOOKUP_LINE, PI_DOCS_LOOKUP_LIST);
}

function createTheClawBayAnthropicContext(context: Context): Context {
	const systemPrompt = normalizeTheClawBayAnthropicSystemPrompt(context.systemPrompt);
	if (systemPrompt === context.systemPrompt) {
		return context;
	}

	return { ...context, systemPrompt };
}

function stripProxyRejectedToolChoice(options?: SimpleStreamOptions): SimpleStreamOptions | undefined {
	if (!options) {
		return undefined;
	}

	const { toolChoice: _toolChoice, ...safeOptions } = options as TheClawBayAnthropicOptions;
	return safeOptions;
}

function contextNeedsFineGrainedToolStreaming(model: Model<Api>, context: Context): boolean {
	return !!context?.tools?.length && getAnthropicCompat(model).supportsEagerToolInputStreaming === false;
}

function buildAnthropicOptions(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AnthropicOptions {
	const safeOptions = stripProxyRejectedToolChoice(options);
	const timeoutMs = resolveAnthropicTimeoutMs(safeOptions?.timeoutMs);
	const timeoutOptions = { ...safeOptions, timeoutMs };
	const client = buildAnthropicClient(model, context, timeoutOptions);
	const shared = {
		...timeoutOptions,
		apiKey: safeOptions?.apiKey ?? process.env.THECLAWBAY_API_KEY,
		client,
	};

	if (!model.reasoning || !safeOptions?.reasoning) {
		return { ...shared, thinkingEnabled: false };
	}

	if (getAnthropicCompat(model).forceAdaptiveThinking === true) {
		return {
			...shared,
			thinkingEnabled: true,
			thinkingDisplay: ADAPTIVE_THINKING_DISPLAY,
			effort: resolveAnthropicEffort(model, safeOptions.reasoning),
		};
	}

	return {
		...shared,
		thinkingEnabled: true,
		...adjustMaxTokensForThinking(
			safeOptions.maxTokens,
			model.maxTokens,
			safeOptions.reasoning,
			safeOptions.thinkingBudgets
		),
	};
}

export function streamSimpleTheClawBayAnthropicMessages(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions
): AssistantMessageEventStream {
	const safeContext = createTheClawBayAnthropicContext(context);
	return streamAnthropic(model as Model<"anthropic-messages">, safeContext, buildAnthropicOptions(model, safeContext, options));
}
