export interface TheClawBayModelMetadata {
	id: string;
	name?: string;
	supportsReasoning?: boolean;
	supportedReasoningEfforts?: string[];
	defaultReasoningEffort?: string | null;
}

export interface OpenAIModelListResponse {
	data?: Array<{
		id?: string;
		display_name?: string;
		supports_reasoning?: boolean;
		supported_reasoning_efforts?: string[];
		default_reasoning_effort?: string | null;
	}>;
}

export interface ModelCacheFile {
	version?: number;
	fetchedAt?: string;
	modelIds?: string[];
	models?: TheClawBayModelMetadata[];
}

export interface QuotaWindow {
	secondsUntilReset?: number;
	requestCount?: number;
	estimatedCostUsdUsed?: number | null;
	costUsdLimit?: number | null;
	percentUsed?: number;
	limitReached?: boolean;
}

export interface QuotaResponse {
	usageLimitPresentation?: string;
	usage?: {
		fiveHour?: QuotaWindow;
		weekly?: QuotaWindow;
	};
	fiveHourLimitReached?: boolean;
	weeklyLimitReached?: boolean;
	anyLimitReached?: boolean;
}
