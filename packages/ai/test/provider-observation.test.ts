import { describe, expect, it } from "vitest";
import { streamSimple as anthropicSimple, stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { streamSimple as completionsSimple, stream as completionsStream } from "../src/api/openai-completions.ts";
import { streamSimple as responsesSimple, stream as responsesStream } from "../src/api/openai-responses.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Protocol fixtures only: all SDK requests are answered by this local fetch, never a model endpoint.
function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test-model",
		name: "Protocol fixture",
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
	};
}
const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
function sse(events: unknown[], anthropic = false): typeof fetch {
	return async () =>
		new Response(
			events
				.map(
					(event) =>
						`${anthropic ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
				)
				.join("") + (anthropic ? "" : "data: [DONE]\n\n"),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
}
function completion(usage?: object) {
	return [
		{
			id: "fixture",
			model: "test-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			...(usage ? { usage } : {}),
		},
	];
}
function responses(usage?: object) {
	return [
		{
			type: "response.completed",
			response: { id: "fixture", model: "test-model", status: "completed", output: [], ...(usage ? { usage } : {}) },
		},
	];
}
function anthropic(usage: object = {}) {
	return [
		{ type: "message_start", message: { id: "fixture", model: "test-model", usage } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
		{ type: "message_stop" },
	];
}

describe("provider observation wiring", () => {
	it.each([false, true])("captures Completions missing vs zero usage (zero=%s)", async (zero) => {
		const result = await completionsStream(model("openai-completions"), context, {
			apiKey: "fixture",
			fetch: sse(completion(zero ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } : undefined)),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.observation!.usage.output).toEqual({
			value: zero ? 0 : null,
			source: zero ? "reported" : "unknown",
		});
		expect(result.observation!.reportedResponseModel).toBe("test-model");
		expect(result.observation!.timing.firstEffectiveDeltaMs).toBeNull();
		expect(result.usage.output).toBe(0);
	});

	it.each([false, true])("captures Responses missing vs zero usage (zero=%s)", async (zero) => {
		const result = await responsesStream(model("openai-responses"), context, {
			apiKey: "fixture",
			fetch: sse(responses(zero ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : undefined)),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.observation!.usage.output).toEqual({
			value: zero ? 0 : null,
			source: zero ? "reported" : "unknown",
		});
		expect(result.observation!.reportedResponseModel).toBe("test-model");
		expect(result.observation!.usage.cacheRead.value).toBeNull();
	});

	it.each([false, true])("captures Anthropic missing vs zero usage (zero=%s)", async (zero) => {
		const result = await anthropicStream(model("anthropic-messages"), context, {
			apiKey: "fixture",
			fetch: sse(anthropic(zero ? { input_tokens: 0, output_tokens: 0 } : {}), true),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.observation!.usage.output).toEqual({
			value: zero ? 0 : null,
			source: zero ? "reported" : "unknown",
		});
		expect(result.observation!.reportedResponseModel).toBe("test-model");
		expect(result.observation!.usage.totalTokens.value).toBeNull();
	});

	it("keeps requested, clamped, mapped and payload-replaced Completions effort distinct", async () => {
		const fixture = model("openai-completions");
		fixture.thinkingLevelMap = { off: "none", high: "medium", max: null, xhigh: null };
		const result = await completionsSimple(fixture, context, {
			apiKey: "fixture",
			reasoning: "max",
			fetch: sse(completion()),
			onPayload: (payload) => ({ ...(payload as object), reasoning_effort: "low" }),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.observation!.effort).toMatchObject({
			requested: "max",
			clamped: "high",
			wire: { effort: "low" },
			serverActual: null,
		});
	});

	it("captures Responses mapped wire effort after simple clamping", async () => {
		const fixture = model("openai-responses");
		fixture.thinkingLevelMap = { high: "low", max: null, xhigh: null };
		const result = await responsesSimple(fixture, context, {
			apiKey: "fixture",
			reasoning: "max",
			fetch: sse(responses()),
		}).result();
		expect(result.observation!.effort).toMatchObject({ requested: "max", clamped: "high", wire: { effort: "low" } });
	});

	it("captures Anthropic adaptive effort and budget mode without server-actual claims", async () => {
		const adaptive = model("anthropic-messages");
		adaptive.compat = { forceAdaptiveThinking: true };
		adaptive.thinkingLevelMap = { high: "low" };
		const result = await anthropicSimple(adaptive, context, {
			apiKey: "fixture",
			reasoning: "high",
			fetch: sse(anthropic(), true),
		}).result();
		expect(result.observation!.effort).toMatchObject({
			requested: "high",
			clamped: "high",
			wire: { effort: "low", mode: "adaptive", budgetTokens: null },
			serverActual: null,
		});
		const budget = await anthropicSimple(model("anthropic-messages"), context, {
			apiKey: "fixture",
			reasoning: "max",
			fetch: sse(anthropic(), true),
		}).result();
		expect(budget.observation!.effort).toMatchObject({
			requested: "max",
			clamped: "high",
			wire: { effort: null, mode: "enabled", budgetTokens: 7168 },
		});
	});

	it("retains a terminal sidecar for setup errors with unknown usage", async () => {
		const result = await completionsSimple(model("openai-completions"), context, {
			apiKey: "fixture",
			reasoning: "high",
			onPayload: () => {
				throw new Error("fixture setup failure");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.observation!.usage.output.value).toBeNull();
		expect(result.observation!.timing.endMs).toBeGreaterThanOrEqual(0);
		expect(result.observation!.effort).toMatchObject({ requested: "high", clamped: "high", wire: { effort: null } });
	});

	it("retains reported usage and model on a failed Responses terminal event", async () => {
		const result = await responsesStream(model("openai-responses"), context, {
			apiKey: "fixture",
			fetch: sse([
				{
					type: "response.failed",
					response: {
						id: "fixture",
						model: "reported-model",
						status: "failed",
						error: { code: "fixture", message: "fixture" },
						usage: { input_tokens: 8, output_tokens: 0 },
					},
				},
			]),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.observation!.reportedResponseModel).toBe("reported-model");
		expect(result.observation!.usage.output).toEqual({ value: 0, source: "reported" });
		expect(result.observation!.timing.firstEffectiveDeltaMs).toBeNull();
	});
});
