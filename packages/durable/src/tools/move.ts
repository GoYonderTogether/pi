import type { ToolRegistration } from "../harness/types.ts";
import { createTransferTool, type TransferToolDetails, type TransferToolInput, transferSchema } from "./copy.ts";

export type MoveToolInput = TransferToolInput;

export type MoveToolDetails = TransferToolDetails;

/** `move` is `copy` with the source range removed afterwards; one implementation serves both. */
export function createMoveTool(): ToolRegistration<typeof transferSchema, MoveToolDetails> {
	return createTransferTool("move");
}
