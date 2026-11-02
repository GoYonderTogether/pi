import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import type { ToolExecutionApi, ToolExecutionResult } from "../../src/harness/types.ts";
import { clearHashlineState, HASH_SEP } from "../../src/tools/hashline/anchors.ts";
import { createReadTool } from "../../src/tools/read.ts";
import { createWriteTool } from "../../src/tools/write.ts";
import { tempHome } from "./support.ts";

let root: string;
let env: NodeExecutionEnv;

beforeEach(async () => {
	clearHashlineState();
	root = await tempHome("yonder-hashline-write-");
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
	return textOf(await createReadTool().execute({ path }, api(), BACKGROUND_CONTEXT)).split("\n");
}

async function content(path: string): Promise<string> {
	return readFile(join(root, path), "utf8");
}

test("write refuses content that copies an anchor served for that file", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const [first] = await rowsOf("a.ts");
	const anchor = first.slice(0, first.indexOf(HASH_SEP));

	const failure = await createWriteTool()
		.execute(
			{ path: "a.ts", content: `${anchor}${HASH_SEP}one\n${anchor}${HASH_SEP}two\n` },
			api(),
			BACKGROUND_CONTEXT,
		)
		.catch((error: Error) => error);
	expect((failure as Error).message).toContain("[E_WRITE_HASH_ECHO]");
	expect((failure as Error).message).toContain("contains the copied");
	expect((failure as Error).message).toContain("Remove the copied anchors and retry.");
	expect(await content("a.ts")).toBe("one\ntwo\n");
});

test("write accepts content whose 5-letter prefix was never served for the file", async () => {
	await writeFile(join(root, "a.ts"), "one\ntwo\n");
	const served = new Set((await rowsOf("a.ts")).map((row) => row.slice(0, row.indexOf(HASH_SEP))));
	const free = ["zzzzz", "yyyyy", "xxxxx", "wwwww"].find((candidate) => !served.has(candidate));
	if (free === undefined) throw new Error("every candidate anchor was served");
	const written = `${free}${HASH_SEP}looks like a row\n`;
	const result = await createWriteTool().execute({ path: "a.ts", content: written }, api(), BACKGROUND_CONTEXT);
	expect(textOf(result)).toContain("Successfully wrote to a.ts");
	expect(await content("a.ts")).toBe(written);
});

test("write is not gated for a file whose rows were never read", async () => {
	const written = "abcde│not served\n";
	await createWriteTool().execute({ path: "b.ts", content: written }, api(), BACKGROUND_CONTEXT);
	expect(await content("b.ts")).toBe(written);
});
