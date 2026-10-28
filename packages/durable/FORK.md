# Yonder durable fork

Source: https://github.com/GoYonderTogether/pi/tree/yonder/1.3/packages/durable
Base: earendil-works/pi tag v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0).
MIT license and upstream copyright are retained.

The fork modifies packages/durable and, for T61 stream observation and T63 explicit credential isolation, packages/ai:

- D28: beforeAgent host callback before task agent resolution; abort of one run continues queued inputs at the native final boundary.
- D29: RunReceiptDoc records inputs, settlement and ending usage in the same transaction that settles the run.
- D49: steer interrupts generation without cancelling tools; explicit interrupt cancels the active ownership scope and resumes the same run with queued inputs. Final-answer commits consume pending steers before settling, retaining superseded text as aborted history.
- D44: shouldRetry generation hook overrides classification while native overflow/abort checks, retry budget and persisted deadlines remain authoritative. Exhaustion includes the retry count and final provider error.

pi-ai 1.3.0 already caps retryDelayMs via maxAgentDelayMs; durable forwards this setting. Yonder maps yonder.yaml retry.maxDelayMs to it. For the existing retry cap no pi-ai fork is needed. chord and codemode stay pinned upstream npm dependencies. These T61/T63 durable changes require the matching pi-ai fork artifact; syncing durable alone while keeping upstream pi-ai 1.3.0 is not a complete integration. A Yonder source release may bundle an integrity-pinned pi-ai tarball while retaining its actual upstream-derived package name/version, with exact fork provenance, without publishing a new npm version.

New tests use authenticated loopback HTTP failures, never synthetic model streams. Existing upstream tests and helpers are retained; exhaustion detail and abort-boundary inbox/compaction assertions reflect the fork's changed behavior.

Yonder model fallback: optional conversation agent model chain, run-scoped durable index and consecutive error count, atomic with native retry checkpoints. Successful responses clear the count; new runs start at primary. Overflow/abort retain native behavior.

Compaction summarization follows the same configured fallback chain, checkpointing each model and its attempt budget. Blocking compaction advances its parent run to the fallback model; manual compaction does not change an in-flight generation.

Generation and compaction share modelRecovery for retry eligibility, fallback advancement, backoff and exhaustion errors. Both expose shouldRetry for host classification, and disable hidden SDK retries so native checkpoints own each attempt. With a fallback chain, backoff follows the failure count of the model being retried, so each candidate's first retry waits the base delay; without a chain it follows the run attempt. Failed attempts append non-model pi.model-attempt entries atomically with their next checkpoint or terminal outcome; these record task, operation, model, attempt, error and next action without entering model context.

## Local process lifecycle adapter

`NodeExecutionEnv` accepts optional `localSpawn: LocalProcessSpawn`, exported from
`@earendil-works/pi-durable/env/node`. The synchronous callback receives
`{ program, args: readonly string[], cwd, env: NodeJS.ProcessEnv, stdin: "pipe" | "ignore" }`
after shell selection, cwd resolution and environment merging. It returns
`{ child: ChildProcess, cancel: () => void, result: Promise<{ code: number | null, signal: NodeJS.Signals | null }> }`.
`result` is required, not optional.

The adapter owns process creation and cancellation. It may throw to fail closed; Pi never falls back to unmanaged spawn.
It must expose raw stdout/stderr and requested stdin through `child`, provide an idempotent, non-throwing `cancel`,
and settle `result` after child close on success, cancellation and spawn/protocol failure. A wrapper's own exit status
must not replace the business command's status. Pi observes result rejection immediately, cancels on protocol failure,
and waits for both its existing output-drain contract and the adapter result before returning.
Timeout, abort, output callback failure, spill failure and environment cleanup use the adapter cancel function,
including while output has ended but the adapter result is still pending. No bare child PID/PGID is used in this path.
Output decoding, spill/backpressure, shell stdin transport and Result/ExecutionError remain Pi's responsibility.
Without the option, Node's original detached spawn and process-tree cancellation remain in use.
The seam contains no host-specific paths, capabilities or authorization logic.

## Deferred tool search relevance

The existing BM25 scorer now follows Hermes Agent's exact-name priority, rarest-query-term gate and 50 percent answerable-term coverage floor (from four terms). Explicit structured tool identifiers within a query also take priority, so `task_run delegate subagent` cannot lose its named tool to an unknown surrounding word. Rejected calls to selected deferred tools direct the model to search the exact name first, only when tool_search was offered; the call is not executed. Native pi tool loading, call validation, append-only tool declarations and compaction remain unchanged.

Adapted from NousResearch/hermes-agent at bf0203a794a07aac3ff764972ab9087baa4e4f4e, tools/tool_search_catalog.py:
https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/tools/tool_search_catalog.py

The applicable license follows:

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
Optional compaction.backgroundAtTokens caps the background start threshold independently of the model context window; smaller models keep their earlier native thresholds.

## T61 client model observations (unpublished)

`AssistantMessage.observation?` is a version-1 sidecar; legacy numeric Usage and durationMs are unchanged.
Times are client monotonic milliseconds from stream creation. Nonempty text/thinking/toolcall deltas have independent
first/last/count fields; counts are chunks, never tokens. Start, empty delta, tool start and usage-only events do not
count as effective output. Previously timed/deferred/forwarded messages are not retimed.
OpenAI Responses/Completions and Anthropic Messages capture reported usage presence before numeric defaults,
requested/clamped/wire effort, and reported model. Missing counts stay null/unknown, not reported zero.
Wire values are allowlisted snapshots after payload callbacks, not server-actual effort.
Account slots, rate snapshots, HTTP headers/provider/body timing and server-actual effort remain null/unsupported.

`pi.model-observation` is a non-model native entry, one start and at most one end per network invocation, including
compaction and deferred fetch. A logical request is a native task ID; each network invocation gets a UUID and a
checkpointed attempt number, independent of scheduler retry budgets. Start persists before invocation; normal/throw
end clears its active checkpoint pointer. Explicit abort writes end in its existing native abort transaction with
unknown elapsed/usage if unavailable. Close/crash leaves the start unended; only the exporter labels it interrupted.
Observation code never schedules a retry or adds usage, and existing pi.model-attempt diagnostics remain unchanged.
Sidecar times and durable attempt elapsed have different client start boundaries; do not subtract them or call either
server decode timing. Deferred results retain their originating sidecar, not a newly timed polling stream.

Source packages retain version 1.3.0 here: no publish or dependency version bump is implied. The upstream lockstep
package artifact flow is `scripts/pack-packages.mjs` followed by `scripts/use-local-packages.mjs` for an isolated
consumer; production consumption needs a separately approved coherent fork release/dependency update. Syncing this
commit into Yonder vendors only durable and continues resolving npm pi-ai 1.3.0 until that separate integration.
