import { streamSimpleOpenAIResponses, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
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
		instructions: context.systemPrompt,
		input: removeSystemInputs(source.input),
		include: dedupeIds([...getIncludeValues(source.include), "reasoning.encrypted_content"]),
		text: { verbosity: "medium" },
		tool_choice: "auto",
		parallel_tool_calls: true,
		store: false,
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

export function streamSimpleTheClawBayCodexResponses(
	model: unknown,
	context: unknown,
	options?: unknown
): AssistantMessageEventStream {
	const typedModel = model as Model<"openai-responses">;
	const typedContext = context as Context;
	const typedOptions = options as SimpleStreamOptions | undefined;
	const originalOnPayload = typedOptions?.onPayload;
	const remappedModel = { ...typedModel, id: resolveUpstreamModelId(typedModel.id) } as Model<"openai-responses">;

	return streamSimpleOpenAIResponses(remappedModel, typedContext, {
		...typedOptions,
		headers: buildTheClawBayHeaders(typedOptions),
		onPayload: async (payload, streamModel) => {
			const transformedPayload = buildTheClawBayPayload(payload, typedContext);
			const nextPayload = await originalOnPayload?.(transformedPayload, streamModel);
			return nextPayload === undefined ? transformedPayload : nextPayload;
		},
	});
}
