import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../lib/log.js', () => ({
	panic: vi.fn((message: string) => {
		throw new Error(message);
	}),
	warn: vi.fn(),
	debug: vi.fn(),
	isVerbose: vi.fn(() => false),
}));

const { generateTreemap, parseTreemapData, renderTreemapSvg, squarify } = await import('./treemap.js');

const data = {
	title: 'Bundle',
	caption: '**42 KB** in total',
	unit: 'bytes' as const,
	children: [
		{
			name: 'shortbread',
			children: [
				{ name: 'layers/pois.ts', size: 5300 },
				{ name: 'layers/labels.ts', size: 4500 },
				{ name: 'x.ts', size: 300 },
			],
		},
		{ name: 'color', children: [{ name: 'color.ts', size: 4200 }] },
		{ name: 'index.ts', size: 900 },
	],
};

describe('squarify', () => {
	const rect = { x: 10, y: 20, width: 600, height: 400 };
	const items = [6, 6, 4, 3, 2, 2, 1].map((value) => ({ value }));

	it('fills the rectangle with areas proportional to the values', () => {
		const result = squarify(items, rect);
		const total = items.reduce((sum, item) => sum + item.value, 0);

		expect(result).toHaveLength(items.length);
		for (const { item, rect: box } of result) {
			expect(box.width * box.height).toBeCloseTo((item.value / total) * rect.width * rect.height);
			expect(box.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
			expect(box.y).toBeGreaterThanOrEqual(rect.y - 1e-9);
			expect(box.x + box.width).toBeLessThanOrEqual(rect.x + rect.width + 1e-9);
			expect(box.y + box.height).toBeLessThanOrEqual(rect.y + rect.height + 1e-9);
		}
	});

	it('produces boxes that do not overlap', () => {
		const boxes = squarify(items, rect).map((r) => r.rect);
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i];
				const b = boxes[j];
				const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
				const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
				expect(overlapX <= 1e-9 || overlapY <= 1e-9).toBe(true);
			}
		}
	});

	it('keeps aspect ratios close to squares for equal values', () => {
		const boxes = squarify(
			Array.from({ length: 4 }, () => ({ value: 1 })),
			{ x: 0, y: 0, width: 200, height: 200 },
		);
		for (const { rect: box } of boxes) expect(box.width / box.height).toBeCloseTo(1);
	});

	it('skips items without value', () => {
		expect(squarify([{ value: 0 }, { value: 2 }], rect)).toHaveLength(1);
	});
});

describe('renderTreemapSvg', () => {
	it('draws groups, leaves, labels and tooltips', () => {
		const svg = renderTreemapSvg(data, 600, 400);

		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="600" height="400"/);
		expect(svg).toContain('<title>Bundle</title>');
		expect(svg.match(/<g class="group c\d"/g)).toHaveLength(2);
		expect(svg.match(/<g class="leaf c\d"/g)).toHaveLength(5);
		expect(svg).toContain('>shortbread 9.9 KB</text>');
		expect(svg).toContain('<title>shortbread/layers/pois.ts: 5.2 KB (34.9%)</title>');
		expect(svg).toContain('>layers/pois.ts</text>');
		expect(svg).toContain('@media (prefers-color-scheme: dark)');
	});

	it('gives each top-level group its own color and nested boxes the color of their group', () => {
		const svg = renderTreemapSvg(data, 600, 400);

		// the largest group comes first
		expect(svg).toContain('<g class="group c0"><title>shortbread:');
		expect(svg).toContain('<g class="leaf c0"><title>shortbread/x.ts:');
		expect(svg).toContain('<g class="group c1"><title>color:');
		expect(svg).toContain('<g class="leaf c1"><title>color/color.ts:');
		expect(svg).toContain('<g class="leaf c2"><title>index.ts:');
	});

	it('shortens or omits labels that do not fit', () => {
		const svg = renderTreemapSvg(
			{
				children: [
					{ name: 'a-very-long-file-name.ts', size: 1 },
					{ name: 'big.ts', size: 30 },
				],
			},
			300,
			100,
		);

		expect(svg).not.toContain('>a-very-long-file-name.ts</text>');
		expect(svg).toMatch(
			/>a-very-lo?n?g?[^<]*…<\/text>|<title>a-very-long-file-name.ts: 1 \(3.2%\)<\/title>\n<rect[^>]*\/>\n<\/g>/,
		);
		expect(svg).toContain('>big.ts</text>');
		expect(svg).toContain('>30</text>');
	});

	it('is deterministic', () => {
		expect(renderTreemapSvg(data, 600, 400)).toBe(renderTreemapSvg(data, 600, 400));
	});
});

describe('parseTreemapData', () => {
	it('accepts valid input', () => {
		expect(parseTreemapData(JSON.stringify(data))).toStrictEqual(data);
	});

	it.each([
		['{ invalid', 'treemap: invalid JSON'],
		['[]', 'treemap: input must be a JSON object'],
		['{"children":[]}', '"children" must be a non-empty array'],
		['{"title":1,"children":[{"name":"a","size":1}]}', '"title" must be a string'],
		['{"unit":"kb","children":[{"name":"a","size":1}]}', '"unit" must be "bytes" or omitted'],
		['{"children":[{"size":1}]}', '"children[0].name" must be a non-empty string'],
		['{"children":[{"name":"a"}]}', '"children[0]" needs "children" or a "size" of at least 0'],
		['{"children":[{"name":"a","children":[{"name":"b","size":-1}]}]}', '"children[0].children[0]" needs'],
	])('rejects %s', (input, message) => {
		expect(() => parseTreemapData(input)).toThrow(message);
	});
});

describe('generateTreemap', () => {
	let directory: string;
	let stdout: MockInstance<typeof process.stdout.write>;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-treemap-'));
		stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		delete process.env.VRT_RELEASE_VERSION;
	});

	afterEach(() => {
		stdout.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	});

	it('writes the SVG and prints the linked image followed by the caption', async () => {
		await generateTreemap(directory, JSON.stringify(data), { svg: 'assets/treemap.svg', width: 500, height: 300 });

		expect(readFileSync(join(directory, 'assets/treemap.svg'), 'utf8')).toContain('width="500" height="300"');
		expect(stdout.mock.calls.map((c) => c[0]).join('')).toBe(
			'[![Bundle](assets/treemap.svg)](assets/treemap.svg?raw=true)\n\n**42 KB** in total\n',
		);
	});

	it('prints only the image without caption', async () => {
		await generateTreemap(directory, '{"children":[{"name":"a","size":1}]}', { svg: 'treemap.svg' });

		expect(stdout.mock.calls.map((c) => c[0]).join('')).toBe('[![Treemap](treemap.svg)](treemap.svg?raw=true)\n');
		expect(readFileSync(join(directory, 'treemap.svg'), 'utf8')).toContain('width="880" height="480"');
	});
});
