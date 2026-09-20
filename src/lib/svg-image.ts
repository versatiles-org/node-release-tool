import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, relative, resolve, sep } from 'path';
import { extractGitHubRepoUrl } from './git.js';
import { warn } from './log.js';
import { getReleaseBaseUrl, RELEASE_VERSION_ENV } from './release-link.js';
import { Shell } from './shell.js';

/**
 * Writes a generated SVG file for the docs and returns Markdown that shows it
 * as an image linked to the raw file, where the SVG is interactive:
 * `[![alt](path)](path?raw=true)`.
 *
 * The URLs are relative to `directory`, so GitHub shows the file of the current
 * commit. While `release-npm` publishes (see {@link RELEASE_VERSION_ENV}), they
 * point to the file at the git tag of the release instead, so that the
 * published README always shows the image of its version.
 *
 * Warns if git ignores the file, because the link would be broken.
 *
 * @param directory - The project directory
 * @param svgPath - Path of the SVG file, relative to `directory`
 * @param svg - The SVG content
 * @param alt - Alternative text of the image
 */
export async function writeSvgImage(directory: string, svgPath: string, svg: string, alt: string): Promise<string> {
	const absolutePath = resolve(directory, svgPath);
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, svg);
	if (await isIgnoredByGit(directory, absolutePath)) {
		warn(`${svgPath} is ignored by git, so the image link will be broken on GitHub and npm`);
	}
	const url = getImageUrl(directory, svgPath);
	return `[![${alt}](${url})](${url}?raw=true)`;
}

/**
 * Whether git ignores the file, so it would never be committed. Returns false
 * outside of a git repository or if git is not available.
 *
 * The path is handed to git through stdin rather than as an argument: a path is
 * data, and one that begins with a dash would be read as an option on the
 * command line. `-z` makes git take the input as a single NUL-terminated
 * record, so not even a newline in the name can split it into two paths. The
 * exit code means the same as with `--quiet`: 0 if the path is ignored, 1 if it
 * is not, 128 outside of a repository.
 */
async function isIgnoredByGit(directory: string, path: string): Promise<boolean> {
	try {
		const shell = new Shell(directory);
		const result = await shell.exec('git', ['check-ignore', '--stdin', '-z'], false, true, `${path}\0`);
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Returns the URL of the SVG file: relative to `directory`, or at the release
 * tag while `release-npm` publishes.
 */
function getImageUrl(directory: string, svgPath: string): string {
	const relativePath = relative(resolve(directory), resolve(directory, svgPath)).split(sep).join('/');
	const version = process.env[RELEASE_VERSION_ENV];
	if (!version) return relativePath;

	let repository: unknown;
	try {
		repository = (JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { repository?: unknown })
			.repository;
	} catch {
		repository = undefined;
	}
	const repoUrl = extractGitHubRepoUrl(repository);
	if (!repoUrl) {
		warn(`no GitHub repository URL in package.json, using a relative link for ${svgPath}`);
		return relativePath;
	}
	return getReleaseBaseUrl(repoUrl, version, directory) + relativePath;
}
