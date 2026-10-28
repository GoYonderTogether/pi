import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import type { ConversationRetryPolicy, ModelRef } from "./types.ts";

/** Shared policy only; generation and compaction retain their native checkpoints and cancellation. */
export function modelRecovery(
	message: AssistantMessage,
	policy: ConversationRetryPolicy,
	attempt: number,
	retryable: boolean,
	fallback?: { models: ModelRef[]; after: number },
	index = 0,
	failures = attempt,
) {
	const eligible = message.stopReason === "error" && !isContextOverflow(message) && policy.enabled;
	const text = message.errorMessage ?? "";
	const immediate = /\b(?:401|403|404|429)\b|unauthorized|forbidden|authentication|invalid.api.key|model.not.found|quota|billing|insufficient.(?:balance|credit)|rate.?limit|too many requests/i.test(text);
	const terminal = /\b(?:400|422)\b|invalid.?request|invalid.?parameter|content.?policy|safety.?filter/i.test(text);
	const transient = retryable && !immediate && !terminal;
	const advance = eligible && fallback !== undefined && (immediate || (transient && failures >= fallback.after)) && index < fallback.models.length;
	const retry = eligible && (fallback ? advance || (transient && failures < fallback.after) : retryable && attempt <= policy.maxRetries);
	const exhausted = eligible && !retry && (fallback ? (immediate || transient) : retryable && attempt > policy.maxRetries);
	const lastError = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
	const error = exhausted
		? fallback
			? `Model fallback chain exhausted (${fallback.after} consecutive failures per model): ${lastError}`
			: `Model retries exhausted (${policy.maxRetries} retries): ${lastError}`
		: lastError;
	// Backoff counts the failures of the model being retried, not the attempts of the whole run: with a chain the
	// run-level attempt keeps growing across models, so a later candidate waits minutes for its first retry.
	return { retry, advance, error, delay: retry && !advance ? retryDelayMs(policy, fallback ? failures : attempt) : 0 };
}
