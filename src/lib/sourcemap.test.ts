import { describe, expect, it } from 'vitest';
import { bytesPerSource, commonDirectoryPrefix, decodeVlq, normalizeSource } from './sourcemap.js';
import { encodeMappings } from '../test/sourcemap-fixture.js';

describe('decodeVlq', () => {
	it.each([
		['A', [0]],
		['C', [1]],
		['D', [-1]],
		['AAAA', [0, 0, 0, 0]],
		['gB', [16]],
		['ghB', [528]],
		['IAAM', [4, 0, 0, 6]],
	])('decodes %s', (segment, expected) => {
		expect(decodeVlq(segment)).toStrictEqual(expected);
	});

	it('rejects characters outside the alphabet', () => {
		expect(() => decodeVlq('A#')).toThrow('bad VLQ character "#"');
	});
});

describe('bytesPerSource', () => {
	it('gives every source the code from its segment to the next one', () => {
		const code = ['aaaabbbb', 'cccccc'].join('\n');
		const mappings = encodeMappings([
			[
				[0, 0],
				[4, 1],
			],
			[[0, 1]],
		]);

		expect(bytesPerSource(code, { mappings, sources: ['a.ts', 'b.ts'] })).toStrictEqual(
			new Map([
				['a.ts', 4],
				['b.ts', 10],
			]),
		);
	});

	it('counts the bytes, not the characters', () => {
		const mappings = encodeMappings([[[0, 0]]]);

		expect(bytesPerSource('äöü', { mappings, sources: ['a.ts'] })).toStrictEqual(new Map([['a.ts', 6]]));
	});

	it('ignores segments without a source, and lines without mappings', () => {
		const code = ['aaaa', 'unmapped', 'bbbb'].join('\n');
		const mappings = encodeMappings([
			[[0, 0]],
			[],
			[
				[0, null],
				[2, 0],
			],
		]);

		expect(bytesPerSource(code, { mappings, sources: ['a.ts'] })).toStrictEqual(new Map([['a.ts', 6]]));
	});

	it('handles segments that are not in column order', () => {
		const mappings = encodeMappings([
			[
				[6, 1],
				[0, 0],
			],
		]);

		expect(bytesPerSource('aaaaaabb', { mappings, sources: ['a.ts', 'b.ts'] })).toStrictEqual(
			new Map([
				['a.ts', 6],
				['b.ts', 2],
			]),
		);
	});

	it('falls back to "?" for a source the map does not name', () => {
		const mappings = encodeMappings([[[0, 3]]]);

		expect(bytesPerSource('abc', { mappings, sources: ['a.ts'] })).toStrictEqual(new Map([['?', 3]]));
	});

	it('returns nothing for an empty map', () => {
		expect(bytesPerSource('abc', { mappings: '', sources: [] }).size).toBe(0);
	});
});

describe('normalizeSource', () => {
	it.each([
		['src/index.ts', undefined, 'src/index.ts'],
		['../../src/index.ts', undefined, 'src/index.ts'],
		['./src/index.ts', undefined, 'src/index.ts'],
		['webpack:///src/index.ts', undefined, 'src/index.ts'],
		['file:///src/index.ts', undefined, 'src/index.ts'],
		['\0commonjsHelpers.js', undefined, 'commonjsHelpers.js'],
		['index.ts', 'src', 'src/index.ts'],
		['index.ts', 'src/', 'src/index.ts'],
		['a/../index.ts', undefined, 'index.ts'],
		['dist/../index.ts', 'webpack:///src/', 'src/index.ts'],
	])('normalizes %s', (source, sourceRoot, expected) => {
		expect(normalizeSource(source, sourceRoot)).toBe(expected);
	});
});

describe('commonDirectoryPrefix', () => {
	it.each([
		[['src/index.ts', 'src/lib/log.ts'], 'src/'],
		[['src/lib/a.ts', 'src/lib/b.ts'], 'src/lib/'],
		[['src/index.ts', 'node_modules/x/y.js'], ''],
		[['src/index.ts'], ''],
		[[], ''],
		[['a.ts', 'b.ts'], ''],
		[['src/a/x.ts', 'src/ab/y.ts'], 'src/'],
	])('of %s', (paths, expected) => {
		expect(commonDirectoryPrefix(paths)).toBe(expected);
	});
});
