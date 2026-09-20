/**
 * Building source maps for the tests, i.e. the opposite of `lib/sourcemap.ts`.
 * Not part of the published package, see `tsconfig.build.json`.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encodes numbers as one Base64 VLQ segment. */
export function encodeVlq(values: number[]): string {
	let segment = '';
	for (const value of values) {
		let rest = value < 0 ? (-value << 1) | 1 : value << 1;
		do {
			let digit = rest & 31;
			rest >>>= 5;
			if (rest > 0) digit |= 32;
			segment += BASE64_CHARS[digit];
		} while (rest > 0);
	}
	return segment;
}

/**
 * Builds the `mappings` string of a source map from absolute positions: one
 * array per generated line, holding `[column, source]` pairs, where a `source`
 * of `null` marks generated code without one.
 */
export function encodeMappings(lines: [column: number, source: number | null][][]): string {
	let previousColumn = 0;
	let previousSource = 0;
	return lines
		.map((segments) => {
			previousColumn = 0;
			return segments
				.map(([column, source]) => {
					const fields = [column - previousColumn];
					previousColumn = column;
					if (source !== null) {
						fields.push(source - previousSource, 0, 0);
						previousSource = source;
					}
					return encodeVlq(fields);
				})
				.join(',');
		})
		.join(';');
}
