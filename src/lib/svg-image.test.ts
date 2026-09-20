import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./log.js', () => ({
	warn: vi.fn(),
	debug: vi.fn(),
	isVerbose: vi.fn(() => false),
}));

const { warn } = await import('./log.js');
const { writeSvgImage } = await import('./svg-image.js');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

describe('writeSvgImage', () => {
	let directory: string;

	beforeEach(() => {
		vi.clearAllMocks();
		directory = mkdtempSync(join(tmpdir(), 'vrt-svg-image-'));
		delete process.env.VRT_RELEASE_VERSION;
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	/** Turns the temporary directory into a repository that ignores `ignored/`. */
	function initRepository(): void {
		execFileSync('git', ['init', '--quiet'], { cwd: directory });
		writeFileSync(join(directory, '.gitignore'), 'ignored/\n');
	}

	it('writes the file and returns the image linked to it', async () => {
		const image = await writeSvgImage(directory, 'assets/graph.svg', SVG, 'Dependency graph');

		expect(readFileSync(join(directory, 'assets/graph.svg'), 'utf8')).toBe(SVG);
		expect(image).toBe('[![Dependency graph](assets/graph.svg)](assets/graph.svg?raw=true)');
	});

	it('warns about a file that git ignores', async () => {
		initRepository();

		await writeSvgImage(directory, 'ignored/graph.svg', SVG, 'Dependency graph');

		expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('ignored/graph.svg is ignored by git'));
	});

	it('does not warn about a file that git would commit', async () => {
		initRepository();

		await writeSvgImage(directory, 'assets/graph.svg', SVG, 'Dependency graph');

		expect(vi.mocked(warn)).not.toHaveBeenCalled();
	});

	it('does not warn outside of a repository', async () => {
		await writeSvgImage(directory, 'assets/graph.svg', SVG, 'Dependency graph');

		expect(vi.mocked(warn)).not.toHaveBeenCalled();
	});

	// the path reaches git as one NUL-terminated record on stdin, so nothing in the name can be
	// read as an option or as a second path
	it.each(['--version/graph.svg', '-n/graph.svg', 'two lines/a\nb.svg'])(
		'handles the path %j like any other',
		async (svgPath) => {
			initRepository();

			const image = await writeSvgImage(directory, svgPath, SVG, 'Graph');

			expect(readFileSync(join(directory, svgPath), 'utf8')).toBe(SVG);
			expect(image).toBe(`[![Graph](${svgPath})](${svgPath}?raw=true)`);
			expect(vi.mocked(warn)).not.toHaveBeenCalled();
		},
	);
});
