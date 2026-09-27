import type { ICruiseResult } from 'dependency-cruiser';
import type extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import { debug, warn } from '../lib/log.js';

/**
 * A package of an npm workspace. All paths are relative to the workspace root
 * and use forward slashes, like the paths in a cruise result.
 */
export interface WorkspacePackage {
	name: string;
	directory: string;
	/** Directory of the build output, e.g. `packages/core/dist`. */
	outDir: string;
	/** Directories of the source files the build output is generated from, e.g. `packages/core/src`. */
	rootDirs: string[];
}

/** Extensions of source files, in the order they are tried. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.svelte'];

/** Extensions of build output files, which are removed before looking for the source file. */
const OUTPUT_EXTENSION = /(\.d)?\.([cm]?[jt]sx?|svelte)$/;

/**
 * Reads the packages of the npm workspace in `directory` from the `workspaces`
 * field of its `package.json`. Returns an empty array if it is no workspace.
 *
 * The build output and source directories of each package are read from
 * `compilerOptions.outDir` and `rootDir` of its `tsconfig.build.json` or
 * `tsconfig.json`. Without them, `dist` is assumed to be built from `src`, or
 * from `src/lib` like `svelte-package` does.
 */
export function readWorkspacePackages(directory: string, readTsConfig: typeof extractTSConfig): WorkspacePackage[] {
	const patterns = readWorkspacePatterns(directory);
	return patterns
		.flatMap((pattern) => expandDirectoryGlob(directory, pattern))
		.flatMap((packageDirectory) => {
			const name = readPackageJson(resolve(directory, packageDirectory, 'package.json'))?.name;
			if (typeof name !== 'string') return [];

			const toPath = (absolute: string): string => relative(directory, absolute).split('\\').join('/');
			let outDir = posix.join(packageDirectory, 'dist');
			let rootDirs = [posix.join(packageDirectory, 'src'), posix.join(packageDirectory, 'src/lib')];

			const tsconfig = ['tsconfig.build.json', 'tsconfig.json']
				.map((file) => resolve(directory, packageDirectory, file))
				.find((file) => existsSync(file));
			if (tsconfig) {
				try {
					const { options } = readTsConfig(tsconfig);
					if (options.outDir) outDir = toPath(options.outDir);
					if (options.rootDir) rootDirs = [toPath(options.rootDir)];
				} catch (error) {
					warn(`could not read ${tsconfig}: ${String(error)}`);
				}
			}
			return [{ name, directory: packageDirectory, outDir, rootDirs }];
		});
}

/**
 * Rewrites imports of other workspace packages that point to their build
 * output, or that could not be resolved because the package is not built, so
 * that they point to the source files instead.
 *
 * A build output file is mapped to the source file with the same path in one
 * of the `rootDirs`. If there is none, e.g. because the package is bundled
 * into a single file, an import of the package itself is mapped to its
 * `index` file.
 */
export function mapBuildOutputToSource(
	result: ICruiseResult,
	packages: WorkspacePackage[],
	directory: string,
): ICruiseResult {
	if (packages.length === 0) return result;

	const findSource = (pkg: WorkspacePackage, path: string, isEntry: boolean): string | undefined => {
		const base = path.replace(OUTPUT_EXTENSION, '');
		const candidates = [base, ...(isEntry ? ['index'] : [])];
		for (const rootDir of pkg.rootDirs) {
			for (const candidate of candidates) {
				for (const extension of SOURCE_EXTENSIONS) {
					const file = posix.join(rootDir, candidate + extension);
					if (existsSync(resolve(directory, file))) return file;
				}
			}
		}
		return undefined;
	};

	const toSource = (module: string, resolved: string, couldNotResolve: boolean): string | undefined => {
		for (const pkg of packages) {
			if (!couldNotResolve && resolved.startsWith(pkg.outDir + '/')) {
				return findSource(pkg, resolved.slice(pkg.outDir.length + 1), module === pkg.name);
			}
			if (couldNotResolve && (module === pkg.name || module.startsWith(pkg.name + '/'))) {
				const subpath = module.slice(pkg.name.length + 1);
				return subpath ? findSource(pkg, subpath, false) : findSource(pkg, 'index', true);
			}
		}
		return undefined;
	};

	const modules = result.modules.map((module) => ({
		...module,
		dependencies: module.dependencies.map((dependency) => {
			const source = toSource(dependency.module, dependency.resolved, dependency.couldNotResolve);
			if (!source) return dependency;
			debug(`${module.source}: "${dependency.module}" is mapped from ${dependency.resolved} to ${source}`);
			return { ...dependency, resolved: source, couldNotResolve: false };
		}),
	}));
	return { ...result, modules };
}

/**
 * Returns the globs in the `workspaces` field of the `package.json` in
 * `directory`, which is either an array or an object with a `packages` array.
 */
function readWorkspacePatterns(directory: string): string[] {
	const workspaces = readPackageJson(resolve(directory, 'package.json'))?.workspaces;
	const patterns = Array.isArray(workspaces)
		? workspaces
		: (workspaces as { packages?: unknown } | undefined)?.packages;
	if (!Array.isArray(patterns)) return [];
	return patterns.filter((pattern): pattern is string => typeof pattern === 'string' && !pattern.startsWith('!'));
}

function readPackageJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Returns the directories in `directory` that match the glob, one path
 * segment at a time, so that `node_modules` and hidden directories are never
 * scanned. Supports `*`, `?` and `**` in segments.
 */
function expandDirectoryGlob(directory: string, pattern: string): string[] {
	const segments = pattern
		.replace(/^\.\/+/, '')
		.replace(/\/+$/, '')
		.split('/');

	const subdirectories = (path: string): string[] => {
		try {
			return readdirSync(resolve(directory, path), { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
				.map((entry) => posix.join(path, entry.name));
		} catch {
			return [];
		}
	};

	let paths = [''];
	for (const segment of segments) {
		if (segment === '**') {
			const all = new Set(paths);
			for (let level = paths; level.length > 0;) {
				level = level.flatMap(subdirectories);
				level.forEach((path) => all.add(path));
			}
			paths = [...all];
		} else if (picomatch.scan(segment).isGlob) {
			const isMatch = picomatch(segment);
			paths = paths.flatMap(subdirectories).filter((path) => isMatch(posix.basename(path)));
		} else {
			paths = paths.map((path) => posix.join(path, segment)).filter((path) => existsSync(resolve(directory, path)));
		}
	}
	return paths.filter((path) => path !== '');
}
