import { describe, expect, it } from 'vitest';
import { COMMIT_TYPES, getGit, getSuggestedBump, groupCommitsByType, parseConventionalCommit } from './git.js';
import type { Commit, ParsedCommit } from './git.js';

describe('Git module tests', () => {
	const cwd = new URL('../../', import.meta.url).pathname;
	const git = getGit(cwd);

	it('gets the last GitHub tag', async () => {
		const result = await git.getLastGitHubTag();
		expect(result).toBeTruthy();
		if (!result) throw Error();
		expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
		expect(result.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
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

function checkCommit(commit: { tag?: string; sha: string; message: string }): void {
	expect(commit).toBeDefined();
	expect(commit).toHaveProperty('tag');
	expect(commit.sha).toMatch(/^[a-f0-9]{40}$/);
	expect(typeof commit.message).toBe('string');
}

describe('parseConventionalCommit', () => {
	const baseCommit: Commit = { sha: 'abc123', message: '' };

	it('parses a simple conventional commit', () => {
		const commit = { ...baseCommit, message: 'feat: add new feature' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.type).toBe('feat');
		expect(parsed.scope).toBeUndefined();
		expect(parsed.description).toBe('add new feature');
		expect(parsed.breaking).toBe(false);
	});

	it('parses a conventional commit with scope', () => {
		const commit = { ...baseCommit, message: 'fix(api): resolve timeout issue' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.type).toBe('fix');
		expect(parsed.scope).toBe('api');
		expect(parsed.description).toBe('resolve timeout issue');
		expect(parsed.breaking).toBe(false);
	});

	it('parses a breaking change with !', () => {
		const commit = { ...baseCommit, message: 'feat!: breaking change' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.type).toBe('feat');
		expect(parsed.breaking).toBe(true);
	});

	it('parses a breaking change with scope and !', () => {
		const commit = { ...baseCommit, message: 'refactor(core)!: rewrite module' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.type).toBe('refactor');
		expect(parsed.scope).toBe('core');
		expect(parsed.breaking).toBe(true);
	});

	it('detects BREAKING CHANGE in message', () => {
		const commit = { ...baseCommit, message: 'feat: new api BREAKING CHANGE' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.breaking).toBe(true);
	});

	it('handles non-conventional commits', () => {
		const commit = { ...baseCommit, message: 'Update dependencies' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.type).toBeUndefined();
		expect(parsed.description).toBe('Update dependencies');
		expect(parsed.breaking).toBe(false);
	});

	it('handles unknown commit types', () => {
		const commit = { ...baseCommit, message: 'unknown: some change' };
		const parsed = parseConventionalCommit(commit);

		expect(parsed.type).toBeUndefined();
		expect(parsed.description).toBe('some change');
	});

	it('recognizes all standard commit types', () => {
		for (const type of Object.keys(COMMIT_TYPES)) {
			const commit = { ...baseCommit, message: `${type}: test message` };
			const parsed = parseConventionalCommit(commit);
			expect(parsed.type).toBe(type);
		}
	});
});

describe('getSuggestedBump', () => {
	const makeCommit = (type?: string, breaking = false): ParsedCommit => ({
		sha: 'abc123',
		message: '',
		description: 'test',
		type: type as ParsedCommit['type'],
		breaking,
	});

	it('returns major for breaking changes', () => {
		const commits = [makeCommit('feat'), makeCommit('fix', true)];
		expect(getSuggestedBump(commits)).toBe('major');
	});

	it('returns minor for features without breaking changes', () => {
		const commits = [makeCommit('feat'), makeCommit('fix')];
		expect(getSuggestedBump(commits)).toBe('minor');
	});

	it('returns patch for fixes only', () => {
		const commits = [makeCommit('fix'), makeCommit('chore')];
		expect(getSuggestedBump(commits)).toBe('patch');
	});

	it('returns patch for non-conventional commits', () => {
		const commits = [makeCommit(), makeCommit()];
		expect(getSuggestedBump(commits)).toBe('patch');
	});
});

describe('groupCommitsByType', () => {
	const makeCommit = (type?: string): ParsedCommit => ({
		sha: 'abc123',
		message: '',
		description: 'test',
		type: type as ParsedCommit['type'],
		breaking: false,
	});

	it('groups commits by type', () => {
		const commits = [makeCommit('feat'), makeCommit('fix'), makeCommit('feat'), makeCommit()];

		const groups = groupCommitsByType(commits);

		expect(groups.get('feat')?.length).toBe(2);
		expect(groups.get('fix')?.length).toBe(1);
		expect(groups.get('other')?.length).toBe(1);
	});

	it('returns empty map for empty input', () => {
		const groups = groupCommitsByType([]);
		expect(groups.size).toBe(0);
	});
});
