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
