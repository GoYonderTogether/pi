import type { Context } from "@earendil-works/chord";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	abortModelObservation,
	type ModelObservation,
	type ObservationCheckpoint,
	observationSnapshot,
	observeModelAttempt,
	terminalObservation,
} from "../src/harness/model-observation.ts";
import type { EntryId, TaskRuntime, Tx } from "../src/types.ts";

const model = { id: "gpt-6-luna", provider: "openai", api: "openai-responses" } as Model<Api>;
const context = {} as Context;
const start: ModelObservation = {
	version: 1,
	phase: "start",
	operation: "generation",
	logicalRequestId: "1",
	attemptId: "local-id",
	attemptNo: 1,
	selected: { model: model.id, provider: model.provider, api: model.api },
	requestThinking: "high",
	startedAtMs: 100,
};
// Data fixture for the pure projection, never a synthetic provider or model invocation.
function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		model: model.id,
		provider: model.provider,
		api: model.api,
		stopReason: "stop",
		timestamp: 100,
		usage: {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** In-memory transaction recorder for the lifecycle function, not a model/provider substitute. */
function recorder() {
	const controller = new AbortController();
	const entries: ModelObservation[] = [];
	let checkpoint: ObservationCheckpoint = {};
	const tx = {
		appendEntry: async (_kind: unknown, _conversation: unknown, value: { data: ModelObservation }) => {
			entries.push(structuredClone(value.data));
			return { id: entries.length as EntryId };
		},
		entry: async (_kind: unknown, id: EntryId) => ({ data: entries[id - 1] }),
	} as unknown as Tx;
	const runtime = {
		taskId: 1,
		conversationId: 1,
		signal: controller.signal,
		now: () => 100,
		commit: async (
			change: (
				tx: Tx,
				current: { state: { checkpoint: ObservationCheckpoint } },
			) => Promise<{ checkpoint: ObservationCheckpoint }>,
		) => {
			checkpoint = (await change(tx, { state: { checkpoint } })).checkpoint;
		},
	} as unknown as TaskRuntime<never, ObservationCheckpoint, never, Record<string, never>>;
	return { entries, runtime, controller, tx, checkpoint: () => checkpoint };
}

describe("model attempt statistics (deterministic data logic)", () => {
	it("keeps legacy usage separate, never sums reasoning into output, strips unknown leaves", () => {
		const value = message();
		Object.assign(value, {
			observation: {
				version: 1,
				timing: { firstTextDeltaMs: 1, headers: "SECRET" },
				usage: {
					support: "supported",
					output: { value: 0, source: "reported", raw: "SECRET" },
					input: { value: null, source: "unknown" },
					reasoning: { value: 1, source: "reported" },
				},
				effort: {
					support: "supported",
					requested: "high",
					clamped: "medium",
					wire: { effort: "low", token: "SECRET" },
					serverActual: "SECRET",
				},
				reportedResponseModel: "https://SECRET",
				prompt: "SECRET",
			},
		});
		const projected = observationSnapshot(value);
		expect(JSON.stringify(projected)).not.toContain("SECRET");
		expect(projected).toMatchObject({
			usage: { output: { value: 0, source: "reported" }, input: { value: null, source: "unknown" } },
			effort: { requested: "high", clamped: "medium", wire: { effort: "low" }, serverActual: null },
		});
		const end = terminalObservation(start, 200, 10, value);
		expect(end.usage?.output).toBe(3);
		expect(end.usage?.reasoning).toBeNull();
		expect(value.usage.output).toBe(3);
	});

	it("rejects credential-shaped nested model labels and preserves supported wire modes", () => {
		for (const label of [
			"org/sk-secret",
			"org/token_secret",
			"org/api-key-secret",
			"org/eyJsecret",
			"https://secret",
		]) {
			const value = message();
			Object.assign(value, { observation: { version: 1, reportedResponseModel: label } });
			expect(observationSnapshot(value)).toMatchObject({ reportedResponseModel: null });
		}
		const value = message();
		Object.assign(value, { observation: { version: 1, effort: { requested: "default", wire: { mode: "on" } } } });
		expect(observationSnapshot(value)).toMatchObject({ effort: { requested: "default", wire: { mode: "on" } } });
	});

	it("classifies structured throw and cancellation without copying raw errors", () => {
		const error = Object.assign(new Error("SECRET"), { status: 429, headers: { authorization: "SECRET" } });
		const thrown = terminalObservation(start, 200, 100, undefined, error);
		expect(thrown).toMatchObject({
			status: "throw",
			errorClass: "unknown",
			httpStatus: 429,
			usage: null,
			observation: null,
		});
		expect(JSON.stringify(thrown)).not.toContain("SECRET");
		expect(terminalObservation(start, 200, 100, { ...message(), stopReason: "aborted" })).toMatchObject({
			status: "aborted",
			errorClass: "cancelled",
		});
	});

	it.each(["generation", "compaction"] as const)(
		"records separate %s attempts with exactly start/end and no usage ledger calls",
		async (operation) => {
			const recorded = recorder();
			const clock = vi
				.spyOn(performance, "now")
				.mockReturnValueOnce(10)
				.mockReturnValueOnce(15)
				.mockReturnValueOnce(20)
				.mockReturnValueOnce(27);
			try {
				for (let i = 0; i < 2; i++) {
					await expect(
						observeModelAttempt(
							recorded.runtime,
							operation,
							model,
							"high",
							() => {
								throw new Error("SECRET");
							},
							context,
						),
					).rejects.toThrow("SECRET");
				}
				expect(recorded.entries.map((entry) => [entry.phase, entry.attemptNo])).toEqual([
					["start", 1],
					["end", 1],
					["start", 2],
					["end", 2],
				]);
				expect(recorded.entries[0]?.attemptId).not.toBe(recorded.entries[2]?.attemptId);
				expect(recorded.entries[1]?.elapsedMs).toBe(5);
				expect(recorded.entries[3]?.elapsedMs).toBe(7);
				expect(recorded.entries.every((entry) => entry.operation === operation)).toBe(true);
				expect(recorded.checkpoint().observationStart).toBeUndefined();
				expect(JSON.stringify(recorded.entries)).not.toContain("SECRET");
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("explicit abort writes its end in native abort transaction, not the cancelled invocation", async () => {
		const recorded = recorder();
		await expect(
			observeModelAttempt(
				recorded.runtime,
				"generation",
				model,
				"off",
				async () => {
					recorded.controller.abort();
					throw new Error("SECRET");
				},
				context,
			),
		).rejects.toThrow("SECRET");
		expect(recorded.entries.map((entry) => entry.phase)).toEqual(["start"]);
		await abortModelObservation(recorded.tx, 1 as never, recorded.checkpoint(), 200);
		expect(recorded.entries).toHaveLength(2);
		expect(recorded.entries[1]).toMatchObject({ status: "aborted", errorClass: "cancelled", elapsedMs: null });
	});

	it("an unended close remains only a start; the observer does not fabricate an end", async () => {
		const recorded = recorder();
		await expect(
			observeModelAttempt(
				recorded.runtime,
				"compaction",
				model,
				null,
				async () => {
					recorded.controller.abort();
					throw new Error("close");
				},
				context,
			),
		).rejects.toThrow("close");
		expect(recorded.entries).toHaveLength(1);
		expect(recorded.entries[0]?.phase).toBe("start");
	});
	it("a successful pure result is framed once without changing existing usage", async () => {
		const recorded = recorder();
		const value = message();
		const before = structuredClone(value.usage);
		expect(await observeModelAttempt(recorded.runtime, "compaction", model, "high", async () => value, context)).toBe(
			value,
		);
		expect(recorded.entries.map((entry) => entry.phase)).toEqual(["start", "end"]);
		expect(recorded.entries[1]).toMatchObject({ status: "stop", usage: { output: 3 } });
		expect(value.usage).toEqual(before);
	});
});
