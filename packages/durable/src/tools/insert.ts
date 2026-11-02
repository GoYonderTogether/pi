import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { generateDiffString } from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	applyRange,
	assertRangeServed,
	assertWritableText,
	type EditableFile,
	readEditableFile,
	replacementLines,
	requireAnchor,
	resolveEditPath,
	resolveRange,
	writeEditableFile,
} from "./hashline/edit.ts";

const insertSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description: "Path to the file the anchor was served for; required and must match anchor ownership.",
			}),
		),
		anchor: Type.String({ description: "5-char anchor of the line to insert next to." }),
		direction: Type.Union([Type.Literal("after"), Type.Literal("before")], { description: '"after" or "before"' }),
		text: Type.String({
			description:
				'The exact text to insert; an empty string inserts one blank line. A trailing line break sets the newline of the last line written instead of adding a blank line; a lone newline writes one blank line. Never include the anchor line.',
		}),
	},
	{ additionalProperties: true },
);

export type InsertToolInput = Static<typeof insertSchema>;

export type InsertToolDetails = {
	diff: string;
	firstChangedLine?: number;
};

/** The side of the anchor line a block lands on; the anchors say where, this says which way. */
export function requireDirection(value: unknown): "after" | "before" {
	if (value === "after" || value === "before") return value;
	throw new Error('[E_BAD_SHAPE] "direction" must be "before" or "after".');
}

/** A file whose whole content is no line at all: one empty row with nothing before or after it. */
export function isEmptyEditableFile(file: EditableFile): boolean {
	return file.lines.length === 1 && file.lines[0] === "";
}

export function createInsertTool(): ToolRegistration<typeof insertSchema, InsertToolDetails> {
	return defineTool({
		name: "insert",
		description:
			"Insert text next to an existing line without removing anything. The anchor line stays in place, and `anchor` is a bare 5-character anchor from any served `anchor│content` row.",
		parameters: insertSchema,
		async execute(args, api, context) {
			const env = requireEnv(api);
			const anchor = requireAnchor(args.anchor, "anchor");
			const direction = requireDirection(args.direction);
			const displayPath = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
			const absolutePath = await resolveEditPath(env, args.path, [anchor], context);
			assertWritableText(args.text);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const file = await readEditableFile(env, absolutePath, context);
					const { start } = resolveRange(file, anchor, anchor);
					assertRangeServed(file, start, start, false);
					const written = replacementLines(args.text.length === 0 ? "\n" : args.text);
					const anchorLine = isEmptyEditableFile(file) ? undefined : file.lines[start];
					const replacement =
						anchorLine === undefined
							? written
							: direction === "after"
								? [anchorLine, ...written]
								: [...written, anchorLine];
					const applied = applyRange(file, start, start, replacement);
					const before = file.lines.join("\n");
					const after = applied.lines.join("\n");
					if (before === after) {
						return {
							output: [{ type: "text" as const, text: `No changes made to ${displayPath ?? absolutePath}.` }],
						};
					}
					await writeEditableFile(env, absolutePath, applied.content, context);
					const diff = generateDiffString(before, after);
					return {
						output: [
							{
								type: "text" as const,
								text: `Inserted ${written.length} line(s) ${direction} line ${start + 1} of ${displayPath ?? absolutePath}.\n\n${diff.diff}`,
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
