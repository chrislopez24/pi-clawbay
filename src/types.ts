export interface OpenAIModelListResponse {
	data?: Array<{
		id?: string;
	}>;
}

export interface ModelCacheFile {
	version?: number;
	fetchedAt?: string;
	modelIds?: string[];
}

export interface QuotaWindow {
	secondsUntilReset?: number;
	requestCount?: number;
	estimatedCostUsdUsed?: number | null;
	costUsdLimit?: number | null;
	percentUsed: number;
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
