import type { Context } from "@earendil-works/chord";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../edit-diff.ts";
import { type ExecutionEnv, getOrThrow } from "../../env/index.ts";
import { resolveToolPath } from "../path-utils.ts";
import {
	anchorsFor,
	badAnchorMessage,
	lineChecksum,
	ownersOf,
	parseAnchor,
	serveRows,
	servedFor,
	splitLines,
	staleAnchorMessage,
	staleAnchorReport,
} from "./anchors.ts";

/** A file as an anchor edit sees it: its lines, their anchors, and what its text needs on the way back. */
export type EditableFile = {
	readonly absolutePath: string;
	readonly lines: readonly string[];
	readonly hashes: readonly string[];
	readonly bom: string;
	readonly ending: "\r\n" | "\n";
	readonly endsWithNewline: boolean;
};

function editAccessError(path: string, code: string): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${code}.`);
}

/** Read `absolutePath` and give every one of its lines an anchor. */
export async function readEditableFile(
	env: ExecutionEnv,
	absolutePath: string,
	context: Context,
): Promise<EditableFile> {
	const read = await env.readTextFile(absolutePath, context);
	if (!read.ok) throw editAccessError(absolutePath, read.error.code);
	const { bom, text } = stripBom(read.value);
	const ending = detectLineEnding(text);
	const normalized = normalizeToLF(text);
	const lines = splitLines(normalized);
	return {
		absolutePath,
		lines,
		hashes: anchorsFor(absolutePath, lines),
		bom,
		ending,
		endsWithNewline: normalized.endsWith("\n"),
	};
}

/** The anchor a request names, or an error saying how an anchor is written. */
export function requireAnchor(value: unknown, field: string): string {
	const anchor = typeof value === "string" ? parseAnchor(value) : undefined;
	if (anchor === undefined) throw new Error(badAnchorMessage(value, field));
	return anchor;
}

/**
 * The file to edit: the one the request names, or the only file the anchors were served for. Anchors of different
 * files in one call are refused, so a call never edits two files.
 */
export async function resolveEditPath(
	env: ExecutionEnv,
	path: unknown,
	anchors: readonly string[],
	context: Context,
): Promise<string> {
	if (typeof path === "string" && path.length > 0) return resolveToolPath(env, path, context);
	const owned = new Set<string>();
	for (const anchor of anchors) for (const owner of ownersOf(anchor)) owned.add(owner);
	if (owned.size === 0) throw new Error(staleAnchorMessage(anchors[0]));
	if (owned.size > 1) {
		throw new Error(
			`[E_BAD_SHAPE] The anchors are owned by different files (${[...owned].join(", ")}); edit one file per call.`,
		);
	}
	return [...owned][0];
}

/**
 * The lines the two anchors address, both of which must have been served and still hold what was served. A stale
 * anchor fails with the current rows, served again, so the retry needs no read.
 */
export function resolveRange(file: EditableFile, from: string, to: string): { start: number; end: number } {
	const rows = servedFor(file.absolutePath);
	const stale: string[] = [];
	const lines = [from, to].map((anchor) => {
		const index = file.hashes.indexOf(anchor);
		const line = index === -1 ? undefined : file.lines[index];
		if (line === undefined || rows.get(anchor)?.checksum !== lineChecksum(line)) {
			stale.push(anchor);
			return -1;
		}
		return index;
	});
	if (stale.length > 0) {
		throw new Error(staleAnchorReport(file.absolutePath, file.hashes, file.lines, stale));
	}
	return { start: Math.min(lines[0], lines[1]), end: Math.max(lines[0], lines[1]) };
}

/** Every line of the range must still be what was served; a pure deletion only needs the two rows it names. */
export function assertRangeServed(file: EditableFile, start: number, end: number, pureDeletion: boolean): void {
	const rows = servedFor(file.absolutePath);
	const stale = file.hashes
		.slice(start, end + 1)
		.filter((anchor, offset) => {
			const index = start + offset;
			if (pureDeletion && index !== start && index !== end) return false;
			return rows.get(anchor)?.checksum !== lineChecksum(file.lines[index]);
		});
	if (stale.length === 0) return;
	serveRows(file.absolutePath, file.hashes, file.lines, file.hashes);
	throw new Error(
		`[E_RANGE_STALE] ${stale.length} line(s) of the replaced range (lines ${start + 1}-${end + 1}) in ${file.absolutePath} were never shown or changed on disk. Read the file again, then retry with its fresh anchors.`,
	);
}

/**
 * The lines a `text` payload writes: `""` deletes the range, a trailing line break sets the newline of the last line
 * written instead of adding a blank line, and a lone newline writes one blank line.
 */
export function replacementLines(text: string): string[] {
	if (text.length === 0) return [];
	return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** The file's lines with `[start, end]` replaced, and its whole text keeping BOM, line endings, and final newline. */
export function applyRange(
	file: EditableFile,
	start: number,
	end: number,
	replacement: readonly string[],
): { lines: string[]; content: string } {
	const lines = [...file.lines.slice(0, start), ...replacement, ...file.lines.slice(end + 1)];
	if (lines.length === 0) return { lines, content: file.bom };
	const text = lines.join("\n");
	return {
		lines,
		content: file.bom + restoreLineEndings(file.endsWithNewline ? `${text}\n` : text, file.ending),
	};
}

/** A text file cannot hold a NUL byte; writing one would break every later read and edit. */
export function assertWritableText(text: string): void {
	if (!text.includes(String.fromCharCode(0))) return;
	throw new Error(
		'[E_BAD_SHAPE] Content contains a NUL byte (U+0000); a text file cannot contain NUL, and writing it would break further reads and edits. Remove the NUL byte and retry.',
	);
}

/** Write the edited text back, under the file's mutation queue. */
export async function writeEditableFile(
	env: ExecutionEnv,
	absolutePath: string,
	content: string,
	context: Context,
): Promise<void> {
	getOrThrow(await env.writeFile(absolutePath, content, context));
}
