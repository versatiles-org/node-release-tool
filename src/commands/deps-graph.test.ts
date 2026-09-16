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
const { panic, warn } = await import('../lib/log.js');
const { renderSvgGraph } = await import('./deps-graph-svg.js');
const { generateDependencyGraph, readDepsGraphConfig } = await import('./deps-graph.js');

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
		await expect(generateDependencyGraph('src')).resolves.toBeUndefined();

		expect(cruise).toHaveBeenCalledWith(['src'], expect.objectContaining({ outputType: 'json' }));

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

	it('panics if the formatted output is not a string', async () => {
		vi.mocked(format).mockResolvedValueOnce({ output: null } as unknown as IReporterOutput);

		await expect(generateDependencyGraph('src')).rejects.toThrow('no output');
		expect(panic).toHaveBeenCalledWith('no output');
		expect(mockStdoutWrite).not.toHaveBeenCalled();
	});

	describe('--exclude', () => {
		it('passes user-provided globs (as regex) to cruise alongside built-in excludes', async () => {
			await generateDependencyGraph('src', { exclude: ['**/_planned.ts'] });

			const opts = vi.mocked(cruise).mock.calls[0][1];
			expect(opts).toBeDefined();
			const excludePatterns = (opts!.exclude ?? []) as string[];
			// built-in excludes are still present
			expect(excludePatterns).toContain('\\.(test|d|mock)\\.ts$');
			// user glob translated to a regex
			expect(excludePatterns.some((p) => /_planned/.test(p))).toBe(true);
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

			await generateDependencyGraph('src', { collapseDir: ['src/regions/{de,fr,it}.ts'] });

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

			await generateDependencyGraph('src', { collapseDir: ['src/no-match/*.ts'] });

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
			await generateDependencyGraph('src', { subgraphDirection: ['src/lib=LR'] });

			const output = written();
			expect(output).toContain('subgraph 3["lib"]\ndirection LR\nsubgraph 4["utils"]');
			expect(output.match(/direction/g)).toHaveLength(1);
			expect(warn).not.toHaveBeenCalled();
		});

		it('matches nested paths with globs, accepts lowercase and lets the last rule win', async () => {
			await generateDependencyGraph('src', {
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
			await generateDependencyGraph('src', { subgraphDirection: ['src/nope=LR'] });

			expect(warn).toHaveBeenCalledWith('subgraph direction glob "src/nope" did not match any directory');
			expect(written()).not.toContain('direction');
		});

		it.each(['src/lib', 'src/lib=XX', '=LR'])('panics on invalid value "%s"', async (value) => {
			await expect(generateDependencyGraph('src', { subgraphDirection: [value] })).rejects.toThrow(
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
			await generateDependencyGraph('src', { mergeOutgoing: ['src/a/sub', 'src/a/'] });

			// x.ts: b, c and sub/d merged; y.ts: b and c merged; z.ts only from b; c->b is internal
			expect(edges()).toEqual(['1-->6', '1-->7', '2-->8', '3-->2']);
			expect(warn).not.toHaveBeenCalled();
		});

		it('only merges direct and nested children of the matching directory', async () => {
			await generateDependencyGraph('src', { mergeOutgoing: ['src/a/sub'] });

			// sub has a single outgoing edge, so nothing changes
			expect(edges()).toEqual(['2-->6', '2-->7', '2-->8', '3-->6', '3-->7', '3-->2', '5-->6']);
		});

		it('keeps non-edge lines in place', async () => {
			await generateDependencyGraph('src', { mergeOutgoing: ['src/a'] });

			const output = (mockStdoutWrite.mock.calls[0][0] as Buffer).toString();
			expect(output).toContain('end\n1-->6\n1-->7\n2-->8\n3-->2\n\nstyle 6 fill:lime');
		});

		it('panics on an empty glob', async () => {
			await expect(generateDependencyGraph('src', { mergeOutgoing: ['/'] })).rejects.toThrow(
				'invalid directory glob',
			);
			expect(cruise).not.toHaveBeenCalled();
		});

		it('warns about globs that match no subgraph', async () => {
			await generateDependencyGraph('src', { mergeOutgoing: ['src/nope'] });

			expect(warn).toHaveBeenCalledWith('merge outgoing glob "src/nope" did not match any directory');
			expect(edges()).toHaveLength(7);
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
					'merge-outgoing': ['src/*'],
					'subgraph-direction': ['src/lib=LR'],
				},
			});

			expect(readDepsGraphConfig(directory)).toEqual({
				collapseDir: ['src/themes/*'],
				exclude: ['**/_planned.ts'],
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
			expect(output()).toBe('![Dependency graph](docs/graph.svg)\n');
			expect(format).not.toHaveBeenCalled();
		});

		it('merges outgoing edges of matching directories in the graph model', async () => {
			await generateDependencyGraph(directory, { svg: 'graph.svg', mergeOutgoing: ['src/a'] });

			expect(vi.mocked(renderSvgGraph).mock.calls[0][0]).toStrictEqual({
				files: ['src/a/b.ts', 'src/a/c.ts', 'src/x.ts', 'src/y.ts'],
				edges: [
					{ from: 'src/a', to: 'src/x.ts' },
					{ from: 'src/a', to: 'src/y.ts' },
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
				'![Dependency graph](https://raw.githubusercontent.com/owner/repo/v2.0.0/docs/graph.svg)\n',
			);
		});

		it('falls back to a relative link without GitHub repository', async () => {
			writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'test' }));
			process.env.VRT_RELEASE_VERSION = '2.0.0';

			await generateDependencyGraph(directory, { svg: 'docs/graph.svg' });

			expect(output()).toBe('![Dependency graph](docs/graph.svg)\n');
			expect(warn).toHaveBeenCalledWith(
				'no GitHub repository URL in package.json, using a relative link for the dependency graph',
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
			expect(output()).toBe('![Dependency graph](config.svg)\n');

			mockStdoutWrite.mockClear();
			await generateDependencyGraph(directory, { svg: 'cli.svg' });
			expect(output()).toBe('![Dependency graph](cli.svg)\n');
		});

		it('panics on an invalid SVG path in vrt.config.json', () => {
			writeFileSync(join(directory, 'vrt.config.json'), JSON.stringify({ 'deps-graph': { svg: ['a.svg'] } }));
			expect(() => readDepsGraphConfig(directory)).toThrow('"deps-graph.svg" must be a file path');
		});
	});
});
