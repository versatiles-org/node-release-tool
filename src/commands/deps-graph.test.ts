import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import type { ICruiseResult, IModule, IReporterOutput } from 'dependency-cruiser';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// 1. Mock dependency-cruiser to control the output of `cruise` and `format`
vi.mock('dependency-cruiser', () => ({
	cruise: vi.fn(),
	format: vi.fn(),
}));

vi.mock('dependency-cruiser/config-utl/extract-ts-config', () => ({
	default: vi.fn((fileName: string) => ({ parsedFrom: fileName })),
}));

// 2. Mock the log/panic module
vi.mock('../lib/log.js', () => ({
	panic: vi.fn((message: string) => {
		throw new Error(message);
	}),
	warn: vi.fn(),
	debug: vi.fn(),
	isVerbose: vi.fn(() => false),
}));

// Capture the graph model instead of running the ELK layout (tested in deps-graph-svg.test.ts)
vi.mock('./deps-graph-svg.js', () => ({
	renderSvgGraph: vi.fn(async () => '<svg/>'),
}));

// 3. Import the mocked modules and the function under test
const { cruise, format } = await import('dependency-cruiser');
const { default: extractTSConfig } = await import('dependency-cruiser/config-utl/extract-ts-config');
const { debug, isVerbose, panic, warn } = await import('../lib/log.js');
const { renderSvgGraph } = await import('./deps-graph-svg.js');
const { generateDependencyGraph, readDepsGraphConfig, readSvelteKitAliases } = await import('./deps-graph.js');

/** Build a minimal ICruiseResult with the given modules; all other fields stubbed. */
function fakeCruiseResult(modules: Pick<IModule, 'source' | 'dependencies'>[]): ICruiseResult {
	return {
		modules: modules.map((m) => ({
			source: m.source,
			dependencies: m.dependencies,
			dependents: [],
			valid: true,
		})) as IModule[],
		summary: {} as ICruiseResult['summary'],
	};
}

describe('generateDependencyGraph', () => {
	let mockStdoutWrite: MockInstance<typeof process.stdout.write>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		// Default: cruise returns the modules-shaped result the new code expects
		vi.mocked(cruise).mockResolvedValue({
			output: fakeCruiseResult([{ source: 'src/a.ts', dependencies: [] }]),
		} as IReporterOutput);

		// Default: format returns a minimal mermaid string the post-processor can rewrite
		vi.mocked(format).mockResolvedValue({ output: 'flowchart LR\nA-->B' } as IReporterOutput);
	});

	afterEach(() => {
		mockStdoutWrite.mockRestore();
	});

	it('generates a mermaid diagram, replacing flowchart LR with flowchart TB', async () => {
		await expect(generateDependencyGraph('.')).resolves.toBeUndefined();

		expect(cruise).toHaveBeenCalledWith(
			['src'],
			expect.objectContaining({ baseDir: '.', outputType: 'json' }),
			{ alias: {} },
			expect.anything(),
		);

		expect(mockStdoutWrite).toHaveBeenCalledTimes(1);
		const writtenString = (mockStdoutWrite.mock.calls[0][0] as Buffer).toString();
		expect(writtenString).toMatch(/^```mermaid\n/);
		expect(writtenString).toMatch(/\nflowchart TB\nA-->B\n/);
		expect(writtenString).toMatch(/\n```\n$/);
	});

	it('panics if dependency-cruiser throws an error', async () => {
		vi.mocked(cruise).mockImplementationOnce(async () => {
			throw new Error('Some error from dependency-cruiser');
		});

		await expect(generateDependencyGraph('bad/path')).rejects.toThrow('Some error from dependency-cruiser');

		expect(panic).toHaveBeenCalledWith('Error: Some error from dependency-cruiser');
		expect(mockStdoutWrite).not.toHaveBeenCalled();
	});

	describe('files that can not be analyzed', () => {
		const cruiseError = (file: string): Error =>
			new Error(
				`Extracting dependencies ran afoul of...\n\n  Unexpected token (3:4)\n  more details\n... in ${file}\n\n`,
			);

		it('adds them as nodes without imports and warns', async () => {
			vi.mocked(cruise)
				.mockRejectedValueOnce(cruiseError('src/a.svelte'))
				.mockRejectedValueOnce(cruiseError('src/b (1).svelte'));
			await generateDependencyGraph('.');

			expect(warn).toHaveBeenCalledWith(
				'could not analyze src/a.svelte, its imports are missing in the graph: Unexpected token (3:4)',
			);
			expect(cruise).toHaveBeenCalledTimes(3);
			const doNotFollow = new RegExp((vi.mocked(cruise).mock.calls[2][1]!.doNotFollow as { path: string }).path);
			expect(doNotFollow.test('src/a.svelte')).toBe(true);
			expect(doNotFollow.test('src/b (1).svelte')).toBe(true);
			expect(doNotFollow.test('src/b.svelte')).toBe(false);

			const result = vi.mocked(format).mock.calls[0][0] as ICruiseResult;
			expect(result.modules.map((m) => m.source)).toStrictEqual(['src/a.ts', 'src/a.svelte', 'src/b (1).svelte']);
		});

		it('panics if the same file fails again', async () => {
			vi.mocked(cruise).mockRejectedValue(cruiseError('src/a.svelte'));
			await expect(generateDependencyGraph('.')).rejects.toThrow('ran afoul of');
			expect(cruise).toHaveBeenCalledTimes(2);
		});

		it('gives up after 10 files', async () => {
			let count = 0;
			vi.mocked(cruise).mockImplementation(async () => {
				throw cruiseError(`src/${count++}.svelte`);
			});
			await expect(generateDependencyGraph('.')).rejects.toThrow('src/10.svelte');
			expect(cruise).toHaveBeenCalledTimes(11);
		});
	});

	it('panics if the formatted output is not a string', async () => {
		vi.mocked(format).mockResolvedValueOnce({ output: null } as unknown as IReporterOutput);

		await expect(generateDependencyGraph('.')).rejects.toThrow('no output');
		expect(panic).toHaveBeenCalledWith('no output');
		expect(mockStdoutWrite).not.toHaveBeenCalled();
	});

	describe('--include', () => {
		function cruiseOptions() {
			return vi.mocked(cruise).mock.calls[0][1]!;
		}

		/** Whether dependency-cruiser analyzes the file, instead of adding it as a leaf. */
		function isFollowed(path: string): boolean {
			const { doNotFollow } = cruiseOptions();
			return !new RegExp((doNotFollow as { path: string }).path).test(path);
		}

		it('analyzes only src by default', async () => {
			await generateDependencyGraph('.');
			expect(vi.mocked(cruise).mock.calls[0][0]).toStrictEqual(['src']);
			expect(cruiseOptions().includeOnly).toBeUndefined();
			expect(isFollowed('src/a.ts')).toBe(true);
			expect(isFollowed('src')).toBe(true);
			expect(isFollowed('srcx/a.ts')).toBe(false);
			expect(isFollowed('packages/core/dist/index.js')).toBe(false);
		});

		it('always resolves through the exports field of package.json', async () => {
			await generateDependencyGraph('.');
			expect(cruiseOptions().enhancedResolveOptions).toEqual({
				exportsFields: ['exports'],
				conditionNames: ['import', 'default'],
			});
		});

		it('replaces the default with the given globs', async () => {
			await generateDependencyGraph('.', { include: ['packages/*/src/', './lib/*.ts', 'tools/**/?.ts'] });

			expect(vi.mocked(cruise).mock.calls[0][0]).toStrictEqual(['packages/*/src', 'lib/*.ts', 'tools/**/?.ts']);
			expect(isFollowed('packages/core/src/map_renderer.ts')).toBe(true);
			expect(isFollowed('packages/core/src/lib/utils.ts')).toBe(true);
			expect(isFollowed('lib/a.ts')).toBe(true);
			expect(isFollowed('lib/a.js')).toBe(false);
			expect(isFollowed('tools/a.ts')).toBe(true);
			expect(isFollowed('tools/x/y/a.ts')).toBe(true);
			expect(isFollowed('tools/ab.ts')).toBe(false);
			expect(isFollowed('src/index.ts')).toBe(false);
			expect(isFollowed('packages/core/srcx/a.ts')).toBe(false);
			expect(isFollowed('packages/core/package.json')).toBe(false);
		});

		it('skips include paths that do not exist', async () => {
			await generateDependencyGraph('.', { include: ['src', 'missing', 'missing/*'] });
			expect(vi.mocked(cruise).mock.calls[0][0]).toStrictEqual(['src', 'missing/*']);
			expect(warn).toHaveBeenCalledWith('include path "missing" does not exist');
		});

		it('panics on an empty glob', async () => {
			await expect(generateDependencyGraph('.', { include: ['/'] })).rejects.toThrow('invalid include glob');
			expect(cruise).not.toHaveBeenCalled();
		});
	});

	describe('imports outside of include', () => {
		function dependency(module: string, resolved: string, extra: object = {}): IModule['dependencies'][number] {
			return {
				module,
				resolved,
				coreModule: false,
				couldNotResolve: false,
				...extra,
			} as IModule['dependencies'][number];
		}

		function mockModules(modules: Pick<IModule, 'source' | 'dependencies'>[]): void {
			vi.mocked(cruise).mockResolvedValue({ output: fakeCruiseResult(modules) } as IReporterOutput);
		}

		const warnings = (): string[] => vi.mocked(warn).mock.calls.map(([text]) => text);

		it('removes files outside of include and imports of them from the graph', async () => {
			mockModules([
				{
					source: 'src/a.ts',
					dependencies: [dependency('./b.js', 'src/b.ts'), dependency('@x/y', 'packages/y/dist/index.js')],
				},
				{ source: 'src/b.ts', dependencies: [] },
				{ source: 'packages/y/dist/index.js', dependencies: [] },
			]);
			await generateDependencyGraph('.');

			const result = vi.mocked(format).mock.calls[0][0] as ICruiseResult;
			expect(result.modules.map((m) => [m.source, m.dependencies.map((d) => d.resolved)])).toStrictEqual([
				['src/a.ts', ['src/b.ts']],
				['src/b.ts', []],
			]);
		});

		it('warns about unresolved local imports and imports resolving outside of include', async () => {
			mockModules([
				{
					source: 'src/a.ts',
					dependencies: [
						dependency('@x/y', 'packages/y/dist/index.js'),
						dependency('./gone.js', './gone.js', { couldNotResolve: true }),
						dependency('$lib/gone', '$lib/gone', { couldNotResolve: true }),
					],
				},
				{ source: 'src/b.ts', dependencies: [dependency('@x/y', 'packages/y/dist/index.js')] },
			]);
			await generateDependencyGraph('.');

			expect(warnings()).toStrictEqual([
				'missing in graph: 2 imports of "@x/y", which resolves to packages/y/dist/index.js, outside of "include"',
				'missing in graph: 1 import of "./gone.js", which could not be resolved',
				'missing in graph: 1 import of "$lib/gone", which could not be resolved',
			]);
			expect(debug).toHaveBeenCalledWith('imported by src/a.ts');
			expect(debug).toHaveBeenCalledWith('imported by src/b.ts');
		});

		it('ignores npm packages, core modules, assets and modules provided by frameworks', async () => {
			mockModules([
				{
					source: 'src/a.ts',
					dependencies: [
						dependency('fs', 'fs', { coreModule: true }),
						dependency('../icons/logo.png', 'icons/logo.png'),
						dependency('not-installed', 'not-installed', { couldNotResolve: true }),
						dependency('@scope/not-installed/sub', '@scope/not-installed/sub', { couldNotResolve: true }),
						dependency('$app/navigation', '$app/navigation', { couldNotResolve: true }),
						dependency('$app/types', '.svelte-kit/types/index.d.ts'),
						dependency('$env/static/public', '$env/static/public', { couldNotResolve: true }),
						dependency('./$types', './$types', { couldNotResolve: true }),
						dependency('virtual:worker-url', 'virtual:worker-url', { couldNotResolve: true }),
					],
				},
			]);
			await generateDependencyGraph('.');
			expect(warn).not.toHaveBeenCalled();
		});

		it('lists only the most frequent targets without verbose mode', async () => {
			const dependencies = Array.from({ length: 12 }, (_, i) =>
				dependency(`./gone${i}.js`, `./gone${i}.js`, { couldNotResolve: true }),
			);
			mockModules([
				{ source: 'src/a.ts', dependencies },
				{ source: 'src/b.ts', dependencies: [dependencies[11]] },
			]);
			await generateDependencyGraph('.');

			expect(warnings()).toHaveLength(11);
			expect(warnings()[0]).toBe('missing in graph: 2 imports of "./gone11.js", which could not be resolved');
			expect(warnings()[10]).toBe('missing in graph: imports of 2 more targets, run with -v to see all');

			vi.mocked(warn).mockClear();
			vi.mocked(isVerbose).mockReturnValueOnce(true);
			await generateDependencyGraph('.');
			expect(warnings()).toHaveLength(12);
		});
	});

	describe('--exclude', () => {
		it('passes user-provided globs (as regex) to cruise', async () => {
			await generateDependencyGraph('.', { exclude: ['**/_planned.ts'] });

			const opts = vi.mocked(cruise).mock.calls[0][1];
			expect(opts).toBeDefined();
			const excludePatterns = (opts!.exclude ?? []) as string[];
			// user glob translated to a regex
			expect(excludePatterns.some((p) => /_planned/.test(p))).toBe(true);
		});

		it('always excludes tests, mocks, type declarations and dependencies', async () => {
			await generateDependencyGraph('.');
			const patterns = (vi.mocked(cruise).mock.calls[0][1]!.exclude as string[]).map((p) => new RegExp(p));
			const isExcluded = (path: string): boolean => patterns.some((p) => p.test(path));

			for (const path of [
				'src/a.test.ts',
				'src/a.spec.ts',
				'src/a.mock.ts',
				'src/a.svelte.test.ts',
				'src/a.test.tsx',
				'src/a.spec.js',
				'src/a.test.mjs',
				'src/a.d.ts',
				'src/a.d.mts',
				'src/__tests__/a.ts',
				'src/lib/__mocks__/map.ts',
				'__tests__/a.ts',
				'node_modules/x/index.js',
			]) {
				expect(isExcluded(path), path).toBe(true);
			}
			for (const path of [
				'src/a.ts',
				'src/a.svelte',
				'src/a.svelte.ts',
				'src/test.ts',
				'src/latest.ts',
				'src/contest.spec_helper.ts',
				'src/a.data.ts',
				'src/tests/a.ts',
				'src/my__tests__/a.ts',
			]) {
				expect(isExcluded(path), path).toBe(false);
			}
		});
	});

	describe('--collapse-dir', () => {
		it('merges files matching a glob into a single node and reports the count', async () => {
			vi.mocked(cruise).mockResolvedValueOnce({
				output: fakeCruiseResult([
					{
						source: 'src/regions/index.ts',
						dependencies: [
							{ resolved: 'src/regions/de.ts' },
							{ resolved: 'src/regions/fr.ts' },
							{ resolved: 'src/regions/it.ts' },
							{ resolved: 'src/regions/lib.ts' },
						] as IModule['dependencies'],
					},
					{
						source: 'src/regions/de.ts',
						dependencies: [{ resolved: 'src/regions/lib.ts' }] as IModule['dependencies'],
					},
					{
						source: 'src/regions/fr.ts',
						dependencies: [{ resolved: 'src/regions/lib.ts' }] as IModule['dependencies'],
					},
					{
						source: 'src/regions/it.ts',
						dependencies: [{ resolved: 'src/regions/lib.ts' }] as IModule['dependencies'],
					},
					{ source: 'src/regions/lib.ts', dependencies: [] },
				]),
			} as IReporterOutput);

			await generateDependencyGraph('.', { collapseDir: ['src/regions/{de,fr,it}.ts'] });

			// The collapsed result is what `format` receives.
			const formatArg = vi.mocked(format).mock.calls[0][0] as ICruiseResult;
			const sources = formatArg.modules.map((m) => m.source).sort();

			// Original 5 files reduced to 3: index, lib, and one merged regions/{de,fr,it}.ts node
			expect(formatArg.modules).toHaveLength(3);
			expect(sources).toEqual(['src/regions/index.ts', 'src/regions/lib.ts', 'src/regions/{de,fr,it}.ts (3 files)']);

			// Edges from index.ts: the three collapsed files become a single deduped edge to the merged node.
			const indexNode = formatArg.modules.find((m) => m.source === 'src/regions/index.ts')!;
			const indexResolved = indexNode.dependencies.map((d) => d.resolved).sort();
			expect(indexResolved).toEqual(['src/regions/lib.ts', 'src/regions/{de,fr,it}.ts (3 files)']);

			// The merged node depends on lib.ts (deduped from the three originals) — and has no self-loop.
			const merged = formatArg.modules.find((m) => m.source.startsWith('src/regions/{de,fr,it}.ts'))!;
			expect(merged.dependencies.map((d) => d.resolved)).toEqual(['src/regions/lib.ts']);
		});

		it('does nothing when no files match the collapse glob', async () => {
			vi.mocked(cruise).mockResolvedValueOnce({
				output: fakeCruiseResult([
					{ source: 'src/a.ts', dependencies: [{ resolved: 'src/b.ts' }] as IModule['dependencies'] },
					{ source: 'src/b.ts', dependencies: [] },
				]),
			} as IReporterOutput);

			await generateDependencyGraph('.', { collapseDir: ['src/no-match/*.ts'] });

			const formatArg = vi.mocked(format).mock.calls[0][0] as ICruiseResult;
			expect(formatArg.modules.map((m) => m.source).sort()).toEqual(['src/a.ts', 'src/b.ts']);
		});
	});

	describe('--subgraph-direction', () => {
		const mermaid = [
			'flowchart LR',
			'',
			'subgraph 0["src"]',
			'subgraph 1["commands"]',
			'2["check.ts"]',
			'end',
			'subgraph 3["lib"]',
			'subgraph 4["utils"]',
			'5["a.ts"]',
			'end',
			'6["log.ts"]',
			'end',
			'end',
			'2-->6',
		].join('\n');

		function written(): string {
			return (mockStdoutWrite.mock.calls[0][0] as Buffer).toString();
		}

		beforeEach(() => {
			vi.mocked(format).mockResolvedValue({ output: mermaid } as IReporterOutput);
		});

		it('inserts a direction statement into subgraphs matching the glob', async () => {
			await generateDependencyGraph('.', { subgraphDirection: ['src/lib=LR'] });

			const output = written();
			expect(output).toContain('subgraph 3["lib"]\ndirection LR\nsubgraph 4["utils"]');
			expect(output.match(/direction/g)).toHaveLength(1);
			expect(warn).not.toHaveBeenCalled();
		});

		it('matches nested paths with globs, accepts lowercase and lets the last rule win', async () => {
			await generateDependencyGraph('.', {
				subgraphDirection: ['src/*=bt', 'src/lib/utils/=RL'],
			});

			const output = written();
			expect(output).toContain('subgraph 1["commands"]\ndirection BT\n');
			expect(output).toContain('subgraph 3["lib"]\ndirection BT\n');
			expect(output).toContain('subgraph 4["utils"]\ndirection RL\n');
			// "src/*" does not match "src" itself
			expect(output).toContain('subgraph 0["src"]\nsubgraph 1["commands"]');
		});

		it('warns about globs that match no subgraph', async () => {
			await generateDependencyGraph('.', { subgraphDirection: ['src/nope=LR'] });

			expect(warn).toHaveBeenCalledWith('subgraph direction glob "src/nope" did not match any directory');
			expect(written()).not.toContain('direction');
		});

		it.each(['src/lib', 'src/lib=XX', '=LR'])('panics on invalid value "%s"', async (value) => {
			await expect(generateDependencyGraph('.', { subgraphDirection: [value] })).rejects.toThrow(
				'invalid subgraph direction',
			);
			expect(cruise).not.toHaveBeenCalled();
		});
	});

	describe('--merge-outgoing', () => {
		// a/b.ts, a/c.ts, a/sub/d.ts depend on x.ts and y.ts; a/c.ts also on a/b.ts; a/b.ts alone on z.ts
		const mermaid = [
			'flowchart LR',
			'',
			'subgraph 0["src"]',
			'subgraph 1["a"]',
			'2["b.ts"]',
			'3["c.ts"]',
			'subgraph 4["sub"]',
			'5["d.ts"]',
			'end',
			'end',
			'6["x.ts"]',
			'7["y.ts"]',
			'8["z.ts"]',
			'end',
			'2-->6',
			'2-->7',
			'2-->8',
			'3-->6',
			'3-->7',
			'3-->2',
			'5-->6',
			'',
			'style 6 fill:lime',
		].join('\n');

		function edges(): string[] {
			const output = (mockStdoutWrite.mock.calls[0][0] as Buffer).toString();
			return output.split('\n').filter((line) => line.includes('-->'));
		}

		beforeEach(() => {
			vi.mocked(format).mockResolvedValue({ output: mermaid } as IReporterOutput);
		});

		it('merges edges from a directory that point to the same target', async () => {
			await generateDependencyGraph('.', { mergeOutgoing: ['src/a/sub', 'src/a/'] });

			// x.ts: b, c and sub/d merged; y.ts: b and c merged; z.ts only from b; c->b is internal
			expect(edges()).toEqual(['1-->6', '1-->7', '2-->8', '3-->2']);
			expect(warn).not.toHaveBeenCalled();
		});

		it('only merges direct and nested children of the matching directory', async () => {
			await generateDependencyGraph('.', { mergeOutgoing: ['src/a/sub'] });

			// sub has a single outgoing edge, so nothing changes
			expect(edges()).toEqual(['2-->6', '2-->7', '2-->8', '3-->6', '3-->7', '3-->2', '5-->6']);
		});

		it('keeps non-edge lines in place', async () => {
			await generateDependencyGraph('.', { mergeOutgoing: ['src/a'] });

			const output = (mockStdoutWrite.mock.calls[0][0] as Buffer).toString();
			expect(output).toContain('end\n1-->6\n1-->7\n2-->8\n3-->2\n\nstyle 6 fill:lime');
		});

		it('panics on an empty glob', async () => {
			await expect(generateDependencyGraph('.', { mergeOutgoing: ['/'] })).rejects.toThrow('invalid directory glob');
			expect(cruise).not.toHaveBeenCalled();
		});

		it('warns about globs that match no subgraph', async () => {
			await generateDependencyGraph('.', { mergeOutgoing: ['src/nope'] });

			expect(warn).toHaveBeenCalledWith('merge outgoing glob "src/nope" did not match any directory');
			expect(edges()).toHaveLength(7);
		});
	});

	describe('SvelteKit aliases', () => {
		let directory: string;

		function writeJson(path: string, content: unknown): void {
			mkdirSync(join(directory, path, '..'), { recursive: true });
			writeFileSync(join(directory, path), JSON.stringify(content));
		}

		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), 'vrt-deps-graph-kit-'));
		});

		afterEach(() => {
			rmSync(directory, { recursive: true, force: true });
		});

		it('reads the aliases from .svelte-kit/tsconfig.json', () => {
			writeJson('.svelte-kit/tsconfig.json', {
				compilerOptions: {
					paths: {
						$lib: ['../src/lib'],
						'$lib/*': ['../src/lib/*'],
						$utils: ['../src/utils'],
						'$app/types': ['./types/index.d.ts'],
						'weird/*/glob': ['../x/*/y'],
					},
				},
			});
			expect(readSvelteKitAliases(directory)).toStrictEqual({
				$lib: join(directory, 'src/lib'),
				$utils: join(directory, 'src/utils'),
				'$app/types': join(directory, '.svelte-kit/types/index.d.ts'),
			});
		});

		it('falls back to $lib for SvelteKit projects without generated tsconfig', () => {
			writeJson('package.json', { devDependencies: { '@sveltejs/kit': '^2.0.0' } });
			expect(readSvelteKitAliases(directory)).toStrictEqual({ $lib: join(directory, 'src/lib') });
		});

		it('returns no aliases for other projects', () => {
			expect(readSvelteKitAliases(directory)).toStrictEqual({});
			writeJson('package.json', { dependencies: { svelte: '^5.0.0' } });
			expect(readSvelteKitAliases(directory)).toStrictEqual({});
		});

		it('warns about an unreadable tsconfig and falls back', () => {
			mkdirSync(join(directory, '.svelte-kit'));
			writeFileSync(join(directory, '.svelte-kit/tsconfig.json'), '{ invalid');
			writeJson('package.json', { dependencies: { '@sveltejs/kit': '^2.0.0' } });
			expect(readSvelteKitAliases(directory)).toStrictEqual({ $lib: join(directory, 'src/lib') });
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read aliases'));
		});

		it('passes the aliases to the resolver', async () => {
			writeJson('package.json', { devDependencies: { '@sveltejs/kit': '^2.0.0' } });
			await generateDependencyGraph(directory);
			expect(vi.mocked(cruise).mock.calls[0][2]).toEqual({ alias: { $lib: join(directory, 'src/lib') } });
		});
	});

	describe('tsconfig.json', () => {
		let directory: string;

		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), 'vrt-deps-graph-tsconfig-'));
		});

		afterEach(() => {
			rmSync(directory, { recursive: true, force: true });
		});

		it('passes the tsconfig to cruise, so that path aliases are resolved', async () => {
			const fileName = join(directory, 'tsconfig.json');
			writeFileSync(fileName, '{}');
			await generateDependencyGraph(directory);

			expect(extractTSConfig).toHaveBeenCalledWith(fileName);
			const [, options, , transpileOptions] = vi.mocked(cruise).mock.calls[0];
			expect(options!.tsConfig).toStrictEqual({ fileName });
			expect(transpileOptions).toStrictEqual({ tsConfig: { parsedFrom: fileName } });
		});

		it('does without tsconfig if there is none', async () => {
			await generateDependencyGraph(directory);

			expect(extractTSConfig).not.toHaveBeenCalled();
			const [, options, , transpileOptions] = vi.mocked(cruise).mock.calls[0];
			expect(options!.tsConfig).toBeUndefined();
			expect(transpileOptions).toBeUndefined();
		});

		it('warns about an invalid tsconfig and does without it', async () => {
			writeFileSync(join(directory, 'tsconfig.json'), '{}');
			vi.mocked(extractTSConfig).mockImplementationOnce(() => {
				throw new TypeError('broken');
			});
			await generateDependencyGraph(directory);

			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not read .*tsconfig\.json.*broken/));
			expect(vi.mocked(cruise).mock.calls[0][1]!.tsConfig).toBeUndefined();
		});
	});

	describe('vrt.config.json', () => {
		let directory: string;

		function writeConfig(content: unknown): void {
			writeFileSync(join(directory, 'vrt.config.json'), JSON.stringify(content));
		}

		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), 'vrt-deps-graph-'));
		});

		afterEach(() => {
			rmSync(directory, { recursive: true, force: true });
		});

		it('reads options from the "deps-graph" section', () => {
			writeConfig({
				'deps-graph': {
					'collapse-dir': ['src/themes/*'],
					exclude: ['**/_planned.ts'],
					include: ['packages/*/src'],
					'merge-outgoing': ['src/*'],
					'subgraph-direction': ['src/lib=LR'],
				},
			});

			expect(readDepsGraphConfig(directory)).toEqual({
				collapseDir: ['src/themes/*'],
				exclude: ['**/_planned.ts'],
				include: ['packages/*/src'],
				mergeOutgoing: ['src/*'],
				subgraphDirection: ['src/lib=LR'],
			});
		});

		it('returns empty options without config file or section', () => {
			expect(readDepsGraphConfig(directory)).toEqual({});
			writeConfig({});
			expect(readDepsGraphConfig(directory)).toEqual({});
		});

		it.each([
			[{ 'deps-graph': { collapseDir: ['src'] } }, 'unknown key "deps-graph.collapseDir"'],
			[{ 'deps-graph': { exclude: 'src' } }, '"deps-graph.exclude" must be an array of strings'],
			[{ 'deps-graph': { exclude: [1] } }, '"deps-graph.exclude" must be an array of strings'],
		])('panics on invalid config %j', (content, message) => {
			writeConfig(content);
			expect(() => readDepsGraphConfig(directory)).toThrow(message);
		});

		it('combines config and CLI options, CLI options last', async () => {
			writeConfig({ 'deps-graph': { exclude: ['**/a.ts'], 'subgraph-direction': ['src=LR'] } });
			vi.mocked(format).mockResolvedValueOnce({
				output: 'flowchart LR\nsubgraph 0["src"]\n1["a.ts"]\nend',
			} as IReporterOutput);

			await generateDependencyGraph(directory, { exclude: ['**/b.ts'], subgraphDirection: ['src=RL'] });

			const excludePatterns = vi.mocked(cruise).mock.calls[0][1]!.exclude as string[];
			expect(excludePatterns.findIndex((p) => p.includes('a\\.ts'))).toBeGreaterThan(-1);
			expect(excludePatterns.findIndex((p) => p.includes('b\\.ts'))).toBeGreaterThan(
				excludePatterns.findIndex((p) => p.includes('a\\.ts')),
			);

			const output = (mockStdoutWrite.mock.calls[0][0] as Buffer).toString();
			expect(output).toContain('subgraph 0["src"]\ndirection RL\n');
		});
	});

	describe('--svg', () => {
		let directory: string;

		function output(): string {
			return mockStdoutWrite.mock.calls.map((c) => c[0].toString()).join('');
		}

		beforeEach(() => {
			directory = mkdtempSync(join(tmpdir(), 'vrt-deps-graph-svg-'));
			mkdirSync(join(directory, '.git'));
			mkdirSync(join(directory, 'src'));
			delete process.env.VRT_RELEASE_VERSION;
			vi.mocked(cruise).mockResolvedValue({
				output: fakeCruiseResult([
					{
						source: 'src/a/b.ts',
						dependencies: [{ resolved: 'src/x.ts' }, { resolved: 'src/y.ts' }] as IModule['dependencies'],
					},
					{
						source: 'src/a/c.ts',
						dependencies: [
							{ resolved: 'src/x.ts' },
							{ resolved: 'src/y.ts' },
							{ resolved: 'src/a/b.ts' },
						] as IModule['dependencies'],
					},
					{ source: 'src/x.ts', dependencies: [] },
					{ source: 'src/y.ts', dependencies: [] },
				]),
			} as IReporterOutput);
		});

		afterEach(() => {
			delete process.env.VRT_RELEASE_VERSION;
			rmSync(directory, { recursive: true, force: true });
		});

		it('writes the SVG and prints a relative image link instead of Mermaid', async () => {
			await generateDependencyGraph(directory, { svg: 'docs/graph.svg' });

			expect(readFileSync(join(directory, 'docs/graph.svg'), 'utf8')).toBe('<svg/>');
			expect(output()).toBe('[![Dependency graph](docs/graph.svg)](docs/graph.svg?raw=true)\n');
			expect(format).not.toHaveBeenCalled();
		});

		it('merges outgoing edges of matching directories in the graph model', async () => {
			await generateDependencyGraph(directory, { svg: 'graph.svg', mergeOutgoing: ['src/a'] });

			expect(vi.mocked(renderSvgGraph).mock.calls[0][0]).toStrictEqual({
				files: ['src/a/b.ts', 'src/a/c.ts', 'src/x.ts', 'src/y.ts'],
				edges: [
					{ from: 'src/a', to: 'src/x.ts', via: ['src/a/b.ts', 'src/a/c.ts'] },
					{ from: 'src/a', to: 'src/y.ts', via: ['src/a/b.ts', 'src/a/c.ts'] },
					{ from: 'src/a/c.ts', to: 'src/a/b.ts' },
				],
			});
			expect(warn).not.toHaveBeenCalled();
		});

		it('links to the file at the release tag while release-npm publishes', async () => {
			writeFileSync(
				join(directory, 'package.json'),
				JSON.stringify({ repository: { url: 'git+https://github.com/owner/repo.git' } }),
			);
			process.env.VRT_RELEASE_VERSION = '2.0.0';

			await generateDependencyGraph(directory, { svg: 'docs/graph.svg' });

			expect(output()).toBe(
				'[![Dependency graph](https://raw.githubusercontent.com/owner/repo/v2.0.0/docs/graph.svg)]' +
					'(https://raw.githubusercontent.com/owner/repo/v2.0.0/docs/graph.svg?raw=true)\n',
			);
		});

		it('falls back to a relative link without GitHub repository', async () => {
			writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'test' }));
			process.env.VRT_RELEASE_VERSION = '2.0.0';

			await generateDependencyGraph(directory, { svg: 'docs/graph.svg' });

			expect(output()).toBe('[![Dependency graph](docs/graph.svg)](docs/graph.svg?raw=true)\n');
			expect(warn).toHaveBeenCalledWith(
				'no GitHub repository URL in package.json, using a relative link for docs/graph.svg',
			);
		});

		it('warns if the SVG file is ignored by git', async () => {
			rmSync(join(directory, '.git'), { recursive: true });
			execFileSync('git', ['init', '--quiet'], { cwd: directory });
			writeFileSync(join(directory, '.gitignore'), '/docs/\n');

			await generateDependencyGraph(directory, { svg: 'docs/graph.svg' });
			expect(warn).toHaveBeenCalledWith(
				'docs/graph.svg is ignored by git, so the image link will be broken on GitHub and npm',
			);

			vi.mocked(warn).mockClear();
			await generateDependencyGraph(directory, { svg: 'assets/graph.svg' });
			expect(warn).not.toHaveBeenCalled();
		});

		it('warns that subgraph directions are ignored', async () => {
			await generateDependencyGraph(directory, { svg: 'graph.svg', subgraphDirection: ['src/a=LR'] });

			expect(warn).toHaveBeenCalledWith('subgraph direction is not supported for SVG output and is ignored');
		});

		it('reads the SVG path from vrt.config.json, overridden by the CLI option', async () => {
			writeFileSync(join(directory, 'vrt.config.json'), JSON.stringify({ 'deps-graph': { svg: 'config.svg' } }));
			expect(readDepsGraphConfig(directory)).toEqual({ svg: 'config.svg' });

			await generateDependencyGraph(directory);
			expect(output()).toBe('[![Dependency graph](config.svg)](config.svg?raw=true)\n');

			mockStdoutWrite.mockClear();
			await generateDependencyGraph(directory, { svg: 'cli.svg' });
			expect(output()).toBe('[![Dependency graph](cli.svg)](cli.svg?raw=true)\n');
		});

		it('panics on an invalid SVG path in vrt.config.json', () => {
			writeFileSync(join(directory, 'vrt.config.json'), JSON.stringify({ 'deps-graph': { svg: ['a.svg'] } }));
			expect(() => readDepsGraphConfig(directory)).toThrow('"deps-graph.svg" must be a file path');
		});
	});
});
