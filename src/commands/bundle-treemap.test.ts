import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { encodeMappings } from '../test/sourcemap-fixture.js';

vi.mock('../lib/log.js', () => ({
	panic: vi.fn((message: string) => {
		throw new Error(message);
	}),
	warn: vi.fn(),
	debug: vi.fn(),
	isVerbose: vi.fn(() => false),
}));

const { generateBundleTreemap, groupFiles, locateBundle, measureBundle, readSourceMap } =
	await import('./bundle-treemap.js');

/** Sources of the fake bundle, one line each, sized by the length of the line. */
const SOURCES = [
	'src/index.ts',
	'src/color/color.ts',
	'src/color/parser.ts',
	'src/style/a.ts',
	'src/style/b.ts',
	'src/tiny.ts',
];

/**
 * Writes a bundle whose source map attributes line `i` to `SOURCES[i]`, with
 * line lengths of 4000, 3000, 2000, 1000, 500 and 5 bytes.
 */
function writeBundle(directory: string, options: { comment?: string; mapName?: string } = {}): string {
	const sizes = [4000, 3000, 2000, 1000, 500, 5];
	const lines = sizes.map((size) => 'x'.repeat(size));
	const code = lines.join('\n') + (options.comment ?? '');
	const map = {
		version: 3,
		file: 'bundle.js',
		sources: SOURCES,
		mappings: encodeMappings(sizes.map((_, index) => [[0, index]])),
	};
	const mapPath = join(directory, options.mapName ?? 'dist/bundle.js.map');
	mkdirSync(dirname(mapPath), { recursive: true });
	mkdirSync(join(directory, 'dist'), { recursive: true });
	writeFileSync(join(directory, 'dist/bundle.js'), code);
	writeFileSync(mapPath, JSON.stringify(map));
	return code;
}

describe('measureBundle', () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-bundle-'));
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it('groups the sources by directory and sizes them by their bytes in the bundle', () => {
		writeBundle(directory);

		expect(measureBundle(directory, 'dist/bundle.js', { minSize: 1 })).toStrictEqual({
			title: 'Bundle composition',
			caption: expect.stringContaining('**10.3 KB** raw') as string,
			unit: 'bytes',
			children: [
				{
					name: 'color',
					children: [
						{ name: 'color.ts', size: 3000 },
						{ name: 'parser.ts', size: 2000 },
					],
				},
				{ name: 'index.ts', size: 4000 },
				{
					name: 'style',
					children: [
						{ name: 'a.ts', size: 1000 },
						{ name: 'b.ts', size: 500 },
					],
				},
				{ name: 'tiny.ts', size: 5 },
				// the five line breaks no mapping covers
				{ name: '(unmapped)', size: 5 },
			],
		});
	});

	it('reports the raw and the gzipped size of the whole bundle', () => {
		const code = writeBundle(directory);
		const { caption } = measureBundle(directory, 'dist/bundle.js');

		expect(code.length).toBe(10510);
		expect(caption).toMatch(
			/^Sized by the bundle's own source map: \*\*10\.3 KB\*\* raw, \*\*[\d.]+ KB\*\* gzipped, across 6 modules\.$/,
		);
	});

	it('keeps every source above the default minimum size of 0.5 %', () => {
		writeBundle(directory);
		const { children } = measureBundle(directory, 'dist/bundle.js');

		// 0.5 % of 10510 bytes is 53, so only tiny.ts is small - and a lone small node is not folded
		expect(children.map((child) => child.name)).toStrictEqual([
			'color',
			'index.ts',
			'style',
			'tiny.ts',
			'(unmapped)',
		]);
	});

	it('takes the title, the depth and the minimum size from the options', () => {
		writeBundle(directory);
		const data = measureBundle(directory, 'dist/bundle.js', { title: 'Browser bundle', depth: 0, minSize: 600 });

		expect(data.title).toBe('Browser bundle');
		expect(data.children).toStrictEqual([
			{ name: 'index.ts', size: 4000 },
			{ name: 'color/color.ts', size: 3000 },
			{ name: 'color/parser.ts', size: 2000 },
			{ name: 'style/a.ts', size: 1000 },
			{ name: 'other (2 files)', size: 505 },
			{ name: '(unmapped)', size: 5 },
		]);
	});

	it('accepts the source map instead of the bundle', () => {
		writeBundle(directory);

		expect(measureBundle(directory, 'dist/bundle.js.map')).toStrictEqual(measureBundle(directory, 'dist/bundle.js'));
	});

	it('fails if the map covers none of the code', () => {
		writeBundle(directory);
		writeFileSync(join(directory, 'dist/bundle.js.map'), '{"version":3,"sources":[],"mappings":""}');

		expect(() => measureBundle(directory, 'dist/bundle.js')).toThrow('maps no code');
	});
});

describe('locateBundle', () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-bundle-'));
		writeBundle(directory);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it('finds the map next to the bundle', () => {
		expect(locateBundle(directory, 'dist/bundle.js')).toStrictEqual({
			codePath: join(directory, 'dist/bundle.js'),
			mapPath: join(directory, 'dist/bundle.js.map'),
		});
	});

	it('follows the sourceMappingURL comment of the bundle', () => {
		writeBundle(directory, { comment: '\n//# sourceMappingURL=maps/bundle.map\n', mapName: 'dist/maps/bundle.map' });

		expect(locateBundle(directory, 'dist/bundle.js').mapPath).toBe(join(directory, 'dist/maps/bundle.map'));
	});

	it('takes a source map that is inlined in the bundle', () => {
		const map = readFileSync(join(directory, 'dist/bundle.js.map'), 'utf8');
		const url = `data:application/json;base64,${Buffer.from(map).toString('base64')}`;
		writeBundle(directory, { comment: `\n//# sourceMappingURL=${url}\n` });
		rmSync(join(directory, 'dist/bundle.js.map'));

		expect(locateBundle(directory, 'dist/bundle.js').mapPath).toBe(url);
		expect(readSourceMap(url).sources).toStrictEqual(SOURCES);
	});

	it('prefers the map given as option', () => {
		writeFileSync(join(directory, 'dist/other.map'), '{}');

		expect(locateBundle(directory, 'dist/bundle.js', 'dist/other.map').mapPath).toBe(
			join(directory, 'dist/other.map'),
		);
	});

	it('derives the bundle from the path of the map', () => {
		expect(locateBundle(directory, 'dist/bundle.js.map')).toStrictEqual({
			codePath: join(directory, 'dist/bundle.js'),
			mapPath: join(directory, 'dist/bundle.js.map'),
		});
	});

	it.each([
		['dist/missing.js', undefined, 'does not exist'],
		['dist/bundle.js', 'dist/missing.map', 'does not exist'],
	])('rejects %s', (bundle, map, message) => {
		expect(() => locateBundle(directory, bundle, map)).toThrow(message);
	});

	it('reports a bundle without a source map', () => {
		writeFileSync(join(directory, 'lonely.js'), 'console.log(1)');

		expect(() => locateBundle(directory, 'lonely.js')).toThrow('no source map found');
	});

	it('reports a map whose bundle is missing', () => {
		writeFileSync(join(directory, 'lonely.js.map'), '{}');

		expect(() => locateBundle(directory, 'lonely.js.map')).toThrow('give the bundle instead of its source map');
	});
});

describe('readSourceMap', () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-bundle-'));
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it.each([
		['{ invalid', 'could not parse'],
		['[]', 'must contain an object'],
		['{"sources":[]}', 'has no "mappings"'],
		['{"mappings":""}', 'has no "sources"'],
		['{"mappings":"","sources":[],"sourceRoot":1}', '"sourceRoot"'],
	])('rejects %s', (content, message) => {
		const path = join(directory, 'map.json');
		writeFileSync(path, content);

		expect(() => readSourceMap(path)).toThrow(message);
	});
});

describe('groupFiles', () => {
	const files = [
		{ path: 'a/b/one.ts', size: 100 },
		{ path: 'a/b/two.ts', size: 90 },
		{ path: 'a/three.ts', size: 80 },
		{ path: 'four.ts', size: 70 },
	];

	it('nests directories up to the depth and sorts by size', () => {
		expect(groupFiles(files, 2, 1)).toStrictEqual([
			{
				name: 'a',
				children: [
					{
						name: 'b',
						children: [
							{ name: 'one.ts', size: 100 },
							{ name: 'two.ts', size: 90 },
						],
					},
					{ name: 'three.ts', size: 80 },
				],
			},
			{ name: 'four.ts', size: 70 },
		]);
	});

	it('names the leaves below the depth by their remaining path', () => {
		expect(groupFiles(files, 1, 1)).toStrictEqual([
			{
				name: 'a',
				children: [
					{ name: 'b/one.ts', size: 100 },
					{ name: 'b/two.ts', size: 90 },
					{ name: 'three.ts', size: 80 },
				],
			},
			{ name: 'four.ts', size: 70 },
		]);
	});

	it('turns a group of a single file into that file', () => {
		expect(groupFiles([{ path: 'a/b/one.ts', size: 100 }], 2, 1)).toStrictEqual([{ name: 'a/b/one.ts', size: 100 }]);
	});

	it('folds the small nodes of every group into one "other" entry', () => {
		expect(groupFiles(files, 1, 95)).toStrictEqual([
			{
				name: 'a',
				children: [
					{ name: 'b/one.ts', size: 100 },
					{ name: 'other (2 files)', size: 170 },
				],
			},
			{ name: 'four.ts', size: 70 },
		]);
	});

	it('keeps a single small node instead of renaming it to "other"', () => {
		expect(groupFiles([{ path: 'a.ts', size: 1 }], 1, 100)).toStrictEqual([{ name: 'a.ts', size: 1 }]);
	});
});

describe('generateBundleTreemap', () => {
	let directory: string;
	let stdout: MockInstance<typeof process.stdout.write>;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-bundle-'));
		writeBundle(directory);
		stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		delete process.env.VRT_RELEASE_VERSION;
	});

	afterEach(() => {
		stdout.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	});

	const output = (): string => stdout.mock.calls.map((call) => call[0]).join('');

	it('writes the SVG and prints the linked image followed by the caption', async () => {
		await generateBundleTreemap(directory, 'dist/bundle.js', {
			svg: 'assets/bundle.svg',
			width: 500,
			height: 300,
		});

		const svg = readFileSync(join(directory, 'assets/bundle.svg'), 'utf8');
		expect(svg).toContain('width="500" height="300"');
		expect(svg).toContain('<title>Bundle composition</title>');
		expect(svg).toContain('>color.ts</text>');
		const { caption } = measureBundle(directory, 'dist/bundle.js');
		expect(output()).toBe(`[![Bundle composition](assets/bundle.svg)](assets/bundle.svg?raw=true)\n\n${caption}\n`);
	});

	it('prints the treemap as JSON if no SVG is requested', async () => {
		await generateBundleTreemap(directory, 'dist/bundle.js', {});

		expect(JSON.parse(output())).toStrictEqual(measureBundle(directory, 'dist/bundle.js'));
	});
});
