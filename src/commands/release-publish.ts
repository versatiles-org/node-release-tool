import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';
import { releaseError } from '../core/errors.js';
import { getGitHubReleaseState } from '../lib/github.js';
import { check, info } from '../core/log.js';
import { distTag, isPrerelease } from '../lib/release-plan.js';
import { Shell } from '../lib/shell.js';
import { PACKAGES_FILE, type PackedRelease } from './release-pack.js';

/** The oldest npm that supports trusted publishing. */
export const MIN_NPM_VERSION = '11.5.1';

/** Name of the release notes file in the release directory, written by `vrt release-check`. */
export const NOTES_FILE = 'notes.md';

/**
 * Publishes a release that the release workflow has verified, tested and packed: first the
 * tarballs to npm, then the GitHub release with the notes from CHANGELOG.md.
 *
 * Running it again is safe. Versions that are already on npm are skipped, and a published
 * GitHub release is left as it is, so after a failure, e.g. an npm outage, re-running the job
 * finishes the release.
 *
 * npm authenticates with trusted publishing (OIDC), so the job needs the `id-token: write`
 * permission and npm {@link MIN_NPM_VERSION} or later. `gh` needs `GH_TOKEN` and, without a
 * checkout, `GH_REPO`.
 *
 * @param directory - The directory with the tarballs, {@link PACKAGES_FILE} and {@link NOTES_FILE}.
 * @param tag - The tag to release, e.g. `v1.2.3`.
 */
export async function releasePublish(directory: string, tag: string): Promise<void> {
	const release = JSON.parse(readFileSync(resolve(directory, PACKAGES_FILE), 'utf8')) as PackedRelease;
	if (tag !== `v${release.version}`) {
		throw releaseError(`the packages have version ${release.version}, but the tag is ${tag}`);
	}
	const notesFile = resolve(directory, NOTES_FILE);
	if (!existsSync(notesFile)) throw releaseError(`${NOTES_FILE} not found in ${directory}`);

	const shell = new Shell(directory);

	if (release.packages.length > 0) {
		const npmVersion = await check('get npm version', shell.stdout('npm --version'));
		if (!semver.valid(npmVersion) || semver.lt(npmVersion, MIN_NPM_VERSION)) {
			throw releaseError(
				`npm ${npmVersion} is too old for trusted publishing, it needs ${MIN_NPM_VERSION} or later`,
			);
		}
	}

	const tagName = distTag(release.version);
	for (const { name, file } of release.packages) {
		const spec = `${name}@${release.version}`;
		if (await isOnNpm(shell, spec, release.version)) {
			info(`${spec} is already on npm, skipping it`);
			continue;
		}
		await check(
			`publish ${spec} with dist-tag ${tagName}`,
			shell.exec('npm', ['publish', `./${file}`, '--access', 'public', '--tag', tagName, '--provenance']),
		);
	}

	const state = await check('look up the GitHub release', getGitHubReleaseState(shell, tag));
	const latestFlag = isPrerelease(release.version) ? '--prerelease' : '--latest';
	if (state === 'missing') {
		await check(
			`create the GitHub release ${tag}`,
			shell.exec('gh', [
				'release',
				'create',
				tag,
				'--verify-tag',
				'--title',
				tag,
				'--notes-file',
				notesFile,
				latestFlag,
			]),
		);
	} else if (state === 'draft') {
		await check(
			`publish the GitHub release ${tag}`,
			shell.exec('gh', ['release', 'edit', tag, '--draft=false', '--notes-file', notesFile, latestFlag]),
		);
	} else {
		info(`the GitHub release ${tag} is already published, leaving it unchanged`);
	}
}

/**
 * Whether npm already has a version of a package. Unlike `isAvailableOnNpm`, it does not wait
 * for the tarball: a version that npm knows can never be published again.
 */
async function isOnNpm(shell: Shell, spec: string, version: string): Promise<boolean> {
	const result = await shell.exec('npm', ['view', spec, 'version', '--prefer-online'], false, true);
	return result.code === 0 && result.stdout.trim() === version;
}
