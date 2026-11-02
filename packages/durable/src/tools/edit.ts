import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };
type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/**
 * Repair shapes models commonly send: `edits` as a JSON string or as a single edit object, and a top-level
 * `oldText`/`newText` pair. Works on a copy; the call's arguments stay unchanged.
 */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as EditToolInput;
	const args: Record<string, unknown> = { ...input };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {
			// A string that is not JSON is no repaired shape; validation reports it.
		}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return legacy;
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits };
}

export type EditToolDetails = {
	diff: string;
	patch: string;
	firstChangedLine?: number;
};

/**
 * Deprecated: `edit` matched text approximately, which a file that changed under the model silently rewrote. Every edit
 * is now addressed by the anchors `read` serves, so the name stays only to answer calls that still use it.
 */
export function createEditTool(): ToolRegistration<typeof editSchema, EditToolDetails> {
	return defineTool({
		name: "edit",
		description:
			"Deprecated: this tool no longer edits files and every call is refused with a migration note. Edits are addressed by the anchors read() serves: replace (a range of lines), replace_match (part of one line), insert (text next to a line), copy and move (a range to another anchor), and undo_last_change (revert the last edit of a file).",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(args) {
			const path = typeof args.path === "string" && args.path.length > 0 ? args.path : "the target file";
			return {
				output: [
					{
						type: "text",
						text: `[E_TOOL_REPLACED] The edit tool no longer edits files; nothing was changed in ${path}. Edits are addressed by the anchors read() serves: replace writes a range of lines, replace_match one fragment inside a line, insert text next to a line, copy and move a range to another anchor, and undo_last_change reverts the last edit of a file. Call read() on ${path} for its current anchor│content rows, then send the anchors with the exact text.`,
					},
				],
				isError: true,
			};
		},
	});
}
