import { type Static, Type } from "typebox";
import { generateDiffString } from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { clipLine, fmtRegion } from "./hashline/anchors.ts";
import {
	applyRange,
	assertRangeServed,
	assertWritableText,
	readEditableFile,
	requireAnchor,
	resolveEditPath,
	resolveRange,
	writeEditableFile,
} from "./hashline/edit.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";

const replaceMatchSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description: "Path to the file the anchors were served for; required and must match anchor ownership.",
			}),
		),
		replace_from: Type.String({ description: "5-char anchor of the FIRST line of the range searched." }),
		replace_to: Type.String({
			description: "5-char anchor of the LAST line of the range searched; same as `replace_from` for a single line.",
		}),
		match: Type.String({
			description:
				"The exact text to find inside the range, as it appears in the served rows. Send only the fragment that changes; it must stay within one line (a trailing line break is accepted and dropped), and every occurrence inside the range is replaced.",
		}),
		replacement: Type.String({
			description:
				'The exact replacement for every occurrence of `match`. "" deletes them; a single trailing line break is dropped, while line breaks inside the value split it into lines.',
		}),
	},
	{ additionalProperties: true },
);

export type ReplaceMatchToolInput = Static<typeof replaceMatchSchema>;

export type ReplaceMatchToolDetails = {
	diff: string;
	occurrences: number;
	firstChangedLine?: number;
};

/** `match` as it must be sent: one line, without the row's own terminator. */
function singleLineMatch(value: string): string {
	const text = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (text.includes("\n")) {
		throw new Error(
			"[E_BAD_SHAPE] match must stay within one line, but the value contains a line break. A trailing line break is accepted as the line's own terminator; a match that spans lines belongs to replace.",
		);
	}
	if (text.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Replace-match request field "match" must be a non-empty string holding the exact text to find.',
		);
	}
	return text;
}

/** The replacement fragment: a single trailing line break is the last line's own terminator and is dropped. */
function replacementFragment(value: string): string {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function notFoundMessage(
	absolutePath: string,
	hashes: readonly string[],
	lines: readonly string[],
	start: number,
	end: number,
): string {
	const where = start === end ? `line ${start + 1}` : `lines ${start + 1}-${end + 1}`;
	const rows = fmtRegion(hashes.slice(start, end + 1), lines.slice(start, end + 1).map((line) => clipLine(line)));
	return `[E_SUBSTRING_NOT_FOUND] "match" was not found in ${where} of ${absolutePath}. Current rows:\n\n${rows}\n\nCopy only the fragment that changes from the served row (a trailing line break is accepted and dropped) and retry; for a whole-line rewrite use replace with the same anchors.`;
}

export function createReplaceMatchTool(): ToolRegistration<typeof replaceMatchSchema, ReplaceMatchToolDetails> {
	return defineTool({
		name: "replace_match",
		description:
			"Replace part of the served lines of one file without retyping the rest: match is the exact fragment to find inside the anchored range, and replacement replaces every occurrence. The text around each match is kept byte for byte. Both boundary anchors must have been served, and stale anchors are rejected with the current rows instead of being matched approximately.",
		parameters: replaceMatchSchema,
		async execute(args, api, context) {
			const env = requireEnv(api);
			const from = requireAnchor(args.replace_from, "replace_from");
			const to = requireAnchor(args.replace_to, "replace_to");
			const matchText = singleLineMatch(args.match);
			const fragment = replacementFragment(args.replacement);
			assertWritableText(fragment);
			const displayPath = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
			const absolutePath = await resolveEditPath(env, args.path, [from, to], context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const file = await readEditableFile(env, absolutePath, context);
					const { start, end } = resolveRange(file, from, to);
					assertRangeServed(file, start, end, false);
					let occurrences = 0;
					const replaced = file.lines.slice(start, end + 1).map((line) => {
						const pieces = line.split(matchText);
						occurrences += pieces.length - 1;
						return pieces.join(fragment);
					});
					if (occurrences === 0) {
						throw new Error(notFoundMessage(absolutePath, file.hashes, file.lines, start, end));
					}
					const replacement = replaced.join("\n").split("\n");
					const applied = applyRange(file, start, end, replacement);
					await writeEditableFile(env, absolutePath, applied.content, context);
					const diff = generateDiffString(file.lines.join("\n"), applied.lines.join("\n"));
					return {
						output: [
							{
								type: "text",
								text: `Replaced ${occurrences} occurrence(s) of "match" in lines ${start + 1}-${end + 1} of ${displayPath ?? absolutePath}.\n\n${diff.diff}`,
							},
						],
						details: {
							diff: diff.diff,
							occurrences,
							...(diff.firstChangedLine === undefined ? {} : { firstChangedLine: diff.firstChangedLine }),
						},
					};
				},
				context,
			);
		},
	});
}
