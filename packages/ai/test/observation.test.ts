import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import {
	createAssistantMessageObservation,
	observationModelLabel,
	observeAnthropicUsage,
	observeOpenAIUsage,
	observeRequestEffort,
} from "../src/utils/observation.ts";

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("client stream observations", () => {
	let now = 100;
	beforeEach(() => {
		now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		vi.spyOn(Date, "now").mockReturnValue(1000);
	});
	afterEach(() => vi.restoreAllMocks());

	it("does not treat start, empty deltas, tool start, or usage-only completion as output", async () => {
		const stream = new AssistantMessageEventStream();
		const answer = message();
		now = 105;
		stream.push({ type: "start", partial: answer });
		for (const type of ["text_delta", "thinking_delta", "toolcall_delta"] as const)
			stream.push({ type, delta: "", contentIndex: 0, partial: answer });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: answer });
		answer.usage.output = 5;
		now = 140;
		stream.push({ type: "done", reason: "stop", message: answer });
		const observation = (await stream.result()).observation!;
		expect(observation.timing).toEqual({
			firstNormalizedEventMs: 5,
			firstTextDeltaMs: null,
			lastTextDeltaMs: null,
			firstThinkingDeltaMs: null,
			lastThinkingDeltaMs: null,
			firstToolDeltaMs: null,
			lastToolDeltaMs: null,
			firstEffectiveDeltaMs: null,
			lastEffectiveDeltaMs: null,
			endMs: 40,
			textDeltaCount: 0,
			thinkingDeltaCount: 0,
			toolDeltaCount: 0,
		});
		expect(observation.usage.support).toBe("unsupported");
		expect(observation.usage.output.value).toBeNull();
	});

	it("separates reasoning-first, text, tool chunks, and terminal time", () => {
		const stream = new AssistantMessageEventStream();
		const answer = message();
		const emit = (type: "text_delta" | "thinking_delta" | "toolcall_delta", time: number, delta: string) => {
			now = time;
			stream.push({ type, delta, contentIndex: 0, partial: answer });
		};
		emit("thinking_delta", 110, "reason");
		emit("text_delta", 125, " ");
		emit("toolcall_delta", 130, "{}");
		emit("thinking_delta", 140, "more");
		emit("text_delta", 150, "answer");
		now = 190;
		stream.push({ type: "done", reason: "stop", message: answer });
		expect(answer.durationMs).toBe(90);
		expect(answer.observation!.timing).toEqual({
			firstNormalizedEventMs: 10,
			firstThinkingDeltaMs: 10,
			lastThinkingDeltaMs: 40,
			firstTextDeltaMs: 25,
			lastTextDeltaMs: 50,
			firstToolDeltaMs: 30,
			lastToolDeltaMs: 30,
			firstEffectiveDeltaMs: 10,
			lastEffectiveDeltaMs: 50,
			endMs: 90,
			textDeltaCount: 2,
			thinkingDeltaCount: 2,
			toolDeltaCount: 1,
		});
	});

	it("keeps a single tool-only delta a zero-width window, not a token rate", () => {
		const stream = new AssistantMessageEventStream();
		const answer = message();
		now = 112;
		stream.push({ type: "toolcall_delta", delta: "{}", contentIndex: 0, partial: answer });
		now = 125;
		stream.end(answer);
		expect(answer.observation!.timing).toMatchObject({
			firstEffectiveDeltaMs: 12,
			lastEffectiveDeltaMs: 12,
			toolDeltaCount: 1,
			textDeltaCount: 0,
			endMs: 25,
		});
		expect(answer.observation).not.toHaveProperty("tokensPerSecond");
	});

	it.each(["error", "aborted"] as const)("settles %s before the first delta", async (reason) => {
		const stream = new AssistantMessageEventStream();
		const answer = { ...message(), stopReason: reason };
		now = 115;
		stream.push({ type: "error", reason, error: answer });
		expect((await stream.result()).observation!.timing).toMatchObject({
			firstNormalizedEventMs: 15,
			firstEffectiveDeltaMs: null,
			endMs: 15,
		});
	});

	it("settles cancel after output and ignores late events and end calls", () => {
		const stream = new AssistantMessageEventStream();
		const answer = message();
		now = 110;
		stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: answer });
		now = 120;
		stream.push({ type: "error", reason: "aborted", error: answer });
		const before = structuredClone(answer.observation);
		now = 150;
		stream.push({ type: "text_delta", contentIndex: 0, delta: "late", partial: answer });
		stream.end(answer);
		expect(answer.observation).toEqual(before);
	});

	it("preserves old durations, deferred timestamps and forwarded observations", () => {
		const old = { ...message(), durationMs: 123 };
		new AssistantMessageEventStream().end(old);
		expect(old.durationMs).toBe(123);
		expect(old.observation).toBeUndefined();
		const deferred = { ...message(), timestamp: 999 };
		new AssistantMessageEventStream().end(deferred);
		expect(deferred.durationMs).toBeUndefined();
		expect(deferred.observation).toBeUndefined();
		const inner = new AssistantMessageEventStream();
		const answer = message();
		now = 110;
		inner.push({ type: "done", reason: "stop", message: answer });
		const before = structuredClone(answer.observation);
		now = 200;
		new AssistantMessageEventStream().push({ type: "done", reason: "stop", message: answer });
		expect(answer.durationMs).toBe(10);
		expect(answer.observation).toEqual(before);
		delete answer.durationMs;
		new AssistantMessageEventStream().end(answer);
		expect(answer.durationMs).toBeUndefined();
		expect(answer.observation).toEqual(before);
	});

	it("end(result) records an end without inventing a normalized event", () => {
		const stream = new AssistantMessageEventStream();
		const answer = message();
		now = 120;
		stream.end(answer);
		expect(answer.observation!.timing).toMatchObject({
			firstNormalizedEventMs: null,
			firstEffectiveDeltaMs: null,
			endMs: 20,
		});
	});
});

describe("usage and effort observations", () => {
	it.each([false, true])("distinguishes missing fields and reported zeros (Responses=%s)", (responses) => {
		const observation = createAssistantMessageObservation();
		observeOpenAIUsage(observation, {}, responses);
		expect(observation.usage.output).toEqual({ value: null, source: "unknown" });
		observeOpenAIUsage(
			observation,
			responses
				? {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					}
				: {
						prompt_tokens: 0,
						completion_tokens: 0,
						total_tokens: 0,
						prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						completion_tokens_details: { reasoning_tokens: 0 },
					},
			responses,
		);
		expect(observation.usage.output).toEqual({ value: 0, source: "reported" });
		expect(observation.usage.input).toEqual({ value: 0, source: "derived" });
		expect(observation.usage.totalTokens).toEqual({ value: 0, source: "reported" });
		expect(observation.usage.cacheWrite1h.value).toBeNull();
	});

	it("does not infer DeepSeek cache writes from misses, or sum reasoning into output", () => {
		const observation = createAssistantMessageObservation();
		observeOpenAIUsage(
			observation,
			{
				prompt_tokens: 10,
				completion_tokens: 6,
				prompt_cache_hit_tokens: 3,
				prompt_cache_miss_tokens: 7,
				completion_tokens_details: { reasoning_tokens: 4 },
			},
			false,
		);
		expect(observation.usage.cacheRead).toEqual({ value: 3, source: "reported" });
		expect(observation.usage.cacheWrite.value).toBeNull();
		expect(observation.usage.input.value).toBeNull();
		expect(observation.usage.output.value).toBe(6);
		expect(observation.usage.totalTokens).toEqual({ value: 16, source: "derived" });
	});

	it("derives uncached input only from complete components", () => {
		const observation = createAssistantMessageObservation();
		observeOpenAIUsage(
			observation,
			{ input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 } },
			true,
		);
		expect(observation.usage.input).toEqual({ value: 11, source: "derived" });
		expect(observation.usage.totalTokens.value).toBe(25);
	});

	it("merges Anthropic usage snapshots without zero-filling absent components", () => {
		const observation = createAssistantMessageObservation();
		observeAnthropicUsage(observation, { input_tokens: 7, output_tokens: 0 });
		expect(observation.usage.totalTokens.value).toBeNull();
		observeAnthropicUsage(observation, {
			output_tokens: 8,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 3,
			cache_creation: { ephemeral_1h_input_tokens: 1 },
			output_tokens_details: { thinking_tokens: 2 },
		});
		expect(observation.usage.input.value).toBe(7);
		expect(observation.usage.totalTokens).toEqual({ value: 18, source: "derived" });
		expect(observation.usage.cacheWrite1h.value).toBe(1);
		observeAnthropicUsage(observation, { output_tokens: null });
		expect(observation.usage.output.value).toBe(8);
	});

	it("rejects malformed counts rather than accepting them as reported", () => {
		const observation = createAssistantMessageObservation();
		observeOpenAIUsage(observation, { prompt_tokens: -1, completion_tokens: Number.NaN, total_tokens: "0" }, false);
		expect(observation.usage.totalTokens.value).toBeNull();
		expect(observation.usage.output.value).toBeNull();
	});

	it("snapshots only effort controls, including managed effort overrides", () => {
		const observation = createAssistantMessageObservation();
		const payload = {
			reasoning: { effort: "medium" },
			input: [{ type: "configuration_update", reasoning: { effort: "low" } }],
			secret: "do-not-copy",
			thinking: { type: "enabled", budget_tokens: 1024 },
		};
		observeRequestEffort(observation, payload, { requested: "max", clamped: "high" });
		payload.thinking.budget_tokens = 9999;
		expect(observation.effort).toEqual({
			support: "supported",
			requested: "max",
			clamped: "high",
			wire: { effort: "low", mode: "enabled", budgetTokens: 1024 },
			serverActual: null,
		});
		expect(JSON.stringify(observation)).not.toContain("do-not-copy");
		expect(observation.unsupported).toContain("serverActualEffort");
	});
	it("does not persist arbitrary wire strings or credential-shaped model labels", () => {
		const observation = createAssistantMessageObservation();
		observeRequestEffort(
			observation,
			{ reasoning_effort: "https://secret.invalid/key", thinking: { type: "sk-secret", budget_tokens: "secret" } },
			{ requested: "secret", clamped: "secret" },
		);
		expect(observation.effort).toMatchObject({
			requested: null,
			clamped: null,
			wire: { effort: null, mode: null, budgetTokens: null },
		});
		for (const value of ["https://secret.invalid", "sk-secret", "provider/token-secret", "Bearer-secret"])
			expect(observationModelLabel(value)).toBeNull();
		expect(observationModelLabel("provider/model-1")).toBe("provider/model-1");
		expect(observation.accountSlotId).toBeNull();
		expect(observation.rateSnapshot).toBeNull();
	});
});
