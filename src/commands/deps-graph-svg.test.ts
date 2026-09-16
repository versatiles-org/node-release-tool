import { describe, expect, it } from 'vitest';
import { renderSvgGraph } from './deps-graph-svg.js';

describe('renderSvgGraph', () => {
	const model = {
		files: ['src/index.ts', 'src/lib/a.ts', 'src/lib/b&c.ts', 'src/very-long-directory-name/x.ts'],
		edges: [
			{ from: 'src/index.ts', to: 'src/lib/a.ts' },
			{ from: 'src/lib', to: 'src/very-long-directory-name/x.ts' },
			{ from: 'src/lib/a.ts', to: 'src/lib/b&c.ts' },
		],
	};

	it('draws directories, files and edges', async () => {
		const svg = await renderSvgGraph(model);

		expect(svg).toMatch(
			/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="\d+" viewBox="0 0 \d+ \d+">/,
		);
		expect(svg.match(/<rect class="directory /g)).toHaveLength(3);
		expect(svg.match(/<rect class="file"/g)).toHaveLength(4);
		expect(svg.match(/<path class="edge"/g)).toHaveLength(3);
		expect(svg).toContain('>index.ts</text>');
		expect(svg).toContain('>b&amp;c.ts</text>');
		expect(svg).toContain('@media (prefers-color-scheme: dark)');
		expect(svg.trimEnd()).toMatch(/<\/svg>$/);
	});

	it('makes directories wide enough for their label', async () => {
		const svg = await renderSvgGraph(model);

		const label =
			/<text class="directory-label[^"]*" x="([\d.]+)" [^>]*textLength="([\d.]+)"[^>]*>very-long-directory-name</.exec(
				svg,
			);
		expect(label).not.toBeNull();
		const labelEnd = Number(label![1]) + Number(label![2]);

		const boxes = [...svg.matchAll(/<rect class="directory [^"]*" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)];
		const box = boxes.find((b) => Number(b[1]) < Number(label![1]) && Number(label![1]) - Number(b[1]) <= 10);
		expect(box).toBeDefined();
		expect(Number(box![1]) + Number(box![2])).toBeGreaterThanOrEqual(labelEnd);
	});

	it('is deterministic', async () => {
		expect(await renderSvgGraph(model)).toBe(await renderSvgGraph(model));
	});

	it('spaces the edges arriving at a node evenly', async () => {
		const svg = await renderSvgGraph({
			files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/wide-target-file-name.ts'],
			edges: ['a', 'b', 'c', 'd'].map((name) => ({ from: `src/${name}.ts`, to: 'src/wide-target-file-name.ts' })),
		});

		const ends = [...svg.matchAll(/<path class="edge" d="[^"]*L([\d.]+),([\d.]+)"/g)];
		expect(ends).toHaveLength(4);
		expect(new Set(ends.map((m) => m[2])).size).toBe(1);
		const xs = ends.map((m) => Number(m[1])).sort((a, b) => a - b);
		const gaps = xs.slice(1).map((x, i) => Math.round((x - xs[i]) * 100) / 100);
		expect(new Set(gaps).size).toBe(1);
	});

	it('draws directory labels with a background on top of the edges', async () => {
		const svg = await renderSvgGraph(model);

		const lastEdge = svg.lastIndexOf('<path class="edge"');
		const labels = [...svg.matchAll(/<rect class="depth\d" [^>]*\/>\n<text class="directory-label"/g)].map(
			(m) => m.index,
		);
		expect(labels).toHaveLength(3);
		expect(Math.min(...labels)).toBeGreaterThan(lastEdge);
	});

	it('sizes boxes by the proportional width of their labels', async () => {
		const svg = await renderSvgGraph({ files: ['src/iiii.ts', 'src/mmmm.ts'], edges: [] });

		const width = (label: string): number =>
			Number(new RegExp(`textLength="([\\d.]+)"[^>]*>${label}<`).exec(svg)![1]);
		// Helvetica: "i" is 222/1000 em, "m" 833/1000 em, "." 278 and "t", "s" 278 and 500 at 12 px
		expect(width('iiii.ts')).toBeCloseTo(((4 * 222 + 278 + 278 + 500) * 12) / 1000);
		expect(width('mmmm.ts')).toBeCloseTo(((4 * 833 + 278 + 278 + 500) * 12) / 1000);
		expect(svg).toContain('font-family: Helvetica, Arial');
	});
});
