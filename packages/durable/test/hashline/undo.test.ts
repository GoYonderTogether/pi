import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import type { ToolExecutionApi, ToolExecutionResult } from "../../src/harness/types.ts";
import { clearHashlineState, HASH_SEP } from "../../src/tools/hashline/anchors.ts";
import { createCodingTools } from "../../src/tools/index.ts";
import { clearUndoHistory } from "../../src/tools/undo.ts";
import { tempHome } from "./support.ts";

type AnyTool = {
	readonly name: string;
	execute(args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult<never>>;
};

const tools = createCodingTools().tools as unknown as readonly AnyTool[];

function tool(name: string): AnyTool {
	const found = tools.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`the coding tools have no ${name} tool`);
	return found;
}

let root: string;
let env: NodeExecutionEnv;

beforeEach(async () => {
	clearHashlineState();
	clearUndoHistory();
	root = await tempHome("yonder-hashline-undo-");
	env = new NodeExecutionEnv({ cwd: root });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function api(): ToolExecutionApi {
	return { env } as unknown as ToolExecutionApi;
}

function textOf(result: Pick<ToolExecutionResult<never>, "output">): string {
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function rowsOf(path: string): Promise<string[]> {
	return textOf(await tool("read").execute({ path }, api(), BACKGROUND_CONTEXT)).split("\n");
}

/** The anchor of the row whose content is exactly `content`. */
function anchorOf(rows: readonly string[], content: string): string {
	const row = rows.find((candidate) => candidate.endsWith(`${HASH_SEP}${content}`));
	if (row === undefined) throw new Error(`no served row for ${JSON.stringify(content)} in ${rows.join(" | ")}`);
	return row.slice(0, row.indexOf(HASH_SEP));
}

async function content(path: string): Promise<string> {
	return readFile(join(root, path), "utf8");
}

test("undo restores the content a replace changed, and a second undo has nothing left", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const anchor = anchorOf(await rowsOf("a.ts"), "two");
	await tool("replace").execute(
		{ path: "a.ts", remove_from: anchor, remove_to: anchor, text: "TWO" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("a.ts")).toBe("one\nTWO\n");

	const undone = await tool("undo_last_change").execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT);
	expect(textOf(undone)).toContain("Undone last change on a.ts.");
	expect(textOf(undone)).toContain("Removed 2 line(s), restored 2 line(s).");
	expect(textOf(undone)).toContain("Call read for fresh anchors.");
	expect(await content("a.ts")).toBe("one\ntwo\n");

	await expect(tool("undo_last_change").execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT)).rejects.toThrow(
		/E_UNDO_NONE/,
	);
});

test("undo is refused when the file changed after the edit", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const anchor = anchorOf(await rowsOf("a.ts"), "one");
	await tool("replace_match").execute(
		{ path: "a.ts", replace_from: anchor, replace_to: anchor, match: "one", replacement: "ONE" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("a.ts")).toBe("ONE\ntwo\n");
	await writeFile(join(root, "a.ts"), "ONE\ntwo\nedited elsewhere\n");

	const failure = await tool("undo_last_change")
		.execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect((failure as Error).message).toContain("[E_UNDO_STALE]");
	expect((failure as Error).message).toContain("the file was modified after the edit");
	expect(await content("a.ts")).toBe("ONE\ntwo\nedited elsewhere\n");
});

test("undo reverts the last insert, copy and move of a file", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");
	const rows = await rowsOf("a.ts");
	await tool("insert").execute(
		{ path: "a.ts", anchor: anchorOf(rows, "two"), direction: "after", text: "inserted" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("a.ts")).toBe("one\ntwo\ninserted\nthree\n");
	await tool("undo_last_change").execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT);
	expect(await content("a.ts")).toBe("one\ntwo\nthree\n");

	await tool("copy").execute(
		{
			source_from: anchorOf(rows, "one"),
			source_to: anchorOf(rows, "one"),
			anchor: anchorOf(rows, "three"),
			direction: "after",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("a.ts")).toBe("one\ntwo\nthree\none\n");
	await tool("undo_last_change").execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT);
	expect(await content("a.ts")).toBe("one\ntwo\nthree\n");

	await tool("move").execute(
		{
			source_from: anchorOf(rows, "one"),
			source_to: anchorOf(rows, "one"),
			anchor: anchorOf(rows, "three"),
			direction: "after",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("a.ts")).toBe("two\nthree\none\n");
	await tool("undo_last_change").execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT);
	expect(await content("a.ts")).toBe("one\ntwo\nthree\n");
});

test("a cross-file move records one undo entry per file, so both sides revert", async () => {
	await writeFile(join(root, "src.ts"), "alpha\nbeta\n");
	await writeFile(join(root, "dst.ts"), "x\n");
	const source = await rowsOf("src.ts");
	const destination = await rowsOf("dst.ts");
	await tool("move").execute(
		{
			source_from: anchorOf(source, "alpha"),
			source_to: anchorOf(source, "beta"),
			anchor: anchorOf(destination, "x"),
			direction: "after",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("src.ts")).toBe("");
	expect(await content("dst.ts")).toBe("x\nalpha\nbeta\n");

	await tool("undo_last_change").execute({ path: "src.ts" }, api(), BACKGROUND_CONTEXT);
	expect(await content("src.ts")).toBe("alpha\nbeta\n");
	await tool("undo_last_change").execute({ path: "dst.ts" }, api(), BACKGROUND_CONTEXT);
	expect(await content("dst.ts")).toBe("x\n");
});

test("write ends the undo history of the file it rewrites", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const anchor = anchorOf(await rowsOf("a.ts"), "one");
	await tool("replace").execute(
		{ path: "a.ts", remove_from: anchor, remove_to: anchor, text: "ONE" },
		api(),
		BACKGROUND_CONTEXT,
	);
	await tool("write").execute({ path: "a.ts", content: "rewritten\n" }, api(), BACKGROUND_CONTEXT);

	await expect(tool("undo_last_change").execute({ path: "a.ts" }, api(), BACKGROUND_CONTEXT)).rejects.toThrow(
		/E_UNDO_NONE/,
	);
	expect(await content("a.ts")).toBe("rewritten\n");
});
