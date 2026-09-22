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
		expect(svg.match(/<path class="edge /g)).toHaveLength(3);
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

		const ends = [...svg.matchAll(/<path class="edge [^"]*" d="[^"]*L([\d.]+),([\d.]+)"/g)];
		expect(ends).toHaveLength(4);
		expect(new Set(ends.map((m) => m[2])).size).toBe(1);
		const xs = ends.map((m) => Number(m[1])).sort((a, b) => a - b);
		const gaps = xs.slice(1).map((x, i) => Math.round((x - xs[i]) * 100) / 100);
		expect(new Set(gaps).size).toBe(1);
	});

	it('draws directory labels with a background on top of the edges', async () => {
		const svg = await renderSvgGraph(model);

		const lastEdge = svg.lastIndexOf('<path class="edge ');
		const labels = [...svg.matchAll(/<rect class="shade" [^>]*\/>\n<text class="directory-label"/g)].map(
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

	describe('hover highlighting', () => {
		// ids follow the order of files, then directories: n0 src/index.ts, n1 src/lib/a.ts,
		// n2 src/lib/b&c.ts, n3 src/very-long-directory-name/x.ts, n4 src, n5 src/lib, n6 src/very-long-directory-name
		const merged = {
			...model,
			edges: [
				{ from: 'src/index.ts', to: 'src/lib/a.ts' },
				{ from: 'src/lib', to: 'src/very-long-directory-name/x.ts', via: ['src/lib/a.ts', 'src/lib/b&c.ts'] },
				{ from: 'src/lib/a.ts', to: 'src/lib/b&c.ts' },
			],
		};

		it('marks files, directories and edges with node ids', async () => {
			const svg = await renderSvgGraph(merged);

			expect(svg).toMatch(
				/<g class="node n0">\n<rect class="file" [^>]*\/>\n<text class="label"[^>]*>index.ts<\/text>\n<\/g>/,
			);
			expect(svg).toContain('<rect class="directory node n5" ');
			expect(svg).toMatch(
				/<g class="node n5">\n<rect class="label-background" [^>]*\/>\n<rect class="shade" [^>]*fill-opacity="0.0975"\/>\n<text class="directory-label"[^>]*>lib<\/text>/,
			);
			// file classes (from/to) and directory classes (in/out/inner)
			expect(svg).toContain('<path class="edge from-n0 to-n1 inner-n4 in-n5" ');
			expect(svg).toContain('<path class="edge from-n1 from-n2 to-n3 inner-n4 out-n5 in-n6" ');
			expect(svg).toContain('<path class="edge from-n1 to-n2 inner-n4 inner-n5" ');
		});

		it('highlights the edges and connected files of a hovered file or directory', async () => {
			const svg = await renderSvgGraph(merged);
			const rule = (declarations: string): string[] => {
				const line = svg.split('\n').find((l) => l.includes('svg:has(') && l.includes(`{ ${declarations}`));
				expect(line).toBeDefined();
				return line!.slice(0, line!.indexOf('{')).trim().split(', ');
			};

			expect(svg).toContain('svg:has(.node:hover) .edge { stroke-opacity: 0.15; marker-end: url(#arrow-dim); }');
			// edges inside a hovered directory stay visible
			expect(rule('stroke-opacity: 0.7; marker-end: url(#arrow);')).toStrictEqual([
				'svg:has(.n4:hover) .inner-n4',
				'svg:has(.n5:hover) .inner-n5',
			]);
			expect(rule('stroke: var(--outgoing); stroke-opacity: 1;')).toStrictEqual([
				'svg:has(.n0:hover) .from-n0',
				'svg:has(.n1:hover) .from-n1',
				'svg:has(.n2:hover) .from-n2',
				'svg:has(.n5:hover) .out-n5',
			]);
			expect(rule('stroke: var(--incoming); stroke-opacity: 1;')).toStrictEqual([
				'svg:has(.n1:hover) .to-n1',
				'svg:has(.n5:hover) .in-n5',
				'svg:has(.n3:hover) .to-n3',
				'svg:has(.n6:hover) .in-n6',
				'svg:has(.n2:hover) .to-n2',
			]);
			expect(rule('stroke: var(--outgoing); }')).toStrictEqual([
				'svg:has(.n0:hover) .n1 .file',
				'svg:has(.n1:hover) .n3 .file',
				'svg:has(.n2:hover) .n3 .file',
				'svg:has(.n5:hover) .n3 .file',
				'svg:has(.n1:hover) .n2 .file',
			]);
			// connected files outside the hovered directory, never the directory a merged edge starts at
			expect(rule('stroke: var(--incoming); }')).toStrictEqual([
				'svg:has(.n1:hover) .n0 .file',
				'svg:has(.n5:hover) .n0 .file',
				'svg:has(.n3:hover) .n1 .file',
				'svg:has(.n3:hover) .n2 .file',
				'svg:has(.n6:hover) .n1 .file',
				'svg:has(.n6:hover) .n2 .file',
				'svg:has(.n2:hover) .n1 .file',
			]);
			expect(rule('stroke-width: 2;')).toStrictEqual([
				'svg:has(.n4:hover) .directory.n4',
				'svg:has(.n5:hover) .directory.n5',
				'svg:has(.n6:hover) .directory.n6',
			]);
			for (const id of ['arrow', 'arrow-dim', 'arrow-outgoing', 'arrow-incoming']) {
				expect(svg).toContain(`<marker id="${id}" `);
			}
		});

		it('adds no hover rules for a graph without edges', async () => {
			const svg = await renderSvgGraph({ files: ['src/a.ts'], edges: [] });
			expect(svg).not.toContain(':hover) .edge');
		});
	});
});
