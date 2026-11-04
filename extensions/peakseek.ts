/**
 * DeepSeek footer extension for Pi
 *
 * - Adds the remaining DeepSeek balance to the *same* footer line as token usage.
 * - Re-prices each DeepSeek response with the off-peak discount when it finished
 *   outside DeepSeek's peak hours.
 * - Shows a colored dot on the footer line: green = off-peak, orange = peak.
 * - Balance is fetched on session start (Pi launch / new session), and
 *   `settleRefreshDelayMs` (default 10 s) after the agent settles, because
 *   DeepSeek finishes posting usage a little after the response ends.
 *   `/balance` refreshes immediately.
 *
 * DeepSeek peak hours (https://api-docs.deepseek.com/quick_start/pricing):
 *   01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public
 *   holidays. Everything else (nights, weekends, whole holidays) is off-peak.
 *   Off-peak rates are half of the peak rates.
 *
 * Optional config: ~/.pi/agent/peakseek.json
 * {
 *   "baseUrl": "https://api.deepseek.com",
 *   "peakWindowsUtc": [["01:00", "04:00"], ["06:00", "10:00"]],
 *   "peakWeekdays": ["Mon", "Tue", "Wed", "Thu", "Fri"],
 *   "holidays": ["2026-01-01", ...],  // Asia/Shanghai dates, whole day off-peak
 *   "offPeakMultiplier": 0.5,
 *   "modelMultipliers": { "deepseek-flash": 0.5, "deepseek-v4-pro": 0.5 },
 *   "settleRefreshDelayMs": 10000
 * }
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
	/** DeepSeek API root. */
	baseUrl: string;
	/** Peak windows as UTC "HH:MM" pairs. Everything outside them is off-peak. */
	peakWindowsUtc: Array<[string, string]>;
	/** Weekdays that can have peak hours ("Mon" … "Sun"). */
	peakWeekdays: string[];
	/** Asia/Shanghai calendar dates ("YYYY-MM-DD") that are off-peak all day. */
	holidays: string[];
	/** Cost multiplier while off-peak (0.5 = pay 50%). */
	offPeakMultiplier: number;
	/** Per-model overrides for `offPeakMultiplier`. */
	modelMultipliers: Record<string, number>;
	/** Wait this long after a chat settles before reading the balance (ms). */
	settleRefreshDelayMs: number;
}

/** Chinese public holidays, 2026 (source: State Council schedule / holiday-cn). */
const CHINA_HOLIDAYS_2026 = [
	"2026-01-01",
	"2026-01-02",
	"2026-01-03",
	"2026-02-15",
	"2026-02-16",
	"2026-02-17",
	"2026-02-18",
	"2026-02-19",
	"2026-02-20",
	"2026-02-21",
	"2026-02-22",
	"2026-02-23",
	"2026-04-04",
	"2026-04-05",
	"2026-04-06",
	"2026-05-01",
	"2026-05-02",
	"2026-05-03",
	"2026-05-04",
	"2026-05-05",
	"2026-06-19",
	"2026-06-20",
	"2026-06-21",
	"2026-09-25",
	"2026-09-26",
	"2026-09-27",
	"2026-10-01",
	"2026-10-02",
	"2026-10-03",
	"2026-10-04",
	"2026-10-05",
	"2026-10-06",
	"2026-10-07",
];

const DEFAULT_CONFIG: Config = {
	baseUrl: "https://api.deepseek.com",
	peakWindowsUtc: [
		["01:00", "04:00"],
		["06:00", "10:00"],
	],
	peakWeekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
	holidays: CHINA_HOLIDAYS_2026,
	offPeakMultiplier: 0.5,
	modelMultipliers: {},
	settleRefreshDelayMs: 10_000,
};

function loadConfig(): Config {
	const path = join(getAgentDir(), "peakseek.json");
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
		return {
			...DEFAULT_CONFIG,
			...raw,
			modelMultipliers: { ...DEFAULT_CONFIG.modelMultipliers, ...(raw.modelMultipliers ?? {}) },
			settleRefreshDelayMs: Number.isFinite(raw.settleRefreshDelayMs)
				? Math.max(0, raw.settleRefreshDelayMs as number)
				: DEFAULT_CONFIG.settleRefreshDelayMs,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

const CFG = loadConfig();

// ---------------------------------------------------------------------------
// Off-peak window
// ---------------------------------------------------------------------------

function toMinutes(hhmm: string): number {
	if (typeof hhmm !== "string") return 0;
	const [h, m] = hhmm.split(":").map(Number);
	if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
	return (((h * 60 + m) % 1440) + 1440) % 1440;
}

/** China Standard Time is UTC+8 all year (no DST). */
const CHINA_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const PEAK_WINDOWS: Array<[number, number]> = CFG.peakWindowsUtc
	.map(([start, end]) => [toMinutes(start), toMinutes(end)] as [number, number])
	.filter(([start, end]) => start !== end);

const PEAK_WEEKDAYS = new Set<number>(
	CFG.peakWeekdays
		.map((name) => WEEKDAY_INDEX[name.trim().slice(0, 3).toLowerCase()])
		.filter((value): value is number => typeof value === "number"),
);

const HOLIDAYS = new Set<string>(CFG.holidays);

/** Calendar date (YYYY-MM-DD) in China Standard Time. */
function chinaDateKey(timestamp: number): string {
	return new Date(timestamp + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Day of week (0=Sunday) in China Standard Time. */
function chinaWeekday(timestamp: number): number {
	return new Date(timestamp + CHINA_OFFSET_MS).getUTCDay();
}

/** True when DeepSeek bills at off-peak rates for this instant. */
function isOffPeak(timestamp: number = Date.now()): boolean {
	// Whole Chinese public holidays are off-peak, weekends included.
	if (HOLIDAYS.has(chinaDateKey(timestamp))) return true;
	if (!PEAK_WEEKDAYS.has(chinaWeekday(timestamp))) return true;

	const instant = new Date(timestamp);
	const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes();
	return !PEAK_WINDOWS.some(([start, end]) =>
		start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end,
	);
}

/** Epoch ms of the next instant at which peak/off-peak flips. */
function nextTransition(timestamp: number = Date.now()): number {
	const current = isOffPeak(timestamp);
	const utcMidnight = Math.floor(timestamp / DAY_MS) * DAY_MS;
	const candidates: number[] = [];

	for (let day = -1; day <= 2; day++) {
		const midnight = utcMidnight + day * DAY_MS;
		// China midnight (16:00 UTC) can flip weekday/holiday state.
		candidates.push(midnight + 16 * 3_600_000);
		for (const [start, end] of PEAK_WINDOWS) {
			candidates.push(midnight + start * 60_000, midnight + end * 60_000);
		}
	}

	const future = candidates.filter((at) => at > timestamp).sort((a, b) => a - b);
	for (const at of future) {
		if (isOffPeak(at) !== current) return at;
	}
	return future[0] ?? timestamp + 60_000;
}

function clampMultiplier(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(1, Math.max(0, value));
}

function multiplierFor(modelId: string | undefined): number {
	if (modelId) {
		const byModel = CFG.modelMultipliers[modelId];
		if (typeof byModel === "number") return clampMultiplier(byModel);
	}
	return clampMultiplier(CFG.offPeakMultiplier);
}

// ---------------------------------------------------------------------------
// Balance state
// ---------------------------------------------------------------------------

interface BalanceState {
	loaded: boolean;
	total?: number;
	granted?: number;
	toppedUp?: number;
	currency?: string;
	available?: boolean;
	error?: string;
	at?: number;
}

let balance: BalanceState = { loaded: false };
let balanceRequest: Promise<void> | undefined;
/** Set when no DeepSeek key is configured; avoids retrying on every agent settle. */
let keyMissing = false;

function currencySymbol(currency: string | undefined): string {
	switch ((currency ?? "USD").toUpperCase()) {
		case "CNY":
			return "¥";
		case "EUR":
			return "€";
		default:
			return "$";
	}
}

function formatMoney(value: number, currency: string | undefined): string {
	return `${currencySymbol(currency)}${value.toFixed(2)}`;
}

async function refreshBalance(ctx: ExtensionContext): Promise<void> {
	if (balanceRequest) return balanceRequest;
	if (keyMissing) return;

	const request = (async () => {
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
			if (!apiKey) {
				keyMissing = true;
				throw new Error("no DeepSeek API key configured");
			}

			const base = CFG.baseUrl.replace(/\/+$/, "");
			const response = await fetch(`${base}/user/balance`, {
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = (await response.json()) as {
				is_available?: boolean;
				balance_infos?: Array<{
					currency?: string;
					total_balance?: string | number;
					granted_balance?: string | number;
					topped_up_balance?: string | number;
				}>;
			};

			const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
			const info = infos.find((i) => (i.currency ?? "").toUpperCase() === "USD") ?? infos[0];
			if (!info) throw new Error("balance response had no balance_infos");

			balance = {
				loaded: true,
				total: Number(info.total_balance),
				granted: Number(info.granted_balance),
				toppedUp: Number(info.topped_up_balance),
				currency: info.currency ?? "USD",
				available: data.is_available !== false,
				at: Date.now(),
			};
		} catch (error) {
			balance = {
				...balance,
				loaded: true,
				error: error instanceof Error ? error.message : String(error),
				at: Date.now(),
			};
		} finally {
			balanceRequest = undefined;
			requestFooterRender();
		}
	})();

	balanceRequest = request;
	return request;
}

/**
 * DeepSeek posts the spend for a run a moment after the response ends, so a
 * balance read taken immediately after settling is usually stale. Wait, then
 * read. Repeated settles reset the timer; a new run cancels it.
 */
function scheduleSettleRefresh(ctx: ExtensionContext): void {
	cancelSettleRefresh();
	settleTimer = setTimeout(() => {
		settleTimer = undefined;
		void refreshBalance(latestCtx ?? ctx);
	}, Math.max(0, CFG.settleRefreshDelayMs));
	(settleTimer as { unref?: () => void }).unref?.();
}

function cancelSettleRefresh(): void {
	if (!settleTimer) return;
	clearTimeout(settleTimer);
	settleTimer = undefined;
}

// ---------------------------------------------------------------------------
// Footer rendering
// ---------------------------------------------------------------------------

interface FooterComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

let latestCtx: ExtensionContext | undefined;
let activeTui: { requestRender(): void } | undefined;
let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

function requestFooterRender(): void {
	try {
		activeTui?.requestRender();
	} catch {
		// TUI may already be torn down.
	}
}

function scheduleBoundaryRender(): void {
	if (boundaryTimer) clearTimeout(boundaryTimer);
	// +1s so we are safely past the boundary when we re-render.
	const delay = Math.max(1_000, nextTransition() - Date.now() + 1_000);
	boundaryTimer = setTimeout(() => {
		requestFooterRender();
		scheduleBoundaryRender();
	}, delay);
	// Never keep the process alive just for the indicator.
	(boundaryTimer as { unref?: () => void }).unref?.();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate?: number;
	contextUsage?: ContextUsage;
}

function addUsage(totals: UsageTotals, usage: any, promptTokens?: number): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
	if (promptTokens !== undefined && promptTokens > 0) {
		totals.cacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
	}
}

let statsCache:
	| { entryCount: number; leafId: string | null; value: UsageTotals }
	| undefined;

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const sessionManager = ctx.sessionManager;
	const entries = sessionManager.getEntries();
	const entryCount = entries.length;
	const leafId = sessionManager.getLeafId();
	const contextUsage = ctx.getContextUsage();

	if (statsCache && statsCache.entryCount === entryCount && statsCache.leafId === leafId) {
		statsCache.value.contextUsage = contextUsage;
		return statsCache.value;
	}

	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		const e = entry as any;
		if (e.type === "usage" && e.usage) {
			// Cache-warm / bookkeeping usage is never routed through message_end,
			// so price it here when it was recorded during DeepSeek off-peak.
			addUsage(totals, offPeakUsage(e.provider, e.model, e.timestamp, e.usage));
		} else if (e.type === "message") {
			const message = e.message;
			if (message?.role === "assistant") {
				const usage = message.usage;
				addUsage(
					totals,
					usage,
					(usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
				);
			} else if (message?.role === "toolResult" && message.usage) {
				addUsage(totals, message.usage);
			}
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			addUsage(totals, e.usage);
		}
	}
	totals.contextUsage = contextUsage;

	statsCache = { entryCount, leafId, value: totals };
	return totals;
}

/** Best-effort read of `compaction.enabled` from the global settings file. */
function readAutoCompactEnabled(): boolean {
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as {
			compaction?: { enabled?: boolean };
		};
		return settings.compaction?.enabled !== false;
	} catch {
		return true;
	}
}

let autoCompact = readAutoCompactEnabled();

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function peakIndicator(theme: Theme): string {
	const offPeak = isOffPeak();
	if (offPeak) return `${theme.fg("success", "●")} ${theme.fg("dim", "off-peak")}`;
	const orange = parseColor(theme.appearance === "light" ? "#c2410c" : "#ff9e64");
	return `${theme.style("●", { fg: orange })} ${theme.fg("dim", "peak")}`;
}

function balanceIndicator(theme: Theme): string | undefined {
	if (keyMissing && balance.total === undefined) return undefined;
	if (!balance.loaded) return theme.fg("dim", "bal …");
	const total = balance.total;
	if (total === undefined || !Number.isFinite(total)) return theme.fg("dim", "bal ?");
	const text = `bal ${formatMoney(total, balance.currency)}`;
	if (balance.error) return theme.fg("warning", text);
	if (total <= 0) return theme.fg("error", text);
	return theme.fg("dim", text);
}

function createFooter(
	ctx: ExtensionContext,
	theme: Theme,
	tui: { requestRender(): void },
	footerData: ReadonlyFooterDataProvider,
): FooterComponent {
	activeTui = tui;
	const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

	return {
		dispose: unsubscribe,
		invalidate() {},
		render(width: number): string[] {
			const current = latestCtx ?? ctx;
			const model = current?.model;
			const totals: UsageTotals = current
				? getUsageTotals(current)
				: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			const contextUsage = totals.contextUsage;
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const contextPercent = contextUsage?.percent;

			// --- path line ---------------------------------------------------
			let pwd = formatCwd(
				current?.sessionManager.getCwd() ?? process.cwd(),
				process.env.HOME || process.env.USERPROFILE,
			);
			const branch = footerData.getGitBranch();
			if (branch) pwd = `${pwd} (${branch})`;
			const sessionName = current?.sessionManager.getSessionName();
			if (sessionName) pwd = `${pwd} • ${sessionName}`;

			// --- stats line --------------------------------------------------
			const parts: string[] = [];
			const dim = (text: string) => theme.fg("dim", text);

			if (totals.input) parts.push(dim(`↑${formatTokens(totals.input)}`));
			if (totals.output) parts.push(dim(`↓${formatTokens(totals.output)}`));
			if (totals.cacheRead) parts.push(dim(`R${formatTokens(totals.cacheRead)}`));
			if (totals.cacheWrite) parts.push(dim(`W${formatTokens(totals.cacheWrite)}`));
			if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.cacheHitRate !== undefined) {
				parts.push(dim(`CH${totals.cacheHitRate.toFixed(1)}%`));
			}

			let usingSubscription = false;
			try {
				usingSubscription = model
					? model.provider === "kimi-coding" || current.modelRegistry.isUsingOAuth(model)
					: false;
			} catch {
				usingSubscription = false;
			}
			if (totals.cost || usingSubscription) {
				parts.push(dim(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`));
			}

			const bal = balanceIndicator(theme);
			if (bal) parts.push(bal);
			if (model?.provider === "deepseek") parts.push(peakIndicator(theme));

			const autoIndicator = autoCompact ? " (auto)" : "";
			let contextText: string;
			if (contextPercent === null || contextPercent === undefined) {
				contextText = `?/${formatTokens(contextWindow)}${autoIndicator}`;
			} else {
				contextText = `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
			}
			if ((contextPercent ?? 0) > 90) parts.push(theme.fg("error", contextText));
			else if ((contextPercent ?? 0) > 70) parts.push(theme.fg("warning", contextText));
			else parts.push(dim(contextText));

			if (process.env.PI_EXPERIMENTAL === "1") {
				parts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
			}

			let statsLeft = parts.join(" ");
			let statsLeftWidth = visibleWidth(statsLeft);
			if (statsLeftWidth > width) {
				statsLeft = truncateToWidth(statsLeft, width, "...");
				statsLeftWidth = visibleWidth(statsLeft);
			}

			// --- right side ---------------------------------------------------
			const minPadding = 2;
			const modelName = model?.id || "no-model";
			let right = modelName;
			if (model?.reasoning) {
				const level = current?.thinkingLevel || "off";
				right = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
			}
			if (footerData.getAvailableProviderCount() > 1 && model) {
				const withProvider = `(${model.provider}) ${right}`;
				if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) right = withProvider;
			}

			const rightWidth = visibleWidth(right);
			let statsLine: string;
			if (statsLeftWidth + minPadding + rightWidth <= width) {
				statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + theme.fg("dim", right);
			} else {
				const availableForRight = width - statsLeftWidth - minPadding;
				if (availableForRight > 0) {
					const truncatedRight = truncateToWidth(right, availableForRight, "");
					const truncatedWidth = visibleWidth(truncatedRight);
					const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedWidth));
					statsLine = statsLeft + padding + theme.fg("dim", truncatedRight);
				} else {
					statsLine = statsLeft;
				}
			}

			const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), statsLine];

			// --- extension statuses (setStatus) -------------------------------
			const statuses = footerData.getExtensionStatuses();
			if (statuses.size > 0) {
				const statusLine = Array.from(statuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.join(" ");
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}

			return lines;
		},
	};
}

// ---------------------------------------------------------------------------
// Off-peak cost adjustment
// ---------------------------------------------------------------------------

const adjustedKeys = new Set<string>();

function messageKey(message: any): string {
	return [
		message.timestamp ?? 0,
		message.model ?? "",
		message.responseId ?? "",
		message.usage?.input ?? 0,
		message.usage?.output ?? 0,
		message.usage?.cacheRead ?? 0,
		message.usage?.cacheWrite ?? 0,
	].join(":");
}

function scaleCost(cost: any, multiplier: number) {
	const scale = (value: number | undefined) => (value ?? 0) * multiplier;
	return {
		...cost,
		input: scale(cost?.input),
		output: scale(cost?.output),
		cacheRead: scale(cost?.cacheRead),
		cacheWrite: scale(cost?.cacheWrite),
		total: scale(cost?.total),
		totalFromProvider: false,
	};
}

/** Price a "usage" session entry at off-peak rates when it belongs to DeepSeek. */
function offPeakUsage(
	provider: string | undefined,
	modelId: string | undefined,
	timestamp: string | number | undefined,
	usage: any,
): any {
	if (provider !== "deepseek" || !usage?.cost) return usage;
	const multiplier = multiplierFor(modelId);
	if (multiplier >= 1) return usage;
	let when = Date.now();
	if (timestamp !== undefined) {
		const parsed = new Date(timestamp).getTime();
		if (!Number.isNaN(parsed)) when = parsed;
	}
	if (!isOffPeak(when)) return usage;
	return { ...usage, cost: scaleCost(usage.cost, multiplier) };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		statsCache = undefined;
		autoCompact = readAutoCompactEnabled();
		keyMissing = false;
		cancelSettleRefresh();

		ctx.ui.setFooter((tui, theme, footerData) => createFooter(ctx, theme, tui, footerData));
		scheduleBoundaryRender();

		// Balance: on launch / new session only.
		void refreshBalance(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (boundaryTimer) clearTimeout(boundaryTimer);
		boundaryTimer = undefined;
		cancelSettleRefresh();
		activeTui = undefined;
	});

	// Keep the render context fresh.
	pi.on("model_select", async (_event, ctx) => {
		latestCtx = ctx;
		statsCache = undefined;
		requestFooterRender();
		if (!balance.loaded) {
			keyMissing = false;
			void refreshBalance(ctx);
		}
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		latestCtx = ctx;
		requestFooterRender();
	});

	pi.on("message_end", async (event, ctx) => {
		latestCtx = ctx;
		statsCache = undefined;

		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.provider !== "deepseek") return;
		if (!isOffPeak()) return;

		const multiplier = multiplierFor(message.model ?? message.responseModel);
		if (multiplier >= 1) return;

		const usage = message.usage;
		if (!usage?.cost || !(usage.cost.total > 0)) return;

		const key = messageKey(message);
		if (adjustedKeys.has(key)) return;
		adjustedKeys.add(key);
		if (adjustedKeys.size > 1000) adjustedKeys.clear();

		return {
			message: {
				...message,
				usage: { ...usage, cost: scaleCost(usage.cost, multiplier) },
			},
		};
	});

	// Balance: after a chat run has fully settled, plus a delay for DeepSeek to post the spend.
	pi.on("agent_settled", async (_event, ctx) => {
		latestCtx = ctx;
		scheduleSettleRefresh(ctx);
	});

	// A new run makes any pending balance read stale; the next settle re-schedules it.
	pi.on("agent_start", async () => {
		cancelSettleRefresh();
	});

	pi.registerCommand("balance", {
		description: "Refresh and show the DeepSeek account balance",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			keyMissing = false;
			cancelSettleRefresh();
			await refreshBalance(ctx);

			const total = balance.total;
			if (total === undefined || !Number.isFinite(total)) {
				ctx.ui.notify(`DeepSeek balance unavailable: ${balance.error ?? "unknown error"}`, "error");
				return;
			}

			const details: string[] = [`total ${formatMoney(total, balance.currency)}`];
			if (balance.granted !== undefined && Number.isFinite(balance.granted)) {
				details.push(`granted ${formatMoney(balance.granted, balance.currency)}`);
			}
			if (balance.toppedUp !== undefined && Number.isFinite(balance.toppedUp)) {
				details.push(`topped up ${formatMoney(balance.toppedUp, balance.currency)}`);
			}
			details.push(isOffPeak() ? "off-peak rates active" : "peak rates active");
			if (balance.error) details.push(`last refresh error: ${balance.error}`);
			ctx.ui.notify(`DeepSeek ${balance.currency ?? "USD"} balance — ${details.join(" · ")}`, "info");
		},
	});
}
