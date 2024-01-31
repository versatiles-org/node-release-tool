import { getGit } from './git.js';

describe('Git module tests', () => {
	const cwd = new URL('../../', import.meta.url).pathname;
	const git = getGit(cwd);

	it('gets the last GitHub tag', async () => {
		const lastTag = await git.getLastGitHubTag();
		expect(lastTag).toBe(undefined);
	});

	it('gets the current GitHub commit', async () => {
		const currentCommit = await git.getCurrentGitHubCommit();
		checkCommit(currentCommit);
	});

	it('gets commits between two shas', async () => {
		const shaLast = 'SHA_OF_AN_EARLIER_COMMIT';
		const shaCurrent = 'SHA_OF_A_LATER_COMMIT';
		const commits = await git.getCommitsBetween(shaLast, shaCurrent);

		expect(Array.isArray(commits)).toBe(true);
		expect(commits.length).toBeGreaterThan(0);
		commits.forEach(checkCommit);
	});
});

function checkCommit(commit: any) {
	expect(commit).toBeDefined();
	expect(commit).toHaveProperty('tag');
	expect(commit.sha).toMatch(/^[a-f0-9]{40}$/);
	expect(typeof commit.message).toBe('string');
}
