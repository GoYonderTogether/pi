import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { modelRecovery } from "../src/harness/model-recovery.ts";

const failed = { role: "assistant", stopReason: "error", errorMessage: "503 Service Unavailable" } as AssistantMessage;
const policy = { enabled: true, maxRetries: 10, baseDelayMs: 2000 };
const fallback = {
	models: [
		{ provider: "a", modelId: "x" },
		{ provider: "b", modelId: "y" },
	],
	after: 3,
};

test("a fallback model's first retry waits the base delay, however late in the run it comes", () => {
	// Run-level attempt 7: two models already failed three times each; this is the next model's first failure.
	const first = modelRecovery(failed, policy, 7, true, fallback, 2, 1);
	const early = modelRecovery(failed, policy, 1, true, fallback, 0, 1);
	expect(first.retry).toBe(true);
	expect(first.delay).toBe(early.delay);
	expect(modelRecovery(failed, policy, 8, true, fallback, 2, 2).delay).toBeGreaterThan(first.delay);
});

test("without a chain the run attempt still drives backoff", () => {
	expect(modelRecovery(failed, policy, 4, true).delay).toBeGreaterThan(modelRecovery(failed, policy, 1, true).delay);
});

test.each(["401 Unauthorized", "403 Forbidden", "404 model not found", "insufficient quota", "429 Too Many Requests"])("immediately falls back on %s", (errorMessage) => {
	const decision = modelRecovery({ ...failed, errorMessage }, policy, 1, false, fallback);
	expect(decision.advance).toBe(true);
	expect(decision.delay).toBe(0);
});

test("exhaustion preserves the last error and does not claim a content error exhausted the chain", () => {
	expect(modelRecovery({ ...failed, errorMessage: "401 Unauthorized" }, policy, 1, false, fallback, 2).error).toContain("401 Unauthorized");
	expect(modelRecovery({ ...failed, errorMessage: "400 invalid request" }, policy, 1, false, fallback, 2).error).toBe("400 invalid request");
});

test.each(["503 Service Unavailable", "request timed out"])("retries before falling back on %s", (errorMessage) => {
	const message = { ...failed, errorMessage };
	expect(modelRecovery(message, policy, 3, true, fallback, 0, 3).advance).toBe(false);
	expect(modelRecovery(message, policy, 4, true, fallback, 0, 4).advance).toBe(true);
});

test.each(["400 invalid request", "content policy violation"])("stops without falling back on %s", (errorMessage) => {
	for (const retryable of [false, true]) {
		const decision = modelRecovery({ ...failed, errorMessage }, policy, 1, retryable, fallback);
		expect(decision).toMatchObject({ retry: false, advance: false, error: errorMessage });
	}
});
