import { defineExtension } from "../harness/define.ts";
import { createBashTool } from "./bash.ts";
import { createCopyTool } from "./copy.ts";
import { createEditTool } from "./edit.ts";
import { createInsertTool } from "./insert.ts";
import { createMoveTool } from "./move.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createReplaceMatchTool } from "./replace-match.ts";
import { createReplaceTool } from "./replace.ts";
import { createUndoTool, withUndoRecorded } from "./undo.ts";
import { createWriteTool } from "./write.ts";

export {
	type BashExecution,
	type BashPrepare,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createPowerShellTool,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./bash.ts";
export { createCopyTool, type TransferToolDetails, type TransferToolInput } from "./copy.ts";
export { createEditTool, type EditToolDetails, type EditToolInput } from "./edit.ts";
/** The line handling an anchor edit shares with `grep`: split lines, normalize line endings, drop a BOM. */
export { normalizeToLF, stripBom } from "./edit-diff.ts";
export {
	/** The files an anchor was served for: the files an anchor edit may touch. */
	anchorsFor,
	clipLine,
	HASH_SEP,
	/** `HASH_SEP` divides a served row's anchor and text; `serveRows` registers the rows `grep` returns. */
	ownersOf as anchorOwners,
	serveRows,
	splitLines,
} from "./hashline/anchors.ts";
export {
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	type PreparedImage,
} from "./image-processor.ts";
export { createInsertTool, type InsertToolDetails, type InsertToolInput } from "./insert.ts";
export { createMoveTool, type MoveToolDetails, type MoveToolInput } from "./move.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput, type ReadToolOptions } from "./read.ts";
export {
	createReplaceMatchTool,
	type ReplaceMatchToolDetails,
	type ReplaceMatchToolInput,
} from "./replace-match.ts";
export { createReplaceTool, type ReplaceToolDetails, type ReplaceToolInput } from "./replace.ts";
export { clearUndoHistory, createUndoTool, type UndoToolDetails, type UndoToolInput } from "./undo.ts";
export { createWriteTool, type WriteToolInput } from "./write.ts";

/**
 * The `coding-tools` extension: `read`, `write`, `edit`, `replace`, `replace_match`, `insert`, `copy`, `move`,
 * `undo_last_change`, and `bash`; nothing installs it automatically. Every edit is addressed by the anchors `read`
 * serves, and `undo_last_change` reverts the last one of a file. `edit` is a deprecated alias that only answers with a
 * migration note. `createPowerShellTool()` adds `powershell`. `images` prepares the images `read` returns (see
 * `ReadToolOptions`).
 */
export function createCodingTools(options: ReadToolOptions = {}) {
	return defineExtension({
		name: "coding-tools",
		tools: [
			createReadTool(options),
			createWriteTool(),
			createEditTool(),
			withUndoRecorded(createReplaceTool()),
			withUndoRecorded(createReplaceMatchTool()),
			withUndoRecorded(createInsertTool()),
			withUndoRecorded(createCopyTool()),
			withUndoRecorded(createMoveTool()),
			createUndoTool(),
			createBashTool(),
		],
	});
}

/** `createCodingTools()` without an image processor. */
export const CodingTools = createCodingTools();
