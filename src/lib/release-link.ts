import { existsSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';

/**
 * Environment variable that `release-npm` sets while running `npm publish`. It
 * holds the version being released, so that generated documentation can link
 * to files at that release's git tag.
 */
export const RELEASE_VERSION_ENV = 'VRT_RELEASE_VERSION';

/**
 * Finds the root of the git repository containing `directory` by looking for a
 * `.git` entry in it and its parents.
 *
 * @returns The repository root, or `directory` itself if it is not inside a repository
 */
export function findGitRoot(directory: string): string {
	const start = resolve(directory);
	for (let current = start; ; current = dirname(current)) {
		if (existsSync(resolve(current, '.git'))) return current;
		if (dirname(current) === current) return start;
	}
}

/**
 * Returns the URL under which the files of `directory` are served at the git
 * tag of a release, e.g. `https://raw.githubusercontent.com/owner/repo/v1.2.3/`.
 * If `directory` is a subdirectory of the repository, e.g. a package in a
 * monorepo, its path is part of the URL. Appending a path relative to
 * `directory` gives a link that never changes after the release.
 *
 * @param repoUrl - GitHub repository URL like `https://github.com/owner/repo`
 * @param version - The released version, without `v` prefix
 * @param directory - The project directory
 */
export function getReleaseBaseUrl(repoUrl: string, version: string, directory: string): string {
	const repository = repoUrl.replace(/^https:\/\/github\.com\//, '');
	const subdirectory = relative(findGitRoot(directory), resolve(directory)).split(sep).join('/');
	return `https://raw.githubusercontent.com/${repository}/v${version}/${subdirectory ? subdirectory + '/' : ''}`;
}

/**
 * Turns Markdown links that start with `baseUrl` back into links relative to
 * the project directory. This is the reverse of prefixing a relative path with
 * {@link getReleaseBaseUrl}.
 */
export function unpinReleaseLinks(markdown: string, baseUrl: string): string {
	return markdown.split(`](${baseUrl}`).join('](');
}
