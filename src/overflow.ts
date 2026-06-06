import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THECLAWBAY_PROVIDER_ID = "theclawbay";
const CONTEXT_OVERFLOW_PREFIX = "context_length_exceeded";

const THECLAWBAY_CONTEXT_OVERFLOW_PATTERN =
	/\b(?:context(?:[-_\s]?(?:length|window|limit))|maximum context|too many input tokens|input is too long|token limit|tokens?[^.]{0,80}(?:exceed|exceeded|exceeds|larger than|too large)|exceed(?:ed|s)?[^.]{0,80}(?:context|tokens?))\b/i;

type MessageEndEvent = {
	message: {
		role: string;
		provider?: string;
		stopReason?: string;
		errorMessage?: string;
		[key: string]: unknown;
	};
};

type MessageEndContext = {
	model?: {
		provider?: string;
	};
};

export function normalizeTheClawBayContextOverflow(event: MessageEndEvent, ctx: MessageEndContext) {
	const message = event.message;
	if (message.role !== "assistant") return undefined;
	if (message.stopReason !== "error") return undefined;
	if (message.provider !== THECLAWBAY_PROVIDER_ID && ctx.model?.provider !== THECLAWBAY_PROVIDER_ID) return undefined;

	const errorMessage = message.errorMessage ?? "";
	if (errorMessage.includes(CONTEXT_OVERFLOW_PREFIX)) return undefined;
	if (!THECLAWBAY_CONTEXT_OVERFLOW_PATTERN.test(errorMessage)) return undefined;

	return {
		message: {
			...message,
			errorMessage: `${CONTEXT_OVERFLOW_PREFIX}: ${errorMessage}`,
		},
	};
}

export function registerOverflowNormalization(pi: ExtensionAPI): void {
	const api = pi as unknown as {
		on(event: "message_end", handler: typeof normalizeTheClawBayContextOverflow): void;
	};
	api.on("message_end", normalizeTheClawBayContextOverflow);
}
