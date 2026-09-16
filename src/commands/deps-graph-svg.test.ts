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
			/<text class="directory-label" x="([\d.]+)" [^>]*textLength="([\d.]+)"[^>]*>very-long-directory-name</.exec(
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
});
