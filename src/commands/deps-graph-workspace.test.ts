import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICruiseResult, IModule } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

vi.mock('../lib/log.js', () => ({ debug: vi.fn(), warn: vi.fn() }));

const { warn } = await import('../lib/log.js');
const { mapBuildOutputToSource, readWorkspacePackages } = await import('./deps-graph-workspace.js');

describe('deps-graph workspaces', () => {
	let directory: string;

	function writeFiles(files: Record<string, string>): void {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(directory, path)), { recursive: true });
			writeFileSync(join(directory, path), content);
		}
	}

	const packageJson = (content: object): string => JSON.stringify(content);

	beforeEach(() => {
		vi.clearAllMocks();
		directory = mkdtempSync(join(tmpdir(), 'vrt-deps-graph-workspace-'));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	describe('readWorkspacePackages', () => {
		it('returns no packages outside of a workspace', () => {
			expect(readWorkspacePackages(directory, extractTSConfig)).toStrictEqual([]);
			writeFiles({ 'package.json': packageJson({ name: 'single' }) });
			expect(readWorkspacePackages(directory, extractTSConfig)).toStrictEqual([]);
		});

		it('expands the workspace globs and skips directories without package name', () => {
			writeFiles({
				'package.json': packageJson({ workspaces: { packages: ['packages/*', 'tools/**', '!packages/ignored'] } }),
				'packages/core/package.json': packageJson({ name: '@x/core' }),
				'packages/unnamed/package.json': packageJson({}),
				'packages/empty/.keep': '',
				'packages/node_modules/dep/package.json': packageJson({ name: 'dep' }),
				'tools/a/b/package.json': packageJson({ name: 'b' }),
			});
			expect(readWorkspacePackages(directory, extractTSConfig)).toStrictEqual([
				{
					name: '@x/core',
					directory: 'packages/core',
					outDir: 'packages/core/dist',
					rootDirs: ['packages/core/src', 'packages/core/src/lib'],
				},
				{
					name: 'b',
					directory: 'tools/a/b',
					outDir: 'tools/a/b/dist',
					rootDirs: ['tools/a/b/src', 'tools/a/b/src/lib'],
				},
			]);
		});

		it('reads outDir and rootDir from the tsconfig of a package', () => {
			writeFiles({
				'package.json': packageJson({ workspaces: ['packages/*'] }),
				'packages/core/package.json': packageJson({ name: '@x/core' }),
				'packages/core/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'wrong' } }),
				'packages/core/tsconfig.build.json': JSON.stringify({
					compilerOptions: { outDir: 'build', rootDir: 'lib' },
				}),
				'packages/core/lib/index.ts': '',
				'packages/broken/package.json': packageJson({ name: '@x/broken' }),
				'packages/broken/tsconfig.json': '{ invalid',
			});
			expect(readWorkspacePackages(directory, extractTSConfig)).toStrictEqual([
				{
					name: '@x/broken',
					directory: 'packages/broken',
					outDir: 'packages/broken/dist',
					rootDirs: ['packages/broken/src', 'packages/broken/src/lib'],
				},
				{
					name: '@x/core',
					directory: 'packages/core',
					outDir: 'packages/core/build',
					rootDirs: ['packages/core/lib'],
				},
			]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read'));
		});
	});

	describe('mapBuildOutputToSource', () => {
		function dependency(module: string, resolved: string, couldNotResolve = false): IModule['dependencies'][number] {
			return { module, resolved, couldNotResolve } as IModule['dependencies'][number];
		}

		/** Maps the given dependencies of `src/a.ts` and returns their resolved paths. */
		function map(...dependencies: IModule['dependencies']): string[] {
			const result = { modules: [{ source: 'src/a.ts', dependencies }] } as ICruiseResult;
			const packages = readWorkspacePackages(directory, extractTSConfig);
			return mapBuildOutputToSource(result, packages, directory).modules[0].dependencies.map((d) =>
				d.couldNotResolve ? `unresolved ${d.resolved}` : d.resolved,
			);
		}

		beforeEach(() => {
			writeFiles({
				'package.json': packageJson({ workspaces: ['packages/*'] }),
				'packages/core/package.json': packageJson({ name: '@x/core' }),
				'packages/core/src/index.ts': '',
				'packages/core/src/utils/x.ts': '',
				'packages/ui/package.json': packageJson({ name: '@x/ui' }),
				'packages/ui/src/lib/Button.svelte': '',
			});
		});

		it('maps build output to the source file with the same path', () => {
			expect(
				map(
					dependency('@x/core', 'packages/core/dist/index.js'),
					dependency('@x/core/utils/x', 'packages/core/dist/utils/x.mjs'),
					dependency('@x/core/utils/x', 'packages/core/dist/utils/x.d.ts'),
					dependency('@x/ui/Button.svelte', 'packages/ui/dist/Button.svelte'),
				),
			).toStrictEqual([
				'packages/core/src/index.ts',
				'packages/core/src/utils/x.ts',
				'packages/core/src/utils/x.ts',
				'packages/ui/src/lib/Button.svelte',
			]);
		});

		it('maps a bundled package entry to the index file', () => {
			expect(
				map(
					dependency('@x/core', 'packages/core/dist/bundle.js'),
					dependency('@x/core/other', 'packages/core/dist/other.js'),
				),
			).toStrictEqual(['packages/core/src/index.ts', 'packages/core/dist/other.js']);
		});

		it('maps imports of packages that are not built', () => {
			expect(
				map(
					dependency('@x/core', '@x/core', true),
					dependency('@x/core/utils/x.js', '@x/core/utils/x.js', true),
					dependency('@x/core/missing', '@x/core/missing', true),
					dependency('@x/corex', '@x/corex', true),
				),
			).toStrictEqual([
				'packages/core/src/index.ts',
				'packages/core/src/utils/x.ts',
				'unresolved @x/core/missing',
				'unresolved @x/corex',
			]);
		});

		it('leaves other imports untouched', () => {
			expect(
				map(dependency('./b.js', 'src/b.ts'), dependency('@x/core', 'packages/core/src/index.ts')),
			).toStrictEqual(['src/b.ts', 'packages/core/src/index.ts']);
		});
	});
});
