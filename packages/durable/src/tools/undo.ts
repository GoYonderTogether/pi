import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import { generateDiffString } from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { ownersOf, parseAnchor, splitLines } from "./hashline/anchors.ts";
import { resolveToolPath } from "./path-utils.ts";

/** One change of one file: what it held before and what it holds now; `null` is a file that does not exist. */
type UndoEntry = { readonly before: string | null; readonly after: string | null };

/** One slot per file: the last change of that file, never a stack. */
const undoHistory = new Map<string, UndoEntry>();

/** The argument fields that name a served row; every edit tool addresses its files with one of them. */
const ANCHOR_FIELDS = [
	"anchor",
	"remove_from",
	"remove_to",
	"replace_from",
	"replace_to",
	"source_from",
	"source_to",
] as const;

/** Forget every undo record; the hashline state and the tests that reset it reset this too. */
export function clearUndoHistory(): void {
	undoHistory.clear();
}

/** `write` replaces a file wholesale, so it ends the undo history of that file. */
export function clearUndoRecord(absolutePath: string): void {
	undoHistory.delete(absolutePath);
}

/** The file's text, `null` when it does not exist, `undefined` when it cannot be read at all. */
async function textOrNull(
	env: ExecutionEnv,
	absolutePath: string,
	context: Context,
): Promise<string | null | undefined> {
	const read = await env.readTextFile(absolutePath, context);
	if (read.ok) return read.value;
	return read.error.code === "not_found" ? null : undefined;
}

/** The files an edit call touches: the files its anchors were served for, wherever the call puts them. */
async function undoPaths(env: ExecutionEnv, args: Record<string, unknown>): Promise<string[]> {
	const owned = new Set<string>();
	for (const field of ANCHOR_FIELDS) {
		const value = args[field];
		if (typeof value !== "string") continue;
		const anchor = parseAnchor(value);
		if (anchor === undefined) continue;
		for (const path of ownersOf(anchor)) owned.add(path);
	}
	return [...owned];
}

/**
 * Record the last change of every file an edit tool touches, so `undo_last_change` can revert it. Recording sits here,
 * around the registered tool, because it belongs to every anchor edit and to none of their implementations.
 */
export function withUndoRecorded(tool: ToolRegistration): ToolRegistration {
	const execute = tool.execute.bind(tool) as (
		args: unknown,
		api: ToolExecutionApi,
		context: Context,
	) => Promise<ToolExecutionResult>;
	return {
		...tool,
		async execute(args, api, context) {
			const env = api.env;
			if (env === undefined) return execute(args, api, context);
			const paths = await undoPaths(env, args as Record<string, unknown>);
			const before = new Map<string, string | null | undefined>();
			for (const path of paths) before.set(path, await textOrNull(env, path, context));
			const result = await execute(args, api, context);
			for (const path of paths) {
				const previous = before.get(path);
				const after = await textOrNull(env, path, context);
				if (previous === undefined || after === undefined || previous === after) continue;
				undoHistory.set(path, { before: previous, after });
			}
			return result;
		},
	};
}

const undoSchema = Type.Object({
	path: Type.String({ description: "Path to the file to undo" }),
});

export type UndoToolInput = Static<typeof undoSchema>;

export type UndoToolDetails = {
	diff: string;
	firstChangedLine?: number;
};

function lineCount(text: string): number {
	return text.length === 0 ? 0 : splitLines(text).length;
}

export function createUndoTool(): ToolRegistration<typeof undoSchema, UndoToolDetails> {
	return defineTool({
		name: "undo_last_change",
		description:
			"Undo the last replace, replace_match, insert, copy, or move on a file, restoring the previous content, BOM, and line endings. If the file changed since that edit, the undo is refused and the file is left untouched; a file deleted since the edit is restored.",
		parameters: undoSchema,
		async execute(args, api, context) {
			const env = requireEnv(api);
			const rawPath = typeof args.path === "string" ? args.path : "";
			if (rawPath.length === 0) throw new Error('[E_BAD_SHAPE] Undo request requires a non-empty "path" string.');
			const absolutePath = await resolveToolPath(env, rawPath, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					const entry = undoHistory.get(absolutePath);
					const current = await textOrNull(env, absolutePath, context);
					if (current === undefined) throw new Error(`Could not read file: ${rawPath}.`);
					if (entry === undefined) {
						if (current === null) throw new Error(`[E_NOT_FOUND] File not found: ${rawPath}. Nothing was reverted.`);
						throw new Error(`[E_UNDO_NONE] No undo history for ${rawPath}.`);
					}
					if (current !== entry.after) {
						throw new Error(
							`[E_UNDO_STALE] Cannot undo last change on ${rawPath}: the file was modified after the edit, so nothing was reverted and the file was left untouched. The undo record is kept. Do not edit the file to force the undo. Call read() to inspect the current state.`,
						);
					}
					if (entry.before === null) {
						getOrThrow(await env.remove(absolutePath, undefined, context));
					} else {
						getOrThrow(await env.writeFile(absolutePath, entry.before, context));
					}
					undoHistory.delete(absolutePath);
					const diff = generateDiffString(current ?? "", entry.before ?? "");
					const notes = [`Undone last change on ${rawPath}.`];
					if (current === null) notes.push("The file was deleted; restored it from undo history.");
					notes.push(
						`Removed ${current === null ? 0 : lineCount(current)} line(s), restored ${entry.before === null ? 0 : lineCount(entry.before)} line(s).`,
					);
					return {
						output: [
							{
								type: "text" as const,
								text: `${notes.join(" ")}\n\n${diff.diff}\n\nCall read for fresh anchors.`,
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
