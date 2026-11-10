import { existsSync, readFileSync } from 'fs';
import { relative, resolve } from 'path';
import semver from 'semver';
import { readWorkspaceDirectories } from './workspaces.js';
import { releaseError, validationError } from './errors.js';
import { getSuggestedBump, type ParsedCommit } from './git.js';

/**
 * A `package.json` whose version is released, either the root one or that of a workspace.
 * All of them share one version, so that one tag describes the whole repository.
 */
export interface Manifest {
	/** Absolute path of the `package.json`. */
	path: string;
	/** Absolute path of the directory containing it. */
	directory: string;
	/** Path of the directory relative to the repository root, `''` for the root. */
	relative: string;
	/** The package name, if any. */
	name?: string;
	/** The version in the file. */
	version: string;
	/** Whether the package is private, i.e. never published to npm. */
	private: boolean;
	/** Names of the packages it depends on, including peer and optional dependencies. */
	dependencies: string[];
}

/**
 * Reads the `package.json` of the repository root and of every npm workspace in it.
 *
 * @param directory - The repository root.
 * @returns The root manifest first, then the workspaces in the order of the `workspaces` field.
 * @throws A release error if a manifest has no version.
 */
export function readManifests(directory: string): Manifest[] {
	const root = resolve(directory);
	const directories = [root, ...readWorkspaceDirectories(root).map((path) => resolve(root, path))];
	return directories
		.filter((path) => existsSync(resolve(path, 'package.json')))
		.map((path) => {
			const file = resolve(path, 'package.json');
			const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
			const relativePath = relative(root, path).split('\\').join('/');
			if (typeof pkg.version !== 'string') {
				throw releaseError(`${relativePath ? relativePath + '/' : ''}package.json has no version`);
			}
			return {
				path: file,
				directory: path,
				relative: relativePath,
				name: typeof pkg.name === 'string' ? pkg.name : undefined,
				version: pkg.version,
				private: pkg.private === true || String(pkg.private).toLowerCase() === 'true',
				dependencies: ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => {
					const deps = pkg[field];
					return typeof deps === 'object' && deps !== null ? Object.keys(deps) : [];
				}),
			};
		});
}

/**
 * Returns the manifests that are published to npm, ordered so that every package comes after
 * the packages of the same repository it depends on. Then a package never reaches npm before
 * the version of a sibling it needs.
 *
 * @param manifests - The manifests, as returned by {@link readManifests}.
 * @returns The public manifests in publish order.
 */
export function publishOrder(manifests: Manifest[]): Manifest[] {
	const pending = manifests.filter((manifest) => !manifest.private && manifest.name !== undefined);
	const ordered: Manifest[] = [];
	while (pending.length > 0) {
		const names = new Set(pending.map((manifest) => manifest.name));
		// a cycle has no package without pending dependencies: then keep the original order
		const index = Math.max(
			0,
			pending.findIndex((manifest) => manifest.dependencies.every((dependency) => !names.has(dependency))),
		);
		ordered.push(...pending.splice(index, 1));
	}
	return ordered;
}

/** Bump levels accepted instead of an explicit version. */
export const BUMP_LEVELS = ['patch', 'minor', 'major'] as const;

/** A bump level relative to the current version. */
export type BumpLevel = (typeof BUMP_LEVELS)[number];

/**
 * Resolves a requested version: a bump level relative to `current`, or an explicit version,
 * which may be a prerelease such as `2.0.0-rc.0`. Either must be higher than `current`.
 *
 * @param current - The version currently in package.json.
 * @param request - `patch`, `minor`, `major` or a version.
 * @returns The version to release.
 * @throws A validation error if the request is no version or not higher than `current`.
 */
export function resolveReleaseVersion(current: string, request: string): string {
	const level = BUMP_LEVELS.find((candidate) => candidate === request);
	if (level) {
		const next = semver.inc(current, level);
		if (next === null) throw validationError(`"${current}" in package.json is not a valid version`);
		return next;
	}
	const version = semver.valid(request.replace(/^v/, ''));
	if (version === null) {
		throw validationError(`invalid version "${request}", expected ${BUMP_LEVELS.join(', ')} or a version like 1.2.3`);
	}
	if (!semver.gt(version, current)) {
		throw validationError(`${version} is not higher than the current version ${current}`);
	}
	return version;
}

/**
 * Recommends the version to release from the commits since the last release: a major, minor or
 * patch release as the conventional commits ask for, or after a prerelease the next prerelease,
 * e.g. `2.0.0-rc.1` after `2.0.0-rc.0`.
 *
 * @param current - The version currently in package.json.
 * @param commits - The commits since the last release.
 * @returns The recommended version and a short reason for it.
 */
export function recommendVersion(current: string, commits: ParsedCommit[]): { version: string; reason: string } {
	if (semver.prerelease(current)) {
		return {
			version: resolveReleaseVersion(current, semver.inc(current, 'prerelease') ?? ''),
			reason: 'the next prerelease',
		};
	}
	const bump = getSuggestedBump(commits);
	return { version: resolveReleaseVersion(current, bump), reason: `a ${bump} release` };
}

/**
 * Whether a version is a prerelease, such as `2.0.0-rc.0`.
 */
export function isPrerelease(version: string): boolean {
	return semver.prerelease(version) !== null;
}

/**
 * The npm dist-tag of a version: prereleases get `next`, so that they never become `latest`.
 */
export function distTag(version: string): 'latest' | 'next' {
	return isPrerelease(version) ? 'next' : 'latest';
}

/**
 * Sets the version in the text of a `package.json`, keeping its formatting.
 *
 * @param content - The text of the file.
 * @param version - The new version.
 * @returns The changed text.
 * @throws A release error if the file has no `"version"` field.
 */
export function setManifestVersion(content: string, version: string): string {
	const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
	if (!pattern.test(content)) throw releaseError('package.json has no "version" field');
	return content.replace(pattern, `$1${version}$2`);
}

/**
 * Returns the body of the `## [version]` section of a changelog, without its heading.
 *
 * @param changelog - The text of CHANGELOG.md.
 * @param version - The version, without `v`.
 * @returns The trimmed body of the section.
 * @throws A release error if the section is missing or empty.
 */
export function changelogSection(changelog: string, version: string): string {
	const lines = changelog.split('\n');
	const heading = new RegExp(`^## \\[?v?${version.replace(/[.+]/g, '\\$&')}\\]?(\\s|$)`);
	const start = lines.findIndex((line) => heading.test(line));
	if (start < 0) throw releaseError(`CHANGELOG.md has no section for ${version}`);
	const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
	const body = lines
		.slice(start + 1, next < 0 ? undefined : next)
		.join('\n')
		.trim();
	if (body === '') throw releaseError(`the CHANGELOG.md section for ${version} is empty`);
	return body;
}
