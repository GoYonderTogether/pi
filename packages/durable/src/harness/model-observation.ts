import type { Context, JsonValue } from "@earendil-works/chord";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai/utils/uuid";
import { defineEntry } from "../entries.ts";
import type { ConversationId, EntryId, TaskRuntime, Tx } from "../types.ts";

/** Append-only statistics, never model context or a second usage ledger. */
export const ModelObservationEntry = defineEntry<ModelObservation>("pi.model-observation");

export type ObservationCheckpoint = {
	observationAttemptNo?: number;
	observationStart?: EntryId;
};

export type ModelObservation = {
	version: 1;
	phase: "start" | "end";
	operation: "generation" | "compaction";
	logicalRequestId: string;
	attemptId: string;
	attemptNo: number;
	selected: { model: string | null; provider: string | null; api: string | null };
	requestThinking: string | null;
	startedAtMs: number;
	endedAtMs?: number;
	elapsedMs?: number | null;
	status?: string;
	errorClass?: "cancelled" | "provider_error" | "unknown" | null;
	httpStatus?: number | null;
	usage?: Record<string, number | null> | null;
	observation?: JsonValue | null;
};

const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"];
const timingKeys = [
	"firstNormalizedEventMs",
	"firstTextDeltaMs",
	"lastTextDeltaMs",
	"firstThinkingDeltaMs",
	"lastThinkingDeltaMs",
	"firstToolDeltaMs",
	"lastToolDeltaMs",
	"firstEffectiveDeltaMs",
	"lastEffectiveDeltaMs",
	"endMs",
	"textDeltaCount",
	"thinkingDeltaCount",
	"toolDeltaCount",
];
const effortValues = [
	"off",
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"adaptive",
	"enabled",
	"disabled",
	"auto",
	"default",
];

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function choice(value: unknown, values: readonly string[]): string | null {
	return typeof value === "string" && values.includes(value) ? value : null;
}
/** Metadata labels, not arbitrary payload strings or endpoints. */
function label(value: unknown): string | null {
	return typeof value === "string" &&
		value.length <= 160 &&
		/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value) &&
		!value.includes("//") &&
		!/(^|[/:])(sk[-_]|bearer|api[-_]?key|token[-_]|eyJ)/i.test(value)
		? value
		: null;
}

/** Copy known scalar leaves only, including when a custom provider supplies the response. */
export function observationSnapshot(message: AssistantMessage): JsonValue | null {
	const source = object(object(message).observation);
	if (source.version !== 1) return null;
	const timing = object(source.timing);
	const usage = object(source.usage);
	const effort = object(source.effort);
	const wire = object(effort.wire);
	return {
		version: 1,
		timing: Object.fromEntries(timingKeys.map((key) => [key, number(timing[key])])),
		usage: {
			support: choice(usage.support, ["supported", "unsupported"]) ?? "unsupported",
			...Object.fromEntries(
				usageKeys.map((key) => {
					const field = object(usage[key]);
					const value = number(field.value);
					const source = value === null ? "unknown" : (choice(field.source, ["reported", "derived"]) ?? "unknown");
					return [key, { value: source === "unknown" ? null : value, source }];
				}),
			),
		},
		effort: {
			support: choice(effort.support, ["supported", "unsupported"]) ?? "unsupported",
			requested: choice(effort.requested, effortValues),
			clamped: choice(effort.clamped, effortValues),
			wire: {
				effort: typeof wire.effort === "number" ? number(wire.effort) : choice(wire.effort, effortValues),
				mode: choice(wire.mode, ["enabled", "disabled", "adaptive", "auto", "on", "off"]),
				budgetTokens: number(wire.budgetTokens),
			},
			serverActual: null,
		},
		reportedResponseModel: label(source.reportedResponseModel),
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

/** A network invocation gets a fresh identity even when the native scheduler re-enters the same checkpoint. */
export async function observeModelAttempt<I, S extends ObservationCheckpoint, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	operation: ModelObservation["operation"],
	model: Model<Api>,
	thinking: string | null,
	request: () => Promise<AssistantMessage>,
	context: Context,
): Promise<AssistantMessage> {
	let start: ModelObservation | undefined;
	await runtime.commit(async (tx, current) => {
		start = {
			version: 1,
			phase: "start",
			operation,
			logicalRequestId: String(runtime.taskId),
			attemptId: uuidv7(),
			attemptNo: (current.state.checkpoint.observationAttemptNo ?? 0) + 1,
			selected: { model: label(model.id), provider: label(model.provider), api: label(model.api) },
			requestThinking: choice(thinking, effortValues),
			startedAtMs: runtime.now(),
		};
		const entry = await tx.appendEntry(ModelObservationEntry, runtime.conversationId, { data: start });
		return {
			status: "running",
			checkpoint: { ...current.state.checkpoint, observationAttemptNo: start.attemptNo, observationStart: entry.id },
		};
	}, context);
	if (start === undefined) throw new Error("Observation start was not committed");
	const began = performance.now();
	let message: AssistantMessage | undefined;
	let failure: unknown;
	let failed = false;
	try {
		message = await request();
	} catch (error) {
		failed = true;
		failure = error;
	}
	// Abort-marked invocations cannot commit. Their native abort callback writes the end; close/crash leaves start open.
	if (!runtime.signal.aborted) {
		const end = terminalObservation(
			start,
			runtime.now(),
			performance.now() - began,
			message,
			failed ? failure : undefined,
		);
		await runtime.commit(async (tx, current) => {
			await tx.appendEntry(ModelObservationEntry, runtime.conversationId, { data: end });
			const { observationStart: _, ...checkpoint } = current.state.checkpoint;
			return { status: "running", checkpoint: checkpoint as S };
		}, context);
	}
	if (failed) throw failure;
	return message!;
}

/** Error text is intentionally never inspected, copied, or parsed for status. */
export function terminalObservation(
	start: ModelObservation,
	endedAtMs: number,
	elapsedMs: number | null,
	message?: AssistantMessage,
	error?: unknown,
): ModelObservation {
	const status = message?.stopReason ?? "throw";
	const rawStatus = object(error).status;
	const httpStatus =
		typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
			? rawStatus
			: null;
	return {
		...start,
		phase: "end",
		endedAtMs,
		elapsedMs,
		status,
		errorClass:
			status === "aborted"
				? "cancelled"
				: status === "error"
					? "provider_error"
					: status === "throw"
						? "unknown"
						: null,
		httpStatus,
		usage:
			message === undefined
				? null
				: Object.fromEntries(usageKeys.map((key) => [key, number(object(message.usage)[key])])),
		observation: message === undefined ? null : observationSnapshot(message),
	};
}

/** Explicit cancellation ends only the currently active invocation, within the existing abort transaction. */
export async function abortModelObservation(
	tx: Tx,
	conversationId: ConversationId,
	checkpoint: ObservationCheckpoint,
	now: number,
): Promise<void> {
	if (checkpoint.observationStart === undefined) return;
	const start = await tx.entry(ModelObservationEntry, checkpoint.observationStart);
	if (start?.data === undefined || start.data.phase !== "start") return;
	await tx.appendEntry(ModelObservationEntry, conversationId, {
		data: {
			...start.data,
			phase: "end",
			endedAtMs: now,
			elapsedMs: null,
			status: "aborted",
			errorClass: "cancelled",
			httpStatus: null,
			usage: null,
			observation: null,
		},
	});
}
