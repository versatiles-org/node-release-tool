import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { type DepsGraphOptions, generateDependencyGraph } from './deps-graph.js';

/**
 * Runs the real dependency-cruiser on small projects, to check which imports
 * end up as edges in the graph.
 */
describe('generateDependencyGraph with dependency-cruiser', () => {
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

	/** Runs `deps-graph` and returns its edges as `from --> to` file paths. */
	async function edges(options?: DepsGraphOptions): Promise<string[]> {
		await generateDependencyGraph(directory, options);
		const output = mockStdoutWrite.mock.calls.map((c) => c[0].toString()).join('');

		// Reconstruct the file paths from the nesting of subgraphs
		const paths = new Map<string, string>();
		const stack: string[] = [];
		for (const line of output.split('\n')) {
			const subgraph = /^subgraph \w+\["(.*)"\]$/.exec(line);
			const node = /^(\w+)\["(.*)"\]$/.exec(line);
			if (subgraph) stack.push(subgraph[1]);
			else if (line === 'end') stack.pop();
			else if (node) paths.set(node[1], [...stack, node[2]].join('/'));
		}
		return Array.from(
			output.matchAll(/^(\w+)-->(\w+)$/gm),
			([, from, to]) => `${paths.get(from)} --> ${paths.get(to)}`,
		);
	}

	beforeEach(() => {
		directory = realpathSync(mkdtempSync(join(tmpdir(), 'vrt-deps-graph-resolve-')));
		process.chdir(directory);
		mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		mockStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		mockStdoutWrite.mockRestore();
		mockStderrWrite.mockRestore();
		process.chdir(originalCwd);
		rmSync(directory, { recursive: true, force: true });
	});

	it('resolves paths from tsconfig.json', async () => {
		writeFiles({
			'package.json': '{ "type": "module" }',
			'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
			'src/index.ts': "import { x } from '@/utils/x.js';\nexport const a = x;\n",
			'src/utils/x.ts': 'export const x = 1;\n',
		});
		expect(await edges()).toStrictEqual(['src/index.ts --> src/utils/x.ts']);
	});

	it('resolves SvelteKit aliases, next to paths from tsconfig.json', async () => {
		writeFiles({
			'package.json': JSON.stringify({ type: 'module', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
			'.svelte-kit/tsconfig.json': JSON.stringify({
				compilerOptions: { paths: { $lib: ['../src/lib'], '$lib/*': ['../src/lib/*'] } },
			}),
			'tsconfig.json': JSON.stringify({
				extends: './.svelte-kit/tsconfig.json',
				compilerOptions: { paths: { '$lib/*': ['./src/lib/*'], '@/*': ['./src/*'] } },
			}),
			'src/routes/page.ts': "import { x } from '$lib/x.js';\nimport { y } from '@/y.js';\nexport const a = x + y;\n",
			'src/lib/x.ts': 'export const x = 1;\n',
			'src/y.ts': 'export const y = 1;\n',
		});
		expect((await edges()).sort()).toStrictEqual([
			'src/routes/page.ts --> src/lib/x.ts',
			'src/routes/page.ts --> src/y.ts',
		]);
	});

	it('resolves SvelteKit aliases inherited via extends', async () => {
		writeFiles({
			'package.json': JSON.stringify({ type: 'module', devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
			'.svelte-kit/tsconfig.json': JSON.stringify({
				compilerOptions: { paths: { $lib: ['../src/lib'], '$lib/*': ['../src/lib/*'] } },
			}),
			'tsconfig.json': JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }),
			'src/routes/page.ts': "import { x } from '$lib/x.js';\nexport const a = x;\n",
			'src/lib/x.ts': 'export const x = 1;\n',
		});
		expect(await edges()).toStrictEqual(['src/routes/page.ts --> src/lib/x.ts']);
	});

	it('warns about imports that are missing in the graph', async () => {
		writeFiles({
			'package.json': JSON.stringify({ type: 'module', workspaces: ['packages/*'] }),
			'packages/core/package.json': JSON.stringify({ name: '@x/core', exports: './dist/index.js' }),
			'packages/core/dist/index.js': 'export const core = 1;\n',
			'src/index.ts':
				"import { core } from '@x/core';\nimport { gone } from './gone.js';\nexport const a = core + gone;\n",
		});
		mkdirSync(join(directory, 'node_modules/@x'), { recursive: true });
		symlinkSync('../../packages/core', join(directory, 'node_modules/@x/core'));

		expect(await edges()).toStrictEqual([]);
		const stderr = mockStderrWrite.mock.calls.map((c) => c[0].toString()).join('');
		expect(stderr).toContain(
			'missing in graph: 1 import of "@x/core", which resolves to packages/core/dist/index.js, outside of "include"',
		);
		expect(stderr).toContain('missing in graph: 1 import of "./gone.js", which could not be resolved');
	});

	it('maps imports of workspace packages from their build output to their source files', async () => {
		writeFiles({
			'package.json': JSON.stringify({ type: 'module', workspaces: ['packages/*'] }),
			// bundled into a single file
			'packages/core/package.json': JSON.stringify({ name: '@x/core', exports: './dist/bundle.js' }),
			'packages/core/dist/bundle.js': 'export const core = 1;\n',
			'packages/core/src/index.ts': 'export const core = 1;\n',
			// not built yet
			'packages/util/package.json': JSON.stringify({ name: '@x/util', exports: './dist/index.js' }),
			'packages/util/src/index.ts': 'export const util = 1;\n',
			'src/index.ts':
				"import { core } from '@x/core';\nimport { util } from '@x/util';\nexport const a = core + util;\n",
		});
		mkdirSync(join(directory, 'node_modules/@x'), { recursive: true });
		symlinkSync('../../packages/core', join(directory, 'node_modules/@x/core'));
		symlinkSync('../../packages/util', join(directory, 'node_modules/@x/util'));

		expect((await edges({ include: ['src', 'packages/*/src'] })).sort()).toStrictEqual([
			'src/index.ts --> packages/core/src/index.ts',
			'src/index.ts --> packages/util/src/index.ts',
		]);
		expect(mockStderrWrite.mock.calls.join('')).not.toContain('missing in graph');
	});
});
