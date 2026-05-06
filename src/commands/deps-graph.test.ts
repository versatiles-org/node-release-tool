import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import type { ICruiseResult, IModule, IReporterOutput } from 'dependency-cruiser';

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
}));

// 3. Import the mocked modules and the function under test
const { cruise, format } = await import('dependency-cruiser');
const { panic } = await import('../lib/log.js');
const { generateDependencyGraph } = await import('./deps-graph.js');

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
});
