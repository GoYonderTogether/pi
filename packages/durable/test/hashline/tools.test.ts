import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import type { ToolExecutionApi, ToolExecutionResult } from "../../src/harness/types.ts";
import { clearHashlineState, HASH_SEP } from "../../src/tools/hashline/anchors.ts";
import { createReadTool } from "../../src/tools/read.ts";
import { createReplaceTool } from "../../src/tools/replace.ts";
import { createReplaceMatchTool } from "../../src/tools/replace-match.ts";
import { tempHome } from "./support.ts";

let root: string;
let env: NodeExecutionEnv;

beforeEach(async () => {
	clearHashlineState();
	root = await tempHome("yonder-hashline-");
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

test("read serves anchor rows that replace then addresses", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");
	const rows = await rowsOf({ path: "a.ts" });
	expect(rows).toHaveLength(3);
	for (const row of rows) expect(row.slice(0, 5)).toMatch(/^[a-z]{5}$/);
	expect(rows[0].endsWith(`${HASH_SEP}one`)).toBe(true);

	const anchor = anchorOf(rows, "two");
	const replaced = await createReplaceTool().execute(
		{ path: "a.ts", remove_from: anchor, remove_to: anchor, text: "TWO" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(replaced)).toContain("Replaced lines 2-2 of a.ts");
	expect(await readFile(join(root, "a.ts"), "utf8")).toBe("one\nTWO\nthree\n");

	// The served anchors of the untouched rows still address their lines after the write.
	const after = await rowsOf({ path: "a.ts" });
	expect(anchorOf(after, "three")).toBe(anchorOf(rows, "three"));
});

test("an anchor whose line changed on disk is rejected with the current rows, and the fresh one works", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const rows = await rowsOf({ path: "a.ts" });
	const stale = anchorOf(rows, "two");
	await writeFile(join(root, "a.ts"), "one\nchanged on disk\n");

	const failure = await createReplaceTool()
		.execute({ path: "a.ts", remove_from: stale, remove_to: stale, text: "x" }, api(), BACKGROUND_CONTEXT)
		.catch((error: Error) => error);
	expect(failure).toBeInstanceOf(Error);
	const message = (failure as Error).message;
	expect(message).toContain("[E_STALE_ANCHOR]");
	expect(message).toContain("The file changed since read");
	expect(message).toContain("Current rows:");

	const freshRow = message.split("\n").find((line) => line.endsWith(`${HASH_SEP}changed on disk`));
	expect(freshRow).toBeDefined();
	const fresh = (freshRow as string).trim().split(": ")[1].slice(0, 5);
	expect(fresh).not.toBe(stale);
	await createReplaceTool().execute(
		{ path: "a.ts", remove_from: fresh, remove_to: fresh, text: "fixed" },
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(await readFile(join(root, "a.ts"), "utf8")).toBe("one\nfixed\n");
});

test("replace_match refuses a boundary anchor that was never served", async () => {
	await writeFile(join(root, "a.ts"), "alpha\nbeta\n");
	// A one-line read serves the first row only.
	const firstRow = await rowsOf({ path: "a.ts", limit: 1 });
	const served = anchorOf(firstRow, "alpha");
	const unserved = anchorOf(await rowsOf({ path: "a.ts" }), "beta");
	clearHashlineState();
	const again = await rowsOf({ path: "a.ts", limit: 1 });
	const onlyServed = anchorOf(again, "alpha");
	expect(onlyServed).toBe(served);

	await expect(
		createReplaceMatchTool().execute(
			{ path: "a.ts", replace_from: onlyServed, replace_to: unserved, match: "beta", replacement: "BETA" },
			api(),
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/E_STALE_ANCHOR/);
	expect(await readFile(join(root, "a.ts"), "utf8")).toBe("alpha\nbeta\n");

	// With both rows served, the fragment is replaced in place.
	const rows = await rowsOf({ path: "a.ts" });
	const result = await createReplaceMatchTool().execute(
		{
			path: "a.ts",
			replace_from: anchorOf(rows, "alpha"),
			replace_to: anchorOf(rows, "beta"),
			match: "et",
			replacement: "ET",
		},
		api(),
		BACKGROUND_CONTEXT,
	);
	expect(textOf(result)).toContain('Replaced 1 occurrence(s) of "match"');
	expect(await readFile(join(root, "a.ts"), "utf8")).toBe("alpha\nbETa\n");
});

test("replace_match reports a match that is not there with the served rows", async () => {
	await writeFile(join(root, "a.ts"), "alpha\nbeta\n");
	const rows = await rowsOf({ path: "a.ts" });
	const failure = await createReplaceMatchTool()
		.execute(
			{
				path: "a.ts",
				replace_from: anchorOf(rows, "alpha"),
				replace_to: anchorOf(rows, "beta"),
				match: "gamma",
				replacement: "x",
			},
			api(),
			BACKGROUND_CONTEXT,
		)
		.catch((error: Error) => error);
	expect((failure as Error).message).toContain("[E_SUBSTRING_NOT_FOUND]");
	expect((failure as Error).message).toContain("Current rows:");
	expect(await readFile(join(root, "a.ts"), "utf8")).toBe("alpha\nbeta\n");
});

test("read can start at a served anchor and reports an empty file as one empty row", async () => {
	await writeFile(join(root, "a.ts"), "alpha\nbeta\ngamma\n");
	const rows = await rowsOf({ path: "a.ts" });
	const from = await rowsOf({ path: "a.ts", offset: anchorOf(rows, "beta") });
	expect(from.map((row) => row.slice(row.indexOf(HASH_SEP) + 1))).toEqual(["beta", "gamma"]);

	await writeFile(join(root, "empty.ts"), "");
	const empty = textOf(await createReadTool().execute({ path: "empty.ts" }, api(), BACKGROUND_CONTEXT));
	expect(empty).toContain("[File is empty. Use replace to insert content.]");
	expect(empty.split("\n")[0]).toBe(`${empty.slice(0, 5)}${HASH_SEP}`);
});
