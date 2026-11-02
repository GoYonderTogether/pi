import { ALPH_RE, ANCHOR_COUNT, HASH_RE, anchorAt } from "./alphabet.ts";

/** The separator between an anchor and its row's content. */
export const HASH_SEP = "│";

/** Only this many bytes of a line decide its anchor, so long lines stay cheap and their anchors stay stable. */
export const MAX_HASH_SOURCE_BYTES = 500;

/** The most lines one file may have while still having an anchor per line. */
export const MAX_HASH_LINES = ANCHOR_COUNT;

/** How far the probe for a free anchor steps per try, coprime with `ANCHOR_COUNT` so it visits every anchor. */
const PROBE_STRIDE = 836286;

const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

function rotateLeft(value: number, bits: number): number {
	return (value << bits) | (value >>> (32 - bits));
}

function readUint32(bytes: Uint8Array, position: number): number {
	return bytes[position] | (bytes[position + 1] << 8) | (bytes[position + 2] << 16) | (bytes[position + 3] << 24);
}

function round(accumulator: number, input: number): number {
	const added = (accumulator + Math.imul(input, PRIME2)) | 0;
	return Math.imul(rotateLeft(added, 13), PRIME1);
}

/** xxHash32 of a string's UTF-8 bytes: one cheap, well spread 32-bit value per line. */
export function xxh32(input: string, seed = 0): number {
	const bytes = new TextEncoder().encode(input);
	const length = bytes.length;
	let hash: number;
	let position = 0;
	if (length >= 16) {
		let lane1 = (seed + PRIME1 + PRIME2) | 0;
		let lane2 = (seed + PRIME2) | 0;
		let lane3 = seed | 0;
		let lane4 = (seed - PRIME1) | 0;
		const limit = length - 16;
		while (position <= limit) {
			lane1 = round(lane1, readUint32(bytes, position));
			lane2 = round(lane2, readUint32(bytes, position + 4));
			lane3 = round(lane3, readUint32(bytes, position + 8));
			lane4 = round(lane4, readUint32(bytes, position + 12));
			position += 16;
		}
		hash = (rotateLeft(lane1, 1) + rotateLeft(lane2, 7) + rotateLeft(lane3, 12) + rotateLeft(lane4, 18)) | 0;
	} else {
		hash = (seed + PRIME5) | 0;
	}
	hash = (hash + length) | 0;
	while (position + 4 <= length) {
		hash = (hash + Math.imul(readUint32(bytes, position), PRIME3)) | 0;
		hash = Math.imul(rotateLeft(hash, 17), PRIME4);
		position += 4;
	}
	while (position < length) {
		hash = (hash + Math.imul(bytes[position], PRIME5)) | 0;
		hash = Math.imul(rotateLeft(hash, 11), PRIME1);
		position++;
	}
	hash ^= hash >>> 15;
	hash = Math.imul(hash, PRIME2);
	hash ^= hash >>> 13;
	hash = Math.imul(hash, PRIME3);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/** The line as an anchor sees it: no carriage return, no trailing whitespace. */
export function canon(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

/** `text` cut to at most `maxBytes` UTF-8 bytes on a code point boundary. */
export function truncateToBytes(text: string, maxBytes: number): string {
	let used = 0;
	let kept = "";
	const encoder = new TextEncoder();
	for (const character of text) {
		const size = encoder.encode(character).length;
		if (used + size > maxBytes) break;
		used += size;
		kept += character;
	}
	return kept;
}

/** What a line's anchor is derived from. */
export function hashSource(line: string): string {
	return truncateToBytes(canon(line), MAX_HASH_SOURCE_BYTES);
}

/** A line's identity: equal checksums mean the same line, so a served anchor still addresses it. */
export function lineChecksum(line: string): string {
	const source = hashSource(line);
	return xxh32(source).toString(16).padStart(8, "0") + xxh32(source, 0x9e3779b9).toString(16).padStart(8, "0");
}

/** A file's lines, the way `truncateHead` counts them: empty text has one empty line, a trailing newline none. */
export function splitLines(text: string): string[] {
	if (text.length === 0) return [""];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

/** One served row: the anchor, then the line's content. */
export function fmtRow(hash: string, line: string): string {
	return `${hash}${HASH_SEP}${line}`;
}

/** Served rows for a range of a file, one per line. */
export function fmtRegion(hashes: readonly string[], lines: readonly string[]): string {
	if (hashes.length !== lines.length) throw new Error("Anchors and lines must have the same length");
	return lines.map((line, index) => fmtRow(hashes[index], line)).join("\n");
}

/** One line of context for an error, with line breaks made visible and long lines cut. */
export function clipLine(line: string, maxLength = 200): string {
	const flat = line.replace(/\n/g, "\\n");
	return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength)}...`;
}

type FileAnchors = { readonly byLine: Map<string, string>; readonly used: Set<string> };

/** Anchors already handed out per file, so a line keeps its anchor for as long as it is unchanged. */
const anchorStore = new Map<string, FileAnchors>();

function storeFor(path: string): FileAnchors {
	let store = anchorStore.get(path);
	if (store === undefined) {
		store = { byLine: new Map(), used: new Set() };
		anchorStore.set(path, store);
	}
	return store;
}

/**
 * One anchor per line of `path`: a line whose content was seen before keeps its anchor, and a new line gets a free one.
 * A line's anchor therefore depends only on the file's lines and their content, never on how much was read.
 */
export function anchorsFor(path: string, lines: readonly string[]): string[] {
	if (lines.length > MAX_HASH_LINES) {
		throw new Error(
			`[E_FILE_TOO_LARGE] File exceeds the ${MAX_HASH_LINES}-line hashline limit; use write for very large files.`,
		);
	}
	const store = storeFor(path);
	const occurrences = new Map<string, number>();
	return lines.map((line) => {
		const checksum = lineChecksum(line);
		// Two lines with the same content are still two rows, so each occurrence gets its own anchor.
		const occurrence = occurrences.get(checksum) ?? 0;
		occurrences.set(checksum, occurrence + 1);
		const key = `${checksum}:${occurrence}`;
		const known = store.byLine.get(key);
		if (known !== undefined) return known;
		let index = (xxh32(hashSource(line)) >>> 14) % ANCHOR_COUNT;
		let candidate = anchorAt(index);
		for (let probe = 0; store.used.has(candidate); probe++) {
			if (probe >= ANCHOR_COUNT) {
				throw new Error(
					`[E_FILE_TOO_LARGE] File exceeds the ${MAX_HASH_LINES}-line hashline limit; use write for very large files.`,
				);
			}
			index = (index + PROBE_STRIDE) % ANCHOR_COUNT;
			candidate = anchorAt(index);
		}
		store.used.add(candidate);
		store.byLine.set(key, candidate);
		return candidate;
	});
}


/** One served row: where the line sat (1-indexed) and the checksum of what it held when it was served. */
export type ServedRow = { readonly line: number; readonly checksum: string };

const served = new Map<string, Map<string, ServedRow>>();
const owners = new Map<string, Set<string>>();

/**
 * Record that these rows of `path` were shown, so a later edit may address them: which file owns the anchor, where the
 * row sat, and the checksum of the line it addressed then.
 */
export function serveRows(
	path: string,
	hashes: readonly string[],
	lines: readonly string[],
	wanted: readonly string[],
): void {
	let rows = served.get(path);
	if (rows === undefined) {
		rows = new Map();
		served.set(path, rows);
	}
	const wantedSet = new Set(wanted);
	hashes.forEach((hash, index) => {
		const line = lines[index];
		if (!wantedSet.has(hash) || line === undefined) return;
		rows.set(hash, { line: index + 1, checksum: lineChecksum(line) });
		let owned = owners.get(hash);
		if (owned === undefined) {
			owned = new Set();
			owners.set(hash, owned);
		}
		owned.add(path);
	});
}

/** The rows served for `path`: anchor to the line it addressed and that line's checksum. */
export function servedFor(path: string): ReadonlyMap<string, ServedRow> {
	return served.get(path) ?? new Map<string, ServedRow>();
}

/** The files an anchor was served for. */
export function ownersOf(hash: string): readonly string[] {
	return [...(owners.get(hash) ?? [])];
}

/** Forget every served row and anchor; a fresh session starts empty. */
export function clearHashlineState(): void {
	anchorStore.clear();
	served.clear();
	owners.clear();
}

/** An anchor reference as the model wrote it: quotes, a row prefix, or a `N:│` prefix around it are stripped. */
export function parseAnchor(value: string): string | undefined {
	const trimmed = value
		.trim()
		.replace(/^[+-]/, "")
		.replace(/^\d+\s*[:│]\s*/, "")
		.replace(/[│|]+$/, "")
		.trim();
	const unquoted = trimmed.replace(/^["'`]|["'`]$/g, "");
	if (!ALPH_RE.test(unquoted)) return undefined;
	return unquoted.length === 5 ? unquoted.toLowerCase() : undefined;
}

/** An anchor that is not `5` letters cannot address a row; the message says what to send instead. */
export function badAnchorMessage(value: unknown, field: string): string {
	return `[E_BAD_REF] ${field} must be one 5-letter anchor as it appears before the "│" of a served row, but got ${JSON.stringify(value)}. Call read() for the current rows and copy only the anchor, or the anchor plus its row.`;
}

/** Why an anchor addresses no line here, and what to do about it. */
export function staleAnchorMessage(hash: string, next = "Call read() on the target file for fresh anchors."): string {
	return `[E_STALE_ANCHOR] "${hash}" is stale: its line was edited or the anchor was never served in this session, so it addresses no line here. ${next}`;
}

/** A stale-anchor error whose text carries the current rows, served again so the retry needs no read. */
export function staleAnchorReport(
	path: string,
	hashes: readonly string[],
	lines: readonly string[],
	stale: readonly string[],
	next = "Call read() on the target file for fresh anchors.",
): string {
	const unique = [...new Set(stale)];
	const quoted = unique.map((hash) => `"${hash}"`).join(", ");
	const rows: string[] = [];
	const shown: string[] = [];
	for (const hash of unique) {
		// The recorded line is where the row sat when it was served; its content may have moved since, so the rows are
		// read from the file as it is now and served again with their current anchors.
		const recorded = servedFor(path).get(hash)?.line;
		const focus = recorded === undefined ? 0 : recorded - 1;
		for (const near of [focus - 1, focus, focus + 1]) {
			const line = lines[near];
			const anchor = hashes[near];
			if (line === undefined || anchor === undefined || shown.includes(anchor)) continue;
			shown.push(anchor);
			rows.push(`    ${near + 1}: ${fmtRow(anchor, clipLine(line))}`);
		}
	}
	serveRows(path, hashes, lines, shown);
	const current = rows.length === 0 ? "" : `\n\nCurrent rows:\n${rows.join("\n")}`;
	return `[E_STALE_ANCHOR] ${unique.length} stale anchor(s) in ${path}: ${quoted}. The file changed since read. ${next}${current}`;
}

/** Whether `hash` is a well formed anchor at all. */
export function isAnchor(value: string): boolean {
	return HASH_RE.test(value);
}
