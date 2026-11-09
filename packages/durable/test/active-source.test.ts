import { expect, it } from "vitest";
import { activeSourceGroup } from "../src/harness/submissions.ts";
import type { SubmissionId } from "../src/types.ts";

it("uses the current transaction run only for a matching verified parent or conversation", () => {
	const first = 1 as SubmissionId;
	const second = 2 as SubmissionId;
	const run = { sourceGroup: "owner:conversation:first", inputs: [first] };
	const input = { type: "input" as const, content: "test", sourceGroup: "owner:conversation:next" };
	expect(activeSourceGroup({ ...input, activeSource: { input: first } }, run)).toBe(run.sourceGroup);
	expect(activeSourceGroup({ ...input, activeSource: { input: second } }, run)).toBeUndefined();
	expect(activeSourceGroup({ ...input, activeSource: { prefix: "owner:conversation:" } }, run)).toBe(run.sourceGroup);
	expect(activeSourceGroup({ ...input, activeSource: { prefix: "owner:other:" } }, run)).toBeUndefined();
	expect(activeSourceGroup({ ...input, activeSource: { input: first } }, undefined)).toBeUndefined();
});
