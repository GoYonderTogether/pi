/** Characters of a served anchor. */
export const HASH_LEN = 5;

const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

/** How many distinct anchors exist: one per 5-letter lowercase name. */
export const ANCHOR_COUNT = LOWERCASE.length ** HASH_LEN;

/** An anchor as it is written: 5 lowercase letters. */
export const HASH_RE = /^[a-z]{5}$/;

/** A reference an anchor may be written as before it is parsed: letters only, quoted or not. */
export const ALPH_RE = /^[A-Za-z]+$/;

/** An anchor inside a pattern. */
export const HASH_CLASS = "[a-z]{5}";

/** An anchor as it appears at the start of a served row, with an optional diff prefix. */
export const HASH_RUN = "[A-Za-z]{5,6}";

/**
 * The anchor of an index. Every index in `[0, ANCHOR_COUNT)` names a different 5-letter lowercase anchor, so a
 * file's line anchors never collide and the same content always gets the same anchor.
 */
export function anchorAt(index: number): string {
	let remaining = index;
	let anchor = "";
	for (let position = 0; position < HASH_LEN; position++) {
		anchor = LOWERCASE[remaining % LOWERCASE.length] + anchor;
		remaining = Math.floor(remaining / LOWERCASE.length);
	}
	return anchor;
}
