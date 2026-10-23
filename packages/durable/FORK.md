# Yonder durable fork

Source: https://github.com/GoYonderTogether/pi/tree/yonder/1.3/packages/durable
Base: earendil-works/pi tag v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0).
MIT license and upstream copyright are retained.

Only packages/durable is modified:

- D28: beforeAgent host callback before task agent resolution; abort of one run continues queued inputs at the native final boundary.
- D29: RunReceiptDoc records inputs, settlement and ending usage in the same transaction that settles the run.
- D49: steer interrupts generation without cancelling tools; explicit interrupt cancels the active ownership scope and resumes the same run with queued inputs. Final-answer commits consume pending steers before settling, retaining superseded text as aborted history.
- D44: shouldRetry generation hook overrides classification while native overflow/abort checks, retry budget and persisted deadlines remain authoritative. Exhaustion includes the retry count and final provider error.

pi-ai 1.3.0 already caps retryDelayMs via maxAgentDelayMs; durable forwards this setting. Yonder maps yonder.yaml retry.maxDelayMs to it. No pi-ai fork is needed. chord, pi-ai and codemode stay upstream npm dependencies in the Yonder workspace.

New tests use authenticated loopback HTTP failures, never synthetic model streams. Existing upstream tests and helpers are retained; exhaustion detail and abort-boundary inbox/compaction assertions reflect the fork's changed behavior.

Yonder model fallback: optional conversation agent model chain, run-scoped durable index and consecutive error count, atomic with native retry checkpoints. Successful responses clear the count; new runs start at primary. Overflow/abort retain native behavior.

Compaction summarization follows the same configured fallback chain, checkpointing each model and its attempt budget. Blocking compaction advances its parent run to the fallback model; manual compaction does not change an in-flight generation.

## Deferred tool search relevance

The existing BM25 scorer now follows Hermes Agent's exact-name priority, rarest-query-term gate and 50 percent answerable-term coverage floor (from four terms). The native pi tool loading, call validation, append-only tool declarations and compaction remain unchanged.

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
