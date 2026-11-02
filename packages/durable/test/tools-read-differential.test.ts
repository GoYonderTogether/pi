import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { characterEnd, utf8ByteLength } from "@earendil-works/chord/output";
import { afterAll, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import type { ToolDiagnostic, ToolExecutionApi } from "../src/harness/types.ts";
import { normalizeToLF, stripBom } from "../src/tools/edit-diff.ts";
import { anchorsFor, fmtRegion, fmtRow, splitLines } from "../src/tools/hashline/anchors.ts";
import { detectSupportedImageMimeType } from "../src/tools/image.ts";
import { createReadTool } from "../src/tools/read.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHeadOf } from "../src/truncate.ts";

/** Full-file reference for the anchored rows returned by the bounded read path. */
function referenceRead(
	bytes: Uint8Array,
	path: string,
	absolutePath: string,
	offset: number | undefined,
	limit: number | undefined,
) {
	const mimeType = detectSupportedImageMimeType(bytes);
	if (mimeType) {
		return {
			output: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }],
			diagnostics: [{ severity: "info", code: "image", message: `Read image file [${mimeType}].` }],
		};
	}
	const text = new TextDecoder().decode(bytes);
	const normalized = normalizeToLF(stripBom(text).text);
	const lines = splitLines(normalized);
	const hashes = anchorsFor(absolutePath, lines);
	const startLine = offset ?? 1;
	if (startLine > lines.length)
		throw new Error(`Offset ${startLine} is beyond end of file (${lines.length} lines total)`);
	const startIndex = startLine - 1;
	const endIndex = limit === undefined ? lines.length : Math.min(startIndex + limit, lines.length);
	const selected = lines.slice(startIndex, endIndex);
	const selectedHashes = hashes.slice(startIndex, endIndex);
	const diagnostics: ToolDiagnostic[] = [];
	let hadUtf8DecodeErrors = false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		hadUtf8DecodeErrors = true;
	}
	if (hadUtf8DecodeErrors) {
		diagnostics.push({
			severity: "warn",
			code: "encoding",
			message: "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]",
		});
	}
	if (normalized.length === 0) {
		return {
			output: [{ type: "text", text: `${fmtRow(hashes[0]!, "")}\n[File is empty. Use replace to insert content.]` }],
			diagnostics,
		};
	}
	const rows = fmtRegion(selectedHashes, selected);
	const truncation = truncateHeadOf(rows, { lines: selected.length, bytes: utf8ByteLength(rows) });
	const { content: _content, ...truncationDetails } = truncation;
	let outputText = truncation.content;
	let details: object | undefined;
	if (truncation.firstLineExceedsLimit) {
		const rowBytes = new TextEncoder().encode(rows.split("\n")[0] ?? "");
		const end = characterEnd(rowBytes, DEFAULT_MAX_BYTES);
		outputText = new TextDecoder().decode(rowBytes.subarray(0, end));
		diagnostics.push({
			severity: "warn",
			code: "truncated",
			message: `Line ${startLine} is ${formatSize(utf8ByteLength(selected[0]!))}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${startLine}p' ${path} | tail -c +${end + 1}`,
		});
		details = { truncation: { ...truncationDetails, outputBytes: end, outputLines: 1 } };
	} else if (truncation.truncated) {
		const endLine = startLine + truncation.outputLines - 1;
		const limitText = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		diagnostics.push({
			severity: "info",
			code: "truncated",
			message: `Showing lines ${startLine}-${endLine} of ${lines.length}${limitText}. Use offset=${endLine + 1} to continue.`,
		});
		details = { truncation: truncationDetails };
	} else if (limit !== undefined && endIndex < lines.length) {
		diagnostics.push({
			severity: "info",
			message: `${lines.length - endIndex} more lines in file. Use offset=${endIndex + 1} to continue.`,
		});
	}
	return {
		output: outputText === "" ? [] : [{ type: "text", text: outputText }],
		...(details === undefined ? {} : { details }),
		diagnostics,
	};
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = [
	[0x0a],
	[0x0a],
	[0x61],
	[0x62, 0x63, 0x64, 0x65],
	[0xef, 0xbb, 0xbf],
	[0xc3, 0xa9],
	[0xe2, 0x82, 0xac],
	[0xf0, 0x9f, 0x98, 0x80],
	[0xe2, 0x82],
	[0xff],
	[0x0d, 0x0a],
];

/** Mostly small files, some over the line limit, some over the byte limit, some with one huge line. */
function randomFile(next: () => number): Uint8Array {
	const kind = next();
	if (kind < 0.1) return Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("x\n".repeat(2100))]);
	if (kind < 0.2) {
		const line = new Uint8Array(DEFAULT_MAX_BYTES + 200 + Math.floor(next() * 400)).fill(0x61);
		line[DEFAULT_MAX_BYTES - 1 + Math.floor(next() * 3)] = 0xc3;
		return Uint8Array.from([...line, 0x0a, 0x62]);
	}
	if (kind < 0.3) return new TextEncoder().encode(`${"0123456789".repeat(30)}\n`.repeat(200));
	const bytes: number[] = [];
	const pieces = Math.floor(next() * 80);
	for (let index = 0; index < pieces; index++) bytes.push(...PIECES[Math.floor(next() * PIECES.length)]!);
	return Uint8Array.from(bytes);
}

const OFFSETS = [undefined, 0, 1, 2, 3, 2.5, -4, 50, 2001, 3000, 1e20, Number.NaN];
const LIMITS = [undefined, 0, 1, 2, -3, -1e20, 1.5, 7, 2000, 2500, 1e20, Number.NaN];

function apiFor(env: NodeExecutionEnv): ToolExecutionApi {
	return {
		env,
		output: () => {},
		outputWindow: undefined,
		diagnostic: () => {},
		details: async () => {},
		agent: async () => ({}),
	} as unknown as ToolExecutionApi;
}

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function outcome<T>(run: () => T | Promise<T>): Promise<T | { error: string }> {
	try {
		return await run();
	} catch (error) {
		return { error: (error as Error).message };
	}
}

describe("read tool", () => {
	it("returns the same anchored selection as a full-file reference", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-durable-read-"));
		dirs.push(cwd);
		const env = new NodeExecutionEnv({ cwd });
		const tool = createReadTool();
		for (let seed = 1; seed <= 400; seed++) {
			const next = random(seed);
			const file = randomFile(next);
			writeFileSync(join(cwd, "f.txt"), file);
			for (let trial = 0; trial < 4; trial++) {
				const offset = OFFSETS[Math.floor(next() * OFFSETS.length)];
				const limit = LIMITS[Math.floor(next() * LIMITS.length)];
				const args = {
					path: "f.txt",
					...(offset === undefined ? {} : { offset }),
					...(limit === undefined ? {} : { limit }),
				};
				const actual = await outcome(() => tool.execute(args, apiFor(env), BACKGROUND_CONTEXT));
				const expected = await outcome(() => referenceRead(file, "f.txt", join(cwd, "f.txt"), offset, limit));
				expect(actual, `seed ${seed} offset ${offset} limit ${limit}`).toEqual(expected);
			}
		}
	}, 120_000);

	it("detects animated PNGs whose acTL chunk lies far beyond the header", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-durable-read-"));
		dirs.push(cwd);
		const chunk = (type: string, length: number): number[] => [
			(length >>> 24) & 0xff,
			(length >>> 16) & 0xff,
			(length >>> 8) & 0xff,
			length & 0xff,
			...new TextEncoder().encode(type),
			...new Array<number>(length + 4).fill(0),
		];
		const png = Uint8Array.from([
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			...chunk("IHDR", 13),
			...chunk("iCCP", 200_000),
			...chunk("acTL", 8),
			...chunk("IDAT", 10),
		]);
		writeFileSync(join(cwd, "a.png"), png);
		const env = new NodeExecutionEnv({ cwd });
		const actual = await outcome(() => createReadTool().execute({ path: "a.png" }, apiFor(env), BACKGROUND_CONTEXT));
		expect(actual).toEqual(
			await outcome(() => referenceRead(png, "a.png", join(cwd, "a.png"), undefined, undefined)),
		);
	});
});
