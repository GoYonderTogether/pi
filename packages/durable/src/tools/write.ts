import { type Static, Type } from "typebox";
import { getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import { requireEnv } from "./env.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { HASH_SEP, servedFor } from "./hashline/anchors.ts";
import { resolveToolPath } from "./path-utils.ts";
import { clearUndoRecord } from "./undo.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;
/** A served row copied back into content: `abcde│text`, `+abcde│text`, `12:│ abcde│text`, `12-│ abcde│text`. */
const HASH_ECHO_RE = /^(?: *[0-9]+(?: │ |[:-]│ ))?[+ -]?([A-Za-z]{5,6})│/;

/**
 * Refuse content that carries anchors `read` served for this file: a served row is not the file's text, so writing one
 * would paste an anchor into the file.
 */
function assertNoAnchorEcho(absolutePath: string, content: string, rawPath: string): void {
	const served = servedFor(absolutePath);
	if (served.size === 0) return;
	for (const [index, line] of content.split("\n").entries()) {
		const match = HASH_ECHO_RE.exec(line);
		if (match === null) continue;
		const hash = match[1].toLowerCase();
		if (!served.has(hash)) continue;
		throw new Error(
			`[E_WRITE_HASH_ECHO] Refused write to ${rawPath}: line ${index + 1} contains the copied ${hash}${HASH_SEP} anchor served for this file. Remove the copied anchors and retry.`,
		);
	}
}

export function createWriteTool(): ToolRegistration<typeof writeSchema> {
	return defineTool({
		name: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(args, api, context) {
			const { path, content } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					assertNoAnchorEcho(absolutePath, content, path);
					getOrThrow(await env.writeFile(absolutePath, content, context));
					clearUndoRecord(absolutePath);
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					return { output: [{ type: "text", text: `Successfully wrote to ${path}` }] };
				},
				context,
			);
		},
	});
}
