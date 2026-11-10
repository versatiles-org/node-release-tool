import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import picomatch from 'picomatch';

/**
 * Returns the directories matched by the `workspaces` field of the `package.json` in
 * `directory`, relative to it and with forward slashes. Returns an empty array if it is
 * no workspace.
 */
export function readWorkspaceDirectories(directory: string): string[] {
	return readWorkspacePatterns(directory).flatMap((pattern) => expandDirectoryGlob(directory, pattern));
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

export function readPackageJson(file: string): Record<string, unknown> | undefined {
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
