import { Shell } from './shell.js';

/**
 * Represents a Git commit with its SHA, message, and optional tag.
 */
export interface Commit {
	/** The full SHA hash of the commit. */
	sha: string;
	/** The commit message (first line / subject). */
	message: string;
	/** The tag associated with this commit, if any. */
	tag?: string;
}

/**
 * Interface for Git operations used by the release tool.
 */
export interface Git {
	/**
	 * Gets the most recent semver tag from the repository.
	 * @returns The SHA and version string of the last tag, or undefined if no semver tags exist.
	 */
	getLastGitHubTag: () => Promise<{ sha: string; version: string } | undefined>;

	/**
	 * Gets the current (most recent) commit.
	 * @returns The current commit object.
	 */
	getCurrentGitHubCommit: () => Promise<Commit>;

	/**
	 * Gets all commits between two commit SHAs.
	 * @param shaLast - The older commit SHA (exclusive).
	 * @param shaCurrent - The newer commit SHA (inclusive).
	 * @returns Array of commits between the two SHAs.
	 */
	getCommitsBetween: (shaLast?: string, shaCurrent?: string) => Promise<Commit[]>;
}

/**
 * Creates a Git interface for the specified directory.
 * Provides methods to query commit history and tags.
 *
 * @param cwd - The working directory of the Git repository.
 * @returns An object with methods to interact with the Git repository.
 *
 * @example
 * ```ts
 * const git = getGit('/path/to/repo');
 * const lastTag = await git.getLastGitHubTag();
 * const commits = await git.getCommitsBetween(lastTag?.sha, 'HEAD');
 * ```
 */
export function getGit(cwd: string): Git {
	const shell = new Shell(cwd);

	return {
		getLastGitHubTag,
		getCurrentGitHubCommit,
		getCommitsBetween,
	};

	/**
	 * Finds the most recent commit tagged with a semver version (vX.Y.Z format).
	 * Supports pre-release and build metadata suffixes.
	 */
	async function getLastGitHubTag(): Promise<{ sha: string; version: string } | undefined> {
		const commits: Commit[] = await getAllCommits();

		const result = commits
			.map((commit) => ({
				sha: commit.sha,
				version: commit.tag?.match(/^v(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)$/)?.[1],
			}))
			.find((r) => r.version) as { sha: string; version: string } | undefined;

		return result;
	}

	/**
	 * Retrieves all commits from the repository's history.
	 * Parses the git log output to extract SHA, message, and tag information.
	 */
	async function getAllCommits(): Promise<Commit[]> {
		const result: string = await shell.stdout("git log --pretty=format:'⍃%H⍄%s⍄%D⍄'");

		return result
			.split('⍃')
			.filter((line) => line.length > 2)
			.map((line) => {
				const obj: string[] = line.split('⍄');
				return {
					sha: obj[0],
					message: obj[1],
					tag: /tag: ([a-z0-9.]+)/.exec(obj[2])?.[1],
				};
			});
	}

	/**
	 * Returns the most recent commit in the repository.
	 */
	async function getCurrentGitHubCommit(): Promise<Commit> {
		return (await getAllCommits())[0];
	}

	/**
	 * Gets commits between two SHA hashes.
	 * If shaCurrent is provided, starts from that commit.
	 * If shaLast is provided, stops before that commit.
	 */
	async function getCommitsBetween(shaLast?: string, shaCurrent?: string): Promise<Commit[]> {
		let commits: Commit[] = await getAllCommits();

		const start = commits.findIndex((commit) => commit.sha === shaCurrent);
		if (start >= 0) commits = commits.slice(start);

		const end = commits.findIndex((commit) => commit.sha === shaLast);
		if (end >= 0) commits = commits.slice(0, end);

		return commits;
	}
}
