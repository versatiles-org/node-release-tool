import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { generateDependencyGraph } from './deps-graph.js';

/**
 * Runs the real dependency-cruiser on small projects, to check that imports
 * using path aliases end up as edges in the graph.
 */
describe('generateDependencyGraph resolves path aliases', () => {
	const originalCwd = process.cwd();
	let directory: string;
	let mockStdoutWrite: MockInstance<typeof process.stdout.write>;

	function writeFiles(files: Record<string, string>): void {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), content);
		}
	}

	/** Runs `deps-graph` and returns its edges as `from --> to` file paths. */
	async function edges(): Promise<string[]> {
		await generateDependencyGraph(directory);
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
	});

	afterEach(() => {
		mockStdoutWrite.mockRestore();
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
});
