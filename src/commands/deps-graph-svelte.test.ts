import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { generateDependencyGraph, readSvelteCompilerOptions } from './deps-graph.js';

/**
 * A fake `svelte/compiler`, whose `compile` returns the content of the
 * `<script>` tag, and fails like Svelte does for components using `await`,
 * unless `experimental.async` is set.
 */
const FAKE_SVELTE_COMPILER = `
export const VERSION = '5.0.0';
export function compile(source, options) {
	if (source.includes('await') && !options?.experimental?.async) {
		throw new Error('Cannot use \`await\` unless the \`experimental.async\` compiler option is \`true\`');
	}
	return { js: { code: /<script>([\\s\\S]*?)<\\/script>/.exec(source)?.[1] ?? '' } };
}`;

/**
 * Runs the real dependency-cruiser on a small Svelte project. This is a test
 * file of its own, because dependency-cruiser loads the Svelte compiler only
 * once per process, from the first analyzed project.
 */
describe('generateDependencyGraph with Svelte', () => {
	const originalCwd = process.cwd();
	let directory: string;
	let mockStdoutWrite: MockInstance<typeof process.stdout.write>;
	let mockStderrWrite: MockInstance<typeof process.stderr.write>;

	function writeFiles(files: Record<string, string>): void {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), content);
		}
	}

	const output = (mock: MockInstance): string => mock.mock.calls.map((c) => String(c[0])).join('');

	beforeEach(() => {
		directory = realpathSync(mkdtempSync(join(tmpdir(), 'vrt-deps-graph-svelte-')));
		process.chdir(directory);
		mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		mockStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		writeFiles({
			'package.json': JSON.stringify({ type: 'module' }),
			'node_modules/svelte/package.json': JSON.stringify({
				name: 'svelte',
				version: '5.0.0',
				type: 'module',
				exports: { './compiler': './compiler.js', './package.json': './package.json' },
			}),
			'node_modules/svelte/compiler.js': FAKE_SVELTE_COMPILER,
			'src/App.svelte': "<script>\nimport { x } from './x.js';\nconst y = await x;\n</script>\n",
			'src/x.ts': 'export const x = 1;\n',
		});
	});

	afterEach(() => {
		mockStdoutWrite.mockRestore();
		mockStderrWrite.mockRestore();
		process.chdir(originalCwd);
		rmSync(directory, { recursive: true, force: true });
	});

	it('compiles components with the compiler options from svelte.config.js', async () => {
		writeFiles({ 'svelte.config.js': 'export default { compilerOptions: { experimental: { async: true } } };\n' });
		await generateDependencyGraph(directory);

		expect(output(mockStdoutWrite)).toMatch(/^\w+-->\w+$/m);
		expect(output(mockStderrWrite)).toBe('');
	});

	it('keeps components that fail to compile as nodes without imports', async () => {
		await generateDependencyGraph(directory);

		expect(output(mockStdoutWrite)).toContain('["App.svelte"]');
		expect(output(mockStdoutWrite)).not.toMatch(/^\w+-->\w+$/m);
		expect(output(mockStderrWrite)).toContain(
			'could not analyze src/App.svelte, its imports are missing in the graph: Cannot use `await`',
		);
	});

	it('lists components only once, if the first resolved import is a .js import of a .ts file', async () => {
		writeFiles({
			'svelte.config.js': 'export default { compilerOptions: { experimental: { async: true } } };\n',
			'src/App.svelte': "<script>\nimport { x } from './x.js';\nimport Child from './Child.svelte';\n</script>\n",
			'src/Child.svelte': "<script>\nimport { x } from './x.js';\n</script>\n",
		});
		await generateDependencyGraph(directory, { svg: 'graph.svg' });

		const svg = readFileSync(join(directory, 'graph.svg'), 'utf8');
		expect(svg.match(/>Child\.svelte</g)).toHaveLength(1);
	});

	describe('readSvelteCompilerOptions', () => {
		it('returns no options without svelte.config.js', async () => {
			expect(await readSvelteCompilerOptions(directory)).toStrictEqual({});
		});

		it('reads the compiler options from svelte.config.mjs', async () => {
			writeFiles({ 'svelte.config.mjs': 'export default { compilerOptions: { runes: true } };\n' });
			expect(await readSvelteCompilerOptions(directory)).toStrictEqual({ runes: true });
		});

		it('warns if svelte.config.js can not be loaded', async () => {
			writeFiles({ 'svelte.config.js': "import 'missing-package';\n" });
			expect(await readSvelteCompilerOptions(directory)).toStrictEqual({});
			expect(output(mockStderrWrite)).toContain('could not load');
		});
	});
});
