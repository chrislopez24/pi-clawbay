import {
	createAssistantMessageEventStream,
	streamSimpleOpenAIResponses,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { THECLAWBAY_CHATGPT_ACCOUNT_ID } from "./constants.js";
import { dedupeIds, resolveUpstreamModelId } from "./models.js";

export function buildTheClawBayHeaders(options?: SimpleStreamOptions): Record<string, string> {
	return {
		...(options?.headers ?? {}),
		"chatgpt-account-id": THECLAWBAY_CHATGPT_ACCOUNT_ID,
		originator: "pi",
		"OpenAI-Beta": "responses=experimental",
		...(options?.sessionId ? { session_id: options.sessionId } : {}),
	};
}

export function buildTheClawBayPayload(payload: unknown, context: Context): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return payload;
	}

	const source = payload as Record<string, unknown>;
	return {
		...source,
		instructions: context.systemPrompt ?? source.instructions,
		input: removeSystemInputs(source.input),
		include: dedupeIds([...getIncludeValues(source.include), "reasoning.encrypted_content"]),
		text: source.text ?? { verbosity: "medium" },
		tool_choice: source.tool_choice ?? "auto",
		parallel_tool_calls: source.parallel_tool_calls ?? true,
		store: source.store ?? false,
	};
}

function getIncludeValues(include: unknown): string[] {
	return Array.isArray(include) ? include.filter((item): item is string => typeof item === "string") : [];
}

function removeSystemInputs(input: unknown): unknown {
	if (!Array.isArray(input)) {
		return input;
	}

	return input.filter((item) => !isSystemInputItem(item));
}

function isSystemInputItem(item: unknown): boolean {
	if (!item || typeof item !== "object") {
		return false;
	}

	const role = (item as { role?: unknown }).role;
	return role === "developer" || role === "system";
}

export function createTheClawBayStreamModel(model: Model<Api>): Model<"openai-responses"> {
	return {
		...model,
		id: resolveUpstreamModelId(model.id),
		provider: "openai-codex",
		api: "openai-responses",
	} as Model<"openai-responses">;
}

export function createTheClawBayStreamContext(
	context: Context,
	originalModel: Pick<Model<Api>, "api" | "id" | "provider">,
	streamModel: Pick<Model<Api>, "api" | "id" | "provider">
): Context {
	return {
		...context,
		messages: context.messages.map((message) => {
			if (message.role !== "assistant" || message.provider !== originalModel.provider || message.api !== originalModel.api) {
				return message;
			}

			return {
				...message,
				api: streamModel.api,
				provider: streamModel.provider,
				model: streamModel.id,
			};
		}),
	};
}

function restoreAssistantMessageProvider(message: unknown, originalModel: Pick<Model<Api>, "api" | "id" | "provider">): void {
	if (!message || typeof message !== "object") {
		return;
	}

	const assistantMessage = message as { api?: Api; model?: string; provider?: string };
	assistantMessage.api = originalModel.api;
	assistantMessage.provider = originalModel.provider;
	assistantMessage.model = originalModel.id;
}

export function restoreTheClawBayEventProvider<T>(event: T, originalModel: Pick<Model<Api>, "api" | "id" | "provider">): T {
	if (!event || typeof event !== "object") {
		return event;
	}

	const candidate = event as { partial?: unknown; message?: unknown; error?: unknown };
	restoreAssistantMessageProvider(candidate.partial, originalModel);
	restoreAssistantMessageProvider(candidate.message, originalModel);
	restoreAssistantMessageProvider(candidate.error, originalModel);
	return event;
}

function wrapTheClawBayStream(source: AssistantMessageEventStream, originalModel: Model<Api>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		for await (const event of source) {
			stream.push(restoreTheClawBayEventProvider(event, originalModel));
		}
		stream.end();
	})();

	return stream;
}

export function streamSimpleTheClawBayCodexResponses(
	model: unknown,
	context: unknown,
	options?: unknown
): AssistantMessageEventStream {
	const typedModel = model as Model<Api>;
	const typedContext = context as Context;
	const typedOptions = options as SimpleStreamOptions | undefined;
	const originalOnPayload = typedOptions?.onPayload;
	const streamModel = createTheClawBayStreamModel(typedModel);
	const streamOptions: SimpleStreamOptions = {
		...typedOptions,
		apiKey: typedOptions?.apiKey ?? process.env.THECLAWBAY_API_KEY,
		headers: buildTheClawBayHeaders(typedOptions),
		onPayload: async (payload, requestModel) => {
			const transformedPayload = buildTheClawBayPayload(payload, typedContext);
			const nextPayload = await originalOnPayload?.(transformedPayload, requestModel);
			return nextPayload === undefined ? transformedPayload : nextPayload;
		},
	};

	const streamContext = createTheClawBayStreamContext(typedContext, typedModel, streamModel);
	return wrapTheClawBayStream(streamSimpleOpenAIResponses(streamModel, streamContext, streamOptions), typedModel);
}
