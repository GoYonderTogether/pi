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
