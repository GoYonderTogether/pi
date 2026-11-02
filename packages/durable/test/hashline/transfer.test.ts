import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import type { ToolExecutionApi, ToolExecutionResult } from "../../src/harness/types.ts";
import { createCopyTool } from "../../src/tools/copy.ts";
import { clearHashlineState, HASH_SEP } from "../../src/tools/hashline/anchors.ts";
import { createInsertTool } from "../../src/tools/insert.ts";
import { createMoveTool } from "../../src/tools/move.ts";
import { createReadTool } from "../../src/tools/read.ts";
import { tempHome } from "./support.ts";

let root: string;
let env: NodeExecutionEnv;

beforeEach(async () => {
	clearHashlineState();
	root = await tempHome("yonder-hashline-transfer-");
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

async function rowsOf(args: { path: string; offset?: number | string; limit?: number }): Promise<string[]> {
	return textOf(await createReadTool().execute(args, api(), BACKGROUND_CONTEXT)).split("\n");
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

test("insert writes text after and before a served anchor, and an empty string inserts one blank line", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");
	const rows = await rowsOf({ path: "a.ts" });

	const after = await createInsertTool().execute(
		{ path: "a.ts", anchor: anchorOf(rows, "two"), direction: "after", text: "after-two" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(after)).toContain("Inserted 1 line(s) after line 2 of");
	expect(await content("a.ts")).toBe("one\ntwo\nafter-two\nthree\n");

	// The anchor of an untouched line still addresses it, so the block lands on the other side without a new read.
	const before = await createInsertTool().execute(
		{ anchor: anchorOf(rows, "two"), direction: "before", text: "before-two" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(before)).toContain("Inserted 1 line(s) before line 2 of");
	expect(await content("a.ts")).toBe("one\nbefore-two\ntwo\nafter-two\nthree\n");

	const blank = await createInsertTool().execute(
		{ anchor: anchorOf(rows, "one"), direction: "after", text: "" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(blank)).toContain("Inserted 1 line(s) after line 1 of");
	expect(await content("a.ts")).toBe("one\n\nbefore-two\ntwo\nafter-two\nthree\n");
});

test("insert seeds an empty file from its one empty row", async () => {
	await writeFile(join(root, "empty.ts"), "");
	const [row] = await rowsOf({ path: "empty.ts" });
	expect(row).toBe(`${row.slice(0, 5)}${HASH_SEP}`);
	await createInsertTool().execute(
		{ anchor: row.slice(0, 5), direction: "after", text: "seed" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await content("empty.ts")).toBe("seed");
});

test("insert refuses an anchor whose line changed on disk", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const rows = await rowsOf({ path: "a.ts" });
	const stale = anchorOf(rows, "two");
	await writeFile(join(root, "a.ts"), "one\nchanged on disk\n");

	const failure = await createInsertTool()
		.execute({ path: "a.ts", anchor: stale, direction: "after", text: "x" }, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect((failure as Error).message).toContain("[E_STALE_ANCHOR]");
	expect((failure as Error).message).toContain("The file changed since read");
	expect(await content("a.ts")).toBe("one\nchanged on disk\n");
});

test("copy duplicates a served range below another anchor of the same file", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\nthree\nfour\n");
	const rows = await rowsOf({ path: "a.ts" });

	const copied = await createCopyTool().execute(
		{
			source_from: anchorOf(rows, "one"),
			source_to: anchorOf(rows, "two"),
			anchor: anchorOf(rows, "four"),
			direction: "after",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(copied)).toContain("Copied 2 line(s) to after line 4 of");
	expect(await content("a.ts")).toBe("one\ntwo\nthree\nfour\none\ntwo\n");
});

test("copy and move refuse an anchor that places the block inside the source range", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\nthree\nfour\n");
	const rows = await rowsOf({ path: "a.ts" });
	const args = {
		source_from: anchorOf(rows, "one"),
		source_to: anchorOf(rows, "three"),
		anchor: anchorOf(rows, "two"),
		direction: "after" as const,
	};

	const copy = await createCopyTool()
		.execute(args, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect((copy as Error).message).toContain(
		'[E_BAD_SHAPE] "anchor" resolves to line 2, which places the block inside the source range (lines 1-3).',
	);
	const move = await createMoveTool()
		.execute(args, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect((move as Error).message).toContain("Use a line outside the source range.");
	expect(await content("a.ts")).toBe("one\ntwo\nthree\nfour\n");
});

test("move relocates a range and reports a move onto itself as no change", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\nthree\nfour\n");
	const rows = await rowsOf({ path: "a.ts" });

	const up = await createMoveTool().execute(
		{
			source_from: anchorOf(rows, "three"),
			source_to: anchorOf(rows, "four"),
			anchor: anchorOf(rows, "one"),
			direction: "before",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(up)).toContain("Moved 2 line(s) to before line 1 of");
	expect(await content("a.ts")).toBe("three\nfour\none\ntwo\n");

	const moved = await rowsOf({ path: "a.ts" });
	const noChange = await createMoveTool().execute(
		{
			source_from: anchorOf(moved, "one"),
			source_to: anchorOf(moved, "one"),
			anchor: anchorOf(moved, "one"),
			direction: "after",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(noChange)).toContain("No changes made to");
	expect(await content("a.ts")).toBe("three\nfour\none\ntwo\n");
});

test("copy and move take the source range from another file", async () => {
	await writeFile(join(root, "src.ts"), "alpha\nbeta\n");
	await writeFile(join(root, "dst.ts"), "x\ny\n");
	const source = await rowsOf({ path: "src.ts" });
	const destination = await rowsOf({ path: "dst.ts" });
	const range = { source_from: anchorOf(source, "alpha"), source_to: anchorOf(source, "beta") };

	const copied = await createCopyTool().execute(
		{ ...range, anchor: anchorOf(destination, "y"), direction: "after" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(copied)).toContain("Copied 2 line(s) from lines 1-2 of");
	expect(await content("dst.ts")).toBe("x\ny\nalpha\nbeta\n");
	expect(await content("src.ts")).toBe("alpha\nbeta\n");

	const moved = await createMoveTool().execute(
		{ ...range, anchor: anchorOf(destination, "x"), direction: "before" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(moved)).toContain("Moved 2 line(s) from lines 1-2 of");
	expect(textOf(moved)).toContain("Removed lines 1-2 of");
	expect(await content("dst.ts")).toBe("alpha\nbeta\nx\ny\nalpha\nbeta\n");
	expect(await content("src.ts")).toBe("");
});

test("copy and move refuse a source anchor whose line changed on disk", async () => {
	await writeFile(join(root, "src.ts"), "alpha\nbeta\n");
	await writeFile(join(root, "dst.ts"), "x\n");
	const source = await rowsOf({ path: "src.ts" });
	const destination = await rowsOf({ path: "dst.ts" });
	const args = {
		source_from: anchorOf(source, "alpha"),
		source_to: anchorOf(source, "beta"),
		anchor: anchorOf(destination, "x"),
		direction: "after" as const,
	};
	await writeFile(join(root, "src.ts"), "alpha\nchanged on disk\n");

	const copy = await createCopyTool()
		.execute(args, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect((copy as Error).message).toContain("[E_STALE_ANCHOR]");
	const move = await createMoveTool()
		.execute(args, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect((move as Error).message).toContain("[E_STALE_ANCHOR]");
	expect(await content("src.ts")).toBe("alpha\nchanged on disk\n");
	expect(await content("dst.ts")).toBe("x\n");
});
