import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import semver from 'semver';
import { releaseError } from '../lib/errors.js';
import { info } from '../lib/log.js';
import { changelogSection, distTag, isPrerelease, readManifests } from '../lib/release-plan.js';

/**
 * Options for {@link releaseCheck}.
 */
export interface ReleaseCheckOptions {
	/** File to write the release notes to, e.g. for `gh release create --notes-file`. */
	notesFile?: string;
	/** File to append the GitHub Actions outputs to (default: `$GITHUB_OUTPUT`, if set). */
	outputFile?: string;
}

/**
 * What {@link releaseCheck} found out about the tag.
 */
export interface ReleaseCheckResult {
	/** The version of the tag, without `v`. */
	version: string;
	/** Whether it is a prerelease such as `2.0.0-rc.0`. */
	prerelease: boolean;
	/** The npm dist-tag to publish it with: `next` for prereleases, `latest` otherwise. */
	distTag: string;
	/** The version of this tool, so that later jobs can run the same one. */
	toolVersion: string;
	/** The release notes from CHANGELOG.md. */
	notes: string;
}

/**
 * The guard of the release workflow: checks that a pushed tag can be released.
 *
 * It must be `v` and the version of every `package.json` in the repository, including the
 * workspaces, and CHANGELOG.md must have notes for that version. Writes the notes to
 * `notesFile` and, in GitHub Actions, the outputs `version`, `prerelease`, `dist-tag` and
 * `tool-version`.
 *
 * @param directory - The repository root.
 * @param tag - The pushed tag, e.g. `v1.2.3`.
 * @param options - Where to write the notes and outputs.
 * @returns What was found out about the tag.
 * @throws A release error if the tag cannot be released.
 */
export function releaseCheck(directory: string, tag: string, options: ReleaseCheckOptions = {}): ReleaseCheckResult {
	const version = /^v(.+)$/.exec(tag)?.[1];
	if (version === undefined || semver.valid(version) !== version) {
		throw releaseError(`expected a tag like v1.2.3, got "${tag}"`);
	}

	for (const manifest of readManifests(directory)) {
		if (manifest.version !== version) {
			const file = manifest.relative ? `${manifest.relative}/package.json` : 'package.json';
			throw releaseError(
				`${file} has version ${manifest.version}, but the tag is ${tag}. Refusing to release a tag that does not match the code.`,
			);
		}
	}

	const changelogPath = resolve(directory, 'CHANGELOG.md');
	if (!existsSync(changelogPath)) throw releaseError('CHANGELOG.md not found');
	const notes = changelogSection(readFileSync(changelogPath, 'utf8'), version);

	const result: ReleaseCheckResult = {
		version,
		prerelease: isPrerelease(version),
		distTag: distTag(version),
		toolVersion: getToolVersion(),
		notes,
	};

	if (options.notesFile !== undefined) {
		const path = resolve(directory, options.notesFile);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, notes + '\n');
	}

	const outputFile = options.outputFile ?? process.env.GITHUB_OUTPUT;
	const outputs = {
		version: result.version,
		prerelease: String(result.prerelease),
		'dist-tag': result.distTag,
		'tool-version': result.toolVersion,
	};
	if (outputFile) {
		appendFileSync(
			outputFile,
			Object.entries(outputs)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(''),
		);
	}

	info(`${tag} matches every package.json, and CHANGELOG.md has its release notes`);
	info(
		Object.entries(outputs)
			.map(([key, value]) => `${key}=${value}`)
			.join(', '),
	);
	return result;
}

/**
 * Returns the version of this tool from its own package.json.
 */
export function getToolVersion(): string {
	// the same relative path from src/commands/ and dist/commands/
	const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
		version: string;
	};
	return pkg.version;
}
