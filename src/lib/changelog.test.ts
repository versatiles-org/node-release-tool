import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateChangelogEntry, updateChangelog } from './changelog.js';
import type { ParsedCommit } from './git.js';

describe('generateChangelogEntry', () => {
	const fixedDate = new Date('2024-01-15');

	const makeCommit = (
		type: string | undefined,
		description: string,
		breaking = false,
		scope?: string,
	): ParsedCommit => ({
		sha: 'abc123',
		message: type ? `${type}: ${description}` : description,
		description,
		type: type as ParsedCommit['type'],
		scope,
		breaking,
	});

	it('generates entry with version and date', () => {
		const commits = [makeCommit('feat', 'add feature')];
		const entry = generateChangelogEntry('1.0.0', commits, fixedDate);

		expect(entry).toContain('## [1.0.0] - 2024-01-15');
	});

	it('groups commits by type', () => {
		const commits = [
			makeCommit('feat', 'add feature'),
			makeCommit('fix', 'fix bug'),
			makeCommit('feat', 'another feature'),
		];
		const entry = generateChangelogEntry('1.0.0', commits, fixedDate);

		expect(entry).toContain('### Features');
		expect(entry).toContain('- add feature');
		expect(entry).toContain('- another feature');
		expect(entry).toContain('### Bug Fixes');
		expect(entry).toContain('- fix bug');
	});

	it('shows breaking changes first', () => {
		const commits = [makeCommit('feat', 'breaking change', true), makeCommit('fix', 'normal fix')];
		const entry = generateChangelogEntry('1.0.0', commits, fixedDate);

		const breakingIndex = entry.indexOf('### Breaking Changes');
		const featuresIndex = entry.indexOf('### Bug Fixes');

		expect(breakingIndex).toBeLessThan(featuresIndex);
		expect(breakingIndex).toBeGreaterThan(-1);
	});

	it('includes scope in commit message', () => {
		const commits = [makeCommit('feat', 'add endpoint', false, 'api')];
		const entry = generateChangelogEntry('1.0.0', commits, fixedDate);

		expect(entry).toContain('**api:** add endpoint');
	});

	it('handles non-conventional commits under Other Changes', () => {
		const commits = [makeCommit(undefined, 'random change')];
		const entry = generateChangelogEntry('1.0.0', commits, fixedDate);

		expect(entry).toContain('### Other Changes');
		expect(entry).toContain('- random change');
	});

	it('handles empty commits array', () => {
		const entry = generateChangelogEntry('1.0.0', [], fixedDate);

		expect(entry).toContain('## [1.0.0] - 2024-01-15');
		expect(entry).not.toContain('###');
	});
});

describe('updateChangelog', () => {
	const testDir = join(process.cwd(), 'test-changelog-temp');
	const changelogPath = join(testDir, 'CHANGELOG.md');
	const fixedDate = new Date('2024-01-15');

	const makeCommit = (type: string, description: string): ParsedCommit => ({
		sha: 'abc123',
		message: `${type}: ${description}`,
		description,
		type: type as ParsedCommit['type'],
		breaking: false,
	});

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it('creates new CHANGELOG.md if it does not exist', () => {
		const commits = [makeCommit('feat', 'initial feature')];
		const result = updateChangelog(testDir, '1.0.0', commits, fixedDate);

		expect(result.created).toBe(true);
		expect(existsSync(changelogPath)).toBe(true);

		const content = readFileSync(changelogPath, 'utf8');
		expect(content).toContain('# Changelog');
		expect(content).toContain('## [1.0.0] - 2024-01-15');
		expect(content).toContain('- initial feature');
	});

	it('prepends entry to existing CHANGELOG.md', () => {
		const existingContent = `# Changelog

All notable changes to this project will be documented in this file.

## [0.9.0] - 2024-01-01

### Features

- old feature
`;
		writeFileSync(changelogPath, existingContent);

		const commits = [makeCommit('feat', 'new feature')];
		const result = updateChangelog(testDir, '1.0.0', commits, fixedDate);

		expect(result.created).toBe(false);

		const content = readFileSync(changelogPath, 'utf8');
		const v100Index = content.indexOf('## [1.0.0]');
		const v090Index = content.indexOf('## [0.9.0]');

		expect(v100Index).toBeGreaterThan(-1);
		expect(v090Index).toBeGreaterThan(-1);
		expect(v100Index).toBeLessThan(v090Index);
		expect(content).toContain('- new feature');
		expect(content).toContain('- old feature');
	});

	it('preserves header content', () => {
		const existingContent = `# Changelog

Custom header text here.

## [0.9.0] - 2024-01-01

- old entry
`;
		writeFileSync(changelogPath, existingContent);

		const commits = [makeCommit('fix', 'bug fix')];
		updateChangelog(testDir, '1.0.0', commits, fixedDate);

		const content = readFileSync(changelogPath, 'utf8');
		expect(content).toContain('Custom header text here.');
		expect(content).toContain('## [1.0.0]');
	});

	it('returns correct path', () => {
		const commits = [makeCommit('feat', 'feature')];
		const result = updateChangelog(testDir, '1.0.0', commits, fixedDate);

		expect(result.path).toBe(changelogPath);
	});
});
