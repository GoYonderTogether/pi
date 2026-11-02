import { expect, test } from "vitest";
import { ANCHOR_COUNT, anchorAt, HASH_RE } from "../../src/tools/hashline/alphabet.ts";
import {
	anchorsFor,
	clearHashlineState,
	fmtRow,
	HASH_SEP,
	ownersOf,
	servedFor,
	serveRows,
	splitLines,
} from "../../src/tools/hashline/anchors.ts";

test("anchorAt names every index with five lowercase letters, without repeats", () => {
	expect(anchorAt(0)).toBe("aaaaa");
	expect(anchorAt(ANCHOR_COUNT - 1)).toBe("zzzzz");
	for (const index of [0, 1, 25, 26, 1234, 836286, ANCHOR_COUNT - 1]) expect(anchorAt(index)).toMatch(HASH_RE);
	const anchors = new Set(Array.from({ length: 20000 }, (_, index) => anchorAt(index)));
	expect(anchors.size).toBe(20000);
	expect([...anchors].every((anchor) => HASH_RE.test(anchor))).toBe(true);
});

test("the same file content gets the same anchors every time, one per row", () => {
	clearHashlineState();
	const lines = splitLines("alpha\nbeta\nbeta\n");
	const first = anchorsFor("/tmp/anchors-same.ts", lines);
	expect(first).toHaveLength(3);
	expect(first.every((anchor) => HASH_RE.test(anchor))).toBe(true);
	// Two rows with the same content are still two rows, so they never share an anchor.
	expect(new Set(first).size).toBe(3);
	expect(anchorsFor("/tmp/anchors-same.ts", lines)).toEqual(first);
	clearHashlineState();
	expect(anchorsFor("/tmp/anchors-same.ts", lines)).toEqual(first);
});

test("a served row is found by file and anchor, and not from another file", () => {
	clearHashlineState();
	const lines = ["one", "two"];
	const hashes = anchorsFor("/tmp/anchors-a.ts", lines);
	serveRows("/tmp/anchors-a.ts", hashes, lines, hashes);
	expect([...servedFor("/tmp/anchors-a.ts").keys()].sort()).toEqual([...hashes].sort());
	expect(servedFor("/tmp/anchors-b.ts").size).toBe(0);
	expect(ownersOf(hashes[0])).toEqual(["/tmp/anchors-a.ts"]);
	expect(fmtRow(hashes[0], lines[0])).toBe(`${hashes[0]}${HASH_SEP}one`);
	// Only the rows that were wanted are served.
	clearHashlineState();
	serveRows("/tmp/anchors-a.ts", hashes, lines, [hashes[1]]);
	expect([...servedFor("/tmp/anchors-a.ts").keys()]).toEqual([hashes[1]]);
});
