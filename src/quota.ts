import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { THECLAWBAY_QUOTA_URL } from "./constants.js";
import type { QuotaResponse, QuotaWindow } from "./types.js";

export async function fetchQuota(apiKey: string): Promise<QuotaResponse | null> {
	try {
		const response = await fetch(THECLAWBAY_QUOTA_URL, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as QuotaResponse;
	} catch {
		return null;
	}
}

export function getApiKey(): string | undefined {
	return process.env.THECLAWBAY_API_KEY;
}

function getQuotaWindows(quota: QuotaResponse): { fiveHour?: QuotaWindow; weekly?: QuotaWindow } {
	return {
		fiveHour: quota.usage?.fiveHour,
		weekly: quota.usage?.weekly,
	};
}

function formatPercent(percent: number): string {
	const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : percent >= 0.1 ? 2 : 3;
	return `${percent.toFixed(digits)}%`;
}

function formatDuration(seconds?: number): string {
	if (seconds === undefined) {
		return "unknown";
	}

	const totalSeconds = Math.max(0, Math.floor(seconds));
	const totalMinutes = Math.floor(totalSeconds / 60);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const time = `${hours}h ${minutes}m`;

	if (days > 0) {
		return `${days}d ${time}`;
	}
	return time;
}

function formatQuotaDetails(label: string, window?: QuotaWindow): string {
	if (!window || typeof window.percentUsed !== "number" || !Number.isFinite(window.percentUsed)) {
		return `${label}: N/A`;
	}

	const percent = formatPercent(window.percentUsed);
	const costUsed = window.estimatedCostUsdUsed;
	const costLimit = window.costUsdLimit;
	const hasUsd = typeof costUsed === "number" && typeof costLimit === "number";
	const usage = hasUsd ? `${percent} ($${costUsed.toFixed(2)}/$${costLimit.toFixed(2)})` : percent;

	return `${label}: ${usage} • ${window.requestCount ?? 0} req • resets ${formatDuration(window.secondsUntilReset)}`;
}

function getQuotaLevel(quota: QuotaResponse): "info" | "warning" {
	const { fiveHour, weekly } = getQuotaWindows(quota);
	return quota.anyLimitReached || quota.fiveHourLimitReached || quota.weeklyLimitReached || fiveHour?.limitReached || weekly?.limitReached
		? "warning"
		: "info";
}

function formatQuotaMessage(quota: QuotaResponse): string {
	const { fiveHour, weekly } = getQuotaWindows(quota);
	const details = `${formatQuotaDetails("5h", fiveHour)} | ${formatQuotaDetails("Week", weekly)}`;
	return quota.usageLimitPresentation ? `${quota.usageLimitPresentation} | ${details}` : details;
}

export function registerQuotaCommand(pi: ExtensionAPI): void {
	const command = {
		description: "Check TheClawBay quota usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const currentApiKey = getApiKey();
			if (!currentApiKey) {
				ctx.ui.notify("THECLAWBAY_API_KEY is not set", "error");
				return;
			}

			const quota = await fetchQuota(currentApiKey);
			if (!quota) {
				ctx.ui.notify("Failed to fetch quota from TheClawBay", "error");
				return;
			}

			ctx.ui.notify(formatQuotaMessage(quota), getQuotaLevel(quota));
		},
	};

	pi.registerCommand("quota", command);
	pi.registerCommand("clawbay-quota", command);
}
