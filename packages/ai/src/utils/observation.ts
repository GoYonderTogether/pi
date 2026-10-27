import type { AssistantMessageObservation, ObservedUsageValue } from "../types.ts";

export function createAssistantMessageObservation(
	supported = false,
	levels?: RequestedEffortObservation,
): AssistantMessageObservation {
	const unknown = (): ObservedUsageValue => ({ value: null, source: "unknown" });
	return {
		version: 1,
		timing: {
			firstNormalizedEventMs: null,
			firstTextDeltaMs: null,
			lastTextDeltaMs: null,
			firstThinkingDeltaMs: null,
			lastThinkingDeltaMs: null,
			firstToolDeltaMs: null,
			lastToolDeltaMs: null,
			firstEffectiveDeltaMs: null,
			lastEffectiveDeltaMs: null,
			endMs: null,
			textDeltaCount: 0,
			thinkingDeltaCount: 0,
			toolDeltaCount: 0,
		},
		usage: {
			support: supported ? "supported" : "unsupported",
			input: unknown(),
			output: unknown(),
			cacheRead: unknown(),
			cacheWrite: unknown(),
			cacheWrite1h: unknown(),
			reasoning: unknown(),
			totalTokens: unknown(),
		},
		effort: {
			support: supported ? "supported" : "unsupported",
			requested: safeChoice(levels?.requested, effortLabels),
			clamped: safeChoice(levels?.clamped, effortLabels),
			wire: { effort: null, mode: null, budgetTokens: null },
			serverActual: null,
		},
		reportedResponseModel: null,
		responseHeadersMs: null,
		firstProviderEventMs: null,
		firstBodyByteMs: null,
		accountSlotId: null,
		rateSnapshot: null,
		unsupported: [
			"responseHeadersMs",
			"firstProviderEventMs",
			"firstBodyByteMs",
			"serverActualEffort",
			"accountSlotId",
			"rateSnapshot",
		],
	};
}

const effortLabels = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto", "default"];
const modeLabels = ["enabled", "disabled", "adaptive", "auto", "on", "off"];
function safeChoice(value: unknown, labels: readonly string[]): string | null {
	return typeof value === "string" && labels.includes(value) ? value : null;
}
/** Only model labels, not arbitrary endpoints or credential-shaped strings. */
export function observationModelLabel(value: unknown): string | null {
	return typeof value === "string" &&
		/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value) &&
		!value.includes("//") &&
		!/(^|\/)(sk[-_]|bearer|api[-_]?key|token[-_]|eyJ)/i.test(value)
		? value
		: null;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function reported(value: unknown): ObservedUsageValue {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? { value, source: "reported" }
		: { value: null, source: "unknown" };
}

function derived(values: ObservedUsageValue[], calculate: (values: number[]) => number): ObservedUsageValue {
	return values.every((v) => v.value !== null)
		? { value: calculate(values.map((v) => v.value!)), source: "derived" }
		: { value: null, source: "unknown" };
}

/** Capture presence before adapters replace absent fields with zero. */
export function observeOpenAIUsage(observation: AssistantMessageObservation, raw: unknown, responses: boolean): void {
	const usage = record(raw);
	const inputDetails = record(usage[responses ? "input_tokens_details" : "prompt_tokens_details"]);
	const outputDetails = record(usage[responses ? "output_tokens_details" : "completion_tokens_details"]);
	const target = observation.usage;
	target.support = "supported";
	const prompt = reported(usage[responses ? "input_tokens" : "prompt_tokens"]);
	target.output = reported(usage[responses ? "output_tokens" : "completion_tokens"]);
	target.cacheRead = reported(
		inputDetails.cached_tokens ?? (responses ? undefined : (usage.prompt_cache_hit_tokens ?? usage.cached_tokens)),
	);
	target.cacheWrite = reported(inputDetails.cache_write_tokens);
	target.reasoning = reported(outputDetails.reasoning_tokens);
	target.input = derived([prompt, target.cacheRead, target.cacheWrite], ([input, read, write]) =>
		Math.max(0, input - read - write),
	);
	target.totalTokens = reported(usage.total_tokens);
	if (target.totalTokens.value === null)
		target.totalTokens = derived([prompt, target.output], ([input, output]) => input + output);
}

/** Anthropic usage deltas are partial snapshots, not increments. */
export function observeAnthropicUsage(observation: AssistantMessageObservation, raw: unknown): void {
	const usage = record(raw);
	const target = observation.usage;
	target.support = "supported";
	const fields = {
		input: usage.input_tokens,
		output: usage.output_tokens,
		cacheRead: usage.cache_read_input_tokens,
		cacheWrite: usage.cache_creation_input_tokens,
		cacheWrite1h: record(usage.cache_creation).ephemeral_1h_input_tokens,
		reasoning: record(usage.output_tokens_details).thinking_tokens,
	};
	for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
		const value = reported(fields[key]);
		if (value.value !== null) target[key] = value;
	}
	target.totalTokens = derived([target.input, target.output, target.cacheRead, target.cacheWrite], (counts) =>
		counts.reduce((sum, count) => sum + count, 0),
	);
}

export interface RequestedEffortObservation {
	requested: string | null;
	clamped: string | null;
}

/** Copy only effort controls from the final payload; never retain the payload. */
export function observeRequestEffort(
	observation: AssistantMessageObservation,
	payload: unknown,
	levels?: RequestedEffortObservation,
	budgetField?: string,
): void {
	const params = record(payload);
	const reasoning = record(params.reasoning);
	const thinking = record(params.thinking);
	let effort = record(params.output_config).effort ?? reasoning.effort ?? params.reasoning_effort;
	// Managed effort protocols put the active control at the end of the input/messages.
	const items = params.input ?? params.messages;
	if (Array.isArray(items)) {
		for (const item of items) {
			const entry = record(item);
			if (entry.type === "configuration_update") effort = record(entry.reasoning).effort ?? effort;
			if (entry.role === "system") effort = record(entry.output_config).effort ?? effort;
		}
	}
	const enabled =
		params.enable_thinking ??
		record(params.chat_template_kwargs).enable_thinking ??
		record(params.chat_template_args).enable_thinking ??
		reasoning.enabled;
	const mode =
		thinking.type ??
		(typeof params.thinking === "string"
			? params.thinking
			: typeof enabled === "boolean"
				? enabled
					? "enabled"
					: "disabled"
				: undefined);
	const budget = thinking.budget_tokens ?? (budgetField ? params[budgetField] : undefined);
	observation.effort = {
		support: "supported",
		requested: safeChoice(levels?.requested, effortLabels),
		clamped: safeChoice(levels?.clamped, effortLabels),
		wire: {
			effort:
				typeof effort === "number" && Number.isFinite(effort) && effort >= 0
					? effort
					: safeChoice(effort, effortLabels),
			mode: safeChoice(mode, modeLabels),
			budgetTokens: typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : null,
		},
		serverActual: null,
	};
}
