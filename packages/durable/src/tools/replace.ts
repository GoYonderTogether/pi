import { type Static, Type } from "typebox";
import { generateDiffString } from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	applyRange,
	assertRangeServed,
	assertWritableText,
	readEditableFile,
	replacementLines,
	requireAnchor,
	resolveEditPath,
	resolveRange,
	writeEditableFile,
} from "./hashline/edit.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";

const replaceSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description: "Path to the file the anchors were served for; required and must match anchor ownership.",
			}),
		),
		remove_from: Type.String({ description: "5-char anchor of the FIRST line to remove." }),
		remove_to: Type.String({ description: "5-char anchor of the LAST line to remove." }),
		text: Type.String({
			description:
				'The exact text to write in place of the removed range. "" deletes the range. A trailing line break sets the newline of the last line written instead of adding a blank line; a lone newline writes one blank line.',
		}),
	},
	{ additionalProperties: true },
);

export type ReplaceToolInput = Static<typeof replaceSchema>;

export type ReplaceToolDetails = {
	diff: string;
	firstChangedLine?: number;
};

export function createReplaceTool(): ToolRegistration<typeof replaceSchema, ReplaceToolDetails> {
	return defineTool({
		name: "replace",
		description:
			"Replace a range of lines of one file, addressed by the anchors read() served for its first and last line. text is the exact new content of the range; an empty string deletes it. A stale anchor, or a line of the range that was never shown, is rejected with the current rows and their fresh anchors instead of being matched approximately.",
		parameters: replaceSchema,
		async execute(args, api, context) {
			const env = requireEnv(api);
			const from = requireAnchor(args.remove_from, "remove_from");
			const to = requireAnchor(args.remove_to, "remove_to");
			const displayPath = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
			const absolutePath = await resolveEditPath(env, args.path, [from, to], context);
			const text = args.text;
			assertWritableText(text);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const file = await readEditableFile(env, absolutePath, context);
					const { start, end } = resolveRange(file, from, to);
					assertRangeServed(file, start, end, text.length === 0);
					const applied = applyRange(file, start, end, replacementLines(text));
					const before = file.lines.join("\n");
					const after = applied.lines.join("\n");
					if (before === after) {
						return { output: [{ type: "text", text: `No changes made to ${displayPath ?? absolutePath}.` }] };
					}
					await writeEditableFile(env, absolutePath, applied.content, context);
					const diff = generateDiffString(before, after);
					return {
						output: [
							{
								type: "text",
								text: `Replaced lines ${start + 1}-${end + 1} of ${displayPath ?? absolutePath}.\n\n${diff.diff}`,
							},
						],
						details: {
							diff: diff.diff,
							...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
						},
					};
				},
				context,
			);
		},
	});
}
