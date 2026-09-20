/**
 * Reading a source map to attribute every byte of a bundle to the source file
 * it came from. Needs nothing but the bundle and the map the build already
 * emits — no bundler plugin, no extra dependency.
 */

/** The fields of a source map that are needed to attribute bytes. */
export interface SourceMap {
	mappings: string;
	sources: (string | null)[];
	sourceRoot?: string;
	file?: string;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_DIGITS = new Map([...BASE64_CHARS].map((char, index) => [char, index]));

/**
 * Decodes one Base64 VLQ segment of a source map into its signed numbers.
 *
 * @throws {Error} If the segment contains a character outside the Base64 alphabet
 */
export function decodeVlq(segment: string): number[] {
	const values: number[] = [];
	let shift = 0;
	let value = 0;
	for (const char of segment) {
		const digit = BASE64_DIGITS.get(char);
		if (digit === undefined) throw new Error(`bad VLQ character ${JSON.stringify(char)}`);
		value += (digit & 31) << shift;
		if (digit & 32) {
			// continuation bit: the number goes on in the next character
			shift += 5;
			continue;
		}
		// the lowest bit is the sign
		values.push(value & 1 ? -(value >> 1) : value >> 1);
		shift = 0;
		value = 0;
	}
	return values;
}

/**
 * Attributes the bytes of the generated code to the sources of the map.
 *
 * Every mapping segment owns the generated code from its column up to the next
 * segment, or to the end of the line. Code that no segment covers - line breaks,
 * and whatever the bundler added on its own - is not attributed to any source,
 * so the sum is usually a bit smaller than the size of the bundle.
 *
 * @param code - The generated code, i.e. the content of the bundle
 * @param map - Its source map
 * @returns The number of bytes per source, keyed by the source name as the map spells it
 */
export function bytesPerSource(code: string, map: SourceMap): Map<string, number> {
	const lines = code.split('\n');
	const bytes = new Map<string, number>();
	// the source index is relative to the previous segment, across all lines
	let source = 0;

	map.mappings.split(';').forEach((lineMappings, lineNumber) => {
		if (!lineMappings) return;
		const line = lines[lineNumber] ?? '';
		let column = 0;
		const segments: { column: number; source: number | null }[] = [];
		for (const segment of lineMappings.split(',')) {
			if (!segment) continue;
			const fields = decodeVlq(segment);
			column += fields[0];
			if (fields.length > 1) source += fields[1];
			// a segment of one field only marks generated code without a source
			segments.push({ column, source: fields.length > 1 ? source : null });
		}

		segments.sort((a, b) => a.column - b.column);
		segments.forEach((segment, index) => {
			if (segment.source === null) return;
			const end = index + 1 < segments.length ? segments[index + 1].column : line.length;
			const name = map.sources[segment.source] ?? '?';
			const size = Buffer.byteLength(line.slice(segment.column, end));
			bytes.set(name, (bytes.get(name) ?? 0) + size);
		});
	});

	return bytes;
}

/**
 * Turns the source names of a map into plain relative paths: applies the
 * `sourceRoot`, drops the scheme of URLs like `webpack:///src/index.ts` and the
 * NUL prefix of virtual modules, and resolves `.` and `..` segments.
 */
export function normalizeSource(source: string, sourceRoot?: string): string {
	let name = source.replace(/^\0+/, '');
	if (sourceRoot) name = sourceRoot.replace(/\/*$/, '/') + name;
	name = name.replace(/^[a-z][a-z\d+.-]*:\/{0,3}/i, '');

	const segments: string[] = [];
	for (const segment of name.split('/')) {
		if (segment === '' || segment === '.') continue;
		// a ".." that leads out of the path is simply dropped, there is nothing above
		if (segment === '..') segments.pop();
		else segments.push(segment);
	}
	return segments.join('/');
}

/**
 * The longest directory prefix that all paths share, e.g. `src/` for
 * `src/index.ts` and `src/lib/log.ts`. Empty if they share none, or if there is
 * only one path - stripping the whole directory of a single file would leave it
 * without any context.
 */
export function commonDirectoryPrefix(paths: string[]): string {
	if (paths.length < 2) return '';
	const segments = paths.map((path) => path.split('/').slice(0, -1));
	const shortest = Math.min(...segments.map((parts) => parts.length));
	const prefix: string[] = [];
	for (let index = 0; index < shortest; index++) {
		const segment = segments[0][index];
		if (!segments.every((parts) => parts[index] === segment)) break;
		prefix.push(segment);
	}
	return prefix.length > 0 ? prefix.join('/') + '/' : '';
}
