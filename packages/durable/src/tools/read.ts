import type { Context } from "@earendil-works/chord";
import { characterEnd } from "@earendil-works/chord/output";
import { type Static, Type } from "typebox";
import { type BinaryReader, type FileInfo, getOrThrow } from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolDiagnostic, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHeadOf,
	utf8ByteLength,
} from "../truncate.ts";
import { normalizeToLF, stripBom } from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import {
	HASH_SEP,
	anchorsFor,
	badAnchorMessage,
	fmtRegion,
	fmtRow,
	lineChecksum,
	ownersOf,
	parseAnchor,
	serveRows,
	servedFor,
	splitLines,
	staleAnchorMessage,
	staleAnchorReport,
} from "./hashline/anchors.ts";
import { detectSupportedImageMimeTypeOf, imageDimensions } from "./image.ts";
import {
	base64Length,
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	INLINE_IMAGE_TYPES,
	toBase64,
} from "./image-processor.ts";
import { resolveReadToolPath } from "./path-utils.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Union([Type.Integer({ minimum: 1 }), Type.String()], {
			description: "Line number (1-indexed) or a served anchor to start reading from",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum number of lines to read from offset; counted from the anchor row when `offset` is an anchor",
		}),
	),
	anchors: Type.Optional(
		Type.Boolean({ description: "Return the rows as structured data as well: the text, and one entry per row." }),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export type ReadToolDetails = {
	/** How the shown text was cut; the text itself is the result content. */
	truncation?: Omit<TruncationResult, "content">;
};


export type ReadToolOptions = {
	/** Resizes and converts images; without one, images within `DEFAULT_IMAGE_LIMITS.maxBytes` pass through as they are. */
	readonly images?: ImageProcessor;
};

/**
 * Reads text files and images. Remarks about truncation, continuation, and image processing are diagnostics; the content
 * is only file text, or one image, which programs get as its `ImageContent`.
 */
export function createReadTool(options: ReadToolOptions = {}): ToolRegistration<typeof readSchema, ReadToolDetails> {
	const formats = options.images === undefined ? "jpg, png, gif, webp" : "jpg, png, gif, webp, bmp";
	return defineTool({
		name: "read",
		description: `Read the contents of a file. Supports text files and images (${formats}). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(args, api, context) {
			const { path, offset, limit } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveReadToolPath(env, path, context);
			const reader = getOrThrow(await env.openBinaryReader(absolutePath, undefined, context));
			try {
				// A concurrent writer can change the file between the scan and the reads. Appending (a growing log) leaves
				// the scanned text as it was; an image must be whole. Otherwise the file is read again once.
				for (let attempt = 0; ; attempt++) {
					const before = getOrThrow(await reader.info(context));
					const mimeType = await detectSupportedImageMimeTypeOf({
						size: before.size,
						read: async (position, length) => getOrThrow(await reader.read(position, length, context)),
					});
					const result =
						mimeType === undefined
							? await readText(reader, before, absolutePath, path, offset, limit, args.anchors === true, context)
							: await readImage(
									reader,
									before,
									path,
									mimeType,
									options.images,
									await imageModel(api, context),
									context,
								);
					const after = getOrThrow(await reader.info(context));
					const unchanged = after.size === before.size && after.mtimeMs === before.mtimeMs;
					if (unchanged || (mimeType === undefined && after.size > before.size)) return result;
					if (attempt === 1) throw new Error(`${path} changed while it was read`);
				}
			} finally {
				await reader.close(context);
			}
		},
	});
}

/**
 * One image block, prepared by `processor` or, without one, as it is when its format is inline and it fits the limits
 * (its size is checked before reading it, its dimensions from its header); otherwise an error result saying why. What happened to the image is an `info` diagnostic, so programs get the
 * bare `ImageContent`. A model without image input sees pi-ai's placeholder instead; a diagnostic says so.
 */
async function readImage(
	reader: BinaryReader,
	info: FileInfo,
	path: string,
	mimeType: string,
	processor: ImageProcessor | undefined,
	{ vision, limits }: ImageModel,
	context: Context,
): Promise<ToolExecutionResult<ReadToolDetails>> {
	let image: { readonly data: string; readonly mimeType: string };
	const notes: string[] = [];
	if (processor !== undefined) {
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const prepared = await processor.prepare(bytes, mimeType, limits);
		if (prepared === undefined)
			return imageError(`${path} is an image (${mimeType}) that cannot be prepared for the model`);
		image = prepared;
		if (prepared.convertedFrom !== undefined)
			notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
		if (prepared.resized !== undefined) {
			const { from, to } = prepared.resized;
			const scale = (from.width / to.width).toFixed(2);
			notes.push(
				`Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${scale} to map them to the original.`,
			);
		}
	} else {
		if (!INLINE_IMAGE_TYPES.has(mimeType)) {
			return imageError(
				`${path} is an image (${mimeType}) that needs converting, and no image processor is configured`,
			);
		}
		const unshrinkable = "and no image processor is configured to shrink it";
		if (base64Length(info.size) > limits.maxBytes) {
			return imageError(
				`${path} is an image (${mimeType}) of ${formatSize(info.size)}, too large to send, ${unshrinkable}`,
			);
		}
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const size = imageDimensions(bytes, mimeType);
		if (size === undefined) return imageError(`${path} is an image (${mimeType}) whose size cannot be read`);
		if (size.width > limits.maxWidth || size.height > limits.maxHeight) {
			return imageError(
				`${path} is an image (${mimeType}) of ${size.width}x${size.height}, larger than ${limits.maxWidth}x${limits.maxHeight}, ${unshrinkable}`,
			);
		}
		image = { data: toBase64(bytes), mimeType };
	}
	if (!vision) notes.push("The current model does not support images; it sees a placeholder instead.");
	const diagnostics: ToolDiagnostic[] = [
		{ severity: "info", code: "image", message: [`Read image file [${image.mimeType}].`, ...notes].join(" ") },
	];
	return { output: [{ type: "image", data: image.data, mimeType: image.mimeType }], diagnostics };
}

/** What the conversation's model takes: whether images, and within which limits. */
type ImageModel = { readonly vision: boolean; readonly limits: ImageLimits };

/**
 * The conversation model's image input: `DEFAULT_IMAGE_LIMITS` overridden by its `inputLimits.images.resize`. Without
 * a resolvable model, it counts as one that takes images within the defaults.
 */
async function imageModel(api: ToolExecutionApi, context: Context): Promise<ImageModel> {
	const ref = (await api.agent(context)).model;
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	const resize = model?.inputLimits?.images?.resize;
	return {
		vision: model?.input.includes("image") ?? true,
		limits: {
			maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
			maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
			maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
		},
	};
}

function imageError(message: string): ToolExecutionResult<ReadToolDetails> {
	return { output: [], isError: true, diagnostics: [{ severity: "error", code: "unsupported_image", message }] };
}

/**
 * The read result for the opened file. It equals decoding the whole file with `TextDecoder`, splitting it on `\n`,
 * and bounding the selected lines with `truncateHead`, while reading only one scan's worth of the file plus the head.
 */
/** The 1-indexed line an `offset` names: a line number, or an anchor a read of this file served. */
function resolveOffset(
	offset: number | string | undefined,
	lines: readonly string[],
	hashes: readonly string[],
	absolutePath: string,
): number {
	if (offset === undefined) return 1;
	if (typeof offset === "number") return offset;
	const trimmed = offset.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const anchor = parseAnchor(trimmed);
	if (anchor === undefined) throw new Error(badAnchorMessage(offset, "offset"));
	const owned = ownersOf(anchor);
	if (!owned.includes(absolutePath)) {
		throw new Error(
			staleAnchorMessage(
				anchor,
				owned.length === 0
					? "Use a line number, or read again for fresh anchors."
					: `It belongs to ${owned.join(", ")}. Use a line number, or read that file to use it.`,
			),
		);
	}
	const index = hashes.indexOf(anchor);
	const line = index === -1 ? undefined : lines[index];
	if (line === undefined || servedFor(absolutePath).get(anchor)?.checksum !== lineChecksum(line)) {
		throw new Error(
			staleAnchorReport(absolutePath, hashes, lines, [anchor], "Use a line number, or read again for fresh anchors."),
		);
	}
	return index + 1;
}

/** The whole file decoded as UTF-8, and whether some byte was not valid UTF-8 (those bytes show as U+FFFD). */
async function readWholeText(
	reader: BinaryReader,
	info: FileInfo,
	context: Context,
): Promise<{ text: string; hadUtf8DecodeErrors: boolean }> {
	const bytes = getOrThrow(await reader.read(0, info.size, context));
	let hadUtf8DecodeErrors = false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		hadUtf8DecodeErrors = true;
	}
	return { text: new TextDecoder().decode(bytes), hadUtf8DecodeErrors };
}

/** The rows of a served text as data: the anchor of each row and its content. */
function rowEntries(text: string): Array<{ anchor: string; text: string }> {
	return text.split("\n").flatMap((row) => {
		const separator = row.indexOf(HASH_SEP);
		return separator === -1 ? [] : [{ anchor: row.slice(0, separator), text: row.slice(separator + 1) }];
	});
}

/**
 * The read result for a file's text: one served row per line, `anchor│content`, bounded by the shared byte and line
 * limits. `offset` is a line number or an anchor a previous read served, and only complete rows are served again.
 */
async function readText(
	reader: BinaryReader,
	info: FileInfo,
	absolutePath: string,
	path: string,
	offset: number | string | undefined,
	limit: number | undefined,
	structured: boolean,
	context: Context,
): Promise<ToolExecutionResult<ReadToolDetails>> {
	const { text, hadUtf8DecodeErrors } = await readWholeText(reader, info, context);
	const normalized = normalizeToLF(stripBom(text).text);
	const lines = splitLines(normalized);
	const hashes = anchorsFor(absolutePath, lines);
	const startLine = resolveOffset(offset, lines, hashes, absolutePath);
	const totalLines = lines.length;
	if (startLine > totalLines) throw new Error(`Offset ${startLine} is beyond end of file (${totalLines} lines total)`);
	const startIndex = startLine - 1;
	const endIndex = limit === undefined ? totalLines : Math.min(startIndex + limit, totalLines);
	const selected = lines.slice(startIndex, endIndex);
	const selectedHashes = hashes.slice(startIndex, endIndex);
	const diagnostics: ToolDiagnostic[] = [];
	if (hadUtf8DecodeErrors) {
		diagnostics.push({
			severity: "warn",
			code: "encoding",
			message: "[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]",
		});
	}
	const structuredOf = (servedText: string) =>
		structured ? { structuredOutput: { text: servedText, lines: rowEntries(servedText) } } : {};
	if (normalized.length === 0) {
		serveRows(absolutePath, hashes, lines, selectedHashes);
		const servedText = `${fmtRow(hashes[0], "")}\n[File is empty. Use replace to insert content.]`;
		return { output: [{ type: "text", text: servedText }], diagnostics, ...structuredOf(servedText) };
	}
	const rows = fmtRegion(selectedHashes, selected);
	const { content: headText, ...truncation } = truncateHeadOf(rows, {
		lines: selected.length,
		bytes: utf8ByteLength(rows),
	});
	let outputText = headText;
	let servedRows = headText === "" ? 0 : headText.split("\n").length;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		// Show the start of the row, cut at the byte limit on a character boundary, and serve none of it.
		const rowBytes = new TextEncoder().encode(rows.split("\n")[0] ?? "");
		const end = characterEnd(rowBytes, DEFAULT_MAX_BYTES);
		outputText = new TextDecoder().decode(rowBytes.subarray(0, end));
		servedRows = 0;
		diagnostics.push({
			severity: "warn",
			code: "truncated",
			message: `Line ${startLine} is ${formatSize(utf8ByteLength(selected[0]))}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${startLine}p' ${path} | tail -c +${end + 1}`,
		});
		details = { truncation: { ...truncation, outputBytes: end, outputLines: 1 } };
	} else if (truncation.truncated) {
		const endLine = startLine + truncation.outputLines - 1;
		const limitText = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		diagnostics.push({
			severity: "info",
			code: "truncated",
			message: `Showing lines ${startLine}-${endLine} of ${totalLines}${limitText}. Use offset=${endLine + 1} to continue.`,
		});
		details = { truncation };
	} else if (limit !== undefined && endIndex < totalLines) {
		diagnostics.push({
			severity: "info",
			message: `${totalLines - endIndex} more lines in file. Use offset=${endIndex + 1} to continue.`,
		});
	}
	serveRows(absolutePath, hashes, lines, selectedHashes.slice(0, servedRows));
	return {
		output: outputText === "" ? [] : [{ type: "text" as const, text: outputText }],
		...(details === undefined ? {} : { details }),
		diagnostics,
		...structuredOf(outputText),
	};
}
