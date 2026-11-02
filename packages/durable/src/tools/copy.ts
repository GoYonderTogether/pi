import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import { generateDiffString } from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	applyRange,
	assertRangeServed,
	type EditableFile,
	readEditableFile,
	requireAnchor,
	resolveEditPath,
	resolveRange,
	writeEditableFile,
} from "./hashline/edit.ts";
import { isEmptyEditableFile, requireDirection } from "./insert.ts";
import type { ExecutionEnv } from "../env/index.ts";

export const transferSchema = Type.Object(
	{
		source_from: Type.String({ description: "5-char anchor of the FIRST source line." }),
		source_to: Type.String({ description: "5-char anchor of the LAST source line." }),
		anchor: Type.String({
			description:
				"5-char anchor of the destination line; the block lands before or after it and it may live in another file.",
		}),
		direction: Type.Union([Type.Literal("after"), Type.Literal("before")], {
			description: '"after" places the block below the anchor line, "before" above it',
		}),
	},
	{ additionalProperties: true },
);

export type TransferToolInput = Static<typeof transferSchema>;

export type TransferToolDetails = {
	diff: string;
	firstChangedLine?: number;
};

/** What one copy or move asks for, with both files resolved. */
type TransferRequest = {
	readonly kind: "copy" | "move";
	readonly sourcePath: string;
	readonly destPath: string;
	readonly from: string;
	readonly to: string;
	readonly anchor: string;
	readonly direction: "after" | "before";
};

/** The rows a transfer writes into the destination, and the range it replaces there. */
function placement(
	dest: EditableFile,
	anchorIndex: number,
	direction: "after" | "before",
	sourceLines: readonly string[],
): string[] {
	return direction === "after"
		? [dest.lines[anchorIndex], ...sourceLines]
		: [...sourceLines, dest.lines[anchorIndex]];
}

async function transferSameFile(
	env: ExecutionEnv,
	request: TransferRequest,
	context: Context,
): Promise<ToolExecutionResult<TransferToolDetails>> {
	const { kind, sourcePath, direction } = request;
	return withFileMutationQueue(
		env,
		sourcePath,
		async () => {
			const file = await readEditableFile(env, sourcePath, context);
			if (isEmptyEditableFile(file)) {
				throw new Error(
					"[E_BAD_SHAPE] The file is empty, so there are no lines to copy or move; use insert or replace to seed content.",
				);
			}
			const range = resolveRange(file, request.from, request.to);
			assertRangeServed(file, range.start, range.end, false);
			const anchorIndex = resolveRange(file, request.anchor, request.anchor).start;
			const insertLine = direction === "after" ? anchorIndex + 1 : anchorIndex;
			if (insertLine >= range.start && insertLine < range.end + 1) {
				throw new Error(
					`[E_BAD_SHAPE] "anchor" resolves to line ${anchorIndex + 1}, which places the block inside the source range (lines ${range.start + 1}-${range.end + 1}). Use a line outside the source range.`,
				);
			}
			const sourceLines = file.lines.slice(range.start, range.end + 1);
			let start: number;
			let end: number;
			let replacement: string[];
			if (kind === "copy") {
				start = anchorIndex;
				end = anchorIndex;
				replacement = placement(file, anchorIndex, direction, sourceLines);
			} else if (insertLine < range.start) {
				start = insertLine;
				end = range.end;
				replacement = [...sourceLines, ...file.lines.slice(insertLine, range.start)];
			} else {
				start = range.start;
				end = insertLine - 1;
				replacement = [...file.lines.slice(range.end + 1, insertLine), ...sourceLines];
			}
			const applied = applyRange(file, start, end, replacement);
			const before = file.lines.join("\n");
			const after = applied.lines.join("\n");
			if (before === after) {
				return { output: [{ type: "text", text: `No changes made to ${sourcePath}.` }] };
			}
			await writeEditableFile(env, sourcePath, applied.content, context);
			const diff = generateDiffString(before, after);
			const verb = kind === "copy" ? "Copied" : "Moved";
			return {
				output: [
					{
						type: "text",
						text: `${verb} ${sourceLines.length} line(s) to ${direction} line ${anchorIndex + 1} of ${sourcePath}.\n\n${diff.diff}`,
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
}

async function transferAcrossFiles(
	env: ExecutionEnv,
	request: TransferRequest,
	context: Context,
): Promise<ToolExecutionResult<TransferToolDetails>> {
	const { kind, sourcePath, destPath, direction } = request;
	const source = await readEditableFile(env, sourcePath, context);
	const range = resolveRange(source, request.from, request.to);
	assertRangeServed(source, range.start, range.end, false);
	const sourceLines = source.lines.slice(range.start, range.end + 1);
	if (sourceLines.length === 0) {
		throw new Error(
			"[E_BAD_SHAPE] The source file is empty, so there are no lines to copy or move; use insert or replace to seed content.",
		);
	}
	const written = await withFileMutationQueue(
		env,
		destPath,
		async () => {
			const dest = await readEditableFile(env, destPath, context);
			const seeded = isEmptyEditableFile(dest);
			const anchorIndex = resolveRange(dest, request.anchor, request.anchor).start;
			const start = seeded ? 0 : anchorIndex;
			const replacement = seeded ? [...sourceLines] : placement(dest, anchorIndex, direction, sourceLines);
			const applied = applyRange(dest, start, start, replacement);
			const before = dest.lines.join("\n");
			const after = applied.lines.join("\n");
			if (before === after) return { anchorIndex, diff: undefined };
			await writeEditableFile(env, destPath, applied.content, context);
			return { anchorIndex, diff: generateDiffString(before, after) };
		},
		context,
	);
	if (written.diff === undefined && kind === "copy") {
		return { output: [{ type: "text", text: `No changes made to ${destPath}.` }] };
	}
	const parts = [
		`${kind === "copy" ? "Copied" : "Moved"} ${sourceLines.length} line(s) from lines ${range.start + 1}-${range.end + 1} of ${sourcePath} to ${direction} line ${written.anchorIndex + 1} of ${destPath}.`,
	];
	if (written.diff !== undefined) parts.push(written.diff.diff);
	if (kind === "move") {
		const sourceDiff = await withFileMutationQueue(
			env,
			sourcePath,
			async () => {
				const current = await readEditableFile(env, sourcePath, context);
				const currentRange = resolveRange(current, request.from, request.to);
				assertRangeServed(current, currentRange.start, currentRange.end, true);
				const applied = applyRange(current, currentRange.start, currentRange.end, []);
				await writeEditableFile(env, sourcePath, applied.content, context);
				return generateDiffString(current.lines.join("\n"), applied.lines.join("\n"));
			},
			context,
		);
		parts.push(`Removed lines ${range.start + 1}-${range.end + 1} of ${sourcePath}.\n\n${sourceDiff.diff}`);
	}
	return {
		output: [{ type: "text", text: parts.join("\n\n") }],
		details: {
			diff: written.diff?.diff ?? "",
			...(written.diff?.firstChangedLine === undefined
				? {}
				: { firstChangedLine: written.diff.firstChangedLine }),
		},
	};
}

/** `copy` and `move` share one implementation: both take lines from a served range and write them elsewhere. */
export function createTransferTool(kind: "copy" | "move"): ToolRegistration<typeof transferSchema, TransferToolDetails> {
	return defineTool({
		name: kind,
		description:
			kind === "copy"
				? "Duplicate a range of lines at another anchor. The source rows and anchors stay live; the copied lines get fresh anchors in the destination's post-edit diff and keep their source line endings.\n\nA copy duplicates the content its source anchors were served from, so a same-message edit to the source file does not change what is copied."
				: 'Relocate a range of lines to another anchor. Within one file the destination must sit outside the source range. Rows between the source and the destination keep their content but may be re-anchored, so read that span again if you plan to edit it.\n\nA cross-file move whose source file also gets other edits in the same message runs outside any batch: same-message edits to its destination file can then either abort or make the move fail, so send that move in a separate message.',
		parameters: transferSchema,
		async execute(args, api, context) {
			const env = requireEnv(api);
			const from = requireAnchor(args.source_from, "source_from");
			const to = requireAnchor(args.source_to, "source_to");
			const anchor = requireAnchor(args.anchor, "anchor");
			const direction = requireDirection(args.direction);
			const sourcePath = await resolveEditPath(env, undefined, [from, to], context);
			const destPath = await resolveEditPath(env, undefined, [anchor], context);
			const request: TransferRequest = { kind, sourcePath, destPath, from, to, anchor, direction };
			return sourcePath === destPath
				? transferSameFile(env, request, context)
				: transferAcrossFiles(env, request, context);
		},
	});
}

export function createCopyTool(): ToolRegistration<typeof transferSchema, TransferToolDetails> {
	return createTransferTool("copy");
}
